#!/bin/bash
# One-command setup for the job search on this Mac. Safe to run again any time.
#
#   scripts/setup-mac.sh            everything: tools, Python, data files, schedule, checks
#   scripts/setup-mac.sh --tools    only install the tools (Python packages, Node, LibreOffice, browser)
#   scripts/setup-mac.sh --schedule only (re)install the background jobs from profile/candidate.json
#   scripts/setup-mac.sh --check    only report what is ready and what is missing
#   scripts/setup-mac.sh --uninstall  stop and remove the background jobs (keeps all data)
#   scripts/setup-mac.sh --shortcuts  (re)create the two Desktop icons
#
# Needs no administrator password: everything goes into this folder, ~/.local
# and ~/Applications. Uses Homebrew when it is already installed, but never
# installs Homebrew itself. Finds its own folder; do not edit paths by hand.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
ACCOUNT="$(whoami)"
HOME_DIR="${HOME:-/Users/$ACCOUNT}"
LAUNCH_DIR="$HOME_DIR/Library/LaunchAgents"
TEMPLATE_DIR="$SCRIPT_DIR/launchagents"
DOMAIN="gui/$(id -u)"
VENV="$PROJECT/.venv"
LOCAL_BIN="$HOME_DIR/.local/bin"
PROFILE_DIR="$HOME_DIR/.job-search/playwright-profile"
ARCH="$(uname -m)"   # arm64 (Apple silicon) or x86_64 (Intel)
export PATH="$LOCAL_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

MODE="${1:-all}"
ok()   { echo "  [ok]   $*"; }
todo() { echo "  [todo] $*"; }
step() { echo; echo "== $* =="; }

mkdir -p "$PROJECT/logs" "$LAUNCH_DIR" "$LOCAL_BIN" "$PROFILE_DIR"

# ---------------------------------------------------------------- where it lives
warn_documents() {
  case "$PROJECT" in
    "$HOME_DIR/Documents"*|"$HOME_DIR/Desktop"*|"$HOME_DIR/Downloads"*)
      echo "NOTE: this folder is inside Documents, Desktop or Downloads. macOS blocks"
      echo "background jobs there, so the scheduled searches would freeze. Move the"
      echo "folder to $HOME_DIR/job-search and run this again."
      return 1 ;;
  esac
  return 0
}

# ---------------------------------------------------------------- tools
need_clt() {
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "Apple's free developer tools are missing. A window will open: click Install,"
    echo "wait for it to finish (about 5 to 10 minutes), then run this setup again."
    xcode-select --install >/dev/null 2>&1 || true
    exit 2
  fi
}

pick_python() {
  for cand in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [[ -x "$cand" ]] && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

install_python_env() {
  step "Python packages (resume builder, browser for career pages)"
  local py
  py="$(pick_python)" || { echo "No Python 3.9 or newer found. Install Apple's developer tools first."; exit 1; }
  [[ -x "$VENV/bin/python" ]] || "$py" -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  if "$VENV/bin/pip" install -q -r "$PROJECT/requirements.txt"; then ok "Python packages installed"
  else echo "Python packages could not be installed (see the lines above)."; exit 1; fi
  "$VENV/bin/playwright" install chromium >/dev/null 2>&1 && ok "Browser for public career pages installed" \
    || todo "The browser for public career pages did not install; career pages that need it will be skipped"
}

node_bin() {
  for cand in "$LOCAL_BIN/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$cand" ]] && { echo "$cand"; return 0; }
  done
  return 1
}

install_node() {
  step "Node (runs the job browser that Claude drives)"
  if node_bin >/dev/null; then ok "Node is installed ($("$(node_bin)" --version))"; return; fi
  if command -v brew >/dev/null 2>&1; then
    brew install node >/dev/null && ok "Node installed with Homebrew"; return
  fi
  local ver arch tmp
  ver="$(curl -fsS https://nodejs.org/dist/index.json | /usr/bin/python3 -c 'import json,sys; print(next(x["version"] for x in json.load(sys.stdin) if x["lts"]))')"
  arch="$([[ "$ARCH" == "arm64" ]] && echo arm64 || echo x64)"
  tmp="$(mktemp -d)"
  local file="node-${ver}-darwin-${arch}.tar.gz"
  curl -fsSL "https://nodejs.org/dist/${ver}/${file}" -o "$tmp/$file" || { echo "Could not download Node."; return 1; }
  curl -fsSL "https://nodejs.org/dist/${ver}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "Node download failed its safety check. Stopping."; return 1; }
  rm -rf "$HOME_DIR/.local/node"
  mkdir -p "$HOME_DIR/.local/node"
  tar -xzf "$tmp/$file" -C "$HOME_DIR/.local/node" --strip-components 1
  for b in node npm npx; do ln -sfn "$HOME_DIR/.local/node/bin/$b" "$LOCAL_BIN/$b"; done
  rm -rf "$tmp"
  ok "Node $ver installed in your home folder (checksum verified)"
}

