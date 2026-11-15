const connectedPorts = [];
const ALLOWED_URLS = ["https://www.usvisascheduling.com", "https://atlasauth.b2clogin.com"];
function isAllowedUrl(url) { return url && ALLOWED_URLS.some(a => url.startsWith(a)); }

chrome.runtime.onConnect.addListener(port => {
    connectedPorts.push(port);
    port.onDisconnect.addListener(() => {
        const i = connectedPorts.indexOf(port);
        if (i !== -1) connectedPorts.splice(i, 1);
    });
    port.onMessage.addListener(async def => {
        const response = { action: def.action };
        if (def.action === "fetch_info") {
            const { __act } = await chrome.storage.local.get("__act");
            response.data = { $active: __act || false };
        } else if (def.action === "requestKeepAwake") {
            chrome.power.requestKeepAwake("display");
        } else if (def.action === "releaseKeepAwake") {
            chrome.power.releaseKeepAwake();
        }
        port.postMessage(response);
    });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
        await chrome.storage.local.set({
            __act: true, __ab: true, __cr: 1000, __fqType: "seconds", __fq: 30,
            __cty: null, __ctyLabel: null,
            __ofcSelectedCities: [], __consularSelectedCities: []
        });
        chrome.tabs.create({ url: "https://www.usvisascheduling.com" });
    }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cdpSend(tabId, method, params) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params || {}, result => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(result || {});
        });
    });
}

