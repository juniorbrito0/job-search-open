# Tailoring files

One small file per job, made by the search when a role scores well. It tells the
resume builder how to adjust your master resume (`profile/resume.json`) for that
one posting: a rewritten summary, the bullets reordered or reworded to match the
posting's language, and any posting keywords you genuinely have.

It never adds experience you do not have. You do not need to edit these.

Example (`tailor/acme--operations-manager.json`):

```json
{
  "position_id": "acme--operations-manager--20261006",
  "company": "Acme",
  "role": "Operations Manager",
  "summary": "Rewritten to mirror the posting.",
  "bullets": {
    "Example Co": ["Reworded bullet that already exists on the master resume", "..."]
  },
  "skills_line": "Optional: one tailored skills line",
  "extra_keywords": [],
  "one_page": false
}
```

Company names under `bullets` must match `profile/resume.json` exactly.

Build it with:

```
.venv/bin/python scripts/build_resume.py tailor/acme--operations-manager.json --position-id acme--operations-manager--20261006
```

The finished Word file and PDF land in `Applications/<Company>/`.