soffice_bin() {
  for cand in "$LOCAL_BIN/soffice" "$HOME_DIR/Applications/LibreOffice.app/Contents/MacOS/soffice" \
              /Applications/LibreOffice.app/Contents/MacOS/soffice /opt/homebrew/bin/soffice; do
    [[ -x "$cand" ]] && { echo "$cand"; return 0; }
  done
  return 1
}

install_libreoffice() {
  step "LibreOffice (turns resumes into PDFs, free)"
  if soffice_bin >/dev/null; then
    ln -sfn "$(soffice_bin)" "$LOCAL_BIN/soffice" 2>/dev/null
    ok "LibreOffice is installed"; return
  fi
  if command -v brew >/dev/null 2>&1; then
    brew install --cask libreoffice >/dev/null && ok "LibreOffice installed with Homebrew"
    ln -sfn /Applications/LibreOffice.app/Contents/MacOS/soffice "$LOCAL_BIN/soffice"; return
  fi
  local base="https://download.documentfoundation.org/libreoffice/stable"
  local ver dir file tmp mnt
  ver="$(curl -fsS "$base/" | grep -oE 'href="[0-9]+\.[0-9]+\.[0-9]+/"' | grep -oE '[0-9.]+[0-9]' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
  if [[ "$ARCH" == "arm64" ]]; then dir="aarch64"; file="LibreOffice_${ver}_MacOS_aarch64.dmg"
  else dir="x86_64"; file="LibreOffice_${ver}_MacOS_x86-64.dmg"; fi
  tmp="$(mktemp -d)"
  echo "  Downloading LibreOffice $ver (about 300 MB, a few minutes)..."
  curl -fsSL "$base/$ver/mac/$dir/$file" -o "$tmp/$file" || { echo "Could not download LibreOffice."; return 1; }
  local want got
  want="$(curl -fsSL "$base/$ver/mac/$dir/$file.sha256" | awk '{print $1}')"
  got="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"
  [[ -n "$want" && "$want" == "$got" ]] || { echo "LibreOffice download failed its safety check. Stopping."; rm -rf "$tmp"; return 1; }
  mnt="$(hdiutil attach -nobrowse -readonly "$tmp/$file" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  mkdir -p "$HOME_DIR/Applications"
  rm -rf "$HOME_DIR/Applications/LibreOffice.app"
  cp -R "$mnt/LibreOffice.app" "$HOME_DIR/Applications/"
  hdiutil detach "$mnt" -quiet || true
  rm -rf "$tmp"
  codesign --verify --deep "$HOME_DIR/Applications/LibreOffice.app" 2>/dev/null \
    || { echo "LibreOffice failed Apple's signature check. Removing it."; rm -rf "$HOME_DIR/Applications/LibreOffice.app"; return 1; }
  ln -sfn "$HOME_DIR/Applications/LibreOffice.app/Contents/MacOS/soffice" "$LOCAL_BIN/soffice"
  ok "LibreOffice $ver installed in your Applications folder (checksum and signature verified)"
}

claude_bin() {
  for cand in "$LOCAL_BIN/claude" "$HOME_DIR/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [[ -x "$cand" ]] && { echo "$cand"; return 0; }
  done
  return 1
}

install_browser_server() {
  step "Job browser for Claude (a separate browser that stays signed in to LinkedIn)"
  local npm_bin pw_bin claude
  npm_bin="$(dirname "$(node_bin)")/npm"
  pw_bin=""
  for cand in "$LOCAL_BIN/playwright-mcp" "$("$npm_bin" prefix -g 2>/dev/null)/bin/playwright-mcp"; do
    [[ -x "$cand" ]] && { pw_bin="$cand"; break; }
  done
  if [[ -z "$pw_bin" ]]; then
    "$npm_bin" install -g --prefix "$HOME_DIR/.local" @playwright/mcp@latest >/dev/null 2>&1
    pw_bin="$LOCAL_BIN/playwright-mcp"
  fi
  [[ -x "$pw_bin" ]] || { todo "Could not install the job browser server."; return 1; }
  ok "Job browser server installed"
  claude="$(claude_bin)" || { todo "Claude Code is not installed yet, so the job browser could not be connected."; return 1; }
  if "$claude" mcp list 2>/dev/null | grep -q '^playwright-session'; then
    ok "Claude already knows the job browser"
  else
    "$claude" mcp add --scope user playwright-session -- "$pw_bin" --user-data-dir "$PROFILE_DIR" >/dev/null 2>&1 \
      && ok "Connected the job browser to Claude" \
      || todo "Could not connect the job browser to Claude (run: claude mcp add --scope user playwright-session -- $pw_bin --user-data-dir $PROFILE_DIR)"
  fi
  ln -sfn "$SCRIPT_DIR/open-linkedin-login.sh" "$HOME_DIR/.job-search/open-linkedin-login.sh"
}

