#!/usr/bin/env python3
"""FalconPath Telegram controller (Phase 2) — stdlib only, no pip installs.

Control plane for N browser profiles running the FalconPath extension.
Python never touches the tabs: it seeds storage before launch, spawns the
browser, and relays booking events the extension POSTs to localhost.

Commands:
    /start                     help
    /add                       wizard: email, password, 3 security Q&A,
                               date range, interval, cities (one per line)
    /accounts                  list accounts + running state
    /startacc <name>           seed storage + launch browser
    /stopacc <name>            kill that profile's browser
    /stopall                   kill all FalconPath browsers
    /remove <name>             forget account (profile dir kept)
    /events                    last 20 events

Security: single-tenant. Set FALCON_TG_TOKEN (BotFather) and
FALCON_TG_ALLOWED (comma-separated Telegram user ids) in the environment —
messages from anyone else are ignored.

Event flow: extension POSTs {"kind","text"} -> 127.0.0.1:8765 -> events.json
-> relayed to your chat.
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import launcher

BOT_TOKEN = os.environ.get("FALCON_TG_TOKEN", "")
API = f"https://api.telegram.org/bot{BOT_TOKEN}/"
ALLOWED = {x.strip() for x in os.environ.get("FALCON_TG_ALLOWED", "").split(",") if x.strip()}
LISTEN_PORT = int(os.environ.get("FALCON_EVENT_PORT", "8765"))

EVENTS_PATH = os.path.join(launcher.ROOT, "events.json")
MAX_EVENTS = 200

if not BOT_TOKEN:
    raise SystemExit("set FALCON_TG_TOKEN (BotFather token)")
if not ALLOWED:
    raise SystemExit("set FALCON_TG_ALLOWED (your numeric Telegram user id)")

QSLUGS = {
    "1": "Where did you meet your spouse?", "2": "What is the name of the road/street you grew up on?",
    "3": "What is your mother's maiden name?", "4": "What was your first car?",
    "5": "In what city or town was your first job?", "6": "What is your least favorite food?",
    "7": "What is your favorite food?", "8": "What high school did you attend?",
    "9": "What was the name of your first/current/favorite pet?", "10": "Who was your childhood hero?",
    "11": "What was the first company that you worked for?",
    "12": "What is the name of the town/city where you were born?",
    "13": "What is the name of a college you applied to but didnt attend?",
    "14": "What is your sibling's middle name?",
}
FIELDS = ["email", "password", "q1", "a1", "q2", "a2", "q3", "a3",
          "from", "to", "interval_value", "interval_unit", "cities"]

WIZ: dict[int, dict] = {}


# ── Telegram stdlib client ────────────────────────────────────────────
def tg(method, **params):
    data = urllib.parse.urlencode(params).encode()
    with urllib.request.urlopen(API + method, data, timeout=60) as r:
        return json.load(r)


def send(chat_id, text, silent_errors=True):
    try:
        tg("sendMessage", chat_id=chat_id, text=text[:4000])
    except Exception as e:
        if not silent_errors:
            print("send failed:", e)


def log_event(kind, text):
    try:
        ev = json.load(open(EVENTS_PATH)) if os.path.exists(EVENTS_PATH) else []
    except Exception:
        ev = []
    ev.append({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "text": text,
               "relayed": False})
    with open(EVENTS_PATH, "w") as f:
        json.dump(ev[-MAX_EVENTS:], f)


# ── wizard ────────────────────────────────────────────────────────────
def next_field(w):
    done = w.get("_done", set())
    for f in FIELDS:
        if f not in done:
            return f
    return None


def prompt_for(field):
    if field == "email":
        return "Portal email or username:"
    if field == "password":
        return "Portal password:"
    if field[0] == "q" and field[1:].isdigit():
        return "Security question " + field[1] + " — send the number:\n" + \
            "\n".join(f"{k}. {v}" for k, v in QSLUGS.items())
    if field[0] == "a" and field[1:].isdigit():
        return f"Answer for security question {field[1]}:"
    if field == "from":
        return "Earliest date (YYYY-MM-DD):"
    if field == "to":
        return "Latest date (YYYY-MM-DD):"
    if field == "interval_value":
        return "Scan every N (number, min 5):"
    if field == "interval_unit":
        return "Unit: seconds / minutes / hours"
    if field == "cities":
        return ("Cities — one per line, OFC (biometrics) first, then consular.\n"
                "Example:\nHYDERABAD VAC\nCHENNAI VAC\nHYDERABAD\nCHENNAI\n\n"
                "Names are matched to real portal IDs on the first visit.")
    return "?"


def parse_field(w, field, text):
    import datetime
    t = (text or "").strip()
    if field == "email":
        w["email"] = t.lower()
        # keep '+' — Gmail plus-tags are real addresses; only swap dots/specials in the account name
        w["name"] = t.split("@")[0].replace(".", "_").replace("+", "-")[:20] or "acc"
    elif field == "password":
        if not t:
            return "Password cannot be empty."
        w["password"] = t
    elif field[0] == "q" and field[1:].isdigit():
        if t not in QSLUGS:
            return "Send a number from the list."
        w[field] = QSLUGS[t]
    elif field[0] == "a" and field[1:].isdigit():
        if not t:
            return "Answer cannot be empty."
        w[field] = t
    elif field == "from":
        try:
            datetime.date.fromisoformat(t)
        except ValueError:
            return "Format: YYYY-MM-DD"
        w[field] = t
    elif field == "to":
        try:
            d = datetime.date.fromisoformat(t)
        except ValueError:
            return "Format: YYYY-MM-DD"
        if w.get("from") and d.isoformat() <= w["from"]:
            return "Latest date must be after the earliest date."
        w[field] = t
    elif field == "interval_value":
        if not t.isdigit() or int(t) < 5:
            return "Number >= 5."
        w[field] = int(t)
    elif field == "interval_unit":
        if t not in ("seconds", "minutes", "hours"):
            return "seconds / minutes / hours"
        w[field] = t
    elif field == "cities":
        lines = [x.strip().upper() for x in t.splitlines() if x.strip()]
        w["ofc"] = [x for x in lines if "VAC" in x]
        w["consular"] = [x for x in lines if "VAC" not in x]
    return None


def wizard_step(chat_id, w, text):
    field = next_field(w)
    if field is None:
        send(chat_id, "Wizard already complete — /add to start over.")
        return
    err = parse_field(w, field, text)
    if err:
        send(chat_id, err + "\n" + prompt_for(field))
        return
    w.setdefault("_done", set()).add(field)
    nxt = next_field(w)
    if nxt:
        send(chat_id, prompt_for(nxt))
        return
    # ── finish ──
    accounts = launcher.load_accounts()
    base, name, i = w.get("name") or "acc", w.get("name") or "acc", 2
    while name in accounts:
        name = f"{base}{i}"
        i += 1
    accounts[name] = {
        "email": w["email"],
        "password": w["password"],
        "security": [{"q": w[f"q{k}"], "a": w[f"a{k}"]} for k in (1, 2, 3)],
        "dates": {"from": w["from"], "to": w["to"]},
        "interval": {"value": w["interval_value"], "unit": w["interval_unit"]},
        "cities": {"ofc": w.get("ofc", []), "consular": w.get("consular", [])},
        "auto_book": True,
    }
    launcher.save_accounts(accounts)
    WIZ.pop(chat_id, None)
    send(chat_id, f"Saved as {name} (0600, plaintext — this box holds portal creds).\n"
                  f"/startacc {name} to seed + launch.")


# ── command dispatch ──────────────────────────────────────────────────
HELP = ("FalconPath controller.\n\n"
        "/add — add an account (wizard)\n"
        "/accounts — status of all accounts\n"
        "/settings <name> — view config\n"
        "/set <name> <field> — edit one field\n"
        "/startacc <name> — seed + launch\n"
        "/stopacc <name> — stop\n"
        "/stopall — stop everything\n"
        "/remove <name> — forget account (alias /delacc)\n"
        "/events — recent booking events\n"
        "/cancel — abandon current wizard/edit")


def fmt_account(name, a):
    sec = a.get("security") or []
    itv = a.get("interval") or {}
    d = a.get("dates") or {}
    c = a.get("cities") or {}
    return (f"`{name}`\n"
            f"  email: {a.get('email', '?')}\n"
            f"  password: {'•' * 8} (use /set {name} password)\n"
            f"  security: {len(sec)}/3 answered\n"
            f"  dates: {d.get('from', '?')} → {d.get('to', '?')}\n"
            f"  interval: every {itv.get('value', '?')} {itv.get('unit', 'seconds')}\n"
            f"  ofc: {', '.join(c.get('ofc') or []) or '—'}\n"
            f"  consular: {', '.join(c.get('consular') or []) or '—'}\n"
            f"  auto_book: {'on' if a.get('auto_book', True) else 'off'}")


EDIT_FIELDS = {
    "email": "email",
    "password": "password",
    "q1": "security[0].q", "a1": "security[0].a",
    "q2": "security[1].q", "a2": "security[1].a",
    "q3": "security[2].q", "a3": "security[2].a",
    "from": "dates.from", "to": "dates.to",
    "interval_value": "interval.value", "interval_unit": "interval.unit",
    "cities": "cities (ofc first, then consular, one per line)",
    "auto_book": "auto_book (on/off)",
}


def settings_view(chat_id, name, accounts):
    a = accounts[name]
    out = fmt_account(name, a)
    out += "\n\nEditable fields:\n" + "\n".join(
        f"  /set {name} {k}" for k in EDIT_FIELDS)
    out += "\n\n/startacc " + name + " to apply."
    send(chat_id, out)


def begin_edit(chat_id, name, field):
    accounts = launcher.load_accounts()
    if name not in accounts:
        send(chat_id, f"unknown account: {name}")
        return
    if field not in EDIT_FIELDS:
        send(chat_id, "unknown field. Editable: " + ", ".join(EDIT_FIELDS))
        return
    w = {"_edit": name, "_field": field}
    # Pre-fill for fields where we want a numbered list (security questions)
    WIZ[chat_id] = w
    if field[0] == "q" and field[1:].isdigit():
        send(chat_id, prompt_for(field))
    elif field == "auto_book":
        cur = accounts[name].get("auto_book", True)
        send(chat_id, f"auto_book is currently {'on' if cur else 'off'}. Send `on` or `off`.")
    else:
        send(chat_id, f"Send new value for `{EDIT_FIELDS[field]}`:")


def commit_edit(chat_id, name, field, text):
    accounts = launcher.load_accounts()
    a = accounts[name]
    t = (text or "").strip()
    if field == "email":
        a["email"] = t.lower()
    elif field == "password":
        if not t:
            send(chat_id, "empty — aborted"); return
        a["password"] = t
    elif field[0] == "q" and field[1:].isdigit():
        if t not in QSLUGS:
            send(chat_id, "send a number from the list"); return
        idx = int(field[1]) - 1
        a.setdefault("security", [{}, {}, {}])
        while len(a["security"]) < 3:
            a["security"].append({})
        a["security"][idx]["q"] = QSLUGS[t]
    elif field[0] == "a" and field[1:].isdigit():
        if not t:
            send(chat_id, "empty — aborted"); return
        idx = int(field[1]) - 1
        a.setdefault("security", [{}, {}, {}])
        while len(a["security"]) < 3:
            a["security"].append({})
        a["security"][idx]["a"] = t
    elif field == "from":
        import datetime
        try: datetime.date.fromisoformat(t)
        except ValueError:
            send(chat_id, "Format: YYYY-MM-DD"); return
        a.setdefault("dates", {})["from"] = t
    elif field == "to":
        import datetime
        try: d = datetime.date.fromisoformat(t)
        except ValueError:
            send(chat_id, "Format: YYYY-MM-DD"); return
        a.setdefault("dates", {})["to"] = t
    elif field == "interval_value":
        if not t.isdigit() or int(t) < 5:
            send(chat_id, "Number >= 5."); return
        a.setdefault("interval", {})["value"] = int(t)
    elif field == "interval_unit":
        if t not in ("seconds", "minutes", "hours"):
            send(chat_id, "seconds / minutes / hours"); return
        a.setdefault("interval", {})["unit"] = t
    elif field == "cities":
        lines = [x.strip().upper() for x in t.splitlines() if x.strip()]
        a["cities"] = {
            "ofc": [x for x in lines if "VAC" in x],
            "consular": [x for x in lines if "VAC" not in x],
        }
    elif field == "auto_book":
        if t.lower() not in ("on", "off"):
            send(chat_id, "send `on` or `off`"); return
        a["auto_book"] = (t.lower() == "on")
    launcher.save_accounts(accounts)
    WIZ.pop(chat_id, None)
    send(chat_id, f"updated `{name}`.{EDIT_FIELDS[field]}\n\n{fmt_account(name, a)}\n\n"
                  f"/startacc {name} to apply (must be stopped first).")



def handle(chat_id, user_id, text):
    if str(user_id) not in ALLOWED:
        return
    text = (text or "").strip()
    if chat_id in WIZ and not text.startswith("/"):
        w = WIZ[chat_id]
        if w.get("_edit"):
            commit_edit(chat_id, w["_edit"], w["_field"], text)
        else:
            wizard_step(chat_id, w, text)
        return
    parts = text.split()
    cmd, args = (parts[0].split("@")[0] if parts else ""), parts[1:]

    if cmd == "/start":
        send(chat_id, HELP)
    elif cmd == "/cancel":
        if chat_id in WIZ:
            WIZ.pop(chat_id, None)
            send(chat_id, "aborted")
        else:
            send(chat_id, "nothing to cancel")
    elif cmd == "/add":
        WIZ[chat_id] = {}
        send(chat_id, "New account wizard.\n" + prompt_for("email") +
             "\n\n(/cancel to abort)")
    elif cmd == "/settings":
        accounts = launcher.load_accounts()
        if not args:
            if not accounts:
                send(chat_id, "no accounts — /add")
                return
            send(chat_id, "Usage: /settings <name>\n\n" +
                 "\n".join(f"  `{n}`" for n in accounts))
            return
        if args[0] not in accounts:
            send(chat_id, f"unknown account: {args[0]}")
            return
        settings_view(chat_id, args[0], accounts)
    elif cmd == "/set":
        if len(args) < 2:
            send(chat_id, "usage: /set <name> <field>\nfields: " + ", ".join(EDIT_FIELDS))
            return
        begin_edit(chat_id, args[0], args[1])
    elif cmd == "/accounts":
        send(chat_id, "\n".join(launcher.status_lines()))
    elif cmd == "/startacc":
        accounts = launcher.load_accounts()
        name = args[0] if args else ""
        if name not in accounts:
            send(chat_id, f"unknown account: {name or '(none)'}")
            return
        if launcher.running_pids(name):
            send(chat_id, f"{name} already running")
            return
        try:
            n = launcher.seed(name, accounts[name])
        except Exception as e:
            send(chat_id, f"seed failed: {e}")
            return
        pid = launcher.launch(name)
        log_event("launch", f"{name} pid={pid}")
        send(chat_id, f"{name}: {n} keys seeded, browser pid={pid}. Keep the display on.")
    elif cmd == "/stopacc":
        if not args:
            send(chat_id, "usage: /stopacc <name>")
            return
        send(chat_id, "stopped" if launcher.stop(args[0]) else "was not running")
    elif cmd == "/stopall":
        accounts = launcher.load_accounts()
        n = sum(1 for name in accounts if launcher.stop(name))
        send(chat_id, f"stopped {n} profile(s)")
    elif cmd in ("/remove", "/delacc"):
        accounts = launcher.load_accounts()
        if args and args[0] in accounts:
            launcher.stop(args[0])
            del accounts[args[0]]
            launcher.save_accounts(accounts)
            send(chat_id, f"{args[0]} removed (profile dir kept for reuse)")
        else:
            send(chat_id, "unknown account")
    elif cmd == "/events":
        try:
            ev = json.load(open(EVENTS_PATH))[-20:]
        except Exception:
            ev = []
        send(chat_id, "\n".join(f"{e['t']} [{e['kind']}] {e['text']}" for e in ev) or "no events")
    else:
        send(chat_id, "Unknown command. /start for help.")


# ── localhost event hook (extension POSTs here) ───────────────────────
class EventHook(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/event":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            payload = {}
        kind = payload.get("kind", "event")
        acct = payload.get("account", "?")
        text = payload.get("text", json.dumps(payload)[:200])
        log_event(kind, f"[{acct}] {text}")
        # CORS: content-script POSTs arrive with an Origin header; allow the reply
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def log_message(self, *a):
        pass


def relay_events():
    """Push un-relayed events to the first allowed chat.
    Index watermark (not last-3 window) — concurrent bookings from N accounts
    can land in one 2s tick, and a tail window would silently drop the older
    ones. Watermark guarantees no event is skipped regardless of burst size."""
    sent = 0
    while True:
        time.sleep(2)
        try:
            if not os.path.exists(EVENTS_PATH):
                continue
            ev = json.load(open(EVENTS_PATH))
            if len(ev) < sent:
                sent = 0  # rotated
            new = ev[sent:]
            for e in new:
                send(int(next(iter(ALLOWED))), f"[{e['kind']}] {e['text']}")
            sent += len(new)
        except Exception:
            pass


def poll_loop():
    offset = 0
    while True:
        try:
            res = tg("getUpdates", offset=offset, timeout=45)
            for upd in res.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message")
                if not msg:
                    continue
                handle(msg["chat"]["id"], msg["from"]["id"], msg.get("text"))
        except Exception as e:
            print("poll error:", e)
            time.sleep(5)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), EventHook)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=relay_events, daemon=True).start()
    print(f"event hook on 127.0.0.1:{LISTEN_PORT}; polling Telegram…")
    poll_loop()


if __name__ == "__main__":
    main()
