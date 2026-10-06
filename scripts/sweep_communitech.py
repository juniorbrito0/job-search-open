#!/usr/bin/env python3
"""Find openings matching the target titles on the Communitech job board.

Optional source (Canada only). On when profile/candidate.json ->
sources.communitech is true; the search routine decides whether to call it.

https://www1.communitech.ca/jobs is a Getro board ("Work In Tech", Getro
collection 628) with thousands of Canadian tech jobs. Getro's public search
API answers plain HTTP with JSON, so no browser is needed. Each title in
scoring-profile.json search_scope.titles is searched, every page of results
is read (the count the API reports is the bound, not a guess), and the same
title and location filters as the Y Combinator sweep are applied.

    .venv/bin/python scripts/sweep_communitech.py
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_yc_wellfound import UA, keep_title, location_ok  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / "dashboard" / "data" / "scoring-profile.json"
COLLECTION = 628
API = f"https://api.getro.com/api/v2/collections/{COLLECTION}/search/jobs"
BOARD = "https://www1.communitech.ca"
PER_PAGE = 50
# Extra searches beyond the profile's titles: scoring-profile.json ->
# search_scope.extra_queries (optional).
EXTRA_QUERIES: tuple = ()
WORK_MODE = {"remote": "remote", "hybrid": "hybrid", "on_site": "on-site"}


def search(query: str, page: int) -> dict:
    body = json.dumps(
        {"hitsPerPage": PER_PAGE, "page": page, "filters": "", "query": query}
    ).encode()
    req = urllib.request.Request(
        API,
        data=body,
        method="POST",
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8", "replace")).get("results") or {}


def queries() -> list[str]:
    titles: list[str] = []
    extra: list[str] = list(EXTRA_QUERIES)
    try:
        scope = json.loads(PROFILE.read_text()).get("search_scope") or {}
        extra += [q for q in scope.get("extra_queries") or [] if isinstance(q, str)]
        for raw in scope.get("titles") or []:
            if str(raw).strip().upper().startswith("FILL"):
                continue
            for part in str(raw).split("/"):
                part = part.replace(" lead", "").strip()
                if part:
                    titles.append(part)
    except (OSError, json.JSONDecodeError):
        pass
    out: list[str] = []
    for q in [*titles, *extra]:
        if q.lower() not in (x.lower() for x in out):
            out.append(q)
    return out


def money(cents) -> str:
    return "{:,.0f}".format(cents / 100) if isinstance(cents, (int, float)) else ""


def salary_text(job: dict) -> str:
    lo = money(job.get("compensation_amount_min_cents"))
    hi = money(job.get("compensation_amount_max_cents"))
    if not (lo or hi):
        return ""
    cur = job.get("compensation_currency") or ""
    period = (job.get("compensation_period") or "").replace("period_not_defined", "")
    span = f"{lo} to {hi}" if lo and hi and lo != hi else (lo or hi)
    return " ".join(p for p in (cur, span, f"per {period}" if period else "") if p)


def company_size(org: dict) -> str:
    for topic in org.get("topics") or []:
        if topic and topic[0].isdigit() and ("-" in topic or topic.endswith("+")):
            return f"{topic} employees"
    return ""


def to_position(job: dict) -> dict:
    org = job.get("organization") or {}
    locations = job.get("locations") or job.get("searchable_locations") or []
    # Getro fills work_mode from the employer's feed and often defaults it to
    # on_site, so it is passed along as a hint, never folded into the location
    # where it would trip the scan's on-site screen. The scan checks the posting.
    mode = WORK_MODE.get(job.get("work_mode") or "", "")
    loc = "; ".join(locations)
    created = job.get("created_at")
    posted = (
        datetime.fromtimestamp(created, tz=timezone.utc).date().isoformat()
        if isinstance(created, (int, float))
        else ""
    )
    slug = job.get("slug") or ""
    board_url = (
        f"{BOARD}/companies/{org.get('slug')}/jobs/{slug}"
        if org.get("slug") and slug
        else f"{BOARD}/jobs"
    )
    return {
        "title": job.get("title"),
        "company": org.get("name"),
        "location": loc,
        "work_mode_on_board": mode,
        "url": job.get("url") or board_url,
        "board_url": board_url,
        "posted_date": posted,
        "salary_text": salary_text(job),
        "company_size": company_size(org),
        "company_stage": org.get("stage") or "",
        "source": "communitech",
        "getro_id": job.get("id"),
    }


def sweep() -> dict:
    found: dict = {}
    errors = []
    searched = []
    for query in queries():
        page, count, seen = 0, None, 0
        # The API serves at most 20 a page whatever is asked, so the stop is
        # how many were read against the count it reports.
        while count is None or seen < count:
            try:
                results = search(query, page)
            except Exception as exc:  # noqa: BLE001
                errors.append({"query": query, "page": page, "error": str(exc)[:160]})
                break
            jobs = results.get("jobs") or []
            count = int(results.get("count") or 0)
            seen += len(jobs)
            for job in jobs:
                title = job.get("title") or ""
                if not keep_title(title):
                    continue
                pos = to_position(job)
                ok, kind = location_ok(pos["location"])
                # The board carries some overseas jobs. Keep close-to-home
                # and remote; drop the rest here.
                if not ok or kind == "other":
                    continue
                pos["location_kind"] = kind
                found.setdefault(job.get("id"), pos)
            if not jobs:
                break
            page += 1
            time.sleep(0.3)
        searched.append({"query": query, "count": count or 0, "read": seen})
    return {
        "jobs": sorted(found.values(), key=lambda p: p["posted_date"], reverse=True),
        "searched": searched,
        "errors": errors,
        "ok": not errors or bool(found),
    }


def main() -> int:
    result = sweep()
    report = {"communitech": result, "counts": {"communitech": len(result["jobs"])}}
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
