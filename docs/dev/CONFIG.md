# Configuration contract (for the agents and anyone editing the code)

The person running the search is called **the candidate** everywhere in code and
docs. Nothing in this repo may name a real person, employer they applied to, or
their contact details. Everything personal comes from the files below, which the
onboarding interview (`docs/ONBOARDING.md`) writes.

## Where the live folder lives

Recommended: `~/job-search`. macOS stops background jobs from reading
`~/Documents`, so the scheduled search breaks if the folder lives there. Every
script finds its own folder; nothing hardcodes a path.

## Files the onboarding writes

| File | What it holds | Who reads it |
|---|---|---|
| `profile/candidate.json` | Who the candidate is, what she wants, where, schedule, sources, integrations | every script, the dashboard (`/api/data` returns it as `candidate`), every routine |
| `profile/resume.json` | Master resume data (the only source of truth for resume content) | `generate_resume.py`, `scripts/build_resume.py`, `scripts/check_resume_keywords.py` |
| `dashboard/data/scoring-profile.json` | Scoring rules, weights, hard exclusions, learning log, auto-apply switch | search routine, `score_worth_applying.py`, `queue_auto_apply.py`, dashboard |
| `dashboard/data/application-profile.json` | Standard answers for application forms and policies | apply routine |

Blank versions live in `templates/` (`*.example.json`). `scripts/init_data.py`
copies any missing ones into place and creates empty `positions.json`,
`startups.json`, `ignored.json`, `companies.json`, `applied-ledger.json`,
`apply-progress.json`. It never overwrites an existing file.

## profile/candidate.json

```json
{
  "version": 1,
  "onboarded": false,
  "name": "Full Name",
  "first_name": "First",
  "pronouns": "she/her",
  "email": "name@example.com",
  "phone": "",
  "city": "Toronto",
  "region": "ON",
  "country": "Canada",
  "linkedin": "https://linkedin.com/in/...",
  "website": "",
  "currency": "CAD",
  "goal_summary": "One paragraph in plain words: the kind of role and company she wants.",
  "target_titles": ["Operations Manager", "..."],
  "strengths": ["..."],
  "industries": {"preferred": [], "open": [], "off_limits": []},
  "experience_years": {"total": 0, "in_function": 0, "function_label": "operations"},
  "work_authorization": {"countries": ["Canada"], "note": ""},
  "home_area": {
    "label": "Toronto / GTA",
    "cities": ["Toronto", "Mississauga"],
    "linkedin_location": "Greater Toronto Area, Canada",
    "radius_km": 40
  },
  "location_buckets": [
    {"label": "Remote", "pattern": "remote"},
    {"label": "Toronto / GTA", "pattern": "toronto|mississauga|markham|vaughan|oakville|brampton"},
    {"label": "Other / unclear", "pattern": ""}
  ],
  "remote_search_country": "Canada",
  "calendar_url": "",
  "schedule": {
    "search_times": ["08:00", "16:00"],
    "weekly_digest": {"enabled": true, "weekday": 5, "time": "10:00"}
  },
  "sources": {
    "linkedin_alert_emails": true,
    "linkedin_sweep": true,
    "yc_jobs": true,
    "wellfound": true,
    "communitech": false,
    "startup_watch": true
  },
  "startup_watch": {"region_label": "Toronto area", "cities": [], "max_employees": 100, "daily_new": 3},
  "integrations": {
    "gmail": "claude-connector",
    "granola": false,
    "wispr_flow": false,
    "github_backup": false
  },
  "notifications": {"email_strong_matches": true, "mac_notifications": true},
  "dashboard": {"port": 7411, "share_on_home_wifi": false}
}
```

Rules for code that reads it:

- Load with `scripts/profile_lib.py` (`load_candidate()`, `load_resume()`,
  `project_root()`), never by hand, so a missing key falls back to a safe default.
- `location_buckets` patterns are case-insensitive regexes, tried in order; an
  empty pattern is the catch-all.
- `home_area.cities` drives "within commuting distance" checks
  (`prune_review.py`, the LinkedIn sweeps, the startup watchlist).

## profile/resume.json

```json
{
  "name": "Full Name",
  "contact": "phone  ·  email  ·  City, Region  ·  linkedin.com/in/...",
  "headline": "Operations Manager  ·  Program Lead",
  "target_roles": "Operations  ·  Program Management  ·  Business Operations",
  "summary": "...",
  "experience": [
    {
      "company": "Company", "location": "City, Region", "dates": "Jan 2020 – Present",
      "roles": [["Title", "Jan 2022 – Present"], ["Earlier title", "Jan 2020 – Jan 2022"]],
      "previously": null,
      "bullets": ["...", "..."],
      "skip_one_page": false
    }
  ],
  "education": [{"school": "...", "dates": "...", "detail": "Degree  ·  City"}],
  "certifications": [],
  "skills_groups": [["Group label", "Skill  ·  Skill"]],
  "tools": "Tool  ·  Tool",
  "languages": [["English", "Native"]],
  "accent_color": "0f766e"
}
```

## Tailored resumes

One small JSON "overlay" per job, in `tailor/<company-slug>--<role-slug>.json`:

```json
{
  "position_id": "acme--operations-manager--20261006",
  "company": "Acme",
  "role": "Operations Manager",
  "headline": "optional override",
  "target_roles": "optional override",
  "summary": "rewritten to mirror the posting",
  "bullets": {"<company name in resume.json>": ["reordered / reworded bullets"]},
  "skills_line": "optional single tailored skills line",
  "one_page": false
}
```

`scripts/build_resume.py tailor/<file>.json` writes
`Applications/<Company>/<Name> - Resume - <Role> (<Company>).docx` and the PDF
(LibreOffice `soffice --headless`), checks the page count, and prints the PDF
path relative to the project root. Overlays may only reword what is already in
`resume.json`; they never invent experience.

## LaunchAgent labels

`local.jobsearch.dashboard`, `local.jobsearch.search`,
`local.jobsearch.weekly-comms`, `local.jobsearch.autopush` (only when GitHub
backup is on). The apply queue has no LaunchAgent: it runs only from the
dashboard button.

## Optional keys added during the port

- `scoring-profile.json → hard_exclusions.title_words`: list of words that rule a
  title out (short `title_level` entries of 3 words or fewer count too). Empty by default.
- `search_scope.yc_roles`, `search_scope.extra_queries`: optional extra search terms.
- `candidate.outreach_pitch`: optional one-liner used in hiring-manager notes.
- Tailor overlays may carry `extra_keywords` (written by `check_resume_keywords.py --fix`).
- Positions may carry `dq_cause`, `dq_note` and `archetype_override` so the
  Rejected/Lost tagging can be set per position without editing code.
- `dashboard/data/insights.md`: optional; Claude writes it when asked for insights,
  and the Rejected and Lost tabs show it.
