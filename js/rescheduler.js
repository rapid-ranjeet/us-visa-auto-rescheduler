document.head.insertAdjacentHTML("beforeend", "<style>.swal2-modal :is(h2, p){color: initial; margin: 0;line-height: 1.25;}.swal2-modal p+p{margin-top: 1rem;}#consulate_date_time,#asc_date_time{display:block!important;}.swal2-select{width:auto!important;}.swal2-timer-progress-bar{background:rgba(255,255,255,0.6)!important;}.swal2-toast.swal2-show{background:rgba(0,0,0,0.75)!important;}</style>");
const toast = async (e, t = "#8b5cf6") => {
    let a = await getCheckFrequencyMs() || 59e3;
    Toastify({
        text: e,
        duration: a + 3e3,
        close: !0,
        gravity: "top",
        position: "left",
        stopOnFocus: !0,
        style: {
            background: t
        },
        onClick: function() {}
    }).showToast()
};
let schedulingPageHandled = !1,
    dateCheckInterval = null,
    isProcessing = !1,
    preferredDate = null,
    preferredDateId = null,
    isSchedulerActive = !1,
    cookieMonitorInitialized = !1;
async function checkStatusActivate() {
    try {
        // Priority 0: Check if a previous "exceeded limit" block is still active
        if (await checkExceededLimitBlock()) return;

        // Priority 1: Detect "exceeded limit" on current page (with 2s confirm)
        if (getExceededLimitPage()) {
            await new Promise(r => setTimeout(r, 2000));
            if (getExceededLimitPage()) { await handleExceededLimit(); return; }
        }

        // Priority 2: Cloudflare challenge/waiting room
        const cfPage = getCloudflarePage();
        // Priority 3: Generic CGI server error page at startup
        if (!cfPage && getServerErrorPage()) {
            setTimeout(() => triggerLevel1Recovery(), 2000);
            return;
        }
        if (cfPage) { await handleCloudflarePage(cfPage); return; }
        let {
            fp_act: e
        } = await chrome.storage.local.get("fp_act");
        (isSchedulerActive = e || !1) ? initializeSchedulingPage(): toast("FalconPath Visa Assistant is disabled")
    } catch (t) {
        isSchedulerActive = !1
    }
}
// ======== MULTI-CITY LOCATION SETUP ========
// Auto-detects every location the site offers on the OFC / Consular scheduling
// pages, storing them so both the popup and the on-page setup modal can offer
// them. Also detects the *other* type's locations in the background (a plain
// fetch of that page's HTML — no navigation, no visible reload) so the person
// never has to physically visit both pages just to configure both lists.
// Note: OFC and Consular locations use different underlying IDs even when the
// name looks similar (e.g. "CHENNAI VAC" vs "CHENNAI"), so the two lists are
// always detected independently rather than one being copied into the other.

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));
}

const PENDING_PREFIX = "__pending__:";

function isPendingCityId(id) {
    return typeof id === "string" && id.startsWith(PENDING_PREFIX);
}

function normalizeCityName(name) {
    return String(name || "").toUpperCase().replace(/\bVAC\b/g, "").replace(/[^A-Z]/g, "");
}

// Relates two location names regardless of exactly how each page phrases
// them — e.g. "Chennai VAC" (OFC) and "Chennai" or "U.S. Consulate Chennai"
// (Consular) should all be recognized as the same city. Exact match first,
// then falls back to one name containing the other after normalizing.
function cityNamesMatch(a, b) {
    let na = normalizeCityName(a), nb = normalizeCityName(b);
    if (!na || !nb) return !1;
    return na === nb || na.includes(nb) || nb.includes(na);
}

function stripVacSuffix(name) {
    return String(name || "").replace(/\bVAC\b/gi, "").replace(/\s+/g, " ").trim();
}

// The moment a page's REAL location list is detected, immediately seed the
// *other* type's checklist with the same names if it hasn't been detected
// yet — so both lists show right away, without an extra network request that
// the site's bot protection could flag. OFC labels end in "VAC" (that's the
// real OFC naming); Consular locations aren't, so that suffix is stripped
// when borrowing an OFC name for the Consular list.
async function seedProvisionalSiblingList(sourceKind, sourceRealMap) {
    const siblingKey = sourceKind === "ofc" ? "fp_consularCities" : "fp_ofcCities";
    let existing = await chrome.storage.local.get([siblingKey]);
    if (existing[siblingKey] && Object.keys(existing[siblingKey]).length) return;
    let provisional = {};
    Object.entries(sourceRealMap).forEach(([id, name]) => {
        provisional[PENDING_PREFIX + id] = siblingKey === "fp_consularCities" ? stripVacSuffix(name) : name;
    });
    if (Object.keys(provisional).length) {
        await chrome.storage.local.set({
            [siblingKey]: provisional
        });
    }
}

// One-time cleanup for anyone who already has provisional Consular entries
// stored from before this fix — strips any leftover "VAC" text so the
// Consular section only ever shows plain city names.
async function cleanupConsularVacLabels() {
    let stored = await chrome.storage.local.get(["fp_consularCities"]);
    let cities = stored.fp_consularCities;
    if (!cities || !Object.keys(cities).length) return;
    let changed = !1, cleaned = {};
    Object.entries(cities).forEach(([id, name]) => {
        let stripped = stripVacSuffix(name);
        if (stripped !== name) changed = !0;
        cleaned[id] = stripped || name;
    });
    if (changed) await chrome.storage.local.set({
        fp_consularCities: cleaned
    });
}

// Whenever a REAL list for `kind` is stored (replacing whatever was there
// before, provisional or not), reconcile that same type's selected-cities
// array: any previously "unconfirmed" picks get swapped for their real ID by
// matching names, and anything that can't be matched is dropped with a toast
// rather than silently left pointing at a made-up ID.
async function reconcilePendingSelections(kind, oldMap, newRealMap) {
    const selectedKey = kind === "ofc" ? "fp_ofcSelectedCities" : "fp_consularSelectedCities";
    let stored = await chrome.storage.local.get([selectedKey]);
    let selected = Array.isArray(stored[selectedKey]) ? stored[selectedKey] : [];
    if (!selected.some(isPendingCityId)) return;

    let realEntries = Object.entries(newRealMap);

    let upgraded = [], dropped = [];
    selected.forEach(id => {
        if (!isPendingCityId(id)) {
            if (!upgraded.includes(id)) upgraded.push(id);
            return;
        }
        let label = oldMap[id],
            found = label && realEntries.find(([, realName]) => cityNamesMatch(label, realName));
        if (found) {
            if (!upgraded.includes(found[0])) upgraded.push(found[0]);
        } else dropped.push(label || id);
    });

    await chrome.storage.local.set({
        [selectedKey]: upgraded
    });
    if (dropped.length) {
        toast(`Couldn't confirm a matching ${kind === "ofc" ? "OFC" : "Consular"} location for: ${dropped.join(", ")}. Please re-check it in the extension popup if it's still needed.`, "#dc3545");
    }
}

async function migrateLegacyCitySelection() {
    let existing = await chrome.storage.local.get(["fp_ofcSelectedCities", "fp_consularSelectedCities", "fp_cty", "fp_ofcCities", "fp_consularCities"]);
    if (!Array.isArray(existing.fp_ofcSelectedCities)) {
        let seed = (existing.fp_cty && existing.fp_ofcCities && existing.fp_ofcCities[existing.fp_cty]) ? [existing.fp_cty] : [];
        await chrome.storage.local.set({
            fp_ofcSelectedCities: seed
        });
    }
    if (!Array.isArray(existing.fp_consularSelectedCities)) {
        let seed = (existing.fp_cty && existing.fp_consularCities && existing.fp_consularCities[existing.fp_cty]) ? [existing.fp_cty] : [];
        await chrome.storage.local.set({
            fp_consularSelectedCities: seed
        });
    }
}

// A single on-page modal: OFC checklist + Consular checklist + date range,
// all in one place, submitted once via "Start Checking". Non-dismissible —
// it's a required one-time setup step, not an optional prompt.
async function showLocationSetupModal() {
    let stored = await chrome.storage.local.get(["fp_ofcCities", "fp_consularCities", "fp_st", "fp_en"]),
        ofcCities = stored.fp_ofcCities || {},
        consularCities = stored.fp_consularCities || {},
        ofcIds = Object.keys(ofcCities),
        consularIds = Object.keys(consularCities);

    function buildChecklist(prefix, cities, ids) {
        if (!ids.length) return `<div style="padding:8px 4px;color:#94a3b8;font-size:12px;">Not detected yet — you can add these later from the extension popup once this list loads.</div>`;
        return ids.sort((a, b) => cities[a].localeCompare(cities[b])).map(cid => `
            <div style="display:flex;align-items:center;gap:8px;padding:7px 4px;">
                <input type="checkbox" id="setup_${prefix}_${escapeHtml(cid)}" style="width:15px;height:15px;margin:0;accent-color:#8b5cf6;cursor:pointer;flex-shrink:0;">
                <label for="setup_${prefix}_${escapeHtml(cid)}" style="font-size:14.5px;line-height:15px;color:#f1f5f9;cursor:pointer;">${escapeHtml(cities[cid])}</label>
            </div>`).join("");
    }

    const html = `
        <div style="text-align:left;">
            <p style="margin:0 0 12px;color:#94a3b8;font-size:13px;">Choose the locations to monitor and your date range, then start checking.</p>
            <div style="font-weight:700;color:#22d3ee;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">OFC / Biometric Locations</div>
            <div style="background:rgba(15,15,35,0.7);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:6px;margin-bottom:14px;">${buildChecklist("ofc", ofcCities, ofcIds)}</div>
            <div style="font-weight:700;color:#22d3ee;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Consular Locations</div>
            <div style="background:rgba(15,15,35,0.7);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:6px;margin-bottom:14px;">${buildChecklist("consular", consularCities, consularIds)}</div>
            <div style="display:flex;gap:10px;">
                <div style="flex:1;">
                    <label style="display:block;font-size:11px;color:#64748b;margin-bottom:4px;">EARLIEST DATE</label>
                    <input type="date" id="setup_start_date" value="${escapeHtml(stored.fp_st || "")}" style="width:100%;padding:8px;background:rgba(15,15,35,0.7);border:1px solid rgba(139,92,246,0.2);border-radius:8px;color:#f1f5f9;box-sizing:border-box;">
                </div>
                <div style="flex:1;">
                    <label style="display:block;font-size:11px;color:#64748b;margin-bottom:4px;">LATEST DATE</label>
                    <input type="date" id="setup_end_date" value="${escapeHtml(stored.fp_en || "")}" style="width:100%;padding:8px;background:rgba(15,15,35,0.7);border:1px solid rgba(139,92,246,0.2);border-radius:8px;color:#f1f5f9;box-sizing:border-box;">
                </div>
            </div>
        </div>`;

    let result = await Swal.fire({
        title: "Set Up Locations & Dates",
        html,
        width: 480,
        allowEscapeKey: !1,
        allowOutsideClick: !1,
        allowEnterKey: !1,
        confirmButtonText: "Start Checking",
        focusConfirm: !1,
        preConfirm() {
            let ofcSelected = ofcIds.filter(id => document.getElementById(`setup_ofc_${id}`)?.checked),
                consularSelected = consularIds.filter(id => document.getElementById(`setup_consular_${id}`)?.checked),
                start = document.getElementById("setup_start_date").value,
                end = document.getElementById("setup_end_date").value;
            if (!ofcSelected.length && !consularSelected.length) return Swal.showValidationMessage("Select at least one location."), !1;
            if (!start || !end) return Swal.showValidationMessage("Please set both an earliest and latest date."), !1;
            if (new Date(start) > new Date(end)) return Swal.showValidationMessage("Earliest date must be before the latest date."), !1;
            return {
                ofcSelected,
                consularSelected,
                start,
                end
            }
        }
    });

    if (result.isConfirmed && result.value) {
        await chrome.storage.local.set({
            fp_ofcSelectedCities: result.value.ofcSelected,
            fp_consularSelectedCities: result.value.consularSelected,
            fp_st: result.value.start,
            fp_en: result.value.end
        });
        toast("Locations and dates saved. Starting checks...");
    }
}

