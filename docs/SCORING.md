# How jobs are scored

## Four small scores, 1 to 5

| Score | The question it answers |
|---|---|
| **Interests** | Is the day-to-day work the kind you enjoy and are good at? |
| **Goals** | Does it move your career where you want it to go (level, title, kind of company)? |
| **Location** | Can you get there as often as they ask? Remote, a short commute, or too far? |
| **Pay** | Does the posted pay meet your numbers? No pay listed always scores a neutral 3, never a penalty. |

## Dream fit: the headline score

The four scores are blended using **weights** that you chose during setup. The
default is:

| Interests | Goals | Location | Pay |
|---|---|---|---|
| 30% | 30% | 20% | 20% |

Then Claude can move the result up or down by one point for something the four
miss (a red flag in the description, a posting that is weeks old, a company you
said you love). A deal-breaker caps it at 2.

What the numbers mean: **5** go for it, **4** strong, **3** a genuine toss-up,
**2** probably not, **1** wrong job.

## Worth applying: the second score

Dream fit says how much *you* would want the job. **Worth applying** estimates how
likely *they* are to reply, using:

- years of experience they ask for, compared with yours;
- degrees or certificates they say are required;
- company size;
- how much of the job your resume covers (Match %);
- location and pay.

Once you have enough real replies (8 or more), it starts learning which of these
actually predict a reply for you, and adjusts itself.

## Match %

How much of the job description your resume already covers. 75% or more is
strong; under 55% means a lot of the job is new to you.

## What gets hidden, and what never does

Only your **deal-breakers** hide a job (it goes to the Screened out tab with the
reason): industries you will not work in, part-time or short contracts, fully
on-site jobs outside your area, posted pay below your minimum, languages you do
not speak, countries you cannot work in, and any rule you added.

Everything else is shown and scored, weak ones at the bottom. That way a
surprising job is never silently thrown away.

## It learns from you

Every time you press **Not for me** and pick a reason, it is saved. Future
searches read those reasons: if you turn down three jobs for "company too big",
similar companies start scoring lower.

## Changing the balance

Ask Claude (or type `/tune`): "Pay matters more to me now", "stop showing me
jobs in banking", "I'm fine with 3 office days now". Claude updates the rules
and tells you what changed. Old jobs keep their scores; new searches use the
new rules (ask "re-score my Review tab" to update the waiting ones too).

## Where the rules live (for Claude)

`dashboard/data/scoring-profile.json`: `dimensions.*` (signals and guides),
`dimensions.overall.weights`, `dimensions.comp.floor` and `bonus`,
`hard_exclusions`, `learning_log`, `auto_apply`, `worth_applying`.
