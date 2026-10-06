#!/usr/bin/env python3
"""Second layer of the post-mortem: tag every position the candidate actually
applied to with the shape of the seat, and keep each employer rejection's
"gate" (the specific bar the posting set, and whether the resume clears it).

Writes two things:

  position["archetype"]        founding-generalist | exec-support | single-function
  position["gate"]             employer-rejected only:
                               {asked, asked_years?, resume_shows, clears, kind, note}

`archetype` is the question "does this company already have this function?"
  founding-generalist  build/own several functions, usually no incumbent
  exec-support         support an executive at a company that already has functions
  single-function      one lane (RevOps, People, program management) with a team around it

`gate` records the hard bar in the posting (years, credential, work permit,
seniority jump, domain) against what the resume can actually show. The agent
that handles a rejection writes it straight onto the position as `gate`; this
script keeps it. The GATES map below is an alternative for hand-coding by id.
`kind` is one of: years, years-in-function, credential, authorization,
altitude, domain, people-leadership.

The years the resume shows come from profile/candidate.json ->
experience_years.in_function, and are written to positions.json as
`resume_tenure` for the Rejected tab.
"""

from __future__ import annotations

from jobsearch_lib import file_lock, load_positions, save_positions
from profile_lib import load_candidate

# Hand-coded archetypes: {"archetype": ["substring of position id", ...]}.
# Empty by default; set `archetype_override` on a position instead if easier.
ARCHETYPE: dict[str, list[str]] = {"founding-generalist": [], "exec-support": []}

# Hand-coded gates by position id: {"<id>": {asked, resume_shows, clears, kind, note}}.
GATES: dict[str, dict] = {}

VALID_ARCHETYPES = {"founding-generalist", "exec-support", "single-function"}


def archetype_for(pos):
    override = pos.get("archetype_override")
    if override in VALID_ARCHETYPES:
        return override
    pid = pos.get("id") or ""
    for kind, keys in ARCHETYPE.items():
        if any(k and k in pid for k in keys):
            return kind
    title = (pos.get("title") or "").lower()
    if any(w in title for w in ("chief of staff", "ceo office", "founder associate",
                                "executive assistant", "executive business partner")):
        return "exec-support"
    if any(w in title for w in ("head of", "founding", "business operations", "bizops",
                                "generalist", "general manager", "first ")):
        return "founding-generalist"
    return "single-function"


def classify(data: dict) -> int:
    applied = 0
    for p in data["positions"]:
        ever = bool(p.get("applied_at")) or any(
            h.get("status") == "applied" for h in p.get("status_history") or [])
        if not ever:
            p.pop("archetype", None)
            p.pop("gate", None)
            continue
        applied += 1
        p["archetype"] = archetype_for(p)
        gate = GATES.get(p.get("id"))
        if gate:
            p["gate"] = gate
        elif not isinstance(p.get("gate"), dict):
            p.pop("gate", None)
    return applied


def main():
    years = (load_candidate().get("experience_years") or {})
    with file_lock():
        data = load_positions()
        classify(data)
        data["resume_tenure"] = {
            "ops_years": years.get("in_function") or 0,
            "total_years": years.get("total") or 0,
            "function_label": years.get("function_label") or "",
            "note": "Years the resume shows in the target function, from profile/candidate.json.",
        }
        save_positions(data)

    counts = {}
    for p in data["positions"]:
        a = p.get("archetype")
        if not a:
            continue
        rej = (p.get("dq_analysis") or {}).get("cause") == "employer-rejected"
        conv = p.get("status") in {"ongoing", "screen", "interview", "offer"}
        c = counts.setdefault(a, [0, 0, 0])
        c[0] += 1
        c[1] += rej
        c[2] += conv
    if not counts:
        print("No applications yet, so nothing to tag.")
        return
    print(f"{'archetype':22} {'applied':>7} {'rejected':>9} {'conversations':>14}")
    for a, (n, r, c) in sorted(counts.items(), key=lambda kv: -kv[1][0]):
        print(f"{a:22} {n:7} {r:9} {c:14}")
    print(f"gates recorded: {sum(1 for p in data['positions'] if p.get('gate'))}")


if __name__ == "__main__":
    main()
