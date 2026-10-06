#!/bin/bash
# Run one agent prompt, trying several AI providers in order until one is usable.
#
# Why this exists. Every scheduled job goes through here instead of calling
# `claude` directly. It adds a hard time limit (a watchdog), and it can fall back
# to another AI tool when Claude cannot run at all (usage limit reached, signed
# out). Claude Code is the only one most people need; the others are optional.
#
# The important rule: fall through ONLY when a provider could not run at all.
# Never fall through because the task itself failed. If Claude ran the apply
# routine and a portal rejected it, handing the same prompt to another tool
# would repeat the work and risk applying to the same job twice.
#
# Usage:
#   agent-run.sh --label apply --log logs/auto-apply.log --timeout 3600 \
#                --prompt-file /tmp/prompt.txt
#   agent-run.sh --label scan --log logs/morning-scan.log --prompt "do the thing"
#
# Exit codes:
#   0    a provider ran the prompt to completion
#   1    the provider that ran it reported a task failure
#   70   every provider was unavailable, nothing ran at all
#   143  the watchdog stopped it at --timeout
#
# Override the order with JOBSEARCH_AGENT_ORDER, e.g. "grok claude".
# AGENT_KILL_GRACE is the seconds between the polite stop and the forced one.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Order matters. Claude Code first: the routines were written and tested
# against it. Grok (xAI's CLI) and Cursor's CLI are optional fallbacks and are
# simply skipped when they are not installed.
DEFAULT_ORDER="claude grok cursor"
ORDER="${JOBSEARCH_AGENT_ORDER:-$DEFAULT_ORDER}"

LABEL="agent"
LOG=""
TIMEOUT_SECONDS=3600
# How long the provider gets to shut down after the polite stop, before it is
# taken out by force. Twenty seconds is generous for a process that is answering.
KILL_GRACE="${AGENT_KILL_GRACE:-20}"
PROMPT=""
PROMPT_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    *) echo "agent-run.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$PROMPT_FILE" ]; then
  [ -r "$PROMPT_FILE" ] || { echo "agent-run.sh: cannot read $PROMPT_FILE" >&2; exit 2; }
  PROMPT="$(cat "$PROMPT_FILE")"
fi
[ -n "$PROMPT" ] || { echo "agent-run.sh: no prompt given" >&2; exit 2; }

# Keep every unattended run out of ~/Documents when the project lives outside it
# (the recommended ~/job-search). macOS asks "allow access to Documents?" the
# first time a background job touches that folder; nobody is there to click
# Allow, so the run would freeze until the watchdog kills it.
case "$PROJECT" in
  "$HOME/Documents"|"$HOME/Documents/"*) ;;
  *)
    PROMPT="House rule for this unattended run: never read, list, search, cd into, or run anything under $HOME/Documents (THE ARTIFACT included). This Mac has no permission for that folder, so touching it opens a dialog nobody can answer and freezes the run. The project is $PROJECT; everything you need is there or online.

$PROMPT"
    ;;
esac

[ -n "$LOG" ] || LOG="$PROJECT/logs/${LABEL}.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$LABEL] $*" >>"$LOG"; }

# launchd hands over a near-empty environment, so name every location a provider
# binary might live in. ~/.grok/bin is where the Grok installer puts its binary.
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$HOME/.cursor/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Text that means "this provider could not serve the request", as opposed to
# "the provider ran and the work failed". Matched case-insensitively against the
# provider's own output. Keep this list conservative: a false positive here
# re-runs a whole routine on another provider.
# A bare "429" is deliberately not in here: it would match ordinary output like
# "429 positions scored". Real 429s print alongside "too many requests".
#
UNAVAILABLE_PATTERNS='hit your (session|usage|rate) limit|session limit ·|usage limit reached|rate.?limit|too many requests|(http|status)[ :]*429|quota exceeded|out of[[:space:]]+([a-z]+[[:space:]]+){0,3}credits|insufficient credits|cc_cli_limit_message|not logged in|please run /login|not authenticated|authentication (failed|required)|failed to authenticate|oauth (session|token) (has )?expired|unauthorized|invalid api key|no credentials|please sign in|subscription (required|expired)|workspace trust required'

# Resolve a provider to its binary, or return 1 if it is not installed here.
provider_bin() {
  case "$1" in
    claude) command -v claude 2>/dev/null ;;
    grok)   command -v grok 2>/dev/null ;;
    cursor) command -v cursor-agent 2>/dev/null ;;
    *) return 1 ;;
  esac
}

# Launch one non-interactive, auto-approved, single-shot run in $PROJECT and set
# PID. Each provider spells those three ideas differently.
#
# This deliberately does not run inside $( ). A background job started in a
# command substitution belongs to that subshell, so the parent's `wait` rejects
# the pid ("is not a child of this shell") and the watchdog kills a process the
# parent is not even tracking. Set a global instead.
PID=""
launch_provider() {
  local name="$1" bin="$2" out="$3"
  case "$name" in
    claude)
      env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
        "$bin" -p "$PROMPT" \
        --dangerously-skip-permissions \
        --add-dir "$PROJECT" \
        </dev/null >>"$out" 2>&1 &
      PID=$!
      ;;
    grok)
      # -p takes the prompt as its VALUE here, unlike Claude where -p is a bare
      # switch. --permission-mode bypassPermissions is Grok's equivalent of
      # --dangerously-skip-permissions. --no-alt-screen stops it trying to take
      # over a terminal that does not exist under launchd.
      "$bin" -p "$PROMPT" \
        --permission-mode bypassPermissions \
        --cwd "$PROJECT" \
        --output-format plain \
        --no-alt-screen \
        </dev/null >>"$out" 2>&1 &
      PID=$!
      ;;
    cursor)
      # Cursor is the odd one out: -p/--print is a BARE switch and the prompt is
      # positional. Getting this wrong makes it treat the prompt as a flag value.
      #
      # --force is not optional. Without it, print mode only *proposes* edits and
      # writes nothing, so the job would report success having changed not one
      # file. --trust skips the workspace-trust prompt that otherwise hangs an
      # unattended run, and --approve-mcps lets it use the browser.
      "$bin" -p \
        --force \
        --trust \
        --approve-mcps \
        --output-format text \
        "$PROMPT" \
        </dev/null >>"$out" 2>&1 &
      PID=$!
      ;;
    *) return 70 ;;
  esac
}

