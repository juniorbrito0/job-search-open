#!/usr/bin/env python3
"""Second score on every position: Worth applying (1-5).

The dashboard shows two numbers:

  Dream fit       scores.overall. Is this the seat the candidate actually wants?
                  Scored by the search agent per scoring-profile.json.
  Worth applying  scores.worth_applying, written here. Is an application likely to
                  get a reply? Deterministic, so every position is scored the same
                  way and the weights can be tuned in one place.

Why a script and not the agent: the factors are all things already on the record
(years asked for, company size, match %, location and pay scores), and the weights
have to move together when the outcome data says so.

Settings live in scoring-profile.json -> worth_applying:
  weights     override any of DEFAULT_WEIGHTS below (empty = use defaults)
  thresholds  override any of DEFAULT_THRESHOLDS below
The years bar is relative to profile/candidate.json -> experience_years.in_function:
  within reach   the posting asks for in_function + 1 years or fewer
  stretch        it asks for in_function + 2 or + 3
  wall           it asks for in_function + 4 or more
The pay factor only counts when scoring-profile.json -> dimensions.comp.bonus is
set (a number above zero, in the candidate's currency).

What deliberately does NOT count against Worth applying: an industry the
candidate has not worked in, or an undisclosed employer (recruiter postings).

Usage:
  python3 scripts/score_worth_applying.py            score every position, write
  python3 scripts/score_worth_applying.py --dry-run  print the distribution only
  python3 scripts/score_worth_applying.py --learn    also refresh the outcome
                                                     calibration in the profile
  python3 scripts/score_worth_applying.py --sweep-titles
        move review-tab positions whose title contains one of
        scoring-profile.json -> hard_exclusions.title_words into ignored.json
  python3 scripts/score_worth_applying.py --test     self-checks, writes nothing
"""

from __future__ import annotations

import re
import sys
from collections import Counter

from jobsearch_lib import (
    DATA,
    PROFILE_FILE,
    file_lock,
    load_positions,
    now_iso,
    read_json,
    save_positions,
    write_json,
)
from profile_lib import load_candidate, title_exclusion_regex

IGNORED_FILE = DATA / "ignored.json"

DEFAULT_WEIGHTS = {
    "years_within_reach": 0.5,   # asks no more than in_function + 1 years
    "years_stretch": -0.5,       # asks in_function + 2 or + 3 years
    "years_wall": -1.5,          # asks in_function + 4 years or more
    "credential_gate": -1.0,     # MBA / CPA / consulting stated as required
    "altitude_gap": -1.0,        # VP/SVP/C-level (not Chief of Staff) at a big company
    "founding_shape": 1.0,       # lead title at a small company
    "large_company": -0.5,       # very large company
    "match_strong": 0.5,         # match_pct at or above thresholds.match_strong
    "match_weak": -0.5,          # match_pct under thresholds.match_weak
    "remote_or_local": 0.5,      # location score 5
    "heavy_office": -0.5,        # location score 2 or lower
    "pay_top_band": 0.5,         # comp score 5 (pay at or above the bonus band)
}

DEFAULT_THRESHOLDS = {
    "small_company_max": 60,
    "large_company_min": 500,
    "exec_altitude_min": 150,
    "match_strong": 75,
    "match_weak": 55,
}

# Plain-English explanation of each factor, for the dashboard and onboarding.
FACTOR_LABELS = {
    "years_within_reach": "The years of experience asked for are within your reach",
    "years_stretch": "The posting asks for 2 to 3 more years than you have",
    "years_wall": "The posting asks for 4 or more years more than you have, a bar screeners usually enforce",
    "credential_gate": "The posting requires a credential like an MBA, a CPA or a consulting background",
    "altitude_gap": "An executive title (VP or C-level) at a large company, a big jump in seniority",
    "founding_shape": "A lead role at a small company, where broad experience counts most",
    "large_company": "A very large company, where replies tend to be rarer",
    "match_strong": "Your experience covers most of the duties",
    "match_weak": "Your experience covers less than half of the duties",
    "remote_or_local": "Remote, or close to home",
    "heavy_office": "Several office days a week, or a long commute",
    "pay_top_band": "Published pay at or above your target",
}