# ---------------------------------------------------------------- schedule
calendar_xml() {
  # $1 = search | weekly
  /usr/bin/python3 - "$PROJECT/profile/candidate.json" "$1" <<'PY'
import json, re, sys
path, kind = sys.argv[1], sys.argv[2]
try:
    sched = (json.load(open(path)).get("schedule") or {})
except Exception:
    sched = {}
def entry(h, m, wd=None):
    s = "    <dict>\n"
    if wd is not None:
        s += f"      <key>Weekday</key>\n      <integer>{wd}</integer>\n"
    s += f"      <key>Hour</key>\n      <integer>{h}</integer>\n      <key>Minute</key>\n      <integer>{m}</integer>\n    </dict>\n"
    return s
out = []
if kind == "search":
    for t in sched.get("search_times") or ["08:00", "16:00"]:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(t).strip())
        if m:
            out.append(entry(int(m.group(1)), int(m.group(2))))
else:
    w = sched.get("weekly_digest") or {}
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(w.get("time", "10:00")).strip()) or re.fullmatch(r"(10):(00)", "10:00")
    out.append(entry(int(m.group(1)), int(m.group(2)), int(w.get("weekday", 5))))
print("<array>\n" + "".join(out) + "  </array>")
PY
}

weekly_enabled() {
  /usr/bin/python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
w=(d.get("schedule") or {}).get("weekly_digest") or {}
sys.exit(0 if w.get("enabled", True) else 1)' "$PROJECT/profile/candidate.json"
}

backup_enabled() {
  /usr/bin/python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
sys.exit(0 if (d.get("integrations") or {}).get("github_backup") else 1)' "$PROJECT/profile/candidate.json"
}

write_plist() {
  local name="$1" src="$TEMPLATE_DIR/$1.plist" dest="$LAUNCH_DIR/$1.plist" cal=""
  case "$name" in
    local.jobsearch.search) cal="$(calendar_xml search)" ;;
    local.jobsearch.weekly-comms) cal="$(calendar_xml weekly)" ;;
  esac
  /usr/bin/python3 - "$src" "$dest" "$PROJECT" "$HOME_DIR" "$ACCOUNT" "$cal" <<'PY'
import pathlib, sys
src, dest, project, home, user, cal = sys.argv[1:7]
from xml.sax.saxutils import escape
text = pathlib.Path(src).read_text()
text = (text.replace("__PROJECT_ROOT__", escape(project)).replace("__HOME__", escape(home))
            .replace("__USER__", escape(user)).replace("__CALENDAR__", cal))
pathlib.Path(dest).write_text(text)
PY
}

load_agent() {
  local name="$1"
  write_plist "$name"
  launchctl bootout "$DOMAIN/$name" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$LAUNCH_DIR/$name.plist" && ok "Started $name"
}

unload_agent() {
  launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_DIR/$1.plist"
}

install_schedule() {
  step "Background jobs"
  [[ -f "$PROJECT/profile/candidate.json" ]] || { todo "profile/candidate.json is missing; finish the setup interview first."; return 1; }
  load_agent local.jobsearch.dashboard
  load_agent local.jobsearch.search
  echo "         searches at: $(/usr/bin/python3 "$SCRIPT_DIR/schedule_slot.py" --times | tr '\n' ' ')"
  if weekly_enabled; then load_agent local.jobsearch.weekly-comms; else unload_agent local.jobsearch.weekly-comms; ok "Weekly email digest is switched off"; fi
  if backup_enabled; then load_agent local.jobsearch.autopush; else unload_agent local.jobsearch.autopush; ok "GitHub backup is switched off"; fi
}

# ---------------------------------------------------------------- checks
dashboard_port() {
  /usr/bin/python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print((d.get("dashboard") or {}).get("port", 7411))' "$PROJECT/profile/candidate.json"
}

