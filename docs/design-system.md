# Job Search dashboard: design system

The dashboard uses the same look as the Job Search room of the Command hub it
was taken from: **Materio** (an MUI admin theme) neutrals, a violet primary,
tonal chips, soft grey rows on white cards. It is rebuilt here in plain HTML,
CSS and JavaScript, so there is still no build step and nothing to install.
Tokens live as CSS custom properties at the top of `dashboard/styles.css`
(`:root` for light, `[data-theme="dark"]` for dark). Components read tokens;
never hardcode a colour, radius or shadow.

## Tokens

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--canvas` | #F4F5FA | #28243D | page background |
| `--paper` | #FFFFFF | #312D4B | cards, dialogs |
| `--ink` | #2F2B3D | #E7E3FC | text |
| `--primary` | #8C57FF | #8C57FF | buttons, active tab, selected chips, score dots |
| `--hero` | #2563EB | #5B8CFF | the dot beside the title, nothing else |
| `--good` | #56CA00 | | score 4 and 5, "ok" status |
| `--watch` | #FFB400 | | score 3, things waiting on you |
| `--bad` | #FF4C51 | | failures, "Not for me" |

Type is Inter. Cards are 10px radius with a soft shadow, rows 8px with a faint
grey fill, chips are pills. Dark mode is first-class: the sun icon toggles it,
it is remembered in `localStorage`, and it defaults to the computer's setting.

## The page pattern

1. **One title** with its hero dot, and "for <first name>" beside it.
2. **Actions** on the right: Search now (outlined), Run apply queue
   (filled, the only filled button in the bar), Refresh, the theme toggle.
3. **The status strip.** One line of small pills, each a dot and a value:
   board up or down, last search, apply queue, waiting on you, in play. It
   sticks to the top with the title. Hovering a pill says what it means and
   where the number comes from.
4. **Alerts**, only when something is wrong: the board not answering, the
   apply queue wedged or failed, the search stuck. Red edge, plain words, and
   the exact thing to ask Claude.
5. **One card of tabs**: Review, Pipeline, Apply queue, Applied, Startups,
   Turned down, Rejected, Lost, Screened out, Analytics, Guide. Counts in
   brackets. A brand-new install opens on Guide.
6. **A source line** at the bottom.

## Rows

Every job is the same row everywhere: company (click it to open the job),
title, a grey line of place, work model, pay and size, then a `% match` chip
and a `Score` chip (green at 4 and 5, gold at 3). Under that, two lines say
**why** each number is what it is and what kept it from being higher, worded
from the search's own fit analysis and score rationale (`buildWhy` in
`app.js`). Review rows add the summary and the buttons Apply for me (filled),
Interested (outlined), Not for me (red text), Posting.

## Filter bar

Shared by every list tab. Collapsed it is one line: Find, three quick score
chips (everything, 3 and up, the strong ones), Filters, and "N of M". Open, it
adds job title, location, work model, company size, minimum score and match,
yearly pay in the candidate's currency, and the two dates. Nothing filters
silently: every active filter shows as a chip you can remove, and Clear filters
resets all of them.

## Job panel

Clicking a company opens a large dialog: stage menu, Open the posting, the
tailored resume (or a button to prepare one), the why lines, then two
columns. Left: Applying, Resume keywords, Reaching out, Why you and what is
thin, What has happened, Add a note, Research, the full posting. Right: the
five scores as clickable dots with the search's rationale under each, the
details list, how it ended, why it was turned down.

## Writing on the page

The person using this is not technical. Every label, empty state, tooltip and
toast is plain, friendly English addressed to "you". No jargon (say "company
application form", not "ATS"), no em or en dashes. Empty states say what will
fill the space and when, using the search times from `profile/candidate.json`.
Anything that sends a real application asks first.

## What comes from the candidate profile

`/api/data` returns `candidate` (from `profile/candidate.json`, with safe
defaults). The page reads `first_name`, `schedule.search_times`,
`schedule.weekly_digest`, `startup_watch.region_label` and `currency`.
