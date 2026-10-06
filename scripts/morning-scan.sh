#!/bin/bash
# Scheduled job-search runner.
# Invoked by the LaunchAgent local.jobsearch.search at the times in profile/candidate.json.
# Launches a headless Claude Code session that executes docs/morning-scan-routine.md.
#
# launchd gives a near-empty environment, so every external binary this run needs
# (claude, node/npx for the Playwright MCP, uv for the Gmail MCP, soffice for
# resume PDF export) has to be on PATH explicitly.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT/logs"
LOG="$LOG_DIR/morning-scan.log"
LOCK="$LOG_DIR/.morning-scan.lock"
TIMEOUT_SECONDS=5400          # 90 min hard cap on a single run
STALE_LOCK_MINUTES=100        # reclaim a lock left behind by a killed run

ACCOUNT="$(whoami 2>/dev/null || echo "$USER")"
export HOME="${HOME:-/Users/$ACCOUNT}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# USER is required: Claude Code reads its OAuth credentials from the login
# Keychain keyed on the account name, and launchd does not set USER. Without it
# every run dies with "Not logged in · Please run /login". Verified 2026-07-28.
export USER="${USER:-$ACCOUNT}"
export LOGNAME="${LOGNAME:-$USER}"

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# keep the log from growing without bound
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# mkdir is atomic, so it doubles as a lock (no flock on macOS)
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

PY_BIN="$PROJECT/.venv/bin/python"
[ -x "$PY_BIN" ] || PY_BIN="python3"
stamp_now() {
  "$PY_BIN" -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'))" >"$1"
}

# Slot guard. The search times live in profile/candidate.json (schedule.search_times).
# A slot id looks like 2026-10-06-0800. launchd also fires on wake if the Mac was
# asleep at a search time; the guard makes sure each slot runs once.
# JOBSEARCH_FORCE=1 is the dashboard "Search now" button: skip the guard and run.
FORCE="${JOBSEARCH_FORCE:-0}"
SLOT="$(/usr/bin/python3 "$SCRIPT_DIR/schedule_slot.py" 2>/dev/null || echo none)"
COMMON='Read docs/morning-scan-routine.md top to bottom, then execute it exactly as written, working autonomously and without asking questions. Everything about the candidate (who the candidate is, what they want, where, which sources are switched on) is in profile/candidate.json and dashboard/data/scoring-profile.json. This job finds and scores only. Do not submit any application. After scoring, run scripts/queue_auto_apply.py (it does nothing when auto_apply is off). Honor hard_exclusions and learning_log in dashboard/data/scoring-profile.json. Append a dated entry to docs/WORKLOG.md when you finish.'
if [ "$FORCE" != "1" ]; then
  if [ "$SLOT" = "none" ]; then
    log "no search time has come yet today"
    exit 0
  fi
  LAST="$(tr -d '[:space:]' <"dashboard/data/.last-scan" 2>/dev/null || true)"
  if [ "$LAST" = "$SLOT" ]; then
    log "search already completed for slot $SLOT, nothing to do"
    exit 0
  fi
  PROMPT="Run the scheduled job search. $COMMON"
else
  log "manual dashboard run, skipping slot guard"
  [ "$SLOT" = "none" ] && SLOT="$(date '+%Y-%m-%d')-manual"
  PROMPT="Run the job search now. This is a manual run started from the dashboard Search now button, so skip the slot guard in section 0. $COMMON"
fi

log "=== starting search for slot $SLOT ==="

# Not `claude` directly: agent-run.sh owns the watchdog, the timeout and the
# optional fallback providers. Exit 70 means no AI provider was usable at all.
bash "$SCRIPT_DIR/agent-run.sh" \
  --label scan \
  --log "$LOG" \
  --timeout "$TIMEOUT_SECONDS" \
  --prompt "$PROMPT"
STATUS=$?
if [ "$STATUS" -eq 70 ]; then
  log "no AI provider was available, leaving slot $SLOT unclaimed so the next run retries"
fi

# Backstop: queue any 4+ the session scored but did not mark. This only writes
# auto_apply_queued / apply_requested. It never opens LinkedIn or submits.
log "queueing strong matches (only if auto-apply is switched on)"
"$PY_BIN" "$PROJECT/scripts/queue_auto_apply.py" >>"$LOG" 2>&1 || log "queue_auto_apply.py exited $?"
"$PY_BIN" "$PROJECT/scripts/sync_diary.py" >>"$LOG" 2>&1 || log "sync_diary.py exited $?"
"$PY_BIN" "$PROJECT/scripts/company_memory.py" --refresh >>"$LOG" 2>&1 || log "company_memory.py exited $?"

if [ "$STATUS" -eq 0 ]; then
  printf '%s\n' "$SLOT" > "dashboard/data/.last-scan"
  stamp_now "dashboard/data/.last-scan-at"
  log "=== search finished OK (slot $SLOT, provider $(cat "$LOG_DIR/.last-provider-scan" 2>/dev/null || echo unknown)) ==="
else
  log "=== search exited with status $STATUS (timeout kills show as 143, 70 = no provider) ==="
fi

# Back up to GitHub if the candidate switched that on (autopush.sh checks).
bash "$SCRIPT_DIR/autopush.sh" "search $SLOT" >/dev/null 2>&1

exit "$STATUS"
