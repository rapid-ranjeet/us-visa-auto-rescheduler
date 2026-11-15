# FalconPath Visa Assistant — US Visa Auto Rescheduler (local build)

Unpacked Chrome extension (Manifest V3) that monitors the CGI Federal US visa
scheduling portal (`usvisascheduling.com`) and automatically books earlier
appointment dates within a date range you choose.

This is a **local build**: the original "Niken" vendor backend, credit system,
payment flow, telemetry, and remote ban-check have all been removed. Everything
runs between your browser and the visa portal — nothing is sent to any
third-party server.

## Install (Load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`us-visa-auto-rescheduler-copy`)
5. Pin the extension and open `https://www.usvisascheduling.com`

> If Chrome reports an ID conflict with the store version, delete the
> `"key": "..."` line in `manifest.json` and click reload on the card.

## Setup

1. Open the visa portal — the extension asks (once) for:
   - portal email / username
   - portal password
   - answers to your security questions
2. From the popup: pick OFC and Consular locations, set earliest/latest date,
   set scan interval, toggle **Scheduler Active**
3. Optional: toggle **Auto-Confirm Booking** and **Keep Screen Awake**
4. Leave the portal tab open — it scans and books in that tab

## What was removed vs the store version

| Removed | Replacement |
|---|---|
| `usvisaserver.zapto.org` backend calls (`/users-cgi`, `/credits-cgi`, `/book-cgi`) | no-op stubs |
| Credit balance + deduction + "out of credits" gate | unlimited scanning |
| Payment flow (`payment.js`, upgrade button) | deleted |
| Remote ban/kill switch | deleted |
| Telemetry (email, version, booking reports) | deleted |
| `niken.us-visa.workers.dev` host permission | removed from manifest |

Everything else — login autofill, security-question fill, city detection,
scan loop, direct-API booking, DOM booking fallback, Cloudflare Turnstile
handling, notifications — is unchanged from the original extension.

## Files

```
manifest.json          MV3 config (portal + b2clogin + cloudflare hosts only)
background.js          service worker: CDP Turnstile clicker, notifications
js/portalNetworkHook.js  MAIN-world XHR hook + alert() suppression
js/rescheduler.js      scan loop, date matching, direct booking engine
js/content.js          login autofill, security questions
js/interface.js        popup wiring
index.html + css/      popup UI (amber/teal "FalconPath" theme)
```

## Notes & risk

- Portal credentials are stored in `chrome.storage.local` (XOR-scrambled with
  a key that ships in the source — treat the profile as sensitive).
- Automated booking may violate CGI Federal's terms of service; any
  rate-limit or account action from the embassy applies to your account.
- The `debugger` permission is used by the Turnstile click routine; Chrome
  will show a warning bar while it is active.