YEARS = re.compile(r"(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*years", re.I)
CREDENTIAL = re.compile(
    r"(mba|cpa|chartered professional accountant)[^.\n]{0,40}(required|must|mandatory)"
    r"|(required|must have|must hold)[^.\n]{0,40}(mba|cpa)"
    r"|(top[- ]tier|management) consulting (background|experience) (is )?(required|preferred)"
    r"|\d+\+? years[^.\n]{0,30}management consulting",
    re.I,
)
EXEC_TITLE = re.compile(r"\b(vp|vice president|svp|chief(?! of staff)|cxo|coo|cfo|cpo|cro)\b", re.I)
LEAD_TITLE = re.compile(
    r"chief of staff|head of|director|general manager|founding|\blead\b|principal|"
    r"\bmanager\b|\bvp\b|vice president",
    re.I,
)
POSITIVE = {"screen", "interview", "offer", "ongoing"}

_SETTINGS: dict = {}


def settings() -> dict:
    """Years in function, thresholds, pay switch and title rule, read once per run."""
    if not _SETTINGS:
        cand = load_candidate()
        profile = read_json(PROFILE_FILE, default={})
        wa = profile.get("worth_applying") or {}
        th = dict(DEFAULT_THRESHOLDS)
        th.update(wa.get("thresholds") or {})
        comp = (profile.get("dimensions") or {}).get("comp") or {}
        bonus = comp.get("bonus") or comp.get("bonus_cad") or 0
        try:
            years = float((cand.get("experience_years") or {}).get("in_function") or 0)
        except (TypeError, ValueError):
            years = 0.0
        _SETTINGS.update({
            "years": years,
            "thresholds": th,
            "pay_enabled": bool(bonus),
            "title_re": title_exclusion_regex(profile),
        })
    return _SETTINGS


def title_excluded(title: str) -> bool:
    rx = settings()["title_re"]
    return bool(rx and rx.search(title or ""))


def company_size(raw) -> int | None:
    """First headcount in a free-text size field; None when unknown."""
    text = str(raw or "").replace(",", "")
    m = re.search(r"(\d{1,6})\s*(?:\+|-|–|to|employees|people|staff|ppl|p\b)", text)
    if not m:
        m = re.search(r"~\s*(\d{1,6})", text)
    return int(m.group(1)) if m else None


def years_asked(text: str) -> int | None:
    """Highest plausible 'N years' requirement in the JD (ignores 'founded 20 years ago')."""
    vals = []
    for m in YEARS.finditer(text or ""):
        n = int(m.group(2) or m.group(1))
        tail = (text or "")[m.end(): m.end() + 40].lower()
        if 1 <= n <= 20 and ("experience" in tail or "in " in tail or "of " in tail or "leading" in tail):
            vals.append(n)
    return max(vals) if vals else None


def years_band(asked: int, have: float) -> str:
    gap = asked - have
    if gap <= 1:
        return "years_within_reach"
    if gap <= 3:
        return "years_stretch"
    return "years_wall"


def factors(p: dict) -> list[str]:
    cfg = settings()
    th = cfg["thresholds"]
    s = p.get("scores") or {}
    jd = p.get("jd_text") or p.get("jd_summary") or ""
    title = p.get("title") or ""
    size = company_size(p.get("company_size"))
    out = []
    y = years_asked(jd)
    if y is not None and cfg["years"] > 0:
        out.append(years_band(y, cfg["years"]))
    if CREDENTIAL.search(jd):
        out.append("credential_gate")
    if EXEC_TITLE.search(title) and size is not None and size >= th["exec_altitude_min"]:
        out.append("altitude_gap")
    if LEAD_TITLE.search(title) and size is not None and size <= th["small_company_max"]:
        out.append("founding_shape")
    if size is not None and size >= th["large_company_min"]:
        out.append("large_company")
    m = p.get("match_pct")
    if isinstance(m, (int, float)):
        if m >= th["match_strong"]:
            out.append("match_strong")
        elif m < th["match_weak"]:
            out.append("match_weak")
    loc = s.get("location") or 3
    if loc >= 5:
        out.append("remote_or_local")
    elif loc <= 2:
        out.append("heavy_office")
    if cfg["pay_enabled"] and (s.get("comp") or 3) >= 5:
        out.append("pay_top_band")
    return out


