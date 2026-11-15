#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# FalconPath — Phase 1: plain Chrome-profile launcher
#
# Boots N isolated Chrome profiles, each with this extension loaded,
# each with its own staggered scan interval. No Python, no bot.
# Credentials are entered once per profile via the onboarding modal.
#
# Usage:
#   ./chrome-profiles.sh 3                 # 3 profiles, default stagger
#   ./chrome-profiles.sh 5 1200            # 5 profiles, 1200s between launches
#   BROWSER=brave ./chrome-profiles.sh 3   # any Chromium-family binary
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

N="${1:-3}"
STAGGER="${2:-900}"                       # seconds between launches (default 15 min)
BROWSER="${BROWSER:-google-chrome}"
EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_ROOT="${PROFILE_ROOT:-$HOME/.falconpath/profiles}"
PORTAL="https://www.usvisascheduling.com"

# Staggered scan intervals per profile (seconds) — one IP, don't burst.
# acc1 scans every 30s, acc2 every 45s, acc3 every 60s, etc.
INTERVALS=(30 45 60 75 90 105 120 135 150 165)

for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
    command -v "$b" >/dev/null 2>&1 && { command -v "$BROWSER" >/dev/null 2>&1 || BROWSER="$b"; }
done
command -v "$BROWSER" >/dev/null 2>&1 || { echo "No Chromium-family browser found"; exit 1; }

mkdir -p "$PROFILE_ROOT"
echo "Browser : $BROWSER"
echo "Profiles: $N (stagger ${STAGGER}s, interval rotation: ${INTERVALS[*]:0:$N})"

pids=()
for i in $(seq 1 "$N"); do
    dir="$PROFILE_ROOT/acc$i"
    mkdir -p "$dir"
    echo "[acc$i] launching → $dir"
    "$BROWSER" \
        --user-data-dir="$dir" \
        --load-extension="$EXT_DIR" \
        --no-first-run \
        --no-default-browser-check \
        --window-size=1200,900 \
        "$PORTAL" &
    pids+=($!)
    sleep "$STAGGER"
done

echo
echo "All $N profiles launched. First-run per profile:"
echo "  1. Enter portal credentials in the onboarding modal"
echo "  2. Set date range + pick cities in the popup"
echo "  3. Hit ENGAGE SCANNER"
echo
echo "Phase 2 note: to pre-seed credentials instead, use launcher.py (Telegram bot)."
wait
