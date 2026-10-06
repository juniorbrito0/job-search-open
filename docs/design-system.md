# Job Search dashboard: design system

**Signal desk:** a calm, modern product UI built for one person scanning job
postings. Cool canvas, hairline borders, almost no drop shadow, frosted top bar.
Tokens live as CSS custom properties in `dashboard/styles.css` (`:root` for
light, `[data-theme="dark"]` for dark). Components consume tokens. Never
hardcode colours, type, radius or shadow.

- **Palette (light):** canvas `--paper` #F4F5FA, raised `--paper-raised` #FFFFFF,
  ink `--ink` #2F2B3D, accent `--ember` #2563EB (links, Dream fit 5, live
  signal), `--moss` #56CA00 (agree, Easy Apply, applied, good news), `--gold`
  #FFB400 (Dream fit 4, things to watch), `--slate` #8A8D93 (Dream fit 3),
  `--danger` #FF4C51.
- **Palette (dark):** canvas #0B0C10, raised #14161C, ink #EEF0F4, accent
  #FF6D4D, moss #34C48B, gold #E0A63A, slate #8B9BB0.
- **Type:** Inter (display and body), the system monospace for counts, dates
  and small labels.
- **Motion:** cards lift a couple of pixels on hover. The search pulse dot is
  the only looping motion. `prefers-reduced-motion` turns the lift off.
- **Shape:** 10px cards, 8px controls, square score badges. Signature is a 3px
  **score rail** on the left of each Review card.
- **Atmosphere:** faint film grain over the canvas, frosted top bar and bulk bar.
- **Score colours:** Dream fit 5 accent, 4 gold, 3 slate, 1 and 2 faint ink.
  Worth applying is an outlined square (moss at 4 and 5). Match % is a pill:
  moss at 80%+, gold at 60 to 79%, faint below.
- Dark mode is first-class: toggle in the top bar, remembered in
  `localStorage`, defaults to the computer's setting.

## Writing on the page

The person using this is not technical. Every label, empty state, tooltip and
toast is plain, friendly English addressed to "you". No jargon (say "company
application form", not "ATS"), no em or en dashes, no dates of internal
changes. Empty states always say what will fill the space and when, using the
search times from `profile/candidate.json`.

## What comes from the candidate profile

`/api/data` returns `candidate` (from `profile/candidate.json`, with safe
defaults). The page reads:

- `first_name` for the greeting on the Guide and the "For <name>" line under
  the brand.
- `schedule.search_times` and `schedule.weekly_digest` for every "when does it
  run" sentence and the Search now tooltip.
- `location_buckets` for the Location mix chart on Analytics.
- `startup_watch.region_label` and `max_employees` for the Startups intro.
- `experience_years.in_function` for the years line on the Rejected tab.
- Pay filter bands come from `scoring-profile.json → dimensions.comp.floor_cad`
  and `bonus_cad`, labelled in `candidate.currency`.

## Tabs

Review, Pipeline, Startups, Archive, Screened out, Analytics, Rejected, Lost,
Guide. Tabs sit in a recessed track and wrap as a group rather than crushing a
label. The active tab is a raised chip. Empty counts hide.

A brand-new install (no positions yet) opens on **Guide**, so the first thing
anyone sees is an explanation rather than an empty board.

### Guide

Built from the same `.panel` and `.verdict` pieces as Analytics. Each section is
a `.guide-section` panel holding either a `.guide-list` (two-column term and
explanation grid, one column under 640px), `.guide-bullets` or `.guide-steps`
(numbered, accent markers). Real badges are reused inside the list as
`.guide-chip` so the explanation shows the exact thing it explains. A "Your
first day" checklist appears only while there are no positions.

### Rejected and Lost

All numbers are computed from the data; no sentence names a company or a
person unless it comes from a position record. Sections hide themselves when
they have nothing to show. Both tabs end with an **Insights** panel that renders
`dashboard/data/insights.md` (written by Claude on request) through the same
markdown renderer as company research; when the file is missing the panel says
what to ask Claude.

## Pipeline board (kanban)

One column per stage (Interested, Applied, Screen, Interview, Offer,
Disqualified, No answer). Columns share a grid track so all seven fit at about
1300px; each scrolls on its own. Below 860px it stacks vertically.

**Cards carry five things and nothing else:** title, company, posted date,
applied date, Dream fit (plus Worth applying). Everything else lives on the
job's own page.

- Titles clamp to 3 lines, company to 2, full title in a tooltip.
- Dates render as `4 Aug` in mono; the year only when it is not this year.
- Interested cards show one status line when an apply is queued
  (`Queued to apply`, moss) or blocked (`Needs you`, red), otherwise the Apply
  button. Strong matches can also show a message flag: `Message ready`,
  `Send queued`, `Message sent`, `Message blocked`.

The job's own page has a **Diary** panel: dated events plus a note field.

## Run controls

The top bar shows the last search time under the brand and a **Search now**
button. While a search runs, a pulse dot sits beside it and the label becomes
`Searching…`.

The Pipeline tab has a run bar with two actions:

- **Apply queue now (N):** moss, like Agree. Disabled when nothing is waiting.
  Asks once before it sends real applications.
- **Update from email:** reads recruiting email and moves cards.

Each keeps a one-line mono timestamp underneath. Buttons use `.btn`. Do not
invent a second button style.
