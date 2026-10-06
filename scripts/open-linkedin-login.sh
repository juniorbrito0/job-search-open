#!/bin/bash
# Sign LinkedIn into the browser profile the unattended jobs actually use.
#
# Your normal Chrome session does NOT help here: the job search drives
# Playwright against its own profile at ~/.job-search/playwright-profile, and
# Chrome's cookies are encrypted with a Keychain key that cannot be copied over.
# So this needs doing once, at this Mac's own screen.
#
# Run it, sign in (password plus two-factor), wait for the LinkedIn home feed to
# load, then close the window. The session then persists for the jobs.
set -euo pipefail

# Resolve symlinks before locating the project. This is normally reached through
# ~/.job-search/open-linkedin-login.sh, which is a symlink; without resolving it,
# PROJECT lands on $HOME, the venv is not found, and the fallback system python3
# has no playwright module, so the script dies with ModuleNotFoundError.
TARGET="$0"
while [ -L "$TARGET" ]; do
  LINK="$(readlink "$TARGET")"
  case "$LINK" in
    /*) TARGET="$LINK" ;;
    *) TARGET="$(cd "$(dirname "$TARGET")" && pwd)/$LINK" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$TARGET")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

PY="$PROJECT/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "No project virtualenv at $PY." >&2
  echo "Setup has not finished yet. Ask Claude to run the setup again." >&2
  exit 1
fi

PROFILE="${HOME}/.job-search/playwright-profile"

mkdir -p "$PROFILE"

exec "$PY" - "$PROFILE" <<'PY'
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

profile = Path(sys.argv[1])
profile.mkdir(parents=True, exist_ok=True)

print("Opening LinkedIn in the job browser (a separate browser just for the job search).")
print("Sign in with your LinkedIn email and password, wait until you see your LinkedIn home feed, then close that browser window.")

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        headless=False,
        viewport={"width": 1280, "height": 900},
        args=["--disable-blink-features=AutomationControlled"],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded")
    page.wait_for_event("close", timeout=0)
    ctx.close()

print("Window closed. Checking whether the session was saved...")
import sqlite3
import shutil
import tempfile

cookies = profile / "Default" / "Cookies"
if not cookies.exists():
    print("No cookie store was written. Sign-in did not complete.")
    raise SystemExit(1)

tmp = Path(tempfile.mkdtemp()) / "Cookies"
shutil.copy(cookies, tmp)
names = {
    row[0]
    for row in sqlite3.connect(tmp).execute(
        "select name from cookies where host_key like '%linkedin%'"
    )
}
if "li_at" in names:
    print("Signed in. The job search can now use LinkedIn. You can close this Terminal window.")
else:
    print("Still not signed in (no li_at cookie). Run this again and complete the sign-in.")
    raise SystemExit(1)
PY
