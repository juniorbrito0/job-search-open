#!/bin/bash
# Connect a password manager so the apply job can create portal accounts on its own.
#
#   connect-password-manager.sh 1password [vault name]   (recommended)
#   connect-password-manager.sh bitwarden [folder name]
#   connect-password-manager.sh mac-keychain              (for Apple Passwords / Google users)
#   connect-password-manager.sh test                      check the current connection
#   connect-password-manager.sh off                       stop creating accounts (keeps saved logins)
#
# Secrets are never typed into Terminal or chat: a Mac pop-up with a hidden field
# asks for each one, and it goes straight into the macOS Keychain (service
# "job-search"). Nothing secret is written into this folder.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_BIN="$HOME/.local/bin"
export PATH="$LOCAL_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PY="$PROJECT/.venv/bin/python"; [[ -x "$PY" ]] || PY=/usr/bin/python3
MODE="${1:-}"
NAME="${2:-}"
mkdir -p "$LOCAL_BIN"

ask_secret() {   # $1 = prompt text. Prints the answer, or exits if cancelled.
  /usr/bin/osascript - "$1" <<'OSA' 2>/dev/null
on run argv
  set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "Job Search: connect password manager" buttons {"Cancel", "Save"} default button "Save"
  return text returned of r
end run
OSA
}

store_secret() {  # $1 = account name, value on stdin
  local value; value="$(cat)"
  [[ -n "$value" ]] || { echo "Nothing was entered, so nothing was saved."; exit 1; }
  local esc="${value//\\/\\\\}"; esc="${esc//\"/\\\"}"
  printf 'add-generic-password -U -s "job-search" -a "%s" -w "%s"\n' "$1" "$esc" | /usr/bin/security -i >/dev/null \
    || { echo "Could not save to the Keychain."; exit 1; }
}

set_profile() {  # $1 = backend, $2 = vault/folder name
  "$PY" - "$PROJECT/profile/candidate.json" "$1" "$2" <<'PY'
import json, os, sys
path, kind, vault = sys.argv[1:4]
data = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
integ = data.setdefault("integrations", {})
integ["password_manager"] = kind
if vault:
    integ["password_vault"] = vault
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
}

install_op() {
  command -v op >/dev/null 2>&1 && return 0
  if command -v brew >/dev/null 2>&1 && brew install 1password-cli >/dev/null 2>&1; then return 0; fi
  local ver arch tmp
  ver="$(curl -fsS 'https://app-updates.agilebits.com/check/1/0/CLI2/en/2.0.0/N' | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')"
  arch="$([[ "$(uname -m)" == "arm64" ]] && echo arm64 || echo amd64)"
  tmp="$(mktemp -d)"
  curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v${ver}/op_darwin_${arch}_v${ver}.zip" -o "$tmp/op.zip" || { echo "Could not download the 1Password tool."; return 1; }
  /usr/bin/unzip -q "$tmp/op.zip" -d "$tmp/op"
  # Only accept a binary signed by 1Password's developer team (AgileBits, 2BUA8C4S2C).
  if ! /usr/bin/codesign --verify "$tmp/op/op" 2>/dev/null || ! /usr/bin/codesign -dv "$tmp/op/op" 2>&1 | grep -q "TeamIdentifier=2BUA8C4S2C"; then
    echo "The 1Password tool failed its signature check. Not installing it."; return 1
  fi
  mv "$tmp/op/op" "$LOCAL_BIN/op" && chmod +x "$LOCAL_BIN/op"
  echo "Installed the 1Password command-line tool ($ver, signature verified)."
}

install_bw() {
  command -v bw >/dev/null 2>&1 && return 0
  local npm; npm="$(command -v npm)" || { echo "Node is missing; run scripts/setup-mac.sh --tools first."; return 1; }
  "$npm" install -g --prefix "$HOME/.local" @bitwarden/cli >/dev/null 2>&1 && echo "Installed the Bitwarden command-line tool." \
    || { echo "Could not install the Bitwarden tool."; return 1; }
}

case "$MODE" in
  1password)
    VAULT="${NAME:-Job Portals}"
    install_op || exit 1
    TOKEN="$(ask_secret "Paste the 1Password service account token (it starts with ops_). It is saved only in your Mac's Keychain.")" || { echo "Cancelled."; exit 1; }
    printf "%s" "$TOKEN" | store_secret "1password-token" || exit 1; unset TOKEN
    set_profile 1password "$VAULT"
    ;;
  bitwarden)
    FOLDER="${NAME:-Job Portals}"
    install_bw || exit 1
    ask_secret "Bitwarden: paste your API key client_id (Account settings > Security > Keys > View API key)." | store_secret "bitwarden-client-id" || exit 1
    ask_secret "Bitwarden: paste your API key client_secret." | store_secret "bitwarden-client-secret" || exit 1
    ask_secret "Bitwarden: type your Bitwarden master password. It is kept only in this Mac's Keychain so the job search can unlock Bitwarden while you are away." | store_secret "bitwarden-master-password" || exit 1
    set_profile bitwarden "$FOLDER"
    ;;
  mac-keychain)
    set_profile mac-keychain ""
    ;;
  off)
    set_profile none ""
    echo "Account creation is off. Roles that need a new account will be left for you."
    exit 0
    ;;
  test) ;;
  *)
    echo "Usage: connect-password-manager.sh 1password|bitwarden|mac-keychain|test|off"; exit 2 ;;
esac

"$PY" "$SCRIPT_DIR/save_login.py" --check
