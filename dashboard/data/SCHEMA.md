# Dashboard data schema

"The candidate" below is the person running this job search. Everything about
them (name, home area, pay numbers, titles) lives in `profile/candidate.json`
and `scoring-profile.json`; see `docs/dev/CONFIG.md`.

`positions.json` → `{ version, updated_at, positions: [Position], resume_tenure? }`

`resume_tenure` is written by `scripts/classify_applications.py`:
`{ops_years, total_years, function_label, note}`, the years the resume shows in
the target function (from `profile/candidate.json → experience_years`).

## Position

| Field | Type | Notes |
|---|---|---|
| `id` | string | `<company-slug>--<role-slug>--<yyyymmdd>` (found date). Always taken through `jobsearch_lib.unique_position_id()` |
| `title` | string | Job title as posted |
| `company` | string | Company name |
| `company_url` | string\|null | Company website |
| `url` | string | Job posting URL (LinkedIn or the employer's own site) |
| `easy_apply` | bool | true = LinkedIn Easy Apply, false = external/company page |
| `source` | string | `alert-email` \| `linkedin-sweep` \| `startup-watch` \| `yc-jobs` \| `wellfound` \| `communitech` \| `manual` \| `networking` (referral, intro or direct approach) |
| `found_date` | string | ISO date the routine found it |
| `posted_date` | string\|null | ISO date posted, if known |
| `location` | string | As posted |
| `work_model` | string | `remote` \| `hybrid` \| `on-site` \| `unclear` (+ free-text detail ok) |
| `salary_text` | string\|null | Raw salary text from posting, null if unlisted |
| `comp_unknown` | bool | true when no salary listed (pay scored neutral 3) |
| `company_size` | string\|null | Employee count, researched, e.g. "~80 employees" |
| `company_funding` | string\|null | Funding or revenue one-liner, e.g. "$46M raised" |
| `jd_summary` | string | 3-6 sentence summary of the job description |
| `jd_text` | string | Full job description text |
| `scores` | object | `{interests, goals, location, comp, overall, worth_applying}`, each int 1-5. `overall` is shown as **Dream fit** (set by the search agent per `scoring-profile.json`). `worth_applying` is shown as **Worth applying** and is computed only by `scripts/score_worth_applying.py` (years asked versus the candidate's years, credentials, company size, match %, location, pay; calibrated against employer replies in `scoring-profile.json → worth_applying.calibration`). Its one-line reason is `score_rationale.worth_applying`. |
| `match_pct` | int | 0-100: how much of the posting's duties the candidate's experience covers |
| `fit_analysis` | object | `{strengths: [str], gaps: [str]}`, why the candidate is strong for this role / what is missing |
| `score_rationale` | object | Same keys as `scores`, one sentence each |
| `score_overridden` | bool | true once the candidate edits any score |
| `status` | string | `review` \| `rejected` \| `interested` \| `applied` \| `screen` \| `interview` \| `offer` \| `disqualified` \| `no_answer`. Legacy `ongoing` is accepted and migrated to `screen` / `interview` / `offer`. |
| `reject_reasons` | string[] | Set when the candidate rejects: `location`, `comp`, `industry`, `seniority`, `company-stage`, `role-scope`, `other` |
| `reject_note` | string\|null | Optional free text on rejection |
| `resume_path` | string\|null | Relative path to the tailored PDF (set by `scripts/build_resume.py --position-id`) |
| `resume_requested` | bool | The candidate asked for a tailored resume (button, or auto-set when a position without one is marked interested). Fulfilled on the next search, then set false |
| `research_md` | string\|null | Company and hiring-manager research as markdown (filled when status = interested) |
| `apply_process` | object\|null | `{method: easy_apply\|ats\|careers_form\|email\|unknown, can_auto: bool, summary: str, manual_reason?: str}`, investigated per position during the search |
| `apply_requested` | bool | The candidate clicked Apply for me, or the search job queued a strong match. The apply job (started only from the dashboard) fulfills it, then sets it false |
| `apply_manual` | bool | The candidate will apply to this one personally; never auto-queued |
| `auto_apply_queued` | bool | The search job put this strong match on the apply queue. Stays true after submit |
| `auto_applied` | bool | Set only after a successful application from the queue. Shown on the card |
| `applied_at` | string\|null | ISO date the application was actually submitted |
| `apply_result` | string\|null | What happened when applying, or "needs your input: ..." if blocked. Employer rejections start with `employer-rejected:` |
| `status_history` | array | `[{status, at, note?}]` appended on every stage change |
| `events` | array | Diary on the position page. `{id, type, at, source, title, detail, external_id}`. `type` is `applied` \| `email` \| `screen` \| `interview` \| `offer` \| `rejection` \| `note` \| `whisper` \| `status` \| `outreach`. Seeded from `status_history`, recruiting email, and (if switched on) Wispr Flow meetings that clearly name the company. Never attach therapy, medical or household meetings. Dedupe on `id` / `external_id`. |
| `stakeholder_outreach` | object\|null | Dream fit 4 and 5 only, after applying. `{status, researched_at, people, message, calendar_url, send_requested, sent_at, sent_via, sent_to, blocked_reason}`. `status` is `none` \| `researching` \| `ready` \| `send_requested` \| `sent` \| `blocked`. `people` is `[{name, title, role, linkedin_url, email, summary, channel}]` where `role` is `hiring_manager` \| `talent` \| `founder` and `channel` is `linkedin` \| `email`. `message` is one paragraph with no line breaks. The candidate reviews it on the position page and taps Send; that sets `send_requested`. Nothing is sent before that. Written by `scripts/stakeholder_outreach.py`. |
| `resume_check` | object\|null | Written by `scripts/check_resume_keywords.py` after a tailored resume is built. `{at, ok, missing, fixed, unfixable, note}`. Posting words already on the master resume are added to the tailoring file's `extra_keywords` and the PDF is rebuilt. Words the candidate does not have stay off |
| `dq_cause` | string\|null | Optional hand-set cause for a closed position (one of the `dq_analysis.cause` values), with optional `dq_note`. Wins over keyword inference |
| `dq_analysis` | object\|null | Written by `scripts/classify_disqualified.py` for `disqualified` positions only. `{cause, cause_label, group, preventable, detail, inferred, applied_at, closed_at, days_in_hand, days_to_outcome}`. `cause` is one of `closed-before-applying`, `blocked-then-closed`, `employer-rejected`, `rule-onsite`, `rule-us-only`, `rule-other`, `unclassified`. Powers the Rejected and Lost tabs. |
| `archetype` | string\|null | Written by `scripts/classify_applications.py` on applied positions: `founding-generalist` \| `exec-support` \| `single-function`. Override with `archetype_override` |
| `gate` | object\|null | Employer rejections only: the bar the posting set and whether the resume clears it. `{kind, asked, asked_years?, resume_shows, clears, note}`. `kind` is `years` \| `years-in-function` \| `credential` \| `authorization` \| `altitude` \| `domain` \| `people-leadership`. Written by the agent that records the rejection |

## Rules

- New positions from the search enter with `status: "review"`.
- `rejected` means **the candidate** turned the role down. `disqualified` means it died any other way (employer said no, posting closed, or one of the candidate's standing rules). Never mix them: the Rejected and Lost tabs depend on the difference.
- Re-run `scripts/classify_disqualified.py` and `scripts/classify_applications.py` after any status change into `disqualified`.
- Dedupe with `jobsearch_lib.DuplicateIndex` against ALL existing positions (every status), `ignored.json` and `job-applications.csv` before adding.
- When the candidate rejects a role, the reasons are appended to `scoring-profile.json → learning_log` as `{date, company, title, reasons, note}` and honored in future scoring.
- Dream fit at or above `auto_apply.min_overall` ⇒ tailored resume (`tailor/*.json` + `scripts/build_resume.py`) and `resume_path` set. Then, only if `scoring-profile.json → auto_apply.enabled` is true, the search job sets `auto_apply_queued` and `apply_requested`. The search never applies. The apply job runs only when the candidate presses **Apply queue now**; on success it sets `auto_applied` and drafts `stakeholder_outreach` (status `ready`). It sends that note only after the candidate taps Send. Off-limits industries (`candidate.industries.off_limits`, `hard_exclusions.industries`) are never queued.

## startups.json (startup watchlist)

`{ version, updated_at, startups: [Startup] }`: small companies in the candidate's area (`profile/candidate.json → startup_watch`: `region_label`, `cities`, `max_employees`), watched on every search.

| Field | Notes |
|---|---|
| `name`, `website`, `careers_url`, `city`, `sector` | identity; careers_url found during discovery |
| `employees_est` | string estimate, e.g. "~15-25" |
| `source` | where it was discovered |
| `added_date`, `last_checked` | ISO dates; last_checked bumped by every careers sweep |
| `open_matches` | count of currently open matching roles on their careers page |
| `status` | `active` \| `no-careers-page` \| `dead` |
| `funding_stage` | e.g. `pre-seed`, `seed`, `series-a`, blank if unknown |
| `last_round_date`, `last_round_amount` | date and amount of the most recent raise, when found |
| `notes` | one line on why it is interesting; flag a raise inside the last 6 months as an outreach trigger |

`no-careers-page` does not mean "skip forever": those are checked through the company's LinkedIn Jobs tab on every sweep, and re-checked for a careers page roughly weekly.

Positions found through the watchlist use `source: "startup-watch"`.

## companies.json (company memory)

`{ version, updated_at, companies: [Company] }`: one cached card per employer, reused when the same company posts again.

| Field | Notes |
|---|---|
| `key` | Normalized name (`company_key()` in `scripts/jobsearch_lib.py`) |
| `name` | Display name |
| `website` | Official site |
| `size`, `funding` | Same chips as a position (`company_size`, `company_funding`) |
| `summary` | Short who-they-are, clipped from `research_md` when available |
| `roles_seen` | How many positions are logged for this name |
| `added_at`, `updated_at` | ISO datetimes |

The search looks this file up **before** researching a company (`scripts/company_memory.py --lookup "Name"`), and refreshes it at the end (`--refresh`).

## ignored.json (screened-out postings)

`{ version, updated_at, ignored: [Ignored] }`: postings seen during the search but skipped before scoring. Unranked, no scores. Shown on the **Screened out** tab.

Only these land here: true duplicates; the hard exclusions in `scoring-profile.json` (off-limits industries, part-time, internships, gig work, contracts shorter than 12 months, fully on-site outside the home area, posted pay entirely under `dimensions.comp.floor`, ruled-out title words, required languages the candidate does not speak); and postings that are not in the candidate's field at all. Everything else is scored and shown in Review, including roles that look too junior, too senior, too big or stale: those concerns belong in the score, not in a silent filter. Missing pay is never a reason to skip.

| Field | Notes |
|---|---|
| `title`, `company`, `url` | as posted |
| `reason` | one sentence on why it was skipped, naming the rule |
| `found_date` | ISO date the routine found it |
| `source` | same values as a position's `source` |

## applied-ledger.json

`{ note, submitted: [{id, company, title, applied_at, ...}] }`: every application actually sent. Written by `scripts/record_ledger.py`; `scripts/queue_auto_apply.py` never re-queues an id in it.

## apply-progress.json

Live progress of the current apply run, written by `scripts/apply_progress.py` and read by the dashboard.