def label(f: str, y) -> str:
    have = settings()["years"]
    have_txt = "%g" % have
    if f == "years_within_reach":
        return f"asks for {y} years, which your {have_txt} clear"
    if f == "years_stretch":
        return f"asks for {y} years, a stretch on your {have_txt}"
    if f == "years_wall":
        return f"asks for {y} years, a bar screeners usually enforce"
    text = FACTOR_LABELS[f]
    return text[0].lower() + text[1:]


def score(p: dict, weights: dict) -> tuple[int, str]:
    fs = factors(p)
    raw = 3.0 + sum(weights.get(f, 0.0) for f in fs)
    value = max(1, min(5, int(raw + 0.5)))
    y = years_asked(p.get("jd_text") or p.get("jd_summary") or "")
    plus = [label(f, y) for f in fs if weights.get(f, 0) > 0]
    minus = [label(f, y) for f in fs if weights.get(f, 0) < 0]
    parts = []
    if plus:
        parts.append("For: " + "; ".join(plus) + ".")
    if minus:
        parts.append("Against: " + "; ".join(minus) + ".")
    return value, " ".join(parts) or "No strong signal either way; neutral 3."


def outcome(p: dict) -> str:
    seen = {h.get("status") for h in p.get("status_history") or []}
    if p.get("status") in POSITIVE or seen & POSITIVE:
        return "positive"
    if (p.get("dq_analysis") or {}).get("cause") == "employer-rejected":
        return "employer_no"
    return "silent"


def applied(p: dict) -> bool:
    seen = {h.get("status") for h in p.get("status_history") or []}
    return bool(p.get("applied_at") or "applied" in seen or p.get("status") in POSITIVE)


def calibrate(positions: list[dict], cfg: dict) -> dict:
    """Outcome rates per factor among applications. Weights move only on real evidence."""
    pool = [p for p in positions if applied(p)]
    base = Counter(outcome(p) for p in pool)
    n_all = len(pool) or 1
    base_pos = base["positive"] / n_all
    min_n = cfg.get("learn_min_factor_n", 20)
    min_pos = cfg.get("learn_min_positives", 8)
    rows = {}
    for f in DEFAULT_WEIGHTS:
        group = [p for p in pool if f in factors(p)]
        c = Counter(outcome(p) for p in group)
        rows[f] = {
            "applications": len(group),
            "callbacks": c["positive"],
            "employer_no": c["employer_no"],
            "callback_rate": round(c["positive"] / len(group), 3) if group else None,
        }
    learned = {}
    if base["positive"] >= min_pos:
        for f, r in rows.items():
            if r["applications"] >= min_n and r["callback_rate"] is not None:
                diff = r["callback_rate"] - base_pos
                step = max(-1.0, min(1.0, round(diff / 0.05) * 0.25))
                if step:
                    learned[f] = step
    return {
        "updated_at": now_iso(),
        "applications": len(pool),
        "callbacks": base["positive"],
        "employer_no": base["employer_no"],
        "silent": base["silent"],
        "baseline_callback_rate": round(base_pos, 3),
        "by_factor": rows,
        "learned_adjustments": learned,
        "note": (
            "Learned adjustments switch on once there are at least "
            f"{min_pos} callbacks to learn from and a factor has {min_n}+ applications. "
            "Below that the sample is too small to move weights without chasing noise."
        ),
    }


def effective_weights(cfg: dict) -> dict:
    w = dict(DEFAULT_WEIGHTS)
    w.update(cfg.get("weights") or {})
    for f, adj in ((cfg.get("calibration") or {}).get("learned_adjustments") or {}).items():
        w[f] = w.get(f, 0.0) + adj
    return w


