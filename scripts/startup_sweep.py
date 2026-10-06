#!/usr/bin/env python3
"""Daily startup-watchlist careers sweep for the morning scan.

Fetches every active careers page over plain HTTP and reports keyword hits with
surrounding context, because a bare keyword match is usually a false positive
(team bios, testimonials, "Founding ML Engineer"). Companies with no careers
page are checked against LinkedIn's public guest job-search endpoint instead.

Emits a JSON report to stdout; the scan session reads it and judges the hits.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

ROOT = Path(__file__).resolve().parent.parent
STARTUPS = ROOT / "dashboard" / "data" / "startups.json"

# Words that mark a matching opening: the candidate's target titles (from
# scoring-profile.json -> search_scope.titles, else candidate.target_titles),
# plus a few "first hire at a tiny company" words.
def _keywords() -> list[str]:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from profile_lib import search_titles
    titles = search_titles()
    words = [str(t).lower().strip() for t in titles if t]
    for extra in ("founding", "first hire", "general manager"):
        if extra not in words:
            words.append(extra)
    return words


KEYWORDS = _keywords()

GUEST = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"


def get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "en-CA,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def to_text(html: str) -> str:
    html = re.sub(r"<(script|style|svg)\b.*?</\1>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = html.replace("&amp;", "&").replace("&#39;", "'").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", html).strip()


def scan_page(name: str, url: str) -> dict:
    try:
        html = get(url)
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "url": url, "error": str(exc)[:120]}
    text = to_text(html)
    hits = []
    low = text.lower()
    for kw in KEYWORDS:
        for m in re.finditer(re.escape(kw), low):
            start = max(0, m.start() - 90)
            hits.append({"kw": kw, "context": text[start:m.end() + 110]})
            if len(hits) > 25:
                break
    return {"name": name, "url": url, "chars": len(text),
            "js_shell": len(text) < 900, "hits": hits[:25]}


def slug_candidates(name: str, website: str | None) -> list[str]:
    """Slug guesses for linkedin.com/company/<slug>.

    The stripped-suffix guess alone left ~20 watchlist companies unresolvable on four
    consecutive runs (flagged 2026-08-17, -19, -22), because LinkedIn slugs keep the
    suffix ("foo-inc", "foo-ai") or append the city. Try the full name too, then the
    common suffix variants, then the website host.
    """
    name = re.sub(r"\([^)]*\)", " ", name)
    full = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    base = re.sub(r"\b(inc|ltd|llc|corp|corporation|technologies|technology|labs|co)\b", " ",
                  name.lower())
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    out = [base, base.replace("-", ""), full, full.replace("-", "")]
    for suffix in ("ai", "inc", "technologies", "labs", "io", "hq", "canada"):
        out.append(f"{base}-{suffix}")
    if website:
        host = re.sub(r"^https?://(www\.)?", "", website).split("/")[0]
        out.append(host.split(".")[0])
        out.append(re.sub(r"[^a-z0-9]+", "-", host.lower()).strip("-"))
    seen, uniq = set(), []
    for s in out:
        if s and s not in seen:
            seen.add(s)
            uniq.append(s)
    return uniq


def resolve_org_id(name: str, website: str | None) -> dict:
    """LinkedIn's numeric org id, needed because f_C is the only true employer filter.

    Searching the guest endpoint with keywords=<company name> matches job *text*, not
    the employer, so an exact-name filter over those results discards everything and
    reports a false zero. Verified 2026-08-13: keywords=Shopify returned ten cards,
    none of them Shopify.
    """
    for slug in slug_candidates(name, website):
        try:
            html = get(f"https://www.linkedin.com/company/{slug}/", timeout=25)
        except Exception:  # noqa: BLE001
            continue
        m = re.search(r"urn:li:organization:(\d+)", html)
        if not m:
            continue
        title = re.search(r"<title>(.*?)</title>", html, re.S)
        shown = re.sub(r"[^a-z0-9]", "", to_text(title.group(1)).lower()) if title else ""
        target = re.sub(r"[^a-z0-9]", "", name.lower())
        if target[:12] not in shown:
            continue
        return {"org_id": m.group(1), "slug": slug}
    return {}


def linkedin_company_jobs(name: str, org_id: str | None = None,
                          website: str | None = None) -> dict:
    resolved = None
    if not org_id:
        resolved = resolve_org_id(name, website)
        org_id = resolved.get("org_id")
        time.sleep(1.5)
    if not org_id:
        return {"name": name, "error": "could not resolve LinkedIn org id"}

    params = {"f_C": org_id, "f_TPR": "r604800", "start": "0"}
    try:
        html = get(GUEST + "?" + urllib.parse.urlencode(params))
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "org_id": org_id, "error": str(exc)[:120]}
    rows = []
    for block in html.split("<li>"):
        m = re.search(r'data-entity-urn="urn:li:jobPosting:(\d+)"', block)
        if not m:
            continue
        title = re.search(r'class="base-search-card__title">\s*(.*?)\s*</h3>', block, re.S)
        company = re.search(r'class="hidden-nested-link"[^>]*>\s*(.*?)\s*</a>', block, re.S)
        loc = re.search(r'class="job-search-card__location">\s*(.*?)\s*</span>', block, re.S)
        dt = re.search(r'datetime="([\d-]+)"', block)

        def clean(x):
            return to_text(x.group(1)) if x else None

        rows.append({"job_id": m.group(1), "title": clean(title), "company": clean(company),
                     "location": clean(loc), "posted_date": dt.group(1) if dt else None,
                     "url": f"https://www.linkedin.com/jobs/view/{m.group(1)}"})
    result = {"name": name, "org_id": org_id, "linkedin_matches": rows}
    if resolved:
        result["resolved_slug"] = resolved.get("slug")
    return result


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    data = json.loads(STARTUPS.read_text())
    startups = data["startups"]

    out = {}

    if mode in ("all", "pages"):
        page_jobs = [(s["name"], s["careers_url"]) for s in startups
                     if s.get("status") == "active" and s.get("careers_url")]
        with ThreadPoolExecutor(max_workers=8) as pool:
            out["pages"] = list(pool.map(lambda a: scan_page(*a), page_jobs))

    if mode in ("all", "linkedin"):
        # Sequential only: concurrent hits on the guest endpoint get rate-limited with
        # empty 200s that look exactly like a genuine zero-results answer.
        li_jobs = [s for s in startups if s.get("status") != "active"]
        # A high-volume org id, so the canary exercises f_C under the same f_TPR the
        # sweep uses and a zero means "rate-limited", not "quiet week".
        canary_before = linkedin_company_jobs("Tesla", org_id="15564")
        linkedin = []
        for s in li_jobs:
            linkedin.append(linkedin_company_jobs(s["name"], s.get("linkedin_id"),
                                                  s.get("website")))
            time.sleep(1.5)
        canary_after = linkedin_company_jobs("Tesla", org_id="15564")
        out["linkedin"] = linkedin
        out["canary"] = {
            "before": len(canary_before.get("linkedin_matches") or []),
            "after": len(canary_after.get("linkedin_matches") or []),
        }

    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