// Called once when a scheduling page is reached. Detects locations for the
// current page type, seeds the other type's checklist with the same names
// (unconfirmed) if it's still empty, reconciles any previously-unconfirmed
// picks now that real data exists, migrates any legacy single-city setting,
// and — only if nothing is configured yet — blocks on the setup modal above
// until the person submits it. Never returns false / bails the caller;
// scanning always proceeds right after this resolves, no page refresh ever.
async function ensureConfiguredBeforeScanning(kind) {
    const citiesKey = kind === "ofc" ? "fp_ofcCities" : "fp_consularCities";

    await cleanupConsularVacLabels();

    let selectEl = null, waited = 0;
    while (waited < 10 && !(selectEl = document.querySelector("#post_select"))) {
        await new Promise(r => setTimeout(r, 500));
        waited++;
    }
    if (selectEl) {
        const detected = {};
        selectEl.querySelectorAll("option").forEach(opt => {
            if (opt.value && opt.innerText) detected[opt.value] = opt.innerText.trim();
        });
        if (Object.keys(detected).length) {
            let previous = await chrome.storage.local.get([citiesKey]);
            await chrome.storage.local.set({
                [citiesKey]: detected
            });
            await reconcilePendingSelections(kind, previous[citiesKey] || {}, detected);
            await seedProvisionalSiblingList(kind, detected);
        }
    }

    await migrateLegacyCitySelection();

    let cfg = await chrome.storage.local.get(["fp_ofcSelectedCities", "fp_consularSelectedCities", "fp_st", "fp_en"]),
        hasCity = (Array.isArray(cfg.fp_ofcSelectedCities) && cfg.fp_ofcSelectedCities.length) ||
        (Array.isArray(cfg.fp_consularSelectedCities) && cfg.fp_consularSelectedCities.length);
    if (hasCity && cfg.fp_st && cfg.fp_en) return;

    await showLocationSetupModal();
}

async function initializeSchedulingPage() {
    // Install mid-session CF page watcher (title MutationObserver)
    initCFPageWatcher();
    // Register alert() intercept listener for PSE0501 server errors
    setupAlertInterceptListener();
    // Bail out immediately if "exceeded limit" block is still active
    if (await checkExceededLimitBlock()) return;
    if (getExceededLimitPage()) {
        await new Promise(r => setTimeout(r, 2000));
        if (getExceededLimitPage()) { await handleExceededLimit(); return; }
    }
    let e = window.location.pathname + window.location.search;
    if (e.includes("/Account/Login/ExternalAuthenticationFailed")) {
        toast("FalconPath Visa Assistant - trying to login again..."), await new Promise(e => setTimeout(e, 4e3)), window.location.href = "https://www.usvisascheduling.com/";
        return
    }
    // Detect Cloudflare blocking pages before doing anything
    const cfPageCheck = getCloudflarePage();
    if (cfPageCheck) { await handleCloudflarePage(cfPageCheck); return; }
    try {
        if (!isSchedulerActive) return;
        if (dateCheckInterval && (clearInterval(dateCheckInterval), dateCheckInterval = null), window.location.href.includes("usvisascheduling.com/") && !window.location.href.includes("/en-US/")) {
            let t = window.location.href.replace(/\/[a-z]{2}-[A-Z]{2}\//, "/en-US/");
            window.location.replace(t);
            return
        }
        if (window.location.href.includes("appointment-confirmation")) {
            let a = [...document.querySelectorAll("h2.section-title")].find(e => e.textContent.includes("CONSULAR APPOINTMENT DETAILS"));
            if (!a) return console.warn("Consular appointment section not found."), null;
            let r = a.nextElementSibling.querySelectorAll("table")[1],
                o = r.querySelectorAll("tr"),
                n = null;
            if (o.forEach(e => {
                    let t = e.querySelector("td:first-child"),
                        a = e.querySelector("td:last-child");
                    if (t && a) {
                        let r = t.textContent.trim().replace(/:$/, "");
                        if (a.textContent.trim(), r.includes("Consular Appointment Date")) {
                            let o = Array.from(e.querySelectorAll("td")),
                                i = o[o.length - 1];
                            i && (n = i.textContent.trim())
                        }
                    }
                }), n) {
                let i = new Date(n);
                await chrome.storage.local.set({
                    fp_ad: i.toISOString().split("T")[0]
                }), await chrome.storage.local.set({
                    fp_en: i.toISOString().split("T")[0]
                }), await chrome.storage.local.set({
                    dateSelectionInProgress: !1
                }), toast("FalconPath Visa Assistant - Appointment confirmed successfully")
                // Phase 2: DOM-booking path also reports to the local controller
                try {
                    chrome.storage.local.get("fp_account").then(({ fp_account: acct }) =>
                        fetch("http://127.0.0.1:8765/event", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ kind: "BOOKED", account: acct || "unknown", text: `confirmed page: ${n}` })
                        }).catch(() => {})
                    );
                } catch (e) {}
            }
            await chrome.storage.local.set({
                dateSelectionInProgress: !1
            }), window.location.href = "https://www.usvisascheduling.com/en-US/"
        }
        if (window.location.href.match(/usvisascheduling\.com\/en-US\/?$/)) {
            await new Promise(e => setTimeout(e, 2e3));
            let l, s;
            if (document.getElementById("appointment-card") && (s = document.getElementById("appointment-card").innerText), s) {
                let c = s.match(/([A-Za-z]+ \d{2}, \d{4} \d{2}:\d{2} [AP]M)/);
                c ? l = new Date(c[0]) : (console.error("Invalid date format in currentDate"), l = new Date)
            } else {
                let d = new Date;
                (l = new Date).setFullYear(d.getFullYear() + 3)
            }
            await chrome.storage.local.set({
                fp_ad: l.getFullYear() + "-" + (l.getMonth() + 1 + "").padStart(2, 0) + "-" + (l.getDate() + "").padStart(2, 0)
            });
            let u = await chrome.storage.local.get(["fp_st"]).then(({
                    fp_st: e
                }) => e),
                p = await chrome.storage.local.get(["fp_en"]).then(({
                    fp_en: e
                }) => e);
            u || p || await chrome.storage.local.set({
                fp_st: new Date().toISOString().split("T")[0],
                fp_en: l.getFullYear() + "-" + (l.getMonth() + 1 + "").padStart(2, 0) + "-" + (l.getDate() + "").padStart(2, 0)
            }), p && new Date(p) > l && await chrome.storage.local.set({
                fp_en: l.getFullYear() + "-" + (l.getMonth() + 1 + "").padStart(2, 0) + "-" + (l.getDate() + "").padStart(2, 0)
            });
            // ── Smart home-page navigation ──────────────────────────────────────
            // Uses link.href (DOM property = fully-resolved absolute URL) instead
            // of getAttribute("href") which returns the raw relative string.
            // This eliminates the double /en-US/en-US/ bug entirely.
            toast("FalconPath Visa Assistant — finding scheduling link...", "#8b5cf6");
            (async () => {
                const sanitizeNav = (url) => url.replace(/\/en-US\/en-US\//gi, "/en-US/");

                // Poll for sidebar links to appear (up to 10 seconds)
                for (let _try = 0; _try < 10; _try++) {
                    await new Promise(r => setTimeout(r, 1000));

                    // Case 1: Account with existing appointment → Reschedule Appointment
                    const rescheduleEl = document.getElementById("reschedule_appointment");
                    if (rescheduleEl && rescheduleEl.href) {
                        const dest = sanitizeNav(rescheduleEl.href); // absolute URL from DOM
                        toast("Existing appointment detected — navigating to reschedule page...", "#22c55e");
                        await new Promise(r => setTimeout(r, 400));
                        window.location.replace(dest);
                        return;
                    }

                    // Case 2: Fresh account → Schedule Appointment
                    const freshEl = document.getElementById("continue_application") ||
                                    document.querySelector("a[href*='/ofc-schedule/']") ||
                                    document.querySelector("a[href*='/schedule-consular']") ||
                                    document.querySelector("a[href*='/schedule/']");
                    if (freshEl && freshEl.href) {
                        const dest = sanitizeNav(freshEl.href); // absolute URL from DOM
                        toast("Fresh account — navigating to scheduling page...", "#22c55e");
                        await new Promise(r => setTimeout(r, 400));
                        window.location.replace(dest);
                        return;
                    }
                }
                toast("Could not find scheduling link — please click 'Schedule Appointment' or 'Reschedule Appointment' in the sidebar manually.", "#f59e0b");
            })();
            return
        }
        if (window.location.href.includes("/ofc-schedule")) {
            await ensureConfiguredBeforeScanning("ofc");

            // FIX: Extract page data and start immediately — don't rely on DOM mutation.
            // The MutationObserver alone was causing a delay because the page DOM was
            // already stable by the time the observer registered. Opening DevTools
            // accidentally triggered it via DevTools DOM mutations. Now we try right away.
            const tryStartOFC = async () => {
                if (schedulingPageHandled) return;
                let e = await extractPageData();
                if (e && e.primaryId && e.contactId) {
                    schedulingPageHandled = !0;
                    await chrome.storage.local.set(e);
                    let t = initializeCookieMonitor();
                    try { await fetchOFCDates(e, t) }
                    catch (a) { console.error("Failed to fetch available OFC dates:", a) }
                }
            };

            // Keep observer as fallback for SPA-style late DOM updates
            let S = new MutationObserver(tryStartOFC);
            S.observe(document.body, { childList: !0, subtree: !0, attributes: !0 });

            // Try immediately (most of the time this works without waiting for mutations)
            await tryStartOFC();
            return
        }
        if (!window.location.href.includes("usvisascheduling.com/en-US")) return;
        if (window.location.href.includes("/schedule") && !window.location.href.includes("/ofc-schedule")) {
            await ensureConfiguredBeforeScanning("consular");
        }
        // FIX: Same immediate-start fix for Consular page
        const tryStartConsular = async () => {
            if (schedulingPageHandled) return;
            let e = await extractPageData();
            if (e && e.primaryId && e.contactId) {
                schedulingPageHandled = !0;
                await chrome.storage.local.set(e);
                let t = initializeCookieMonitor();
                try { await fetchOFCDates(e, t) }
                catch (a) { console.error("Failed to fetch available Consular dates:", a) }
            }
        };

        let C = new MutationObserver(tryStartConsular);
        C.observe(document.body, { childList: !0, subtree: !0, attributes: !0 });

        // Try immediately — no DevTools needed
        await tryStartConsular()
    } catch (_) {
        if (console.error("Error initializing scheduling page:", _), console.error("Error stack:", _.stack), document.querySelector("span[data-translate='error']")) {
            toast("Error dates not found trying again...", "#dc3545"), await new Promise(e => setTimeout(e, 4e4)), window.location.replace(window.location.href);
            return
        }
    }
}
async function fetchOFCDates(e, t) {
    try {
        isProcessing = !0, await checkDates(e, t)
    } catch (a) {
        if (console.error("Error in fetchOFCDates:", a), console.error("Error stack:", a.stack), isSchedulerActive) {
            let r = await getCheckFrequencyMs();
            setTimeout(() => fetchOFCDates(e, t), r)
        }
    } finally {
        isProcessing = !1
    }
}
async function checkDates(e, t) {
    try {
        if (!e || !e.primaryId || !e.contactId) {
            console.error("Invalid page data - sequential check");
            return
        }
        await chrome.storage.local.set({
            fp_appid: e.primaryId
        });
        try {
            await fetchFamilyMembers(e.primaryId, e.contactId, t)
        } catch (a) {
            console.error("Error fetching family members:", a)
        }
        await new Promise(e => setTimeout(e, 2e3));
        let isOFC = window.location.pathname.includes("/ofc-schedule"),
            baseData = {
                primaryId: e.primaryId,
                contactId: e.contactId
            };
        await runCityScanLoop(baseData, t, isOFC)
    } catch (n) {
        console.error("Error in consular location checking:", n)
    }
}