def sweep_titles(data: dict) -> int:
    ignored = read_json(IGNORED_FILE, {"version": 1, "ignored": []})
    ignored.setdefault("ignored", [])
    keep, moved = [], 0
    for p in data["positions"]:
        if p.get("status") == "review" and title_excluded(p.get("title", "")):
            ignored["ignored"].append({
                "title": p.get("title"), "company": p.get("company"), "url": p.get("url"),
                "reason": "title-level: the title contains a word you ruled out (hard_exclusions.title_words)",
                "found_date": p.get("found_date"), "source": p.get("source"),
            })
            moved += 1
        else:
            keep.append(p)
    if moved:
        data["positions"] = keep
        ignored["updated_at"] = now_iso()
        write_json(IGNORED_FILE, ignored)
    return moved


def run(argv: list[str]) -> None:
    dry = "--dry-run" in argv
    with file_lock():
        data = load_positions()
        profile = read_json(PROFILE_FILE, default={})
        cfg = profile.setdefault("worth_applying", {})
        moved = 0
        if "--sweep-titles" in argv and not dry and settings()["title_re"]:
            moved = sweep_titles(data)
        if "--learn" in argv:
            cfg["calibration"] = calibrate(data["positions"], cfg)
        w = effective_weights(cfg)
        dist = Counter()
        for p in data["positions"]:
            value, why = score(p, w)
            dist[value] += 1
            if dry:
                continue
            p.setdefault("scores", {})["worth_applying"] = value
            p.setdefault("score_rationale", {})["worth_applying"] = why
        if not dry:
            save_positions(data)
            if "--learn" in argv and PROFILE_FILE.exists():
                write_json(PROFILE_FILE, profile)
    print(f"Worth applying: {dict(sorted(dist.items()))} across {sum(dist.values())} positions"
          + (f"; moved {moved} review cards with a ruled-out title word to Screened out" if moved else "")
          + (" (dry run)" if dry else ""))


def _test() -> None:
    _SETTINGS.clear()
    _SETTINGS.update({
        "years": 4.6, "thresholds": dict(DEFAULT_THRESHOLDS), "pay_enabled": True,
        "title_re": re.compile(r"\b(junior|coordinator|specialist)\b", re.I),
    })
    assert title_excluded("Junior Operations Analyst")
    assert title_excluded("People & Office Coordinator")
    assert not title_excluded("Chief of Staff")
    assert company_size("~1,500-2,500 employees") == 1500
    assert company_size("~21 people (LinkedIn)") == 21
    assert company_size(None) is None
    assert years_asked("You have 8+ years of experience in ops") == 8
    assert years_asked("3-5 years experience; we were founded 20 years ago.") == 5
    assert years_band(5, 4.6) == "years_within_reach"
    assert years_band(7, 4.6) == "years_stretch"
    assert years_band(9, 4.6) == "years_wall"
    founding = {"title": "Head of Operations", "company_size": "~25 employees", "match_pct": 80,
                "scores": {"location": 5, "comp": 3}, "jd_text": "4+ years of experience in operations"}
    v, _ = score(founding, DEFAULT_WEIGHTS)
    assert v == 5, v
    walled = {"title": "VP Operations", "company_size": "~900 employees", "match_pct": 50,
              "scores": {"location": 2, "comp": 3}, "jd_text": "10+ years of experience. MBA required."}
    v, _ = score(walled, DEFAULT_WEIGHTS)
    assert v == 1, v
    neutral = {"title": "Operations Analyst", "scores": {"location": 3, "comp": 3}}
    assert score(neutral, DEFAULT_WEIGHTS)[0] == 3
    assert set(FACTOR_LABELS) == set(DEFAULT_WEIGHTS)
    _SETTINGS.update({"title_re": None, "years": 0.0, "pay_enabled": False})
    assert not title_excluded("Junior Analyst")
    assert "years_wall" not in factors({"jd_text": "12+ years of experience"})
    assert "pay_top_band" not in factors({"scores": {"comp": 5}})
    _SETTINGS.clear()
    print("ok")


if __name__ == "__main__":
    if "--test" in sys.argv:
        _test()
    else:
        run(sys.argv[1:])
