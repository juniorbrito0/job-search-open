#!/usr/bin/env python3
"""Tag every disqualified position with WHY it died, so the Post-mortem tab can
count causes instead of guessing from free text.

Writes `dq_analysis` onto each disqualified position:

    {cause, cause_label, group, preventable, detail, days_open, days_to_outcome}

`cause` taxonomy
    closed-before-applying  posting went dead while it sat in the queue
    blocked-then-closed     same, but the blocker was a portal sign-in we could not pass
    employer-rejected       an application went in and was turned down
    rule-onsite             too many office days, ruled out by the candidate's own rule
    rule-us-only            needs a work permit the candidate does not hold
    rule-other              the candidate's own call (assessment, attestation, employer quality)

A position can carry its own cause: set `dq_cause` (and optionally `dq_note`)
on it. Otherwise the CODED map below, otherwise keyword inference on
`apply_result`, flagged `inferred: true` so a human can confirm it.
Re-runnable: it overwrites `dq_analysis` every time.
"""

import re
from datetime import date

from jobsearch_lib import file_lock, load_positions, save_positions

CAUSES = {
    "closed-before-applying": ("Posting closed before we applied", "timing", True),
    "blocked-then-closed":    ("Closed while blocked on a portal sign-in", "timing", True),
    "employer-rejected":      ("Applied and rejected", "market", False),
    "rule-onsite":            ("Too many office days (your rule)", "screening", True),
    "rule-us-only":           ("Needs a work permit you do not hold", "screening", True),
    "rule-other":             ("Your call (attestation, assessment, domain, employer quality)", "judgment", False),
    "unclassified":           ("Not yet classified", "unknown", False),
}

# Hand-coded causes, keyed by position id: {"<id>": ("<cause>", "one-line why")}.
# Starts empty. Easier than editing this file: put `dq_cause` (one of CAUSES) and
# an optional `dq_note` straight on the position in positions.json; that wins over
# keyword inference the same way an entry here does.
CODED: dict[str, tuple[str, str]] = {}

FALLBACK = [
    (r"no longer accepting|no longer open|has been filled|posting closed|CLOSED|apply-button element is absent|effectively closed", "closed-before-applying"),
    (r"on-site|onsite_days_rule|four days|five days|4 days|5 days", "rule-onsite"),
    (r"United States only|US-only|not authorized in the US", "rule-us-only"),
    (r"employer-rejected:|REJECTION|rejected|move forward with other|not moving forward", "employer-rejected"),
]


def day(s):
    return (s or "")[:10] or None


def diff(a, b):
    try:
        return (date.fromisoformat(b) - date.fromisoformat(a)).days
    except Exception:
        return None


def main():
    with file_lock():
        data = load_positions()
        counts = classify(data)
        save_positions(data)
    total = sum(counts.values())
    if not total:
        print("No closed (disqualified) positions to classify yet.")
        return
    for c, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"{n:3}  {round(n/total*100):3}%  {c}")
    print(f"{total:3}       total disqualified")


def classify(data: dict) -> dict:
    counts = {}
    for p in data["positions"]:
        if p.get("status") != "disqualified":
            p.pop("dq_analysis", None)
            continue

        result = p.get("apply_result")
        result = result if isinstance(result, str) else json.dumps(result or "")
        coded = CODED.get(p.get("id"))
        if p.get("dq_cause") in CAUSES:
            coded = (p["dq_cause"], p.get("dq_note") or (result or "")[:400])
        inferred = False
        if coded:
            cause, detail = coded
        else:
            cause, detail, inferred = "unclassified", (result or "")[:400], True
            for pat, c in FALLBACK:
                if re.search(pat, result, re.I):
                    cause = c
                    break

        hist = p.get("status_history") or []
        applied_at = day(p.get("applied_at")) or next(
            (day(h.get("at")) for h in hist if h.get("status") == "applied"), None)
        dq_at = next((day(h.get("at")) for h in reversed(hist)
                      if h.get("status") == "disqualified"), None)
        found = day(p.get("found_date"))

        label, group, preventable = CAUSES[cause]
        p["dq_analysis"] = {
            "cause": cause,
            "cause_label": label,
            "group": group,
            "preventable": preventable,
            "detail": detail,
            "inferred": inferred,
            "applied_at": applied_at,
            "closed_at": dq_at,
            # how long the posting sat with us before it died / was dropped
            "days_in_hand": diff(found, dq_at) if found and dq_at else None,
            # for the ones we did apply to: application to outcome
            "days_to_outcome": diff(applied_at, dq_at) if applied_at and dq_at else None,
        }
        counts[cause] = counts.get(cause, 0) + 1

    return counts

if __name__ == "__main__":
    main()
