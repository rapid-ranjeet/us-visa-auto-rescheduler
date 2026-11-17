#!/usr/bin/env python3
"""FalconPath Phase 2/3 launcher.

Seeds chrome.storage.local (LevelDB) for a profile *before* Chrome starts,
then launches a browser instance per account. Also usable standalone:

    python3 launcher.py seed acc1
    python3 launcher.py launch acc1 [--browser brave]
    python3 launcher.py stop acc1
    python3 launcher.py status

Phase 3 — fingerprint control: set FP_BROWSER=brave for per-session
canvas/WebGL randomization on each profile. Any Chromium-family binary
works; Firefox does not (no chrome.debugger → Turnstile clicker dies).

Storage format verified against a live Chrome profile: keys are plain,
values are compact JSON bytes.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time

EXT_ID = "hemhplgafablbphgcnadfefolicfdiga"   # stable: manifest.json carries "key"
ROOT = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.dirname(ROOT)                # repo root = unpacked extension
PROFILES = os.path.expanduser("~/.falconpath/profiles")
PORTAL = "https://www.usvisascheduling.com"
SCRAMBLE_KEY = "scramble_29k_1z"               # mirrors js/content.js (public in source)
SCRAMBLE_PREFIX = "__nx__"

BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
            "brave-browser", "microsoft-edge", "vivaldi-stable"]


def browser_path(name=None):
    if name:
        p = shutil.which(name) or (name if os.path.isfile(name) else None)
        if not p:
            raise SystemExit(f"browser not found: {name}")
        return p
    for b in BROWSERS:
        p = shutil.which(b)
        if p:
            return p
    raise SystemExit("no Chromium-family browser found on PATH")


def scramble(s):
    """Mirror js/content.js scramble(): XOR each char with rotating key, btoa, prefix.
    Non-latin1 chars make JS btoa throw -> JS stores raw. Mirror that."""
    if not s:
        return s
    try:
        out = bytearray()
        for i, ch in enumerate(s):
            c = ord(ch)
            if c > 255:
                return s
            out.append(c ^ ord(SCRAMBLE_KEY[i % len(SCRAMBLE_KEY)]))
        return SCRAMBLE_PREFIX + base64.b64encode(bytes(out)).decode()
    except Exception:
        return s


def build_storage(name, acc):
    """Account config -> chrome.storage.local key/value map (values are Python JSON types)."""
    email = (acc.get("email") or "").strip().lower()
    if not email or not acc.get("password"):
        raise ValueError("account needs email and password")

    sec = acc.get("security") or []
    if len(sec) != 3 or any(not q.get("q") or not q.get("a") for q in sec):
        raise ValueError("security needs exactly 3 entries with q and a")

    dates = acc.get("dates") or {}
    if not dates.get("from") or not dates.get("to"):
        raise ValueError("dates.from and dates.to are required")

    itv = acc.get("interval") or {}
    unit = itv.get("unit", "seconds")
    if unit not in ("seconds", "minutes", "hours"):
        raise ValueError("interval.unit must be seconds|minutes|hours")

    cities = acc.get("cities") or {}
    cons = [c for c in (cities.get("consular") or []) if c]
    ofc = [c for c in (cities.get("ofc") or []) if c]
    if not cons:
        raise ValueError("at least one consular city required (interview location)")
    # Pending IDs: extension's reconcilePendingSelections upgrades them to the
    # portal's real city IDs (matched by name) on the first scheduling-page visit.
    cons_map = {f"__pending__:{i}": name for i, name in enumerate(cons)}
    ofc_map = {f"__pending__:{i}": name for i, name in enumerate(ofc)}

    return {
        "fp_usr": email,
        "fp_pw": scramble(acc["password"]),
        "fp_sq": [{"question": q["q"], "answer": scramble(q["a"])} for q in sec],
        "fp_uc": True,                       # skip onboarding modal
        "fp_act": True,                      # scheduler active
        "fp_ab": bool(acc.get("auto_book", True)),
        "fp_st": dates["from"],
        "fp_en": dates["to"],
        "fp_fq": int(itv.get("value", 30)),
        "fp_fqType": unit,
        "fp_consularCities": cons_map,
        "fp_consularSelectedCities": list(cons_map),
        "fp_ofcCities": ofc_map,
        "fp_ofcSelectedCities": list(ofc_map),
        "fp_account": name,                  # tags all localhost events so the bot knows who booked
    }


def seed(name, acc):
    """Write storage for profile `name`. Chrome must not be running that profile."""
    import plyvel  # deferred: `stop`/`status` work without it

    data_dir = os.path.join(PROFILES, name, "Default", "Local Extension Settings", EXT_ID)
    os.makedirs(data_dir, exist_ok=True)
    store = build_storage(name, acc)
    db = plyvel.DB(data_dir, create_if_missing=True)
    try:
        for k, v in store.items():
            db.put(k.encode(), json.dumps(v, separators=(",", ":")).encode())
    finally:
        db.close()
    return len(store)


def profile_cmd(name):
    browser = browser_path(os.environ.get("FP_BROWSER"))
    profile = os.path.join(PROFILES, name)
    os.makedirs(profile, exist_ok=True)
    return [
        browser,
        f"--user-data-dir={profile}",
        f"--load-extension={EXT_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1200,900",
        PORTAL,
    ]


TRACKED: dict[str, subprocess.Popen] = {}


def launch(name):
    """Spawn the browser on a real or virtual display.

    Real display available  -> use it as-is.
    No display (headless server) -> start a private Xvfb for this profile,
    record its pid, and tear it down when the browser exits (daemon thread).
    """
    cmd = profile_cmd(name)
    env = os.environ.copy()
    xvfb_pid = None
    if not env.get("DISPLAY"):
        x = shutil.which("Xvfb")
        if not x:
            raise SystemExit(
                "no DISPLAY and no Xvfb — install xvfb (apt install xvfb) "
                "or run with a real display"
            )
        display = f":{90 + (int(hashlib.md5(name.encode()).hexdigest(), 16) % 500)}"
        xvfb = subprocess.Popen(
            [x, display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(30):
            if os.path.exists(f"/tmp/.X11-unix/X{display[1:]}"):
                break
            time.sleep(0.2)
        env["DISPLAY"] = display
        xvfb_pid = xvfb.pid

    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=env, start_new_session=True)
    TRACKED[name] = p

    if xvfb_pid is not None:
        # Poll (not wait): Chrome children can hold stdio pipes open, so
        # wait() never returns. poll() doesn't depend on the pipes.
        def _cleanup():
            while p.poll() is None:
                time.sleep(1)
            try:
                os.kill(xvfb_pid, 15)
            except ProcessLookupError:
                pass
        threading.Thread(target=_cleanup, daemon=True).start()
    return p.pid


def running_pids(name):
    """Prefer the tracked Popen from launch(); fall back to pgrep -f for
    browser instances started outside this process (e.g. via the shell
    script)."""
    p = TRACKED.get(name)
    if p is not None:
        if p.poll() is None:
            return [p.pid]
        TRACKED.pop(name, None)
        return []
    needle = f"--user-data-dir={os.path.join(PROFILES, name)}"
    try:
        out = subprocess.run(["pgrep", "-f", needle], capture_output=True, text=True)
        return [int(x) for x in out.stdout.split() if x.strip()]
    except FileNotFoundError:
        return []


def stop(name):
    pids = running_pids(name)
    for pid in pids:
        try:
            # Kill the whole process group: Chrome spawns children that would
            # otherwise survive a single-SIGTERM to the parent.
            os.killpg(pid, 15)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
    if pids:
        time.sleep(1)
        for pid in pids:
            try:
                os.killpg(pid, 9)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
        TRACKED.pop(name, None)
    return bool(pids)


def accounts_path():
    return os.path.join(ROOT, "accounts.json")


def load_accounts():
    p = accounts_path()
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def save_accounts(data):
    p = accounts_path()
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(p, 0o600)   # file holds plaintext portal creds
    except OSError:
        pass


def status_lines():
    accounts = load_accounts()
    lines = []
    for name in sorted(accounts):
        pids = running_pids(name)
        state = f"RUNNING pid={pids[0]}" if pids else "stopped"
        itv = accounts[name].get("interval", {})
        lines.append(f"{name}: {state} · every {itv.get('value', 30)} "
                     f"{itv.get('unit', 'seconds')} · {accounts[name].get('email', '?')}")
    return lines or ["no accounts — use the Telegram bot /add or edit accounts.json"]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    op, rest = sys.argv[1], sys.argv[2:]
    accounts = load_accounts()

    if op == "seed":
        name = rest[0]
        if name not in accounts:
            raise SystemExit(f"unknown account: {name}")
        if running_pids(name):
            raise SystemExit(f"{name} is running — stop it before seeding")
        print(f"seeded {seed(name, accounts[name])} keys into profile {name}")
    elif op == "launch":
        name = rest[0]
        # Phase 3: optional --browser flag overrides FP_BROWSER env
        if "--browser" in rest:
            os.environ["FP_BROWSER"] = rest[rest.index("--browser") + 1]
        if name not in accounts:
            raise SystemExit(f"unknown account: {name}")
        print(f"launched {name} pid={launch(name)}")
    elif op == "stop":
        name = rest[0]
        print("stopped" if stop(name) else "was not running")
    elif op == "status":
        print("\n".join(status_lines()))
    else:
        raise SystemExit(f"unknown op: {op}")


if __name__ == "__main__":
    main()
