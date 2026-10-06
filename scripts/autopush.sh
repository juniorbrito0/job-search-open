#!/bin/bash
# Commit and push everything in this folder to GitHub.
#
# OPTIONAL backup. It only runs when profile/candidate.json has
# integrations.github_backup set to true AND this folder points at the
# candidate's own private GitHub repo (never the shared template it was copied
# from). Otherwise it exits quietly and nothing leaves this Mac.
#
# Called three ways:
#   1. LaunchAgent local.jobsearch.autopush, every 30 minutes (the safety net)
#   2. At the end of the search, apply, and comms runners (immediate push)
#   3. By hand:  scripts/autopush.sh "why"
#
# Safe to run concurrently with a scan: positions.json is written by temp file
# plus atomic rename, so a commit never catches a half-written file.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT/logs"
LOG="$LOG_DIR/autopush.log"
LOCK="$LOG_DIR/.autopush.lock"
STALE_LOCK_MINUTES=15
BRANCH="main"
REASON="${1:-scheduled}"

ACCOUNT="$(whoami 2>/dev/null || echo "$USER")"
export HOME="${HOME:-/Users/$ACCOUNT}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USER="${USER:-$ACCOUNT}"
export LOGNAME="${LOGNAME:-$USER}"
export GIT_TERMINAL_PROMPT=0   # never hang an unattended run on a credential prompt

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 4000 ]; then
  tail -n 1500 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +$STALE_LOCK_MINUTES 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$PROJECT" || { log "FATAL: project dir missing"; exit 1; }

# Backup switched off, or still pointing at the shared template: do nothing.
BACKUP="$(/usr/bin/python3 -c 'import json,sys
try:
    d=json.load(open("profile/candidate.json"))
    print("yes" if (d.get("integrations") or {}).get("github_backup") else "no")
except Exception:
    print("no")' 2>/dev/null)"
[ "$BACKUP" = "yes" ] || exit 0
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN" in
  ""|*juniorbrito0/job-search-open*) exit 0 ;;
esac

# Pull first, every run, so a second computer using the same backup never drifts.
if ! git pull --rebase --autostash -q origin "$BRANCH" 2>>"$LOG"; then
  log "ERROR: could not rebase onto origin/$BRANCH before committing. Aborting."
  git rebase --abort 2>/dev/null
  exit 1
fi

# Nothing of our own to send is the common case. Stay silent so the log stays
# readable, but only after the pull above has run.
if [ -z "$(git status --porcelain)" ]; then
  # Still push if a previous run committed but failed to send.
  if [ -n "$(git log --oneline "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
    if git push -q origin "$BRANCH" 2>>"$LOG"; then
      log "pushed a commit left over from an earlier run"
    else
      log "ERROR: leftover commit still could not be pushed"
      exit 1
    fi
  fi
  exit 0
fi

# Stage everything not ignored. .gitignore keeps logs and secrets out.
git add -A

# Refuse to publish anything that looks like a credential, even though
# .gitignore should already have caught it. A private repo is not a vault.
SUSPECT="$(git diff --cached --name-only | grep -Ei '(^|/)(\.env|.*\.env|.*\.pem|.*\.key|.*\.p8|id_rsa.*|id_ed25519.*|.*credentials.*\.json|.*secret.*|.*token.*)$' || true)"
if [ -n "$SUSPECT" ]; then
  log "BLOCKED: refusing to commit possible secrets:"
  printf '  %s\n' "$SUSPECT" >>"$LOG"
  log "Nothing was committed. Add these to .gitignore or move them out of the project, then re-run."
  git reset >/dev/null 2>&1
  exit 1
fi

# Refuse to publish an unresolved merge conflict.
CONFLICTED="$(git diff --cached --name-only -z \
  | xargs -0 -I{} sh -c 'grep -lE "^(<<<<<<< |>>>>>>> |={7}$)" "{}" 2>/dev/null' \
  || true)"
if [ -n "$CONFLICTED" ]; then
  log "BLOCKED: these files still contain merge conflict markers:"
  printf '  %s\n' "$CONFLICTED" >>"$LOG"
  log "Nothing was committed. Resolve the conflict in $PROJECT, then re-run."
  git reset >/dev/null 2>&1
  exit 1
fi

COUNT="$(git diff --cached --name-only | wc -l | tr -d '[:space:]')"
HOST="$(scutil --get ComputerName 2>/dev/null || hostname -s)"

# A Mac with no commit identity fails here, so set one per-repo (never globally)
# from profile/candidate.json.
if [ -z "$(git config user.email)" ]; then
  NAME_EMAIL="$(/usr/bin/python3 -c 'import json
d=json.load(open("profile/candidate.json"))
print((d.get("name") or "Job Search")+"\t"+(d.get("email") or "jobsearch@localhost"))' 2>/dev/null)"
  git config user.name "$(printf '%s' "$NAME_EMAIL" | cut -f1)"
  git config user.email "$(printf '%s' "$NAME_EMAIL" | cut -f2)"
  log "set the repo-local commit identity"
fi

if ! git commit -q -m "Auto-sync: ${REASON} (${COUNT} file(s)) on ${HOST}

Pushed automatically by scripts/autopush.sh (GitHub backup)." 2>>"$LOG"; then
  log "ERROR: git commit failed. The real reason is on the lines just above."
  exit 1
fi

log "committed ${COUNT} file(s): ${REASON}"

# Rebase again in case something else pushed while we were staging. Never force-push, a rejected push is a signal rather than an obstacle.
if ! git pull --rebase --autostash -q origin "$BRANCH" 2>>"$LOG"; then
  log "ERROR: rebase onto origin/$BRANCH failed. Aborting the rebase and leaving the commit local."
  git rebase --abort 2>/dev/null
  log "Resolve by hand in $PROJECT, then run scripts/autopush.sh again."
  exit 1
fi

if git push -q origin "$BRANCH" 2>>"$LOG"; then
  log "pushed to origin/$BRANCH ($(git rev-parse --short HEAD))"
else
  log "ERROR: push to origin/$BRANCH failed. The commit is safe locally; it will go up on the next run."
  exit 1
fi