check_all() {
  step "Readiness check"
  local claude port
  if claude="$(claude_bin)"; then ok "Claude Code installed ($("$claude" --version 2>/dev/null | head -1))"; else todo "Claude Code is not installed"; fi
  [[ -x "$VENV/bin/python" ]] && ok "Python packages" || todo "Python packages not installed (run this script with --tools)"
  node_bin >/dev/null && ok "Node" || todo "Node not installed"
  soffice_bin >/dev/null && ok "LibreOffice (resume PDFs)" || todo "LibreOffice not installed: resumes will be Word files only"
  if [[ -n "${claude:-}" ]] && "$claude" mcp list 2>/dev/null | grep -q '^playwright-session'; then ok "Job browser connected to Claude"; else todo "Job browser not connected to Claude"; fi
  local cookies="$PROFILE_DIR/Default/Cookies"
  if [[ -f "$cookies" ]] && /usr/bin/python3 -c '
import sqlite3, shutil, sys, tempfile, os
t = os.path.join(tempfile.mkdtemp(), "c"); shutil.copy(sys.argv[1], t)
names = {r[0] for r in sqlite3.connect(t).execute("select name from cookies where host_key like \"%linkedin%\"")}
sys.exit(0 if "li_at" in names else 1)' "$cookies" 2>/dev/null; then
    ok "LinkedIn is signed in inside the job browser"
  else
    todo "LinkedIn is not signed in inside the job browser yet (run: $SCRIPT_DIR/open-linkedin-login.sh)"
  fi
  if [[ -x "$VENV/bin/python" && -f "$PROJECT/profile/candidate.json" ]]; then
    "$VENV/bin/python" "$SCRIPT_DIR/save_login.py" --check >/dev/null 2>&1
    case $? in
      0) ok "Password manager connected (job sites that need an account can be done automatically)" ;;
      1) todo "Password manager is connected but not answering (run: $SCRIPT_DIR/connect-password-manager.sh test)" ;;
      *) ok "No password manager connected (optional; job sites that need an account are left for you)" ;;
    esac
  fi
  [[ -f "$PROJECT/profile/candidate.json" ]] && ok "Profile file exists" || todo "Profile not created yet (the setup interview does this)"
  [[ -f "$PROJECT/profile/resume.json" ]] && ok "Resume data exists" || todo "Resume not loaded yet"
  port="$(dashboard_port)"
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/data" 2>/dev/null; then ok "Dashboard is up at http://localhost:$port"
  else todo "Dashboard is not answering on http://localhost:$port yet"; fi
  launchctl print "$DOMAIN/local.jobsearch.search" >/dev/null 2>&1 && ok "Scheduled searches are switched on" || todo "Scheduled searches are not switched on"
}


# ---------------------------------------------------------------- desktop shortcuts
make_shortcuts() {
  step "Desktop shortcuts"
  local desk="$HOME_DIR/Desktop" port claude
  [[ -d "$desk" ]] || return 0
  port="$(dashboard_port)"
  claude="$(claude_bin || echo "$LOCAL_BIN/claude")"
  printf '#!/bin/bash\n# Double-click to talk to your job-search assistant.\ncd "%s" && exec "%s"\n' "$PROJECT" "$claude" > "$desk/Job Search Assistant.command"
  chmod +x "$desk/Job Search Assistant.command"
  cat > "$desk/Job Search Dashboard.webloc" <<WEBLOC
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>http://localhost:$port</string></dict></plist>
WEBLOC
  ok "Put two icons on your Desktop: Job Search Assistant (talk to Claude) and Job Search Dashboard"
}

# ---------------------------------------------------------------- main
case "$MODE" in
  --tools)    need_clt; warn_documents; install_python_env; install_node; install_libreoffice; install_browser_server ;;
  --schedule) warn_documents || exit 1; install_schedule ;;
  --check)    check_all ;;
  --shortcuts) make_shortcuts ;;
  --uninstall)
    for n in local.jobsearch.dashboard local.jobsearch.search local.jobsearch.weekly-comms local.jobsearch.autopush; do unload_agent "$n"; done
    echo "Background jobs stopped and removed. Your data in $PROJECT is untouched." ;;
  all|*)
    need_clt
    warn_documents || exit 1
    install_python_env; install_node; install_libreoffice; install_browser_server
    step "Your data files"
    "$VENV/bin/python" "$SCRIPT_DIR/init_data.py"
    install_schedule
    make_shortcuts
    sleep 2
    check_all ;;
esac
echo
echo "Setup finished."