# Signal a process and everything it started, children first.
#
# Children first, so a parent cannot spawn more while we work up the tree.
kill_tree() {
  local pid="$1" sig="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null
}

TIMED_OUT=""
ATTEMPTED=""
for name in $ORDER; do
  BIN="$(provider_bin "$name")"
  if [ -z "$BIN" ]; then
    log "provider '$name' is not installed here, skipping"
    continue
  fi

  ATTEMPTED="$ATTEMPTED $name"
  log "trying provider '$name' ($BIN)"

  # Capture this attempt separately so the pattern match sees only its output,
  # not the whole historical log.
  ATTEMPT_OUT="$(mktemp "${TMPDIR:-/tmp}/agent-run-${LABEL}.XXXXXX")"

  launch_provider "$name" "$BIN" "$ATTEMPT_OUT"
  # No GNU timeout on macOS, so cap the run with our own watchdog. disown keeps
  # bash from printing "Terminated: 15" into the log when we reap it.
  #
  # A timeout has to be enforceable or it is decoration. Ask the whole tree to
  # stop, and if it is still there after the grace period, end it. A provider
  # blocked on a hung child cannot answer a polite signal, and that is exactly
  # the case a watchdog exists for.
  TIMEOUT_FLAG="$(mktemp "${TMPDIR:-/tmp}/agent-run-${LABEL}-timeout.XXXXXX")"
  ( sleep "$TIMEOUT_SECONDS"
    kill -0 "$PID" 2>/dev/null || exit 0
    echo timeout >"$TIMEOUT_FLAG"
    kill_tree "$PID" TERM
    sleep "$KILL_GRACE"
    kill -0 "$PID" 2>/dev/null && kill_tree "$PID" KILL ) &
  WATCHDOG=$!
  disown "$WATCHDOG" 2>/dev/null
  # 2>/dev/null because bash announces a killed background job on stderr
  # ("Terminated: 15"), which lands in launchd's error log and reads like a
  # fault. The watchdog firing is not a fault; the log line below says it.
  wait "$PID" 2>/dev/null
  STATUS=$?
  kill_tree "$WATCHDOG" KILL 2>/dev/null
  # Anything the provider left behind outlives it otherwise, and a stray child
  # holding the log open is the next version of this same bug.
  kill_tree "$PID" KILL 2>/dev/null
  TIMED_OUT=""
  [ -s "$TIMEOUT_FLAG" ] && TIMED_OUT="yes"
  rm -f "$TIMEOUT_FLAG"

  cat "$ATTEMPT_OUT" >>"$LOG"

  if [ "$STATUS" -eq 0 ]; then
    log "provider '$name' completed (exit 0)"
    rm -f "$ATTEMPT_OUT"
    echo "$name" >"$PROJECT/logs/.last-provider-$LABEL"
    exit 0
  fi

  # Non-zero. Decide whether the provider was unusable or the task simply failed.
  if grep -qEi "$UNAVAILABLE_PATTERNS" "$ATTEMPT_OUT" 2>/dev/null; then
    REASON="$(grep -oEi "$UNAVAILABLE_PATTERNS" "$ATTEMPT_OUT" 2>/dev/null | head -1)"
    log "provider '$name' unavailable (matched '${REASON}'), falling through"
    rm -f "$ATTEMPT_OUT"
    continue
  fi

  # A watchdog stop shows up as 143 when SIGTERM did it and 137 when it took a
  # SIGKILL, and the flag says it was us either way. That is the task
  # overrunning, not the provider refusing us, so do not hand the same job to
  # the next provider: re-running a half-finished apply could submit twice.
  #
  # It leaves as 143 rather than 1, so the caller can tell "this ran out of
  # time" from "this tried and failed" and say so on the board. Until
  # 2026-09-10 a forced stop came back as a plain 1 and read as "exited 1".
  rm -f "$ATTEMPT_OUT"
  echo "$name" >"$PROJECT/logs/.last-provider-$LABEL"
  if [ -n "$TIMED_OUT" ] || [ "$STATUS" -eq 143 ] || [ "$STATUS" -eq 137 ]; then
    log "provider '$name' was stopped at the ${TIMEOUT_SECONDS}s timeout, not retrying elsewhere"
    exit 143
  fi
  log "provider '$name' ran but exited $STATUS (task failure, not a quota problem), not retrying elsewhere"
  exit 1
done

# Nothing could run. Leave a dated note the dashboard and the candidate can find.
log "FATAL: no provider could run. tried:${ATTEMPTED:- none}"
STALL="$PROJECT/logs/PROVIDERS-UNAVAILABLE.txt"
{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $LABEL could not run: no AI provider was usable."
  echo "  providers tried:${ATTEMPTED:- none (none installed)}"
  echo "  Most likely fix: Claude Code reached its usage limit (wait for the reset)"
  echo "  or is signed out (open Terminal, type claude, and sign in again)."
  echo "  Nothing was changed. The next scheduled run will retry."
} >>"$STALL"
exit 70