// Cycles through the selected cities (OFC or Consular) one at a time,
// ascending through the list on each tick, waiting a full frequency interval
// plus a small random jitter between EVERY individual city check — not just
// between full passes — so requests stay spaced out and don't burst. Storage
// is re-read on every tick, so a location added/removed from the popup takes
// effect on the very next check with no page refresh. If nothing is selected
// yet, it polls every couple of seconds and resumes the moment a location is
// picked, rather than exiting and requiring a refresh to restart.
async function runCityScanLoop(baseData, cookieMonitor, isOFC) {
    const citiesKey = isOFC ? "fp_ofcCities" : "fp_consularCities",
        selectedKey = isOFC ? "fp_ofcSelectedCities" : "fp_consularSelectedCities",
        typeLabel = isOFC ? "OFC" : "Consular";
    let notifiedEmpty = !1, cityIndex = 0, consecutiveFailures = 0;
    startSyncInterval();
    startCFKeepalive();
    while (isSchedulerActive) {
        // ── Priority 1: Embassy rate limit ("You have exceeded the limit") ────
        // Confirm with a 2s delay to avoid false-positives on brief page transitions
        if (getExceededLimitPage()) {
            await new Promise(r => setTimeout(r, 2000));
            if (getExceededLimitPage()) { await handleExceededLimit(); return; }
        }

        // ── Priority 2: Cloudflare challenge or waiting room ─────────────────
        const cfLoopPage = getCloudflarePage();
        if (cfLoopPage) { await handleCloudflarePage(cfLoopPage); return; }

        // ── Priority 3: CGI generic server error page ─────────────────────────
        const serverErrPage = getServerErrorPage();
        if (serverErrPage) {
            toast('Server error page detected — triggering session refresh...', '#dc3545');
            await triggerLevel1Recovery();
            return;
        }

        let stored = await chrome.storage.local.get([citiesKey, selectedKey]),
            allCities = stored[citiesKey] || {},
            selectedAll = Array.isArray(stored[selectedKey]) ? stored[selectedKey] : [],
            selected = selectedAll.filter(id => !isPendingCityId(id));

        if (!selected.length) {
            if (!notifiedEmpty) {
                let msg = selectedAll.length ? `Waiting to detect ${typeLabel} locations. Visit the ${typeLabel} scheduling page once to activate your selected picks.` : `No ${typeLabel} locations selected. Choose locations in the extension popup.`;
                toast(msg, "#dc3545");
                if (!selectedAll.length) chrome.runtime.sendMessage({
                    action: "openPopup"
                }, e => {
                    chrome.runtime.lastError && console.error("Error opening popup:", chrome.runtime.lastError)
                });
                notifiedEmpty = !0
            }
            await new Promise(r => setTimeout(r, 2000));
            continue
        }
        notifiedEmpty = !1;

        if (!isSchedulerActive) return;
        if (await validateToContinue()) return;

        if (cityIndex >= selected.length) cityIndex = 0;
        let postId = selected[cityIndex],
            cityData = {
                ...baseData,
                postId,
                cityName: allCities[postId] || "Unknown"
            }, result = {
                matched: !1,
                status: null
            };
        try {
            result = isOFC ? await checkOFCCityDates(cityData, cookieMonitor) : await checkConsularCityDates(cityData, cookieMonitor)
        } catch (err) {
            console.error(`Scan error for ${cityData.cityName}:`, err);
            result = {
                matched: !1,
                status: (err && err.status) || null
            }
        }

        // Credits removed with backend: no local deduction, no server call.

        if (result.matched) return;

        cityIndex = (cityIndex + 1) % selected.length;

        let baseDelay = await getCheckFrequencyMs(),
            jitter = Math.floor(5000 * Math.random());

        // Any non-200 response backs off exponentially instead of retrying
        // quickly or reloading — reloading on error is what caused the
        // rate-limit ban in the first place (a reload pulls the whole page
        // again, multiplying request volume right when the site is already
        // unhappy). A clean response resets the backoff immediately.
        if (result.status && result.status !== 200) {
            consecutiveFailures++;
            let backoff = Math.min(baseDelay * Math.pow(2, consecutiveFailures), 5 * 60 * 1000);
            await toast(`${typeLabel} check for ${cityData.cityName} returned an error (status ${result.status}). Pausing ~${Math.round(backoff / 1000)}s to avoid a rate limit...`, "#dc3545");
            await new Promise(r => setTimeout(r, backoff))
        } else {
            consecutiveFailures = 0;
            await new Promise(r => setTimeout(r, baseDelay + jitter))
        }
    }
}

// Single-shot Consular (main interview) date check for one city. Returns
// true if a matching date was found (and the booking flow was started),
// false if no match this round.
async function checkConsularCityDates(e, t) {
    let r = await chrome.storage.local.get(["fp_ad"]).then(({
        fp_ad: e
    }) => e);
    try {
        let o = await chrome.storage.local.get(["fp_st"]).then(({
                fp_st: e
            }) => e),
            n = await chrome.storage.local.get(["fp_en"]).then(({
                fp_en: e
            }) => e);
        if (!o || !n) {
            toast("Date range not set for date check. Please configure dates in the extension popup."), chrome.runtime.sendMessage({
                action: "openPopup"
            }, e => {
                chrome.runtime.lastError && console.error("Error opening popup:", chrome.runtime.lastError)
            });
            return {
                matched: !1,
                status: null
            }
        }
        let i = window.location.href.includes("reschedule=true"),
            l = [e.primaryId];
        try {
            let s = await chrome.storage.local.get(["applications"]);
            s.applications && Array.isArray(s.applications) && s.applications.length > 0 && (l = s.applications)
        } catch (c) {
            console.error("Error getting application IDs from storage:", c)
        }
        let d = new URLSearchParams;
        d.append("parameters", JSON.stringify({
            primaryId: e.primaryId,
            applications: l,
            scheduleDayId: "",
            scheduleEntryId: "",
            postId: e.postId,
            isReschedule: i ? "true" : "false"
        }));
        // --- Try portal-native first (site's own XHR via dropdown trigger) ---
        let pnConsular = await checkDatesPortalNative(e);
        if (pnConsular.cfStatus !== null) onCFFailure(pnConsular.cfStatus);
        let g = pnConsular.data;
        if (!g) {
            // Portal-native unavailable or timed out — fall back to direct fetch
            let u = Date.now(),
                cleanCid = (e.contactId || "").trim(),
                p = `https://www.usvisascheduling.com/en-US/custom-actions/?route=/api/v1/schedule-group/get-family-consular-schedule-days&appd=${cleanCid}&cacheString=${u}`,
                h = await fetch(p, {
                    method: "POST",
                    headers: {
                        accept: "application/json, text/javascript, */*; q=0.01",
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "x-requested-with": "XMLHttpRequest",
                        cookie: t.getCookieHeader()
                    },
                    body: d,
                    credentials: "include"
                });
            if (!h.ok) {
                let httpErr = Error(`HTTP error! status: ${h.status}`);
                if (h.status === 403) onCFFailure(403);
                throw httpErr.status = h.status, httpErr
            }
            g = await h.json();
        }
        if (g) onCFSuccess();
        if (g.ScheduleDays && g.ScheduleDays.length > 0) {
            let f = g.ScheduleDays.sort((e, t) => new Date(e.Date) - new Date(t.Date));
            for (let y of f) {
                let m = y.Date,
                    [$, S, k] = m.split("-").map(Number),
                    // FIX Bug #2: Compare all dates in UTC to avoid IST +5:30 timezone
                    // skipping valid slots. new Date("YYYY-MM-DD") = UTC midnight;
                    // new Date(y,m,d) = LOCAL midnight — they don't compare correctly.
                    bUTC = Date.UTC($, S - 1, k),
                    startUTC = new Date(o + "T00:00:00Z").getTime(),
                    endUTC = new Date(n + "T00:00:00Z").getTime(),
                    b = new Date(bUTC),
                    I = y.ID,
                    _ = bUTC >= startUTC && bUTC <= endUTC;
                if (_) {
                    await chrome.storage.local.set({ dateSelectionInProgress: !0 });
                    preferredDate = b;
                    preferredDateId = I;
                    const dateStr_c = b.toISOString().split("T")[0];
                    await chrome.storage.local.set({
                        preferredDateString: dateStr_c,
                        preferredDateId: I,
                        preferredLocation: { postId: e.postId, cityName: e.cityName || "Unknown" }
                    });

                    // ── Direct API booking (primary) ──
                    let directBooked_c = false;
                    try {
                        const slots_c = await fetchTimeSlots(e, I, t);
                        if (slots_c && slots_c.length > 0) {
                            const res_c = await proceedWithDirectBooking(e, dateStr_c, slots_c, t);
                            if (res_c.success) {
                                directBooked_c = true;
                                await book();
                                await chrome.storage.local.set({ dateSelectionInProgress: !1 });
                            }
                        }
                    } catch (bookErr_c) {
                        console.warn("[FalconPath] Direct booking error:", bookErr_c.message);
                    }

                    // ── DOM fallback if direct booking failed ──
                    if (!directBooked_c) {
                        let D = document.getElementById("post_select"), E = !1;
                        if (D && "SELECT" === D.tagName && D.options.length > 1 && (E = !0), E) {
                            chrome.storage.local.set({ dateSelectionInProgress: !0 });
                            for (let q = 0; q < D.options.length; q++)
                                if (D.options[q].value === e.postId) {
                                    D.selectedIndex = q;
                                    D.dispatchEvent(new Event("change", { bubbles: !0 }));
                                    await new Promise(r => setTimeout(r, 1e3));
                                    break;
                                }
                            let P = await selectDates(b);
                            P ? await selectTimes() : chrome.storage.local.set({ dateSelectionInProgress: !1 });
                        } else {
                            await new Promise(r => setTimeout(r, 2e3));
                            window.location.reload();
                        }
                    }
                    return { matched: !0, status: 200 }
                }
            }
            let A = f[0].Date,
                [x, M, F] = A.split("-").map(Number),
                L = new Date(x, M - 1, F);
            await toast(`No dates found between your start and end dates.\nLocation: ${e.cityName || "Unknown"}\nLatest date found: ${L.toLocaleDateString("en-US")}\nSearching between: ${o} - ${n}\nYour current appointment: ${r}`);
            return {
                matched: !1,
                status: 200
            }
        }
        return await toast(`No dates found\nLocation: ${e.cityName || "Unknown"}\nSearching between: ${o} - ${n}\nYour current appointment: ${r}`, "#dc3545"), {
            matched: !1,
            status: 200
        }
    } catch (O) {
        console.error(`Date check failed for ${e.cityName || "Unknown"}:`, O), await toast(`Error checking dates: ${O.message}\nLocation: ${e.cityName || "Unknown"}\nYour current appointment: ${r}`, "#dc3545");
        return {
            matched: !1,
            status: (O && O.status) || null
        }
    }
}

