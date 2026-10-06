#!/usr/bin/env python3
"""Read the candidate's own settings, with safe defaults.

Every script loads the personal files through here, never by hand, so a missing
file or a missing key never crashes a scheduled run. The files themselves are
described in docs/dev/CONFIG.md and written by the onboarding interview.

    from profile_lib import load_candidate, load_resume, load_scoring, project_root
"""

from __future__ import annotations

import copy
import json
import os
import re
from pathlib import Path
from typing import Any


def project_root() -> Path:
    env = os.environ.get("JOBSEARCH_ROOT")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent


ROOT = project_root()
PROFILE_DIR = ROOT / "profile"
DATA_DIR = ROOT / "dashboard" / "data"
CANDIDATE_FILE = PROFILE_DIR / "candidate.json"
RESUME_FILE = PROFILE_DIR / "resume.json"
SCORING_FILE = DATA_DIR / "scoring-profile.json"
APPLICATION_FILE = DATA_DIR / "application-profile.json"

CANDIDATE_DEFAULTS: dict[str, Any] = {
    "version": 1,
    "onboarded": False,
    "name": "",
    "first_name": "",
    "pronouns": "",
    "email": "",
    "phone": "",
    "city": "",
    "region": "",
    "country": "Canada",
    "linkedin": "",
    "website": "",
    "currency": "CAD",
    "goal_summary": "",
    "target_titles": [],
    "strengths": [],
    "industries": {"preferred": [], "open": [], "off_limits": []},
    "experience_years": {"total": 0, "in_function": 0, "function_label": "operations"},
    "work_authorization": {"countries": [], "note": ""},
    "home_area": {"label": "", "cities": [], "linkedin_location": "", "radius_km": 40},
    "location_buckets": [
        {"label": "Remote", "pattern": "remote"},
        {"label": "Other / unclear", "pattern": ""},
    ],
    "remote_search_country": "Canada",
    "calendar_url": "",
    "schedule": {
        "search_times": ["08:00", "16:00"],
        "weekly_digest": {"enabled": True, "weekday": 5, "time": "10:00"},
    },
    "sources": {
        "linkedin_alert_emails": True,
        "linkedin_sweep": True,
        "yc_jobs": True,
        "wellfound": True,
        "communitech": False,
        "startup_watch": True,
    },
    "startup_watch": {"region_label": "", "cities": [], "max_employees": 100, "daily_new": 3},
    "integrations": {
        "gmail": "claude-connector",
        "granola": False,
        "wispr_flow": False,
        "github_backup": False,
    },
    "notifications": {"email_strong_matches": True, "mac_notifications": True},
    "dashboard": {"port": 7411, "share_on_home_wifi": False},
}

RESUME_DEFAULTS: dict[str, Any] = {
    "name": "",
    "contact": "",
    "headline": "",
    "target_roles": "",
    "summary": "",
    "experience": [],
    "education": [],
    "certifications": [],
    "skills_groups": [],
    "tools": "",
    "languages": [],
    "accent_color": "0f766e",
}


def _merge(defaults: Any, actual: Any) -> Any:
    """Deep-merge: keys in `actual` win, missing keys come from `defaults`."""
    if isinstance(defaults, dict) and isinstance(actual, dict):
        out = copy.deepcopy(defaults)
        for key, value in actual.items():
            out[key] = _merge(defaults.get(key), value) if key in defaults else value
        return out
    return copy.deepcopy(actual) if actual is not None else copy.deepcopy(defaults)


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"The settings file {path.relative_to(ROOT)} has a typo in it and could not be read "
            f"(line {exc.lineno}). Ask Claude to fix it."
        )


def load_candidate() -> dict:
    return _merge(CANDIDATE_DEFAULTS, _read(CANDIDATE_FILE))


def load_resume() -> dict:
    return _merge(RESUME_DEFAULTS, _read(RESUME_FILE))


def load_scoring() -> dict:
    return _read(SCORING_FILE)


def load_application_profile() -> dict:
    return _read(APPLICATION_FILE)


def candidate_name(candidate: dict | None = None) -> str:
    c = candidate or load_candidate()
    return (c.get("name") or "").strip() or "the candidate"


def first_name(candidate: dict | None = None) -> str:
    c = candidate or load_candidate()
    first = (c.get("first_name") or "").strip()
    if first:
        return first
    name = (c.get("name") or "").strip()
    return name.split()[0] if name else ""


def city_regex(cities: list[str] | None) -> re.Pattern | None:
    """Case-insensitive whole-word regex for a list of city names, or None if empty."""
    names = [re.escape(c.strip().lower()) for c in (cities or []) if c and c.strip()]
    if not names:
        return None
    return re.compile(r"\b(" + "|".join(names) + r")\b", re.I)


def home_area_regex(candidate: dict | None = None) -> re.Pattern | None:
    c = candidate or load_candidate()
    return city_regex((c.get("home_area") or {}).get("cities"))


def _is_placeholder(text) -> bool:
    return not isinstance(text, str) or not text.strip() or text.strip().upper().startswith(("FILL", "TODO"))


def search_titles(scoring: dict | None = None, candidate: dict | None = None) -> list[str]:
    """Job titles to search for: scoring search_scope.titles, else candidate.target_titles."""
    s = scoring if scoring is not None else load_scoring()
    titles = [t.strip() for t in (s.get("search_scope") or {}).get("titles") or [] if not _is_placeholder(t)]
    if not titles:
        c = candidate or load_candidate()
        titles = [t.strip() for t in c.get("target_titles") or [] if not _is_placeholder(t)]
    return titles


def title_exclusion_regex(scoring: dict | None = None) -> re.Pattern | None:
    """Words that rule a title out.

    From scoring-profile hard_exclusions.title_words, plus any entry in
    hard_exclusions.title_level that is a short word or phrase (3 words or
    fewer, e.g. "Intern", "Junior"). Empty (the default) means no title is
    ruled out by its wording.
    """
    s = scoring if scoring is not None else load_scoring()
    hx = s.get("hard_exclusions") or {}
    words = list(hx.get("title_words") or [])
    words += [w for w in hx.get("title_level") or [] if isinstance(w, str) and len(w.split()) <= 3]
    words = [w.strip() for w in words if not _is_placeholder(w)]
    if not words:
        return None
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.I)


def location_bucket(text: str, candidate: dict | None = None) -> str:
    c = candidate or load_candidate()
    low = (text or "").lower()
    for bucket in c.get("location_buckets") or []:
        pattern = bucket.get("pattern") or ""
        if not pattern or re.search(pattern, low, re.I):
            return bucket.get("label") or "Other"
    return "Other / unclear"