// ── KEY FIX: Multi-strategy position finder that handles closed shadow roots ──
// Cloudflare puts the Turnstile iframe inside a #shadow-root (closed) which
// makes normal querySelector return null. We use 4 strategies to bypass this.
async function findTurnstilePosition(tabId) {

    for (let attempt = 0; attempt < 10; attempt++) {

        // ── Strategy A: elementsFromPoint scan + querySelectorAll size scan ────
        // elementsFromPoint returns shadow host elements even for closed roots.
        // querySelectorAll('*') finds the shadow host container div (which has
        // the same ~300×65 dimensions as the iframe inside it).
        try {
            const { result } = await cdpSend(tabId, 'Runtime.evaluate', {
                expression: `(() => {
                    const cx = Math.round(window.innerWidth / 2);

                    // SCAN 1: elementsFromPoint at left-of-centre (checkbox area)
                    // The checkbox is ~24px from the left edge of the 300px widget,
                    // so we scan at cx-100 to hit the left half of the widget.
                    for (let y = 60; y < 600; y += 4) {
                        try {
                            const els = document.elementsFromPoint(cx - 100, y) || [];
                            for (const el of els) {
                                const r = el.getBoundingClientRect();
                                if (r.width >= 240 && r.width <= 340 &&
                                    r.height >= 48 && r.height <= 90 &&
                                    r.top >= 0 && r.top < 700 && r.left >= 0) {
                                    return {
                                        x: Math.round(r.left + 24),
                                        y: Math.round(r.top + r.height / 2),
                                        w: Math.round(r.width), h: Math.round(r.height),
                                        method: 'elementsFromPoint y=' + y
                                    };
                                }
                            }
                        } catch(e) {}
                    }

                    // SCAN 2: querySelectorAll - shadow HOST div is accessible even
                    // though the iframe inside it isn't. It inherits the iframe size.
                    try {
                        const all = Array.from(document.querySelectorAll('div, section, article'));
                        for (const el of all) {
                            const r = el.getBoundingClientRect();
                            if (r.width >= 240 && r.width <= 340 &&
                                r.height >= 48 && r.height <= 90 &&
                                r.top > 0 && r.top < 700 && r.left > 0) {
                                return {
                                    x: Math.round(r.left + 24),
                                    y: Math.round(r.top + r.height / 2),
                                    w: Math.round(r.width), h: Math.round(r.height),
                                    method: 'querySelectorAll-size tag=' + el.tagName
                                };
                            }
                        }
                    } catch(e) {}

                    // SCAN 3: iframe selectors (works if not in shadow root)
                    const iSelectors = [
                        'iframe[src*="challenges.cloudflare.com"]',
                        'iframe[id*="cf-chl-widget"]',
                        'iframe[title*="challenge"]',
                        'iframe[title*="Cloudflare"]',
                        'iframe[allow*="cross-origin-isolated"]',
                        'iframe'
                    ];
                    for (const s of iSelectors) {
                        try {
                            const el = document.querySelector(s);
                            if (el) {
                                const r = el.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0) {
                                    return {
                                        x: Math.round(r.left + 24),
                                        y: Math.round(r.top + r.height / 2),
                                        w: Math.round(r.width), h: Math.round(r.height),
                                        method: 'iframe:' + s
                                    };
                                }
                            }
                        } catch(e) {}
                    }

                    return null;
                })()`,
                returnByValue: true
            });
            if (result && result.value) return result.value;
        } catch(e) {}

        // ── Strategy B: CDP DOM.performSearch (pierce shadow roots) ────────────
        // CDP DOM.performSearch operates at the C++ layer — it can find nodes
        // inside closed shadow roots that JavaScript cannot reach.
        try {
            await cdpSend(tabId, 'DOM.enable');
            for (const q of [
                'iframe[id*="cf-chl-widget"]',
                'iframe[src*="challenges"]',
                'iframe[allow*="cross-origin-isolated"]',
                'iframe'
            ]) {
                try {
                    const { searchId, resultCount } = await cdpSend(tabId, 'DOM.performSearch', {
                        query: q, includeUserAgentShadowDom: true
                    });
                    if (!resultCount) continue;
                    const { nodeIds } = await cdpSend(tabId, 'DOM.getSearchResults', {
                        searchId, fromIndex: 0, toIndex: 1
                    });
                    if (!nodeIds || !nodeIds[0]) continue;
                    const { model } = await cdpSend(tabId, 'DOM.getBoxModel', { nodeId: nodeIds[0] });
                    if (!model || !model.content) continue;
                    const [x0, y0, x1, , , y1] = model.content;
                    const w = x1 - x0, h = y1 - y0;
                    if (w > 0 && h > 0) {
                        return { x: Math.round(x0 + 24), y: Math.round((y0 + y1) / 2), w: Math.round(w), h: Math.round(h), method: 'DOM.performSearch:' + q };
                    }
                } catch(e) {}
            }
        } catch(e) {}

        // ── Strategy C: CDP DOM.getDocument pierce + manual tree search ────────
        try {
            const { root } = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
            const search = (node) => {
                if (!node) return null;
                const id = (node.attributes || []).join(' ');
                const src = node.attributes ? node.attributes[node.attributes.indexOf('src') + 1] || '' : '';
                if (node.nodeName === 'IFRAME' && (id.includes('cf-chl') || src.includes('challenges'))) {
                    return node.nodeId;
                }
                for (const child of (node.children || []).concat(node.shadowRoots || [])) {
                    const found = search(child);
                    if (found) return found;
                }
                return null;
            };
            const nodeId = search(root);
            if (nodeId) {
                const { model } = await cdpSend(tabId, 'DOM.getBoxModel', { nodeId });
                if (model && model.content) {
                    const [x0, y0, x1, , , y1] = model.content;
                    const w = x1 - x0, h = y1 - y0;
                    if (w > 0 && h > 0) {
                        return { x: Math.round(x0 + 24), y: Math.round((y0 + y1) / 2), w: Math.round(w), h: Math.round(h), method: 'DOM.getDocument.pierce' };
                    }
                }
            }
        } catch(e) {}

        if (attempt < 9) await sleep(2000);
    }

    // ── Strategy D: Viewport estimation (guaranteed fallback) ─────────────────
    // Cloudflare's challenge page always places the widget at ~35-40% down,
    // centred horizontally. This clicks the left quarter (checkbox area).
    try {
        const { result } = await cdpSend(tabId, 'Runtime.evaluate', {
            expression: '({ w: window.innerWidth, h: window.innerHeight })',
            returnByValue: true
        });
        const vp = (result && result.value) || { w: 1280, h: 720 };
        return {
            x: Math.round(vp.w / 2 - 125),
            y: Math.round(vp.h * 0.36),
            w: 300, h: 65,
            method: 'viewport-estimate'
        };
    } catch(e) {}

    return null;
}

