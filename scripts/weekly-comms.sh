#!/bin/bash
# Weekly communications & interview-intelligence run for Job Search.
# Invoked by the LaunchAgent local.jobsearch.weekly-comms (day and time from profile/candidate.json).
# Launches a headless Claude Code session that executes docs/weekly-comms-routine.md.
#
# launchd gives a near-empty environment, so PATH and USER must be set explicitly —
# USER in particular, or Claude Code cannot read its OAuth credentials from the
# login Keychain and every run dies with "Not logged in".

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT/logs"
LOG="$LOG_DIR/weekly-comms.log"
LOCK="$LOG_DIR/.weekly-comms.lock"
TIMEOUT_SECONDS=3600
STALE_LOCK_MINUTES=70

ACCOUNT="$(whoami 2>/dev/null || echo "$USER")"
export HOME="${HOME:-/Users/$ACCOUNT}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USER="${USER:-$ACCOUNT}"
export LOGNAME="${LOGNAME:-$USER}"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +$STALE_LOCK_MINUTES 2>/dev/null)" ]; then
    log "reclaiming stale lock"
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || { log "could not acquire lock, exiting"; exit 0; }
  else
    log "another run is in progress, exiting"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$PROJECT" || { log "FATAL: project dir missing"; exit 1; }

PROMPT='Run the weekly job-search email digest. Read docs/weekly-comms-routine.md top to bottom, then execute it exactly as written, working autonomously and without asking questions. Sweep Gmail (and Granola only if profile/candidate.json switches it on) from the last_run date at the bottom of docs/comms-digest.md, compare what you find with dashboard/data/positions.json without silently changing any status, rewrite docs/comms-digest.md, append a dated entry to docs/WORKLOG.md, and send the Mac notification.'

log "=== starting weekly comms sweep ==="

bash "$SCRIPT_DIR/agent-run.sh" \
  --label comms \
  --log "$LOG" \
  --timeout "$TIMEOUT_SECONDS" \
  --prompt "$PROMPT"
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  log "=== weekly comms sweep finished OK (provider $(cat "$LOG_DIR/.last-provider-comms" 2>/dev/null || echo unknown)) ==="
elif [ "$STATUS" -eq 70 ]; then
  log "=== no AI provider available, sweep skipped ==="
else
  log "=== weekly comms sweep exited with status $STATUS (timeout kills show as 143) ==="
fi

bash "$SCRIPT_DIR/autopush.sh" "weekly comms" >/dev/null 2>&1

exit "$STATUS"