// Single-shot OFC (biometrics) date check for one city. Returns true if a
// matching date was found (and the booking flow was started), false if not.
async function checkOFCCityDates(e, t) {
    let r = await chrome.storage.local.get(["fp_ad"]).then(({
        fp_ad: e
    }) => e);
    try {
        let o = await chrome.storage.local.get(["fp_st"]).then(({
                fp_st: e
            }) => e),
            n = await chrome.storage.local.get(["fp_en"]).then(({
                fp_en: e
            }) => e);
        if (!o || !n) {
            toast("Date range not set for date check. Please configure dates in the extension popup."), chrome.runtime.sendMessage({
                action: "openPopup"
            }, e => {
                chrome.runtime.lastError && console.error("Error opening popup:", chrome.runtime.lastError)
            });
            return {
                matched: !1,
                status: null
            }
        }
        let i = window.location.href.includes("reschedule=true"),
            l = [e.primaryId];
        try {
            let s = await chrome.storage.local.get(["applications"]);
            s.applications && Array.isArray(s.applications) && s.applications.length > 0 && (l = s.applications)
        } catch (c) {
            console.error("Error getting application IDs from storage for OFC dates:", c)
        }
        let d = new URLSearchParams;
        d.append("parameters", JSON.stringify({
            primaryId: e.primaryId,
            applications: l,
            scheduleDayId: "",
            scheduleEntryId: "",
            postId: e.postId,
            isReschedule: i ? "true" : "false"
        }));
        // --- Try portal-native first (site's own XHR via dropdown trigger) ---
        let pnOFC = await checkDatesPortalNative(e);
        if (pnOFC.cfStatus !== null) onCFFailure(pnOFC.cfStatus);
        let g = pnOFC.data;
        if (!g) {
            // Portal-native unavailable or timed out — fall back to direct fetch
            let u = Date.now(),
                cleanCid = (e.contactId || "").trim(),
                p = `https://www.usvisascheduling.com/en-US/custom-actions/?route=/api/v1/schedule-group/get-family-ofc-schedule-days&appd=${cleanCid}&cacheString=${u}`,
                h = await fetch(p, {
                    method: "POST",
                    headers: {
                        accept: "application/json, text/javascript, */*; q=0.01",
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "x-requested-with": "XMLHttpRequest",
                        cookie: t.getCookieHeader()
                    },
                    body: d.toString(),
                    credentials: "include"
                });
            if (!h.ok) {
                let httpErr = Error(`HTTP error! status: ${h.status}`);
                if (h.status === 403) onCFFailure(403);
                throw httpErr.status = h.status, httpErr
            }
            try {
                let f = await h.text();
                g = JSON.parse(f)
            } catch (w) {
                let parseErr = Error(`Invalid JSON response: ${w.message}`);
                throw parseErr.status = 403, parseErr
            }
        }
        if (g) onCFSuccess();
        if (g.ScheduleDays && g.ScheduleDays.length > 0) {
            let y = g.ScheduleDays.sort((e, t) => new Date(e.Date) - new Date(t.Date));
            for (let $ of y) {
                let S = $.Date,
                    [k, b, I] = S.split("-").map(Number),
                    // FIX Bug #2: UTC comparison for IST timezone correctness
                    vUTC = Date.UTC(k, b - 1, I),
                    startUTC_o = new Date(o + "T00:00:00Z").getTime(),
                    endUTC_o = new Date(n + "T00:00:00Z").getTime(),
                    v = new Date(vUTC),
                    C = $.ID,
                    E = vUTC >= startUTC_o && vUTC <= endUTC_o;
                if (E) {
                    await chrome.storage.local.set({ dateSelectionInProgress: !0 });
                    preferredDate = v;
                    preferredDateId = C;
                    const dateStr_o = v.toISOString().split("T")[0];
                    await chrome.storage.local.set({
                        preferredDateString: dateStr_o,
                        preferredDateId: C,
                        preferredLocation: { postId: e.postId, cityName: e.cityName || "Unknown" }
                    });

                    // ── Direct API booking (primary — uses consular endpoint; OFC endpoint TBD) ──
                    let directBooked_o = false;
                    try {
                        const slots_o = await fetchTimeSlots(e, C, t);
                        if (slots_o && slots_o.length > 0) {
                            const res_o = await proceedWithDirectBooking(e, dateStr_o, slots_o, t);
                            if (res_o.success) {
                                directBooked_o = true;
                                await book();
                                await chrome.storage.local.set({ dateSelectionInProgress: !1 });
                            }
                        }
                    } catch (bookErr_o) {
                        console.warn("[FalconPath] OFC direct booking error:", bookErr_o.message);
                    }

                    // ── DOM fallback ──
                    if (!directBooked_o) {
                        let q = document.getElementById("post_select"), T = !1;
                        if (q && "SELECT" === q.tagName && q.options.length > 1 && (T = !0), T) {
                            chrome.storage.local.set({ dateSelectionInProgress: !0 });
                            for (let P = 0; P < q.options.length; P++)
                                if (q.options[P].value === e.postId) {
                                    q.selectedIndex = P;
                                    q.dispatchEvent(new Event("change", { bubbles: !0 }));
                                    await new Promise(r => setTimeout(r, 1e3));
                                    break;
                                }
                            let x = await selectDates(v);
                            x ? await selectTimes() : chrome.storage.local.set({ dateSelectionInProgress: !1 });
                        } else {
                            await new Promise(r => setTimeout(r, 2e3));
                            window.location.reload();
                        }
                    }
                    return { matched: !0, status: 200 }
                }
            }
            let M = y[0].Date,
                [F, L, N] = M.split("-").map(Number),
                U = new Date(F, L - 1, N);
            await toast(`No dates found between your start and end dates.\nLocation: ${e.cityName || "Unknown"}\nLatest date found: ${U.toLocaleDateString("en-US")}\nSearching between: ${o} - ${n}\nYour current appointment: ${r}`);
            return {
                matched: !1,
                status: 200
            }
        }
        return await toast(`No OFC dates available\nCity: ${e.cityName}\nSearching between: ${o} - ${n}`, "#dc3545"), {
            matched: !1,
            status: 200
        }
    } catch (j) {
        console.error("OFC date check failed:", j), await toast(`Error checking OFC dates: ${j.message}\nCity: ${e.cityName || "Unknown"}\nChecked @ ${new Date().toLocaleString()}`, "#dc3545");
        return {
            matched: !1,
            status: (j && j.status) || null
        }
    }
}
// Backend removed: sync() no longer contacts server (was credit check + reload loop).
async function sync() { /* no-op: backend sync removed */ }
async function validateToContinue() {
    let {
        dateSelectionInProgress: e,
        preferredDateString: t
    } = await chrome.storage.local.get(["dateSelectionInProgress", "preferredDateString"]);
    if (!0 === e) {
        if (toast("Booking in progress, please wait..."), t) {
            let a = await selectDates(t);
            a && (await new Promise(e => setTimeout(e, 1e3)), await selectTimes()), await chrome.storage.local.set({
                dateSelectionInProgress: !1,
                preferredDateString: null
            })
        } else await chrome.storage.local.set({
            dateSelectionInProgress: !1,
            preferredDateString: null
        });
        return !0
    }
    return !1
}
async function extractPageData() {
    try {
        let {
            dateSelectionInProgress: e
        } = await chrome.storage.local.get("dateSelectionInProgress");
        if (e) return null
    } catch (t) {
        console.error("Error checking dateSelectionInProgress:", t)
    }
    try {
        let a = document.documentElement.innerHTML,
            r, o, n;
        for (let i of [/[?&]appd=([^&"]+)/, /contactId["']?\s*:\s*["']([^"']+)/i, /appd["']?\s*:\s*["']([^"']+)/i]) {
            let l = a.match(i);
            if (l) {
                r = l[1].trim().replace(/["']/g, "");
                break
            }
        }
        for (let s of [/[?&]primaryId=([^&"]+)/, /primaryId["']?\s*:\s*["']([^"']+)/i, /jsdata\['primaryId'\]\s*=\s*"([^"]+)"/i, /applications["']?\s*:\s*\[["']([^"']+)/i]) {
            let c = a.match(s);
            if (c) {
                o = c[1];
                break
            }
        }
        for (let d of [/[?&]postId=([^&"]+)/, /postId["']?\s*:\s*["']([^"']+)/i, /jsdata\['postId'\]\s*=\s*"([^"]+)"/i, /\['postId'\]\s*=\s*"([^"]+)"/]) {
            let u = a.match(d);
            if (u) {
                n = u[1];
                break
            }
        }
        if (!n || !o) {
            let p = document.getElementsByTagName("script");
            for (let h of p) {
                let g = h.textContent || "";
                if (g.includes("jsdata")) {
                    let f = g.match(/jsdata\['postId'\]\s*=\s*"([^"]+)"/);
                    f && !n && (n = f[1]);
                    let w = g.match(/jsdata\['primaryId'\]\s*=\s*"([^"]+)"/);
                    w && !o && (o = w[1])
                }
            }
        }
        let y = document.querySelectorAll('[data-appd], [data-primary-id], [data-post-id], input[type="hidden"]');
        y.forEach(e => {});
        r && (r = r.trim().replace(/["']/g, "")), o && (o = o.trim().replace(/["']/g, "")), n && (n = n.trim().replace(/["']/g, "")), n || (n = await chrome.storage.local.get(["fp_cty"]).then(({
            fp_cty: e
        }) => e));
        let m = {
            contactId: r,
            primaryId: o,
            postId: n
        };
        return m
    } catch ($) {
        return console.error("Error in extractPageData:", $), console.error("Error stack:", $.stack), null
    }
}

function initializeCookieMonitor() {
    let e = {
        storedCookies: {},
        start: function() {
            if (this.captureCookies(document.cookie), !cookieMonitorInitialized) try {
                Object.defineProperty(document, "cookie", {
                    set: e => {
                        let [t, a] = e.split("=");
                        return this.storedCookies[t] = a.split(";")[0], e
                    },
                    get: () => Object.entries(this.storedCookies).map(([e, t]) => `${e}=${t}`).join("; ")
                }), cookieMonitorInitialized = !0
            } catch (e) {
                console.warn("Cookie monitor already initialized, continuing with existing implementation:", e), cookieMonitorInitialized = !0
            }
            let t = window.fetch;
            window.fetch = async (...e) => {
                let a = await t(...e);
                return this.checkResponseCookies(a), a
            }
        },
        captureCookies: function(e) {
            e.split(";").forEach(e => {
                let [t, a] = e.trim().split("=");
                this.storedCookies[t] = a
            })
        },
        checkResponseCookies: function(e) {
            let t = e.headers.get("set-cookie");
            t && t.split(/,\s*/).forEach(e => {
                let [t, a] = e.split("=");
                this.storedCookies[t] = a.split(";")[0]
            })
        },
        getCookieHeader: function() {
            return Object.entries(this.storedCookies).map(([e, t]) => `${e}=${t}`).join("; ")
        }
    };
    return e.start(), e
}

// ======== PORTAL-NATIVE MODE ========
// Instead of firing our own fetch() for date checks, we trigger the site's
// own city dropdown change event, let the site's JS make the XHR naturally,
// and intercept the response via portalNetworkHook.js (injected in MAIN world).
// This way Cloudflare sees a perfectly normal page XHR — no extension fingerprint.

function getFalconPathBridgeKey() {
    try { return sessionStorage.getItem("fp_bridge_key"); } catch(e) { return null; }
}

function waitForBridgeEvent(types, timeoutMs) {
    timeoutMs = timeoutMs || 28000;
    const accepted = Array.isArray(types) ? types : [types];
    return new Promise(function(resolve) {
        const key = getFalconPathBridgeKey();
        if (!key) { resolve({ timedOut: true, reason: "NO_BRIDGE_KEY" }); return; }
        let done = false;
        const finish = function(result) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            window.removeEventListener(key, handler);
            resolve(result);
        };
        const handler = function(event) {
            const detail = event && event.detail;
            if (!detail || accepted.indexOf(detail.type) === -1) return;
            finish({ type: detail.type, data: detail.data, isOFC: detail.isOFC, status: detail.status });
        };
        const timer = setTimeout(function() { finish({ timedOut: true }); }, timeoutMs);
        window.addEventListener(key, handler);
    });
}

// Try to trigger the site's own XHR by switching the city dropdown,
// then collect the intercepted response via the bridge.
// Returns the parsed ScheduleDays array on success, null on failure/timeout.
async function checkDatesPortalNative(cityData) {
    try {
        const dropdown = document.getElementById("post_select");
        if (!dropdown || dropdown.tagName !== "SELECT" || dropdown.options.length < 1) {
            return { data: null, cfStatus: null };
        }
        let found = false;
        for (let i = 0; i < dropdown.options.length; i++) {
            if (dropdown.options[i].value === cityData.postId) {
                dropdown.selectedIndex = i;
                found = true;
                break;
            }
        }
        if (!found) return { data: null, cfStatus: null };

        const bridgePromise = waitForBridgeEvent(["FP_DAYS_CAUGHT", "FP_SCHEDULE_ERROR"], 10000);
        dropdown.dispatchEvent(new Event("change", { bubbles: true }));
        const result = await bridgePromise;

        if (result.timedOut) return { data: null, cfStatus: null };
        if (result.type === "FP_SCHEDULE_ERROR") {
            return { data: null, cfStatus: result.status || 0 };
        }
        onCFSuccess();
        return { data: result.data || null, cfStatus: null };
    } catch (e) {
        console.warn("Portal-native check failed:", e);
        return { data: null, cfStatus: null };
    }
}


// ======== CLOUDFLARE SESSION MANAGER — 3-LEVEL SMART RECOVERY ========
//
// Level 0 (1–2 consecutive 403s): Do nothing extra — existing per-city
//   exponential backoff in runCityScanLoop already handles these. No reload.
//   Prevents embassy IP-banning from too many rapid page refreshes.
//
// Level 1 (3 consecutive 403s): Pause 15 seconds, navigate to home page,
//   let the home-page handler click Schedule/Reschedule to return to the
//   scheduling page with naturally refreshed cookies. Resets the counter.
//
// Level 2 (5 more 403s after Level 1): Session is fundamentally broken.
//   Sign out the account, wait for content.js fillForm() to log back in,
//   returning a completely fresh authenticated session.

const CF_L1_THRESHOLD = 3;     // consecutive 403s before Level 1 recovery
const CF_L2_THRESHOLD = 5;     // additional 403s after Level 1 before Level 2

let cfConsecutive403   = 0;    // resets to 0 on any success
let cfL1Done           = false; // Level 1 already triggered this navigation cycle
let cf403AfterL1       = 0;    // 403s counted after Level 1 action
let cfRecoveryActive   = false; // blocks concurrent recovery attempts
let cfReloadPending    = false; // shared flag used by CAPTCHA/waiting-room handlers
let cfLastReloadAt     = 0;    // used by the CF keepalive timer
let cfSyncIntervalTimer = null;
let cfKeepaliveTimer    = null;

function onCFFailure(status) {
    if (status !== 403) return;
    if (cfRecoveryActive || cfReloadPending) return; // recovery already in progress

    cfConsecutive403++;
    console.warn("[FalconPath CF] Consecutive 403 #" + cfConsecutive403 +
                 " (L1done=" + cfL1Done + ", afterL1=" + cf403AfterL1 + ")");

    if (cfL1Done) {
        // Post-Level-1: count towards Level 2
        cf403AfterL1++;
        console.warn("[FalconPath CF] After-L1 count: " + cf403AfterL1 + "/" + CF_L2_THRESHOLD);
        if (cf403AfterL1 >= CF_L2_THRESHOLD) {
            triggerLevel2Recovery();
        }
        return; // no reload — let per-city backoff handle individual 403s
    }

    if (cfConsecutive403 >= CF_L1_THRESHOLD) {
        triggerLevel1Recovery();
    }
    // 1–2 403s: no action — per-city backoff in scan loop is enough
}

function onCFSuccess() {
    if (cfConsecutive403 > 0) console.log("[FalconPath CF] Success — resetting 403 counter");
    cfConsecutive403 = 0;
    cfReloadPending  = false;
    // Note: cfL1Done and cf403AfterL1 persist until a full Level 1/2 recovery resets them
}

// ── Level 1: Pause → home page → scheduling page (fresh cookies) ──────────────
async function triggerLevel1Recovery() {
    if (cfRecoveryActive) return;
    cfRecoveryActive = true;
    cfReloadPending  = true;
    cfConsecutive403 = 0;
    cfL1Done         = true;
    cf403AfterL1     = 0;

    isSchedulerActive = false;
    stopSyncInterval();
    stopCFKeepalive();

    toast(
        "3× 403 detected — pausing 15s then navigating to home page for fresh cookies..." +
        "\n(Avoids embassy IP-ban from too many rapid reloads)",
        "#f59e0b"
    );
    await new Promise(r => setTimeout(r, 15000));

    toast("Navigating to home page — will auto-return to scheduling page...", "#f59e0b");
    cfLastReloadAt   = Date.now();
    cfRecoveryActive = false;
    cfReloadPending  = false;
    // Navigate to home — initializeSchedulingPage() on the home page
    // auto-clicks the Schedule/Reschedule link to return to the correct page.
    window.location.replace("https://www.usvisascheduling.com/");
}

// ── Level 2: Sign out + sign back in (completely fresh authenticated session) ──
async function triggerLevel2Recovery() {
    if (cfRecoveryActive) return;
    cfRecoveryActive = true;
    cfReloadPending  = true;
    cfConsecutive403 = 0;
    cf403AfterL1     = 0;
    cfL1Done         = false; // allow Level 1 to fire again next time if needed

    isSchedulerActive = false;
    stopSyncInterval();
    stopCFKeepalive();

    toast(
        "5× 403 after session refresh — signing out and back in for a completely fresh session...",
        "#dc3545"
    );
    await new Promise(r => setTimeout(r, 4000));

    // Try to click the user account dropdown, then the sign-out link.
    // content.js fillForm() handles auto-login after sign-out.
    let signedOut = false;
    try {
        // Open the user dropdown (top-right name button)
        const dropdownBtn = document.querySelector(
            ".dropdown-toggle, [data-toggle='dropdown'], " +
            "[aria-haspopup='true'], .usa-menu-btn, #navbarDropdown, " +
            "button[id*='account'], button[id*='user']"
        );
        if (dropdownBtn) { dropdownBtn.click(); await new Promise(r => setTimeout(r, 600)); }

        // Find and click sign-out link
        const signOutEl = document.querySelector(
            "a[href*='logout'], a[href*='signout'], a[href*='sign-out'], " +
            "a[href*='Logout'], a[href*='Signout'], " +
            "button[id*='signout'], #signout, a#signout"
        );
        if (signOutEl) { signOutEl.click(); signedOut = true; }
    } catch(e) {}

    if (!signedOut) {
        // Fallback: navigate directly to the logout endpoint
        toast("Sign-out link not found — navigating to logout URL...", "#dc3545");
        window.location.replace("https://www.usvisascheduling.com/en-US/logout");
    }
    // After sign-out the site redirects to the B2C login page.
    // content.js fillForm() detects #signInName + #password and auto-fills.
    cfLastReloadAt   = Date.now();
    cfRecoveryActive = false;
    cfReloadPending  = false;
}

// Backend removed: periodic server sync deleted — nothing to sync to.
function startSyncInterval() {
    if (cfSyncIntervalTimer) return;
}

function stopSyncInterval() {
    if (cfSyncIntervalTimer) { clearInterval(cfSyncIntervalTimer); cfSyncIntervalTimer = null; }
}

// Proactive keepalive: reload every 7 min to refresh cf_clearance before it expires.
// Only fires when no booking is in progress.
function startCFKeepalive() {
    stopCFKeepalive();
    cfKeepaliveTimer = setInterval(async () => {
        if (!isSchedulerActive) return;
        const { dateSelectionInProgress } = await chrome.storage.local.get("dateSelectionInProgress");
        if (dateSelectionInProgress) return;
        const now = Date.now();
        if ((now - cfLastReloadAt) < 7 * 60 * 1000) return;
        cfLastReloadAt = now;
        toast("Refreshing session (CF keepalive — every 7 min for 24/7 operation)...", "#8b5cf6");
        setTimeout(() => window.location.reload(), 1500);
    }, 7 * 60 * 1000);
}

function stopCFKeepalive() {
    if (cfKeepaliveTimer) { clearInterval(cfKeepaliveTimer); cfKeepaliveTimer = null; }
}

// ── Server error page detection ───────────────────────────────────────────────
// Detects CGI's "We're sorry, something went wrong" error page which appears
// when the server crashes the session. Triggers Level 1 recovery.
function getServerErrorPage() {
    try {
        const title = (document.title || '').toLowerCase();
        const text  = (document.body && document.body.innerText) || '';
        if (title.includes('something went wrong') ||
            title.includes('page not found') ||
            text.includes('something went wrong') ||
            text.includes('contact the website administrator') ||
            text.includes('Error ID #') ||
            (text.includes('We') && text.includes('sorry') && text.includes('wrong'))) {
            return 'SERVER_ERROR';
        }
    } catch(e) {}
    return null;
}

// ── PSE0501 alert handler ─────────────────────────────────────────────────────
// PSE0501 = "Unable to load appointment available days at this time"
// The site normally fires this as a window.alert() which freezes JS.
// portalNetworkHook.js suppresses the dialog and emits FP_ALERT_INTERCEPTED.
// We catch that here and apply a smart pause-and-resume strategy.

let pse0501Count      = 0;   // consecutive PSE0501 occurrences
let pse0501PauseActive = false;
let pse0501Listener   = null;

function setupAlertInterceptListener() {
    if (pse0501Listener) return; // already registered
    const key = getFalconPathBridgeKey();
    if (!key) return;

    pse0501Listener = (event) => {
        const detail = event && event.detail;
        if (!detail || detail.type !== 'FP_ALERT_INTERCEPTED') return;
        const msg = String(detail.message || '').toLowerCase();
        if (msg.includes('pse0501') || msg.includes('unable to load appointment')) {
            handlePSE0501();
        }
    };
    window.addEventListener(key, pse0501Listener);
    console.log('[FalconPath] PSE0501 alert listener registered');
}

async function handlePSE0501() {
    if (pse0501PauseActive) return;
    pse0501PauseActive = true;
    pse0501Count++;

    isSchedulerActive = false;
    stopSyncInterval();

    const pauseMins = pse0501Count === 1 ? 10 : (pse0501Count === 2 ? 20 : 30);
    console.warn(`[FalconPath] PSE0501 #${pse0501Count} — pausing ${pauseMins} min`);

    toast(
        `PSE0501 error #${pse0501Count} — server cannot load appointment days.\n` +
        `Pausing ${pauseMins} min then resuming. (Repeated occurrences increase pause.)`,
        '#dc3545'
    );

    // If PSE0501 keeps repeating, escalate to Level 1 recovery after 3 times
    if (pse0501Count >= 3) {
        toast('PSE0501 repeated 3× — escalating to home page session refresh...', '#dc3545');
        pse0501Count    = 0;
        pse0501PauseActive = false;
        await triggerLevel1Recovery();
        return;
    }

    await new Promise(r => setTimeout(r, pauseMins * 60 * 1000));
    pse0501PauseActive = false;

    const { fp_act } = await chrome.storage.local.get('fp_act');
    if (fp_act) {
        isSchedulerActive    = true;
        schedulingPageHandled = false;
        startSyncInterval();
        startCFKeepalive();
        toast(`Resuming after PSE0501 pause (${pauseMins} min)...`, '#22c55e');
        await initializeSchedulingPage();
    }
}




// ======== RATE-LIMIT / "EXCEEDED THE LIMIT" HARD STOP ========================
// CGI's scheduling site shows "You have exceeded the limit for viewing this page."
// when the IP/account is temporarily banned after too many requests.
// This requires a MANDATORY ~12-hour stop — no recovery attempts, no retries.
// The extension shows a live countdown banner and sends a Chrome notification.

const EXCEEDED_LIMIT_HOURS = 12;
let exceededLimitHandled = false;

function getExceededLimitPage() {
    // Only match the EXACT CGI phrase — nothing broader.
    // Removed title-based checks entirely (too broad, false-positives on normal pages).
    try {
        const text = (document.body && document.body.innerText) || '';
        return text.includes('exceeded the limit for viewing this page') ||
               (text.includes('You have exceeded') && text.includes('limit') && text.includes('viewing this page'));
    } catch(e) { return false; }
}

function showExceededLimitBanner(blockedUntil) {
    // Remove any existing banners first
    ['fp-captcha-banner','fp-cf-overlay'].forEach(id => {
        const el = document.getElementById(id); if (el) el.remove();
    });
    if (document.getElementById('fp-exceeded-banner')) return;

    const div = document.createElement('div');
    div.id = 'fp-exceeded-banner';
    div.style.cssText = [
        'position:fixed','top:0','left:0','right:0','z-index:2147483647',
        'background:#7f1d1d','color:#fff','font-family:sans-serif',
        'font-size:14px','padding:14px 20px','text-align:center',
        'box-shadow:0 4px 24px rgba(0,0,0,.7)','line-height:1.6'
    ].join(';');

    const update = () => {
        const rem = blockedUntil - Date.now();
        if (rem <= 0) {
            div.innerHTML = '✅ <b>FalconPath — Block period over.</b> Reload this page and restart the extension.';
            return;
        }
        const h = Math.floor(rem / 3600000);
        const m = Math.floor((rem % 3600000) / 60000);
        const s = Math.floor((rem % 60000) / 1000);
        div.innerHTML =
            '⛔ <b>FALCONPATH STOPPED — Embassy rate limit reached</b><br>' +
            '<span style="font-weight:normal;font-size:12px">' +
            '"You have exceeded the limit for viewing this page." — ' +
            `Come back in: <b style="font-size:15px">${h}h ${m}m ${s}s</b>` +
            ` &nbsp;·&nbsp; Unblocks at: <b>${new Date(blockedUntil).toLocaleTimeString()}</b>` +
            '</span>';
    };
    update();
    document.body.insertBefore(div, document.body.firstChild);

    const iv = setInterval(() => {
        if (!document.getElementById('fp-exceeded-banner')) { clearInterval(iv); return; }
        update();
        if (Date.now() >= blockedUntil) clearInterval(iv);
    }, 1000);
}

let exceededLimitWatcher = null; // interval that polls for page recovery

async function handleExceededLimit() {
    if (exceededLimitHandled) return;
    exceededLimitHandled = true;

    // ── HARD STOP — this tab only ─────────────────────────────────────────────
    // NOT written to chrome.storage.local — that is shared across all tabs and
    // would wrongly block accounts in other tabs that are not rate-limited.
    isSchedulerActive     = false;
    schedulingPageHandled = false;
    cfReloadPending       = true;
    cfRecoveryActive      = true;
    if (dateCheckInterval) { clearInterval(dateCheckInterval); dateCheckInterval = null; }
    stopSyncInterval();
    stopCFKeepalive();
    stopCFPageWatcher();
    if (exceededLimitWatcher) { clearInterval(exceededLimitWatcher); exceededLimitWatcher = null; }

    const blockedUntil    = Date.now() + EXCEEDED_LIMIT_HOURS * 60 * 60 * 1000;
    const blockedUntilStr = new Date(blockedUntil).toLocaleString();

    showExceededLimitBanner(blockedUntil);

    chrome.runtime.sendMessage({
        action: 'showCFNotification',
        notifType: 'EXCEEDED_LIMIT',
        blockedUntil: blockedUntilStr
    }).catch(() => {});

    console.warn('[FalconPath] EXCEEDED LIMIT — tab hard-stopped until', blockedUntilStr);

    // ── Auto-recovery watcher — checks every 60s if THIS page is still blocked ─
    // If the embassy unblocks early or the page navigates to a normal state,
    // we remove the banner and resume scanning automatically for THIS tab only.
    // Other tabs with different accounts are never affected.
    exceededLimitWatcher = setInterval(async () => {
        if (getExceededLimitPage()) {
            // Still showing the blocked page — keep waiting
            console.log('[FalconPath] Exceeded-limit check: still blocked');
            return;
        }

        // ── Page is now normal — auto-resume this tab ──────────────────────
        clearInterval(exceededLimitWatcher);
        exceededLimitWatcher   = null;
        exceededLimitHandled   = false;
        cfReloadPending        = false;
        cfRecoveryActive       = false;

        const banner = document.getElementById('fp-exceeded-banner');
        if (banner) banner.remove();

        toast('Rate limit cleared on this account — resuming scan...', '#22c55e');
        console.log('[FalconPath] Exceeded-limit resolved — resuming');

        const { fp_act } = await chrome.storage.local.get('fp_act');
        if (fp_act) {
            isSchedulerActive    = true;
            schedulingPageHandled = false;
            startSyncInterval();
            startCFKeepalive();
            await initializeSchedulingPage();
        }
    }, 60 * 1000); // poll every 60 seconds
}

// No-op stub — storage-based global block removed (was cross-contaminating tabs)
async function checkExceededLimitBlock() {
    return false;
}


// ======== CLOUDFLARE PAGE DETECTION (CAPTCHA + WAITING ROOM) ========
// Detects two Cloudflare blocking pages that stop all API calls from working:
//   1. "Just a moment..." — JS/Turnstile CAPTCHA challenge
//   2. "Waiting Room powered by Cloudflare" — high-traffic virtual queue
// When detected: stops all scanning immediately and waits for the page to
// clear. Scanning resumes automatically once access is granted.

function getCloudflarePage() {
    try {
        const title = (document.title || '').trim();
        if (title === 'Waiting Room powered by Cloudflare') return 'WAITING_ROOM';
        if (title === 'Just a moment...') return 'CHALLENGE';
        const bodyStyle = ((document.body && document.body.getAttribute('style')) || '').toLowerCase();
        if (bodyStyle.includes('waiting_room_background')) return 'WAITING_ROOM';
        if (document.getElementById('cf-challenge-running') ||
            document.getElementById('challenge-form') ||
            document.querySelector('.cf-turnstile, #turnstile-wrapper, #cf-stage')) return 'CHALLENGE';
        const bodyText = (document.body && document.body.innerText) || '';
        if (bodyText.includes('You are now in line') || bodyText.includes('Waiting Room powered by Cloudflare')) return 'WAITING_ROOM';
        if (bodyText.includes('Performing security verification') || bodyText.includes('Verify you are human')) return 'CHALLENGE';
    } catch(e) {}
    return null;
}

let cfPageState = null;
let cfPageWatcher = null;
let cfPageToastShown = false;
let cfPageResuming = false;
let cfCaptchaReminder = null;
let cfChallengeReloadDone = false; // only reload once for CAPTCHA

function stopCFPageWatcher() {
    if (cfPageWatcher) { clearInterval(cfPageWatcher); cfPageWatcher = null; }
    if (cfCaptchaReminder) { clearTimeout(cfCaptchaReminder); cfCaptchaReminder = null; }
}

// Show a persistent red banner directly on the page (more visible than a toast)
function showCaptchaOverlay() {
    if (document.getElementById('fp-captcha-banner')) return;
    const div = document.createElement('div');
    div.id = 'fp-captcha-banner';
    div.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'background:#dc2626', 'color:#fff', 'font-family:sans-serif',
        'font-size:15px', 'font-weight:bold', 'text-align:center',
        'padding:12px 16px', 'box-shadow:0 4px 20px rgba(0,0,0,.5)'
    ].join(';');
    div.innerHTML = [
        '<span style="font-size:18px">&#9888;</span>',
        ' FalconPath Visa Assistant — Action Required: ',
        '<span style="font-weight:normal">',
        'Click the <b>"Verify you are human"</b> checkbox below.',
        ' Scanning will resume automatically once verified.',
        '</span>'
    ].join('');
    document.body.insertBefore(div, document.body.firstChild);
}

function removeCaptchaOverlay() {
    const el = document.getElementById('fp-captcha-banner');
    if (el) el.remove();
}

function startCFPageWatcher() {
    stopCFPageWatcher();
    cfPageToastShown = false;
    cfPageWatcher = setInterval(async () => {
        const current = getCloudflarePage();
        if (current) {
            if (!cfPageToastShown) {
                cfPageToastShown = true;
                if (current === 'CHALLENGE') {
                    showCaptchaOverlay();
                    toast('Still waiting for CAPTCHA — click "Verify you are human" to continue.', '#dc3545');
                } else {
                    toast('Still in Cloudflare queue — extension paused. Auto-resuming when access is granted.', '#f59e0b');
                }
                setTimeout(() => { cfPageToastShown = false; }, 30000);
            }
            return;
        }
        if (cfPageResuming) return;
        cfPageResuming = true;
        stopCFPageWatcher();
        cfPageState = null;
        cfChallengeReloadDone = false;
        cfReloadPending = false;
        removeCaptchaOverlay();
        toast('Access granted — resuming date scan...', '#22c55e');
        await new Promise(r => setTimeout(r, 1500));
        const { fp_act } = await chrome.storage.local.get('fp_act');
        if (fp_act) {
            isSchedulerActive = true;
            schedulingPageHandled = false;
            startSyncInterval();
            startCFKeepalive();
            await initializeSchedulingPage();
        }
        cfPageResuming = false;
    }, 3000);
}

async function handleCloudflarePage(pageType) {
    if (cfPageState === pageType) return;
    cfPageState = pageType;
    cfPageToastShown = false;

    // Stop everything AND block onCFFailure from triggering more reloads
    isSchedulerActive = false;
    schedulingPageHandled = false;
    cfReloadPending = true;  // ← CRITICAL: prevents reload loops
    stopSyncInterval();
    stopCFKeepalive();
    stopCFPageWatcher();

    if (pageType === 'WAITING_ROOM') {
        cfReloadPending = false; // waiting room is fine to reload normally
        toast(
            'Cloudflare Waiting Room — extension fully paused.\n' +
            'Estimated wait: ~1-5 min. Will resume automatically when access is granted.',
            '#f59e0b'
        );
        chrome.runtime.sendMessage({ action: 'showCFNotification', notifType: 'WAITING_ROOM' }).catch(() => {});
        startCFPageWatcher();
        return;
    }

    // ── CHALLENGE (CAPTCHA) — multi-step auto-solve attempt ──────────────────
    toast('Cloudflare CAPTCHA detected — attempting auto-verify...', '#f59e0b');

    // Step 1: Wait 10s for Turnstile iframe to fully load and render
    toast('Waiting 10s for Turnstile to render...', '#f59e0b');
    await new Promise(r => setTimeout(r, 10000));

    // ── Primary approach: CDP trusted mouse click ──────────────────────────
    // chrome.debugger + Input.dispatchMouseEvent produces isTrusted:true events
    // that bypass the cross-origin iframe restriction and pass Cloudflare's check.
    let clickResult = { ok: false, clicked: false };
    try {
        clickResult = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'attemptTurnstileClickCDP' }, (res) => {
                resolve(res || { ok: false });
            });
        });
    } catch(e) {}

    if (clickResult.clicked) {
        toast('CDP trusted click sent to Turnstile checkbox — waiting for verification...', '#22c55e');
    } else {
        // CDP failed (e.g. iframe not found yet) — try allFrames scripting as backup
        toast('CDP attempt 1: ' + (clickResult.reason || clickResult.error || 'position not found yet — will retry...'), '#f59e0b');
        try {
            await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'attemptTurnstileClick' }, resolve);
            });
        } catch(e) {}
    }

    // Step 2: Wait 10s to see if verification passed
    await new Promise(r => setTimeout(r, 10000));
    if (!getCloudflarePage()) {
        cfPageState = null;
        cfReloadPending = false;
        return;
    }

    // Step 3: Retry CDP click (maybe iframe finished loading on second attempt)
    toast('Still showing — re-polling for Turnstile position and retrying trusted click...', '#f59e0b');
    try {
        await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'attemptTurnstileClickCDP' }, resolve);
        });
    } catch(e) {}
    await new Promise(r => setTimeout(r, 8000));
    if (!getCloudflarePage()) {
        cfPageState = null;
        cfReloadPending = false;
        return;
    }

    // Step 4: Try ONE page reload (fresh page load sometimes auto-passes Turnstile)
    if (!cfChallengeReloadDone) {
        cfChallengeReloadDone = true;
        toast('Retrying with fresh page reload — Turnstile often auto-passes on clean load...', '#f59e0b');
        await new Promise(r => setTimeout(r, 2000));
        window.location.reload();
        return;
    }

    // Step 5: All automated attempts exhausted — ask user to click manually
    showCaptchaOverlay();
    toast(
        'Auto-solve exhausted — please click "Verify you are human" checkbox manually.\n' +
        'Scanning resumes automatically once verified.',
        '#dc3545'
    );
    chrome.runtime.sendMessage({ action: 'showCFNotification', notifType: 'CHALLENGE' }).catch(() => {});
    cfReloadPending = false;
    startCFPageWatcher();
}

