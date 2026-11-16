# FalconPath — Multi-Account Controller (Phase 1 → 3)

This branch adds the orchestration layer around the working extension.
The extension code stays byte-compatible with `main` — the only JS edits
are 3 event-hook POSTs so Python knows when something happened.

## Phase 1 — plain profiles, zero code

```bash
./chrome-profiles.sh 3          # 3 Chrome profiles, staggered intervals
# or:  ./chrome-profiles.sh 5 1200   (5 profiles, 20 min between launches)
# or:  BROWSER=brave ./chrome-profiles.sh 3
```

Each profile gets its own `~/.falconpath/profiles/accN/`, own `chrome.storage.local`,
own login session. Log in once per profile via the onboarding modal, then hit
ENGAGE SCANNER. Scan intervals rotate 30s / 45s / 60s per profile so N accounts
don't burst one IP.

## Phase 2 — Telegram controller

```
bot/bot.py         stdlib-only Telegram long-poll controller
bot/launcher.py    LevelDB seeder + browser subprocess launcher
accounts.json      created by /add wizard (chmod 600, gitignored)
events.json        booking/status event log (gitignored)
```

### Setup

```bash
pip3 install --user --break-system-packages plyvel   # only external dep
export FALCON_TG_TOKEN="123:ABC"        # from @BotFather
export FALCON_TG_ALLOWED="123456789"    # your numeric user id (@userinfobot)
./chrome-profiles.sh 1                  # optional — pre-create profile root
python3 bot/bot.py
```

**No display on the server?** `launcher.py` auto-starts a private Xvfb per
profile when `DISPLAY` is unset — install `xvfb` (apt) and it just works.
Display numbers are derived from the account name, so N profiles get N
isolated virtual screens without collisions. The X server is torn down with
the browser. On a real desktop, `DISPLAY` is already set and Chrome uses
your monitor directly — Xvfb is skipped.

Then in Telegram:

| Command | Effect |
|---|---|
| `/add` | Wizard: email → password → 3 security Q&A (send number + answer) → date range → scan interval → cities |
| `/accounts` | Status of all accounts + running state |
| `/startacc acc1` | Seed LevelDB from saved config + launch browser (headed) |
| `/stopacc acc1` | Kill that profile's browser |
| `/stopall` | Stop everything |
| `/remove acc1` | Forget account (profile dir kept) |
| `/events` | Last 20 booking / rate-limit / Cloudflare events |

When a booking succeeds, the extension POSTs to `http://127.0.0.1:8765/event`
→ the bot relays it to your chat as `[BOOKED] [acc2] 2026-12-12 09:00 @ HYDERABAD`.

The controller **never attaches to the tab** (no Playwright, no CDP). The
extension owns the page and the Turnstile clicker. That's what makes it work.

## Phase 3 — fingerprint control (evidence-based)

Set `FP_BROWSER` to swap engines:

```bash
export FP_BROWSER=brave-browser
python3 bot/bot.py                # now every launch uses Brave
# or one-shot: python3 bot/launcher.py launch acc1 --browser chromium
```

Brave randomizes canvas/WebGL fingerprint per session — that breaks the
cross-profile correlation Chrome profiles can't. Do this **only** when you
have evidence accounts are being linked (e.g., you see `NIKEN_STOPPED` /
`EXCEEDED_LIMIT` banners across all profiles at once). Don't preemptively
add complexity you haven't earned.

## Security notes

- `accounts.json` is `chmod 600` and holds portal creds **in plaintext** —
  the same trade-off as the extension's `chrome.storage.local`. Treat the box
  as sensitive. `events.json` never contains credentials.
- Telegram: single-tenant by design. `FALCON_TG_ALLOWED` is the only gate —
  set it to your numeric user id and nothing else.
- Localhost listener (`127.0.0.1:8765`) is bound to loopback only.
- No telemetry to any vendor. Everything stays on the machine except:
  your Telegram chat (booking events) and the portal itself.

## Verification

- `python3 -m py_compile bot/*.py` — pass
- `node --check js/*.js background.js` — pass
- Roundtrip test: Python seeds storage → `node -e "unscramble()"` decodes
  credentials byte-exact. Covered by the inline self-check in this README's
  history.
- Extension ID stable across all profiles (`manifest.json` keeps `"key"`) —
  same ID, no ID churn.

## What's deliberately not here

- Playwright / Selenium attaching to the browser: breaks the Turnstile
  clicker (CDP debugger conflict). Don't add it.
- Rewrite of scan/booking logic in Python: the extension already wins by
  riding the portal's own page requests. A rewrite is weeks of work to
  re-fight Cloudflare for zero speed gain.
- Firefox: no `chrome.debugger`. Dead end.

## Risks

- Portal ToS breach; account blocks / embassy rate limits land on the accounts.
- One IP shared by N accounts: portal throttles per-account, Cloudflare
  throttles per-IP. Staggered intervals are the only defense in this build.
- `chrome.storage.local` in profiles is XOR-obfuscated with a key that ships
  in the source. Anyone with filesystem access can recover credentials.
