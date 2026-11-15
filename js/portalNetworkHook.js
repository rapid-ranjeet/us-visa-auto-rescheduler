// portalNetworkHook.js — runs in MAIN world at document_start
// Intercepts the site's own XHR for schedule-days and schedule-entries,
// emits the response data as a CustomEvent so rescheduler.js can read it
// without making its own fetch() — Cloudflare sees the page's own requests.
(() => {
    "use strict";

    const BRIDGE_KEY = "fp-evt_" + Math.floor(Math.random() * 1e9).toString(36);
    try { sessionStorage.setItem("fp_bridge_key", BRIDGE_KEY); } catch(e) {}

    function emit(type, data, extra) {
        try {
            const detail = Object.assign({ type: type, data: data }, extra || {});
            window.dispatchEvent(new CustomEvent(BRIDGE_KEY, { detail: detail }));
        } catch(e) {}
    }

    const RE_CONSULAR_DAYS = /schedule-group\/get-family-consular-schedule-days/i;
    const RE_OFC_DAYS      = /schedule-group\/get-family-ofc-schedule-days/i;
    const RE_ENTRIES       = /schedule-group\/.*schedule-entries/i;

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        try { this.__fpUrl = String(url || ""); } catch(e) {}
        return nativeOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
        const url     = String(this.__fpUrl || "");
        const isConsular = RE_CONSULAR_DAYS.test(url);
        const isOFC      = RE_OFC_DAYS.test(url);
        const isEntries  = RE_ENTRIES.test(url);

        if (isConsular || isOFC || isEntries) {
            const reportFailure = (status) => {
                const code = Number(status);
                emit("FP_SCHEDULE_ERROR", null, { status: code });
            };

            this.addEventListener("error", () => reportFailure(0));
            this.addEventListener("abort", () => reportFailure(0));
            this.addEventListener("load", function() {
                if (this.status >= 400 || this.status === 0) {
                    reportFailure(this.status);
                    return;
                }
                try {
                    const parsed = JSON.parse(this.responseText);
                    if ((isConsular || isOFC) && parsed && Array.isArray(parsed.ScheduleDays)) {
                        emit("FP_DAYS_CAUGHT", parsed, { isOFC: isOFC });
                        return;
                    }
                    if (isEntries && parsed && Array.isArray(parsed.ScheduleEntries)) {
                        emit("FP_ENTRIES_CAUGHT", parsed);
                        return;
                    }
                } catch(e) {
                    reportFailure(0);
                }
            });
        }
        return nativeSend.apply(this, arguments);
    };

    // ── Intercept window.alert() — prevents PSE0501 and similar dialogs ──────
    // The scheduling site uses native alert() for server errors which completely
    // freezes extension JS until the user dismisses it. We suppress the dialog,
    // log the message to console, and emit a bridge event so rescheduler.js
    // can respond with an appropriate pause/recovery action.
    const _fpOrigAlert = window.alert.bind(window);
    window.alert = function(message) {
        const msg = String(message || '');
        console.warn('[FalconPath] Suppressed alert:', msg);
        try {
            const _key = sessionStorage.getItem('fp_bridge_key');
            if (_key) {
                window.dispatchEvent(new CustomEvent(_key, {
                    detail: { type: 'FP_ALERT_INTERCEPTED', message: msg }
                }));
            }
        } catch(e) {}
        // DO NOT call _fpOrigAlert — dialog is suppressed intentionally
    };

    // Also intercept confirm() and prompt() for completeness
    window.confirm = function(message) {
        console.warn('[FalconPath] Suppressed confirm:', message);
        return true; // auto-confirm
    };

})();