function initCFPageWatcher() {
    const titleEl = document.querySelector('title');
    const target = titleEl || document.head || document.documentElement;
    const obs = new MutationObserver(() => {
        const cfPage = getCloudflarePage();
        if (cfPage && cfPageState !== cfPage && !cfPageResuming) {
            handleCloudflarePage(cfPage);
        }
    });
    obs.observe(target, { childList: true, subtree: true, characterData: true });
}




// ======== DIRECT API BOOKING ========
// Calls the scheduling API directly with the Token from ScheduleEntries
// response, bypassing the fragile DOM submit button. Falls back to
// DOM-click approach if the API call fails.

async function proceedWithDirectBooking(pageData, dateStr, slots, cookieMonitor) {
    try {
        const { latestTimeSlotsToken: token } = await chrome.storage.local.get(["latestTimeSlotsToken"]);
        if (!token) throw new Error("No booking token — time slots must be fetched first");

        // FIX Bug #17: Sort by StartTime and pick earliest, not random
        const sortedSlots = [...slots].sort((a, b) => (a.StartTime || "").localeCompare(b.StartTime || ""));
        const slot = sortedSlots[0];
        if (!slot || slot.Num === undefined) throw new Error("Invalid slot — no Num property");

        const parts = String(dateStr).split("-").map(Number);
        const utcDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0)).toISOString();

        const formData = new URLSearchParams();
        formData.append("parameters", JSON.stringify({
            primaryId: null,
            applications: null,
            scheduleDayId: null,
            scheduleEntryId: "",
            postId: null,
            Token: token,
            Date: utcDate,
            Num: String(slot.Num)
        }));

        const cleanContactId = (pageData.contactId || "").trim();
        const cacheString = Date.now();
        // Detect whether this is a reschedule or fresh booking, and OFC vs Consular,
        // so we hit the correct API endpoint for both account types.
        const _href = window.location.href;
        const _bookingIsReschedule = _href.includes("reschedule=true");
        const _bookingIsOFC = _href.includes("/ofc-schedule");
        const _bookingAction = _bookingIsReschedule ? "reschedule" : "schedule";
        const _bookingType   = _bookingIsOFC ? "ofc" : "consular";
        const _bookingRoute  = `/api/v1/schedule-group/${_bookingAction}-${_bookingType}-appointments-for-family`;
        const bookingUrl = `https://www.usvisascheduling.com/en-US/custom-actions/?route=${_bookingRoute}&appd=${cleanContactId}&cacheString=${cacheString}`;
        console.log(`[FalconPath] Booking via: ${_bookingAction}-${_bookingType} (reschedule=${_bookingIsReschedule}, OFC=${_bookingIsOFC})`);

        const response = await fetch(bookingUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
                cookie: cookieMonitor.getCookieHeader()
            },
            body: formData.toString(),
            credentials: "include"
        });

        if (!response.ok) throw new Error("Booking HTTP " + response.status);
        const data = await response.json();
        if (data.HasError) throw new Error(data.ErrorString || data.LocalizedGenericErrorMessage || "Booking API error");

        const timeLabel = slot.StartTime || slot.Time || ("Slot #" + slot.Num);
        await toast("Appointment booked via API! Time: " + timeLabel, "#22c55e");
        // Phase 2: notify local controller (Telegram bot relays it) — fire and forget
        try {
            const { fp_account: acct } = await chrome.storage.local.get("fp_account");
            fetch("http://127.0.0.1:8765/event", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    kind: "BOOKED",
                    account: acct || "unknown",
                    text: `${timeLabel} @ ${(pageData && pageData.cityName) || "unknown city"}`
                })
            }).catch(() => {});
        } catch (e) {}
        return { success: true, slot, data };
    } catch (err) {
        console.warn("[FalconPath] Direct booking failed:", err.message);
        return { success: false, error: err.message };
    }
}

