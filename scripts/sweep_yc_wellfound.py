#!/usr/bin/env python3
"""Find openings matching the candidate's target titles on Y Combinator and Wellfound.

Titles come from scoring-profile.json -> search_scope.titles (or
profile/candidate.json -> target_titles). "Close to home" means the
candidate's country, region, city or home_area.cities. Y Combinator role
families come from search_scope.yc_roles when set.

Y Combinator jobs pages ship a JSON blob we can read over plain HTTP.
Wellfound blocks plain HTTP with a security page, so this script reports
that and the scan uses the logged-in browser for Wellfound.

    .venv/bin/python scripts/sweep_yc_wellfound.py
"""

from __future__ import annotations

import html as htmllib
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from profile_lib import city_regex, load_candidate, load_scoring, search_titles  # noqa: E402

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

CANDIDATE = load_candidate()
SCOPE = load_scoring().get("search_scope") or {}
TITLES = search_titles(candidate=CANDIDATE)


_SYNONYMS = {"and": "(?:and|&)", "&": "(?:and|&)", "operations": "(?:operations|ops)",
             "vp": "(?:vp|vice\\W+president)", "senior": "(?:senior|sr)", "manager": "(?:manager|mgr)"}


def _word(w: str) -> str:
    return _SYNONYMS.get(w, re.escape(w))


def _title_regex(titles: list[str]) -> re.Pattern:
    """Match any target title, allowing "&"/"and" and "of" to vary."""
    parts = []
    for t in titles:
        words = re.sub(r"[^a-z0-9& ]+", " ", t.lower()).split()
        words = [w for w in words if w not in {"of", "the"}]
        if words:
            parts.append(r"\W+(?:of\W+|the\W+)?".join(
                _word(w) for w in words))
    if not parts:
        return re.compile(r"(?!x)x")  # matches nothing until titles are set
    return re.compile("|".join(parts), re.I)


TITLE_RE = _title_regex(TITLES)

SKIP_TITLE_RE = re.compile(
    r"\b(intern|internship|co-?op|part[- ]time|software engineer|"
    r"frontend|backend|fullstack|designer|account executive)\b",
    re.I,
)

ON_SITE_US_RE = re.compile(
    r"\b(san francisco|palo alto|mountain view|los angeles|new york|"
    r"brooklyn|boston|seattle|austin|chicago)\b",
    re.I,
)
REMOTE_RE = re.compile(r"\bremote\b", re.I)
_home_names = [CANDIDATE.get("country"), CANDIDATE.get("region"), CANDIDATE.get("city")]
_home_names += (CANDIDATE.get("home_area") or {}).get("cities") or []
if (CANDIDATE.get("country") or "").lower() == "canada":
    _home_names.append("canadian")
HOME_RE = city_regex([n for n in _home_names if n and len(str(n)) >= 2])
_auth = " ".join((CANDIDATE.get("work_authorization") or {}).get("countries") or []).lower()
US_OK = bool(re.search(r"united states|\busa?\b", _auth))

YC_ROLES = tuple(SCOPE.get("yc_roles") or ("operations", "recruiting-hr", "marketing", "sales", "product"))


def get(url: str) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "text/html,application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode("utf-8", "replace")


def inertia_props(page_html: str) -> dict:
    match = re.search(r'data-page="(.*?)"', page_html)
    if not match:
        return {}
    return json.loads(htmllib.unescape(match.group(1))).get("props") or {}


def location_ok(location: str) -> tuple[bool, str]:
    loc = location or ""
    if HOME_RE and HOME_RE.search(loc):
        return True, "home"
    if not US_OK and ON_SITE_US_RE.search(loc) and not REMOTE_RE.search(loc):
        return False, "on-site-us"
    if REMOTE_RE.search(loc) and re.search(r"remote \(us\)", loc, re.I):
        return True, "remote-us"
    if REMOTE_RE.search(loc):
        return True, "remote"
    return True, "other"


def keep_title(title: str) -> bool:
    if SKIP_TITLE_RE.search(title or "") and not TITLE_RE.search(title or ""):
        return False
    return bool(TITLE_RE.search(title or ""))


def yc_jobs() -> dict:
    found = []
    errors = []
    for slug in YC_ROLES:
        url = f"https://www.ycombinator.com/jobs/role/{slug}"
        try:
            props = inertia_props(get(url))
        except Exception as exc:  # noqa: BLE001
            errors.append({"source": "yc-jobs", "url": url, "error": str(exc)[:160]})
            continue
        for job in props.get("jobPostings") or []:
            title = job.get("title") or ""
            if not keep_title(title):
                continue
            loc = job.get("location") or ""
            ok, loc_kind = location_ok(loc)
            if not ok:
                continue
            path = job.get("url") or ""
            found.append(
                {
                    "title": title,
                    "company": job.get("companyName"),
                    "location": loc,
                    "location_kind": loc_kind,
                    "url": (
                        path
                        if str(path).startswith("http")
                        else f"https://www.ycombinator.com{path}"
                    ),
                    "salary_text": job.get("salaryRange"),
                    "source": "yc-jobs",
                    "role_family": job.get("prettyRole") or slug,
                    "employment_type": job.get("type"),
                }
            )
    return {"jobs": found, "errors": errors}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def wellfound_searches() -> list[dict]:
    place = _slug(CANDIDATE.get("remote_search_country") or CANDIDATE.get("country") or "")
    out = []
    for title in TITLES[:6]:
        slug = _slug(title)
        if place:
            out.append({"title": title, "url": f"https://wellfound.com/role/l/{slug}/{place}"})
        out.append({"title": f"{title} (remote)", "url": f"https://wellfound.com/role/r/{slug}"})
    return out


def wellfound_probe() -> dict:
    searches = wellfound_searches()
    if not searches:
        return {"blocked": False, "jobs": [], "browser_needed": False, "searches": [],
                "note": "No target titles set yet."}
    url = searches[0]["url"]
    try:
        body = get(url)
    except Exception as exc:  # noqa: BLE001
        return {
            "blocked": True,
            "jobs": [],
            "error": str(exc)[:160],
            "browser_needed": True,
            "searches": searches,
        }
    if "Security Check" in body or "captcha" in body.lower() or len(body) < 2000:
        return {"blocked": True, "jobs": [], "browser_needed": True, "searches": searches}
    return {
        "blocked": False,
        "jobs": [],
        "browser_needed": True,
        "note": "HTML came back but is not a structured listing. Use the browser searches.",
        "searches": searches,
    }


def main() -> int:
    yc = yc_jobs()
    wf = wellfound_probe()
    report = {
        "yc-jobs": yc,
        "wellfound": wf,
        "counts": {
            "yc": len(yc["jobs"]),
            "wellfound": len(wf.get("jobs") or []),
        },
    }
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
