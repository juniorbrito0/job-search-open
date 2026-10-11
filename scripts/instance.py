#!/usr/bin/env python3
"""Which copy of the job search this is, and how its AI sessions are fenced in.

One Mac can run more than one job search: your own, and one for someone else
in the house (set up with the web page in docs/WEB-MODE.md). Each copy needs
its own background-job names, its own job browser, its own Keychain entries,
and, for a copy that is not yours, AI sessions that cannot see your accounts.

`profile/candidate.json → instance_id` names the copy ("" for the only one).
JOBSEARCH_INSTANCE in the environment overrides it. With an id set:

* background jobs are `local.jobsearch.<id>.<job>` instead of `local.jobsearch.<job>`
* the job browser lives in `~/.job-search/<id>/playwright-profile`
* Keychain entries use service `job-search-<id>`, held logins `~/.config/job-search-<id>`
* every Claude session is isolated: no user settings, hooks, skills or memory
  from the Mac owner's `~/.claude`, no claude.ai connectors (their Gmail!), and
  only the MCP servers listed in this copy's own config (the job browser).

`candidate.json → isolate_agent: true` turns the isolation on without an id.

    python3 scripts/instance.py id                 the id, or nothing
    python3 scripts/instance.py label search       local.jobsearch[.<id>].search
    python3 scripts/instance.py keychain-service   job-search[-<id>]
    python3 scripts/instance.py browser-profile    the job browser's profile folder
    python3 scripts/instance.py isolated           exit 0 when isolated, 1 when not
    python3 scripts/instance.py claude-args        extra claude flags, NUL separated
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(os.environ.get("JOBSEARCH_ROOT") or Path(__file__).resolve().parent.parent)
HOME = Path(os.path.expanduser("~"))


def _candidate() -> dict:
    try:
        data = json.loads((ROOT / "profile" / "candidate.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def instance_id() -> str:
    raw = os.environ.get("JOBSEARCH_INSTANCE")
    if raw is None:
        raw = str(_candidate().get("instance_id") or "")
    # Goes into file names and launchd labels, so only safe characters survive.
    return re.sub(r"[^a-z0-9-]", "", raw.strip().lower())[:32]


def isolated() -> bool:
    return bool(instance_id()) or _candidate().get("isolate_agent") is True


def label(job: str) -> str:
    iid = instance_id()
    return f"local.jobsearch.{iid}.{job}" if iid else f"local.jobsearch.{job}"


def state_dir() -> Path:
    iid = instance_id()
    return HOME / ".job-search" / iid if iid else HOME / ".job-search"


def browser_profile() -> Path:
    return state_dir() / "playwright-profile"


def keychain_service() -> str:
    iid = instance_id()
    return f"job-search-{iid}" if iid else "job-search"


def config_dir() -> Path:
    iid = instance_id()
    return HOME / ".config" / (f"job-search-{iid}" if iid else "job-search")


def playwright_mcp_bin() -> str | None:
    for cand in (HOME / ".local/bin/playwright-mcp", Path("/opt/homebrew/bin/playwright-mcp"),
                 Path("/usr/local/bin/playwright-mcp")):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return shutil.which("playwright-mcp")


def mcp_config_path() -> Path:
    """This copy's own MCP list: just the job browser, on this copy's profile."""
    path = state_dir() / "mcp.json"
    servers = {}
    pw = playwright_mcp_bin()
    if pw:
        profile = browser_profile()
        profile.mkdir(parents=True, exist_ok=True)
        servers["playwright-session"] = {"command": pw, "args": ["--user-data-dir", str(profile)]}
    body = json.dumps({"mcpServers": servers}, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        current = path.read_text(encoding="utf-8")
    except OSError:
        current = ""
    if current != body:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)
    return path


def claude_args() -> list[str]:
    if not isolated():
        return []
    return [
        "--setting-sources", "project,local",
        "--strict-mcp-config", "--mcp-config", str(mcp_config_path()),
        "--disable-slash-commands",
    ]


def claude_env(env: dict | None = None) -> dict:
    """The environment for an isolated claude run (also drops API keys, like agent-run.sh)."""
    out = dict(os.environ if env is None else env)
    out.pop("ANTHROPIC_API_KEY", None)
    out.pop("ANTHROPIC_AUTH_TOKEN", None)
    if isolated():
        out["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"
    return out


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "id"
    if cmd == "id":
        print(instance_id())
    elif cmd == "label" and len(argv) > 2:
        print(label(argv[2]))
    elif cmd == "keychain-service":
        print(keychain_service())
    elif cmd == "config-dir":
        print(config_dir())
    elif cmd == "browser-profile":
        print(browser_profile())
    elif cmd == "isolated":
        return 0 if isolated() else 1
    elif cmd == "claude-args":
        sys.stdout.write("".join(a + "\0" for a in claude_args()))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