async function fetchTimeSlots(e, t, a) {
    try {
        let r = [e.primaryId];
        try {
            let o = await chrome.storage.local.get(["applications"]);
            o.applications && Array.isArray(o.applications) && o.applications.length > 0 && (r = o.applications)
        } catch (n) {
            console.error("Error getting application IDs from storage for time slots:", n)
        }
        let i = new URLSearchParams;
        i.append("parameters", JSON.stringify({
            primaryId: e.primaryId,
            applications: r,
            scheduleDayId: t,
            scheduleEntryId: "",
            postId: e.postId,
            isReschedule: window.location.href.includes("reschedule=true") ? "true" : "false"
        }));
        // FIX Bug #1: Detect OFC vs Consular page and use correct endpoint
        const _isOFCSlots = window.location.href.includes("/ofc-schedule");
        const _slotsEndpoint = _isOFCSlots
            ? "/api/v1/schedule-group/get-family-ofc-schedule-entries"
            : "/api/v1/schedule-group/get-family-consular-schedule-entries";
        let l = Date.now(),
            s = `https://www.usvisascheduling.com/en-US/custom-actions/?route=${_slotsEndpoint}&appd=${e.contactId}&cacheString=${l}`,
            c = await fetch(s, {
                method: "POST",
                headers: {
                    accept: "application/json, text/javascript, */*; q=0.01",
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "x-requested-with": "XMLHttpRequest",
                    cookie: a.getCookieHeader()
                },
                body: i.toString(),
                credentials: "include"
            });
        if (!c.ok) throw Error(`HTTP error! status: ${c.status}`);
        let d = await c.json();
        if (d && d.Token) await chrome.storage.local.set({ latestTimeSlotsToken: d.Token, latestTimeSlotsTokenAt: Date.now() });
        return d.ScheduleEntries
    } catch (u) {
        return console.error("Error fetching time slots:", u), null
    }
}
async function getCheckFrequencyMs() {
    try {
        let e = await new Promise(e => {
            chrome.storage.local.get(["fp_fq", "fp_fqType"], t => {
                let a = t.fp_fq || 30,
                    r = t.fp_fqType || "seconds",
                    o = 3e4;
                a && ("seconds" === r ? o = 1e3 * a : "minutes" === r ? o = 6e4 * a : "hours" === r && (o = 36e5 * a));
                let n = .2 * o;
                o = Math.floor(o + (Math.random() * n * 2 - n)), e(o)
            })
        });
        return e
    } catch (t) {
        return console.error("Error getting check frequency:", t), 3e4
    }
}
async function selectDates(e) {
    try {
        let t = new Date(e),
            a = t.getMonth(),
            r = t.getFullYear(),
            o = t.getDate(),
            n = Date.now(),
            i, l;
        for (; Date.now() - n < 12e4 && (i = document.querySelector(".ui-datepicker-month"), l = document.querySelector(".ui-datepicker-year"), !i || !l);) Date.now(), await new Promise(e => setTimeout(e, 200));
        if (!i || !l) throw Error("Calendar selectors not found after waiting 120 seconds");
        document.querySelector(".ui-datepicker-year").value = r.toString(), document.querySelector(".ui-datepicker-year").dispatchEvent(new Event("change", {
            bubbles: !0
        })), document.querySelector(".ui-datepicker-month").value = a.toString(), document.querySelector(".ui-datepicker-month").dispatchEvent(new Event("change", {
            bubbles: !0
        })), await new Promise(e => setTimeout(e, 300));
        let s = Date.now(),
            c = null;
        for (; Date.now() - s < 12e4;) {
            let d = [`td.greenday[data-month="${a}"][data-year="${r}"] a[data-date="${o}"]`, `td[data-month="${a}"][data-year="${r}"] a[data-date="${o}"]`, `td.greenday a[data-date="${o}"]`];
            for (let u of d)
                if (c = document.querySelector(u)) break;
            if (c) break;
            Date.now(), await new Promise(e => setTimeout(e, 200))
        }
        if (!c) throw Error(`Date cell not found for ${a + 1}/${o}/${r} after waiting 120 seconds`);
        return c.click(), !0
    } catch (p) {
        return console.error("Error selecting date:", p), console.error("Calendar state:", document.querySelector(".ui-datepicker-inline")?.outerHTML), await chrome.storage.local.set({
            dateSelectionInProgress: !1,
            preferredDateString: null,
            preferredDateId: null
        }), !1
    }
}
async function selectTimes() {
    try {
        let slots = [],
            attempts = 0;
        while (!slots.length && attempts < 10) {
            slots = [...document.querySelectorAll('#time_select input[type="radio"]')];
            if (!slots.length) {
                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }
        }
        // FIX Bug #6: Comma operator was confusing — explicit reload and return
        if (!slots.length) { location.reload(); return false; }
        const pick = slots[Math.floor(Math.random() * slots.length)];
        const row = pick.closest("tr");
        const time = row?.querySelector("td:nth-child(2)")?.textContent.trim() || "Unknown time";
        const avail = pick.getAttribute("data-slots") || "Unknown slots";
        pick.click();
        // ✅ FIX: Save selected time to storage so book() can read it
        await chrome.storage.local.set({
            bookedTimeSlot: time
        });
        const {
            fp_ab
        } = await chrome.storage.local.get("fp_ab");
        if (fp_ab) {
            await toast(`AutoBook! Time: ${time} | Slots: ${avail}`);
            const btn = document.getElementById("submitbtn");
            if (btn) {
                if (btn.disabled) {
                    btn.disabled = false;
                    btn.style.opacity = "1";
                }
                await book(); // book() now reads bookedTimeSlot from storage
                btn.click();
                await toast(`Booking submitted! Time: ${time}`);
            }
        } else {
            const res = await Swal.fire({
                title: "Date and time found!",
                html: `<p style="color:lightblue">Time: ${time}</p><p>Slots: ${avail}</p><p>Book now?</p>`,
                icon: "success",
                showCancelButton: true,
                confirmButtonText: "Book Now!",
                cancelButtonText: "Cancel"
            });
            if (res.isConfirmed) {
                const btn = document.getElementById("submitbtn");
                if (btn) {
                    if (btn.disabled) {
                        btn.disabled = false;
                        btn.style.opacity = "1";
                    }
                    await book();
                    btn.click();
                    await toast(`Booked! Time: ${time}`);
                }
            } else {
                await chrome.storage.local.set({
                    dateSelectionInProgress: false,
                    preferredDateString: null,
                    preferredDateId: null,
                    bookedTimeSlot: null // ✅ clear on cancel
                });
            }
        }
        return true;
    } catch (e) {
        console.error("selectTimes error:", e);
        await chrome.storage.local.set({
            dateSelectionInProgress: false,
            preferredDateString: null,
            preferredDateId: null,
            bookedTimeSlot: null
        });
        return false;
    }
}
// FIX Bug #18: waitForElement() was defined but never called — removed dead code
// FIX Bug #4 + #18: handleCitySelection() crashes (undefined pageData/locationsArray) and was never called — removed dead code