// ── Human-like mouse path + trusted click via CDP ─────────────────────────────
async function cdpHumanClick(tabId, targetX, targetY) {
    const path = [
        { x: targetX - 140, y: targetY - 55 },
        { x: targetX - 100, y: targetY - 35 },
        { x: targetX - 65,  y: targetY - 18 },
        { x: targetX - 30,  y: targetY - 7  },
        { x: targetX - 5,   y: targetY - 1  },
        { x: targetX,       y: targetY       }
    ];
    for (const { x, y } of path) {
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
        await sleep(30 + Math.floor(Math.random() * 50));
    }
    await sleep(70 + Math.floor(Math.random() * 50));
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: targetX, y: targetY, button: 'left', buttons: 1, clickCount: 1
    });
    await sleep(80 + Math.floor(Math.random() * 40));
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: targetX, y: targetY, button: 'left', buttons: 0, clickCount: 1
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === "activate") {
        chrome.storage.local.set({ __act: request.status }).then(() => {
            chrome.tabs.query({}, tabs => tabs.forEach(tab =>
                chrome.tabs.sendMessage(tab.id, { action: "activate", status: request.status }).catch(() => {})
            ));
            connectedPorts.forEach(p => { try { p.postMessage({ action: "activate", status: request.status }); } catch(e) {} });
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === "openPopup") {
        chrome.action.openPopup().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // ── Main CDP Turnstile clicker ────────────────────────────────────────────
    if (request.action === "attemptTurnstileClickCDP") {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false, reason: "no tabId" }); return true; }

        (async () => {
            let attached = false;
            try {
                await new Promise((resolve, reject) => {
                    chrome.debugger.attach({ tabId }, '1.3', () => {
                        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                        else resolve();
                    });
                });
                attached = true;
                await sleep(500);

                const pos = await findTurnstilePosition(tabId);
                if (!pos) { sendResponse({ ok: false, reason: 'all 4 strategies failed' }); return; }

                await cdpHumanClick(tabId, pos.x, pos.y);
                sendResponse({ ok: true, clicked: true, pos });

            } catch(err) {
                sendResponse({ ok: false, error: String(err.message || err) });
            } finally {
                if (attached) chrome.debugger.detach({ tabId }, () => {});
            }
        })();
        return true;
    }

    // ── Fallback: allFrames scripting (non-trusted, best-effort) ─────────────
    if (request.action === "attemptTurnstileClick") {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!tabId) { sendResponse({ ok: false }); return true; }

        (async () => {
            let clicked = false;
            for (let i = 0; i < 3 && !clicked; i++) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId, allFrames: true },
                        func: () => {
                            for (const s of ['input[type="checkbox"]', '.ctp-checkbox-label', 'label', 'input']) {
                                const el = document.querySelector(s);
                                if (el) { try { el.click(); return true; } catch(e) {} }
                            }
                            return false;
                        }
                    });
                    clicked = results && results.some(r => r && r.result === true);
                } catch(e) {}
                if (!clicked) await sleep(1000);
            }
            sendResponse({ ok: true, clicked });
        })();
        return true;
    }

    // ── Chrome notification ───────────────────────────────────────────────────
    if (request.action === "showCFNotification") {
        const type = request.notifType || 'CHALLENGE';
        let title, message, requireInteraction = false;

        if (type === 'EXCEEDED_LIMIT') {
            title   = '⛔ FalconPath — Embassy Rate Limit Reached';
            message = 'The scheduling site has blocked this account for ~12 hours.\n' +
                      'Come back at: ' + (request.blockedUntil || '12 hours from now') + '\n' +
                      'Do NOT restart the extension or log in/out until then.';
            requireInteraction = true; // stays until dismissed
        } else if (type === 'WAITING_ROOM') {
            title   = 'FalconPath — In Cloudflare Queue';
            message = 'Extension paused. Will resume automatically when access is granted.';
        } else {
            title   = 'FalconPath — CAPTCHA Required';
            message = 'Please click "Verify you are human". Scanning resumes automatically.';
            requireInteraction = true;
        }

        chrome.notifications.create('fp-notif-' + Date.now(), {
            type: 'basic', iconUrl: 'icon128.png',
            title, message, priority: 2, requireInteraction
        }, () => sendResponse({ ok: true }));
        return true;
    }

    return false;
});
