#!/usr/bin/env python3
"""Sweep LinkedIn's public guest job-search endpoint (no login needed).

Searches every title in scoring-profile.json -> search_scope.titles (or, if
that is empty, profile/candidate.json -> target_titles) across two passes:
remote roles in candidate.remote_search_country, and anything near
candidate.home_area.linkedin_location. Last 24 hours only.

Used by the search routine as a backup source, or when the logged-in browser
is not available. Prints JSON to stdout:
[{job_id, title, company, location, posted_date, salary_text, url, query}]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, __import__("os").path.dirname(__file__))
from profile_lib import load_candidate, search_titles  # noqa: E402

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def titles_and_passes():
    cand = load_candidate()
    titles = search_titles(candidate=cand)
    passes = []
    country = (cand.get("remote_search_country") or cand.get("country") or "").strip()
    if country:
        passes.append(("remote", {"location": country, "f_WT": "2"}))
    home = cand.get("home_area") or {}
    where = (home.get("linkedin_location") or "").strip()
    if not where and cand.get("city"):
        where = ", ".join(x for x in (cand.get("city"), cand.get("region"), cand.get("country")) if x)
    if where:
        # LinkedIn's distance filter is in miles.
        km = home.get("radius_km") or 40
        miles = max(5, min(100, int(round(float(km) / 1.609))))
        passes.append(("home-area", {"location": where, "distance": str(miles)}))
    return titles, passes


BASE = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"


def fetch(params):
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "en-CA,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


CARD_RE = re.compile(r'data-entity-urn="urn:li:jobPosting:(\d+)"')


def parse(html, query):
    out = []
    for block in html.split('<li>'):
        m = CARD_RE.search(block)
        if not m:
            continue
        job_id = m.group(1)
        t = re.search(r'class="base-search-card__title">\s*(.*?)\s*</h3>', block, re.S)
        c = re.search(r'class="hidden-nested-link"[^>]*>\s*(.*?)\s*</a>', block, re.S)
        loc = re.search(r'class="job-search-card__location">\s*(.*?)\s*</span>', block, re.S)
        dt = re.search(r'datetime="([\d-]+)"', block)
        sal = re.search(r'class="job-search-card__salary-info">\s*(.*?)\s*</div>', block, re.S)

        def clean(x):
            if not x:
                return None
            s = re.sub(r'<[^>]+>', '', x.group(1))
            s = re.sub(r'\s+', ' ', s).strip()
            return s.replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"')

        out.append({
            "job_id": job_id,
            "title": clean(t),
            "company": clean(c),
            "location": clean(loc),
            "posted_date": dt.group(1) if dt else None,
            "salary_text": clean(sal),
            "url": f"https://www.linkedin.com/jobs/view/{job_id}",
            "query": query,
        })
    return out


def main():
    titles, passes = titles_and_passes()
    if not titles or not passes:
        print("No job titles or locations are set yet. Finish the setup interview first.",
              file=sys.stderr)
        json.dump([], sys.stdout)
        return
    seen = {}
    for title in titles:
        for label, extra in passes:
            q = f"{title} | {label}"
            total = 0
            # the guest endpoint serves ~10 cards per page; one page silently
            # truncates busy queries, so page until a short page
            for start in (0, 10, 20, 30):
                params = {"keywords": title, "f_TPR": "r86400",
                          "start": str(start)}
                params.update(extra)
                rows = None
                for attempt in range(3):
                    try:
                        rows = parse(fetch(params), q)
                        break
                    except Exception as e:  # noqa: BLE001
                        print(f"ERR {q} start={start} try{attempt+1}: {e}",
                              file=sys.stderr)
                        time.sleep(2 * (attempt + 1))
                if rows is None:
                    break
                total += len(rows)
                for r in rows:
                    seen.setdefault(r["job_id"], r)
                time.sleep(1.2)
                if len(rows) < 10:
                    break
            print(f"{q}: {total}", file=sys.stderr)
    json.dump(list(seen.values()), sys.stdout, indent=1)


if __name__ == "__main__":
    main()
