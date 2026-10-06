#!/usr/bin/env python3
"""Optional clean-up: cut the review queue down to what is worth the candidate's time.

Only run on request (for example "my review queue is too long, tidy it up").
Every rule below comes from the candidate's own settings:

  - part-time, internships, seasonal, contracts under 12 months
  - title words ruled out in scoring-profile.json -> hard_exclusions.title_words
  - US-only roles, unless profile/candidate.json -> work_authorization.countries
    includes the United States
  - fully on-site outside profile/candidate.json -> home_area.cities
  - asks for 4+ more years than experience_years.in_function
  - companies at or above worth_applying.thresholds.large_company_min people,
    unless the candidate scored it 3 or higher
  - anything the candidate's Dream fit score put at 1 with a weak match

Cut positions move to status "rejected" with a note saying which rule did it.
Run with --apply to write. Without it, prints the plan and changes nothing.
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from datetime import date

from jobsearch_lib import file_lock, load_positions, save_positions
from profile_lib import home_area_regex, load_candidate, load_scoring, title_exclusion_regex

CANDIDATE = load_candidate()
SCORING = load_scoring()
HOME = home_area_regex(CANDIDATE)
TITLE_OUT = title_exclusion_regex(SCORING)
_auth = " ".join((CANDIDATE.get("work_authorization") or {}).get("countries") or []).lower()
US_AUTHORIZED = bool(re.search(r"united states|\busa?\b", _auth))
IN_FUNCTION = float((CANDIDATE.get("experience_years") or {}).get("in_function") or 0)
LARGE = int(((SCORING.get("worth_applying") or {}).get("thresholds") or {}).get("large_company_min") or 500)

US_ONLY = re.compile(r"united states only|u\.s\. only|us only|available from: united states|"
                     r"must (?:be|reside).{0,30}united states|authorized to work in the (?:us|united states)", re.I)
PART_TIME = re.compile(r"part[- ]time|seasonal|internship|\bco-op\b|\bintern\b", re.I)
SHORT_CONTRACT = re.compile(
    r"\b([1-9]|10|11)\s*[- ]?month(?:s)?\s+(?:contract|fixed[- ]term|term)\b",
    re.I,
)
# A bare "\d+ years" also matches "OpenTable, with 25+ years of experience", which is the
# company describing itself. Only count a number that reads as a requirement on the candidate.
YEARS = re.compile(r"(?:(\d{1,2})\s*(?:to|-|\u2013)\s*)?(\d{1,2})\s*\+?\s*years?", re.I)
COMPANY_AGE = re.compile(r"(?:for (?:over|more than)|with (?:over|more than)|we have|has been|"
                         r"been (?:in business|operating)|founded|partners and|history of|celebrating)\s*$", re.I)
REQUIREMENT = re.compile(r"^\s*\+?\s*(?:of|in|')?\s*(?:progressive\s+|relevant\s+|combined\s+|hands[- ]on\s+)?"
                         r"(?:experience|leadership|working|in\b|of\b|as\b|managing|running|building|owning)", re.I)

def size_of(p):
    """Headcount from the company_size field only.

    The funding field is off limits here: "$7.5M seed; 200+ farm waitlist" was being
    read as a 200-person company and cutting a seed-stage startup.
    """
    text = (p.get("company_size") or "").replace(",", "")
    nums = [int(n) for n in re.findall(r"\b(\d{1,7})\b", text)]
    nums = [n for n in nums if not (1990 <= n <= 2035)]
    return max(nums) if nums else None


def max_years_asked(p):
    """Highest candidate-experience bar stated in the JD, 0 if none.

    Ranges resolve to their low end ("5 to 8 years" is a bar of 5), and anything
    sitting in a company-age sentence is skipped.
    """
    jd = p.get("jd_text") or ""
    best = 0
    for m in YEARS.finditer(jd):
        low, high = m.group(1), m.group(2)
        n = int(low or high)
        if not (1 <= n <= 25):
            continue
        before = jd[max(0, m.start() - 60):m.start()]
        after = jd[m.end():m.end() + 60]
        if COMPANY_AGE.search(before):
            continue
        if not REQUIREMENT.match(after):
            continue
        best = max(best, n)
    return best


def onsite_days(p):
    """Most office days a week the posting asks for (0 if it never says)."""
    text = f"{p.get('work_model') or ''} {p.get('jd_text') or ''}"
    days = 0
    for m in re.finditer(r"(\d)\s*(?:\+)?\s*days?\s*(?:per|a|/)?\s*week.{0,30}(?:on[- ]?site|in[- ]?office|office)",
                         text, re.I):
        days = max(days, int(m.group(1)))
    for m in re.finditer(r"(?:on[- ]?site|in[- ]?office|in the office).{0,30}(\d)\s*(?:\+)?\s*days", text, re.I):
        days = max(days, int(m.group(1)))
    return days


def verdict(p):
    """Return (keep: bool, reason: str)."""
    title = p.get("title") or ""
    wm = (p.get("work_model") or "").lower()
    loc = p.get("location") or ""
    jd = p.get("jd_text") or ""
    score = (p.get("scores") or {}).get("overall", 0) or 0
    match = p.get("match_pct") or 0
    size = size_of(p)

    if PART_TIME.search(title):
        return False, "part-time, intern, or seasonal"
    if SHORT_CONTRACT.search(title):
        return False, "contract shorter than 12 months"
    if TITLE_OUT and TITLE_OUT.search(title):
        return False, "title contains a word you ruled out"
    if not US_AUTHORIZED and US_ONLY.search(jd):
        return False, "US-only, and you are not authorized to work in the US"
    home = bool(HOME and HOME.search(loc))
    if not home and "remote" not in wm and (onsite_days(p) >= 5 or "on-site" in wm):
        return False, "fully on-site outside your home area"
    y = max_years_asked(p)
    if IN_FUNCTION and y >= IN_FUNCTION + 4:
        return False, f"asks {y}+ years, well past what the resume shows"
    if size and size >= LARGE and score < 3:
        return False, f"~{size} people and you scored it under 3"
    if score <= 1 and match < 50:
        return False, f"Dream fit 1 and the match is {match}%"

    if score >= 3:
        return True, f"Dream fit {score}"
    if p.get("source") == "startup-watch":
        return True, "from your startup watchlist"
    if match >= 60:
        return True, f"match {match}%"
    return False, f"nothing carries it (Dream fit {score}, match {match}%)"


def main():
    apply = "--apply" in sys.argv
    with file_lock():
        data = load_positions()
        review = [p for p in data["positions"] if p.get("status") == "review"]
        if not review:
            print("The review queue is empty. Nothing to tidy.")
            return

        keeps, cuts = [], []
        for p in review:
            ok, why = verdict(p)
            (keeps if ok else cuts).append((p, why))

        print(f"review queue: {len(review)}")
        print(f"keep: {len(keeps)}   cut: {len(cuts)}   ({round(len(cuts)/len(review)*100)}% cut)\n")
        print("cut reasons:")
        for why, n in Counter(w for _, w in cuts).most_common():
            print(f"  {n:4}  {why}")
        print("\nkeep reasons:")
        for why, n in Counter(w for _, w in keeps).most_common():
            print(f"  {n:4}  {why}")

        if not apply:
            print("\n(dry run, nothing written; pass --apply to commit)")
            return

        today = date.today().isoformat()
        for p, why in cuts:
            p["status"] = "rejected"
            p["reject_reasons"] = p.get("reject_reasons") or ["other"]
            p["reject_note"] = f"Tidy-up {today}: {why}"
            p.setdefault("status_history", []).append({"status": "rejected", "at": today})
        save_positions(data)
    print(f"\nwrote {len(cuts)} cuts, {len(keeps)} left in review")

if __name__ == "__main__":
    main()