// FIX Bug #18: validateStorageData() was defined but never called — removed dead code
// FIX Bug #18: getPageData() was defined but never called (main flow uses extractPageData directly) — removed dead code
document.addEventListener("DOMContentLoaded", async () => {
    await checkStatusActivate()
}), window.addEventListener("beforeunload", () => {
    dateCheckInterval && (clearInterval(dateCheckInterval), dateCheckInterval = null)
});
const schedulerPort = chrome.runtime.connect({
    name: "scheduler"
});

function stopAllOperations() {
    dateCheckInterval && (clearInterval(dateCheckInterval), dateCheckInterval = null);
    schedulingPageHandled = !1;
    isProcessing = !1;
    stopSyncInterval();
    stopCFKeepalive();
}
// Backend removed: book() was a vendor telemetry POST (/book-cgi); booking itself is direct-to-portal.
async function book() { /* no-op: vendor report removed */ }
async function fetchFamilyMembers(e, t, a) {
    try {
        let r = window.location.href,
            o = "";
        o = r.includes("/ofc-schedule") ? r.includes("reschedule=true") ? "/api/v1/schedule-group/query-family-members-ofc-reschedule" : "/api/v1/schedule-group/query-family-members-ofc" : r.includes("/schedule") ? r.includes("reschedule=true") ? "/api/v1/schedule-group/query-family-members-consular-reschedule" : "/api/v1/schedule-group/query-family-members-consular" : "/api/v1/schedule-group/query-family-members-ofc-reschedule";
        let n = Date.now(),
            i = `https://www.usvisascheduling.com/en-US/custom-actions/?route=${o}&appd=${t}&cacheString=${n}`,
            l = new URLSearchParams;
        l.append("parameters", JSON.stringify({
            primaryId: e,
            visaClass: "all"
        }));
        let s = {
                accept: "application/json, text/javascript, */*; q=0.01",
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-requested-with": "XMLHttpRequest",
                cookie: a ? a.getCookieHeader() : document.cookie
            },
            c = await fetch(i, {
                method: "POST",
                headers: s,
                body: l,
                credentials: "include"
            });
        if (!c.ok) throw Error(`Failed to fetch family members: ${c.status} ${c.statusText}`);
        let d = await c.json();
        if (d.HasError) throw Error(`API error: ${d.LocalizedGenericErrorMessage || "Unknown error"}`);
        if (!d.Members || !Array.isArray(d.Members)) return console.warn("No members found or invalid response format"), [{
            ApplicationID: e,
            FullName: "Primary Applicant",
            VisaClassName: "Unknown"
        }];
        let u = d.Members.map(e => e.ApplicationID),
            p = {};
        return d.Members.forEach(e => {
            p[e.ApplicationID] = e.VisaClassName
        }), await chrome.storage.local.set({
            applications: u,
            visaClassNames: p
        }), d.Members
    } catch (h) {
        return console.error("Error fetching members:", h), console.error("Error stack:", h.stack), [{
            ApplicationID: e,
            FullName: "Primary Applicant",
            VisaClassName: "Unknown"
        }]
    }
}
// FIX Bug #16: schedulerPort.onConnect is not a valid Port property (removed dead code)
schedulerPort.onDisconnect && schedulerPort.onDisconnect.addListener(function() {
    setTimeout(() => {
        try {
            chrome.runtime.connect({
                name: "scheduler_reconnect"
            })
        } catch (e) {
            console.error("rescheduler.js: Failed to reconnect port:", e)
        }
    }, 5e3)
});
schedulerPort.onMessage.addListener(async function(e) {
    if ("fetch_info" == e.action) {
        let t = e.data.$active;
        isSchedulerActive = t, t ? await validateToContinue() || initializeSchedulingPage() : stopAllOperations()
    } else if ("activate" == e.action) {
        let a = e.status;
        isSchedulerActive = a, a ? initializeSchedulingPage() : stopAllOperations()
    }
});
schedulerPort.postMessage({
    action: "fetch_info"
});
chrome.runtime.onMessage.addListener((e, t, a) => {
    "notificate" === e.action ? (toast("Changes saved successfully."), e.value && ("fpFrequencyValue" == e.value || "frequencyType" == e.value || "activate" == e.value || "autobook" == e.value) && location.reload()) : "wake" === e.action && (toast("Keep Awake saved successfully." + e.value), !0 === e.value ? chrome.runtime.connect({
        name: "scheduler"
    }).postMessage({
        action: "requestKeepAwake"
    }) : chrome.runtime.connect({
        name: "scheduler"
    }).postMessage({
        action: "releaseKeepAwake"
    }))
});