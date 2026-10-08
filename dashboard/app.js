"use strict";

/* Job Search dashboard.
 *
 * The same page as the Command hub's Job Search room, without the hub: one
 * title, a sticky status strip, one card of tabs, rows that say why each score
 * is what it is, and a panel that opens on any row. Plain JavaScript, no build
 * step, served by dashboard/server.py. Everything it shows comes from /api/data
 * and is written back through POST /api/position/<id>.
 */

/* ── constants ───────────────────────────────────────────────────────── */

const STAGES = [
  { key: "interested", label: "Interested" },
  { key: "applied", label: "Applied" },
  { key: "screen", label: "Screen" },
  { key: "interview", label: "Interview" },
  { key: "offer", label: "Offer" },
];
const ALL_STAGES = ["review", "interested", "applied", "screen", "interview", "offer", "rejected", "disqualified", "no_answer"];
const REJECT_REASONS = [
  ["location", "location"],
  ["comp", "pay"],
  ["industry", "industry"],
  ["seniority", "level"],
  ["company-stage", "company size"],
  ["role-scope", "role scope"],
  ["other", "other"],
];
const CLOSED = new Set(["applied", "ongoing", "screen", "interview", "offer", "disqualified", "rejected", "no_answer"]);
const DIMENSIONS = ["interests", "goals", "location", "comp", "overall"];
const DIM_LABEL = { interests: "interests", goals: "goals", location: "location", comp: "pay" };
const METHOD = {
  easy_apply: "LinkedIn Easy Apply",
  ats: "Company application form",
  careers_form: "Careers-page form",
  email: "Email",
  unknown: "Not worked out yet",
};
const TABS = [
  ["review", "Review"],
  ["pipeline", "Pipeline"],
  ["queue", "Apply queue"],
  ["applied", "Applied"],
  ["startups", "Startups"],
  ["archive", "Turned down"],
  ["rejected", "Rejected"],
  ["lost", "Lost"],
  ["ignored", "Screened out"],
  ["analytics", "Analytics"],
  ["guide", "Guide"],
];
const PAGE = 12;
const MORE = 24;
const USD_TO_CAD = 1.35;

/* ── state ───────────────────────────────────────────────────────────── */

const S = {
  raw: null, // the last /api/data answer
  room: null, // that answer, read into lists
  error: "",
  loading: false,
  checkedAt: null,
  tab: "review",
  shown: PAGE,
  filter: null,
  filterOpen: false,
  selected: new Set(),
  busy: "",
  progress: null,
  progressErr: "",
};

/* ── small helpers ───────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const str = (v, d = "") => (v == null ? d : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rec = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

function shortWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\.$/, "");
}
function hoursSince(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3600000;
}
function since(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/* ── the candidate (profile/candidate.json, with safe defaults) ──────── */

const CAND = () => rec(S.raw && S.raw.candidate);
const firstName = () => CAND().first_name || String(CAND().name || "").split(" ")[0] || "";
const currency = () => (String(CAND().currency || "CAD").toUpperCase() === "USD" ? "USD" : "CAD");

function fmtClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return String(hhmm || "");
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "pm" : "am"}`;
}
function searchTimesText() {
  const times = arr(rec(CAND().schedule).search_times).map(fmtClock);
  if (!times.length) return "8:00 am and 4:00 pm";
  if (times.length === 1) return times[0];
  return `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
}

/* ── reading a posting ───────────────────────────────────────────────── */

/* The first sentence, and at most about 150 characters of it, cut at a word. */
function brief(text, max = 150) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const first = ((t.match(/^.+?[.!?](?=\s|$)/) || [])[0] || t).trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const at = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(", "));
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(" "))).replace(/[,;:\s]+$/, "")}…`;
}

const CAP_RE = /rather than|only because|held at|held back|capped|kept at|instead of 5|not 5/i;

/* One line each for "why this number" and "why not higher", worded by the
   search itself (its fit analysis and score rationale), so the page never says
   more than the search did. */
function buildWhy(scores, rationale, matchPct, strengths, gaps, overridden) {
  const match = matchPct == null ? null : {
    reached: strengths.length ? brief(strengths[0]) : "The search listed no strengths for this one.",
    notHigher: matchPct >= 100 ? "Nothing missing."
      : gaps.length ? brief(gaps[0]) : "The search listed no gaps, so the shortfall is not explained.",
  };

  const overall = String(rationale.overall || "").replace(/\s+/g, " ").trim();
  const sentences = (overall.match(/[^.!?]+[.!?]?/g) || []).map((x) => x.trim()).filter(Boolean);
  const capped = sentences.find((x) => CAP_RE.test(x));
  const weakest = Object.keys(DIM_LABEL)
    .filter((k) => scores[k] > 0 && scores[k] < 5)
    .sort((a, b) => scores[a] - scores[b])
    .slice(0, 2)
    .map((k) => `${DIM_LABEL[k]} ${scores[k]}/5${rationale[k] ? `: ${brief(rationale[k], 75)}` : ""}`);

  let reached = sentences[0] || "";
  let cap = capped || "";
  if (capped && capped === sentences[0]) {
    const parts = capped.split(";").map((x) => x.trim());
    const at = parts.findIndex((x) => CAP_RE.test(x));
    if (at > 0) {
      reached = parts.slice(0, at).join("; ");
      cap = parts.slice(at).join("; ");
    } else {
      cap = "";
    }
  }
  reached = reached ? brief(reached) : "The search left no reason for this score.";
  cap = cap ? brief(cap.charAt(0).toUpperCase() + cap.slice(1), 170) : "";

  return {
    match,
    score: {
      reached: overridden ? `You set this score. The search had said: ${reached}` : reached,
      notHigher: scores.overall >= 5 ? "Top score."
        : cap ? cap
          : weakest.length ? `Held back by ${weakest.join(" · ")}`
            : "The search did not say what kept it lower.",
    },
  };
}

function toPosition(raw) {
  const sc = rec(raw.scores);
  const fit = rec(raw.fit_analysis);
  const proc = rec(raw.apply_process);
  const out = rec(raw.stakeholder_outreach);
  const scores = {
    interests: num(sc.interests), goals: num(sc.goals), location: num(sc.location),
    comp: num(sc.comp), overall: num(sc.overall),
  };
  const rationale = Object.fromEntries(Object.entries(rec(raw.score_rationale)).map(([k, v]) => [k, str(v)]));
  const matchPct = raw.match_pct == null ? null : num(raw.match_pct);
  const strengths = arr(fit.strengths).map(String);
  const gaps = arr(fit.gaps).map(String);
  const dq = raw.dq_analysis ? rec(raw.dq_analysis) : null;
  const rc = raw.resume_check ? rec(raw.resume_check) : null;

  return {
    id: str(raw.id),
    title: str(raw.title),
    company: str(raw.company),
    companyUrl: raw.company_url ? str(raw.company_url) : null,
    url: str(raw.url),
    status: str(raw.status, "review"),
    source: str(raw.source),
    location: str(raw.location),
    workModel: str(raw.work_model),
    salary: raw.salary_text ? str(raw.salary_text) : null,
    compUnknown: Boolean(raw.comp_unknown),
    companySize: raw.company_size ? str(raw.company_size) : null,
    companyFunding: raw.company_funding ? str(raw.company_funding) : null,
    summary: str(raw.jd_summary),
    scores,
    rationale,
    matchPct,
    foundDate: str(raw.found_date),
    postedDate: raw.posted_date ? str(raw.posted_date) : null,
    appliedAt: raw.applied_at ? str(raw.applied_at) : null,
    applyRequested: Boolean(raw.apply_requested),
    autoApplied: Boolean(raw.auto_applied),
    autoQueued: Boolean(raw.auto_apply_queued),
    applyResult: raw.apply_result ? str(raw.apply_result) : null,
    applyMethod: str(proc.method, "unknown"),
    canAuto: Boolean(proc.can_auto),
    applySummary: str(proc.summary),
    applyManualReason: proc.manual_reason ? str(proc.manual_reason) : null,
    resumePath: raw.resume_path ? str(raw.resume_path) : null,
    resumeRequested: Boolean(raw.resume_requested),
    strengths,
    gaps,
    rejectReasons: arr(raw.reject_reasons).map(String),
    rejectNote: raw.reject_note ? str(raw.reject_note) : null,
    easyApply: Boolean(raw.easy_apply),
    scoreOverridden: Boolean(raw.score_overridden),
    outreach: {
      status: out.status ? str(out.status) : null,
      message: str(out.message),
      people: arr(out.people).map((x) => ({
        name: str(x.name), title: str(x.title), role: str(x.role), linkedin: str(x.linkedin_url),
      })),
      blockedReason: out.blocked_reason ? str(out.blocked_reason) : null,
    },
    resumeCheck: rc ? { ok: Boolean(rc.ok), missing: arr(rc.missing).map(String), note: str(rc.note) } : null,
    dq: dq ? {
      cause: str(dq.cause), label: str(dq.cause_label), detail: str(dq.detail),
      preventable: dq.preventable == null ? null : Boolean(dq.preventable),
    } : null,
    // The heavy parts. The list answer may or may not carry them; the panel
    // asks for its own copy either way.
    jdText: str(raw.jd_text),
    researchMd: raw.research_md ? str(raw.research_md) : null,
    events: arr(raw.events),
    statusHistory: arr(raw.status_history).map((h) => ({ status: str(h.status), at: str(h.at), note: str(h.note) })),
    why: buildWhy(scores, rationale, matchPct, strengths, gaps, Boolean(raw.score_overridden)),
  };
}

function asRun(raw) {
  const r = rec(raw);
  return {
    state: str(r.state, "idle"),
    started_at: r.started_at ? str(r.started_at) : null,
    finished_at: r.finished_at ? str(r.finished_at) : null,
    message: r.message ? str(r.message) : null,
    queued: r.queued == null ? null : num(r.queued),
  };
}

/* The whole answer, read into the lists the tabs show. */
function buildRoom(body) {
  const positions = arr(rec(body.positions).positions).map(toPosition);
  const jobs = rec(body.jobs);
  const scan = asRun(jobs.scan);
  const apply = asRun(jobs.apply);
  const inbox = asRun(jobs.inbox);

  const review = positions.filter((p) => p.status === "review").sort((a, b) => b.scores.overall - a.scores.overall);
  const pipeline = {};
  for (const s of STAGES) pipeline[s.key] = positions.filter((p) => p.status === s.key);
  // "ongoing" is an older word for a conversation in progress.
  pipeline.interview = pipeline.interview.concat(positions.filter((p) => p.status === "ongoing"));
  // The same rule the apply run uses (scripts/queue_auto_apply.py
  // pending_apply), so the list the confirm dialog shows is what gets sent.
  const autoOn = rec(rec(body.profile).auto_apply).enabled !== false;
  const queue = positions.filter((p) => p.applyRequested && !p.appliedAt && !p.autoApplied
    && !CLOSED.has(p.status) && !(p.autoQueued && !autoOn));
  const applied = positions.filter((p) => p.appliedAt)
    .sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
  const blocked = positions.filter((p) => (p.applyResult || "").toLowerCase().startsWith("needs input"));
  const archive = positions.filter((p) => p.status === "rejected");
  const rejected = positions.filter((p) => p.dq && p.dq.cause === "employer-rejected");
  const lost = positions.filter((p) =>
    (p.status === "disqualified" && !(p.dq && p.dq.cause === "employer-rejected")) || p.status === "no_answer");

  const startups = arr(rec(body.startups).startups).map((x) => ({
    name: str(x.name), website: str(x.website), careersUrl: str(x.careers_url), city: str(x.city),
    sector: str(x.sector), employees: str(x.employees_est), stage: str(x.funding_stage),
    openMatches: num(x.open_matches), status: str(x.status), notes: str(x.notes),
  }));
  const ignored = arr(rec(body.ignored).ignored).map((x) => ({
    title: str(x.title), company: str(x.company), url: str(x.url), reason: str(x.reason),
    foundDate: str(x.found_date), source: str(x.source),
  }));

  const count = (rows, key) => Object.entries(rows.reduce((acc, p) => {
    const k = key(p);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {})).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);

  const applyStuck = apply.state === "running" && hoursSince(apply.started_at) > 3.5;
  const scanStuck = scan.state === "running" && hoursSince(scan.started_at) > 2;
  const inboxStuck = inbox.state === "running" && hoursSince(inbox.started_at) > 2;
  const inPlay = STAGES.reduce((n, s) => n + pipeline[s.key].length, 0);

  const kpis = [
    { label: "Job Search board", value: "up", tone: "ok", hint: `${plural(positions.length, "role")} on file`, source: "/api/data" },
    {
      label: "Last search",
      value: scanStuck ? "stuck" : shortWhen(scan.finished_at) || "never",
      tone: scan.state === "error" || scanStuck ? "bad" : scan.state === "running" ? "warn" : "ok",
      hint: scanStuck ? `has said "running" since ${shortWhen(scan.started_at)}`
        : scan.state === "running" ? "running now" : scan.state === "error" ? (scan.message || "the last search failed") : `searches run at ${searchTimesText()}`,
      source: "/api/jobs scan",
    },
    {
      label: "Apply queue",
      value: String(queue.length),
      tone: apply.state === "error" || applyStuck ? "bad" : queue.length > 0 ? "warn" : "ok",
      hint: applyStuck ? `held since ${shortWhen(apply.started_at)}, nothing is being submitted`
        : apply.state === "error" ? apply.message || "last run failed"
          : queue.length > 0 ? `waiting for you to press Run apply queue · last run ${shortWhen(apply.finished_at) || "never"}`
            : `runs only when you press it · last run ${shortWhen(apply.finished_at) || "never"}`,
      source: "/api/jobs apply",
    },
    { label: "Waiting on you", value: String(review.length), tone: review.length ? "warn" : "ok", hint: "roles still to review", source: "positions.json, status review" },
    { label: "In play", value: String(inPlay), tone: "neutral", hint: "interested through offer", source: "positions.json, pipeline stages" },
  ];

  return {
    positions, scan, apply, inbox, applyStuck, scanStuck, inboxStuck,
    review, pipeline, queue, applied, blocked, archive, rejected, lost, startups, ignored, kpis,
    analytics: {
      total: positions.length,
      byStatus: count(positions, (p) => (p.status === "rejected" ? "turned down" : p.status.replace("_", " "))),
      bySource: count(positions, (p) => p.source || "unknown"),
      dqCauses: count(lost.concat(rejected), (p) => (p.dq && (p.dq.label || p.dq.cause)) || "not classified yet"),
      applied: applied.length,
      autoApplied: applied.filter((p) => p.autoApplied).length,
      interviews: positions.filter((p) => ["screen", "interview", "offer", "ongoing"].includes(p.status)).length,
      screenedOut: ignored.length,
      startups: startups.length,
    },
  };
}

/* ── filters (same rules as the hub's filter bar) ────────────────────── */

const WORK_MODELS = [["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "In person"], ["unclear", "Not stated"]];
const COMPANY_SIZES = [["s30", "Up to 30"], ["s100", "31 to 100"], ["s200", "101 to 200"], ["s1000", "201 to 1,000"], ["big", "1,000+"], ["unknown", "Not stated"]];
const DATE_PRESETS = [["any", "Any time"], ["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["custom", "Between two dates"]];
const QUICK = [[0, "everything"], [3, "3 and up"], [4, "the strong ones"]];
const anyDate = () => ({ preset: "any", from: "", to: "", unknown: true });
const emptyFilter = () => ({
  q: "", title: "", places: [], models: [], sizes: [], minScore: 0, minMatch: 0,
  payMin: null, payMax: null, payUnknown: true, posted: anyDate(), added: anyDate(),
});
S.filter = emptyFilter();

/* Pay arrives as prose ("CA$140K-170K/yr", "$105-145" an hour). Read it to a
   yearly band in Canadian dollars; US amounts at a stated rate. */
function parsePay(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/[‒-―]/g, "-").replace(/\d[\d,.]*\s*%/g, " ")
    .replace(/\b20\d\d-\d{2}-\d{2}\b/g, " ").replace(/\s+/g, " ");
  const usdAt = text.search(/US\$|USD|\bUS\b/i);
  const cadAt = text.search(/CA\$|C\$|CAD|CDN|\bCanadian\b/i);
  const usd = usdAt >= 0 && (cadAt < 0 || usdAt < cadAt);
  const period = /per hour|\/\s?hr|hourly|\/\s?hour/i.test(text) ? "hour"
    : /per month|\/\s?month|monthly|\/\s?mo\b/i.test(text) ? "month" : "year";
  const re = /(US\$|CA\$|C\$|CAD|USD|\$)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kK])?/g;
  const marked = [];
  const bare = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = Number(m[2].replace(/,/g, "")) * (m[3] ? 1000 : 1);
    if (!Number.isFinite(v) || v <= 0) continue;
    (m[1] || m[3] ? marked : bare).push(v);
  }
  if (!marked.length && !bare.length) return null;
  const small = marked.length > 0 && marked.every((v) => v < 1000);
  const kept = [...marked, ...bare.filter((v) => v >= 1000 || small)];
  if (!kept.length) return null;
  let min = kept[0];
  let max = kept.length > 1 ? kept[1] : kept[0];
  if (max >= 10000 && min < 1000) min *= 1000;
  if (min >= 10000 && max < 1000) max *= 1000;
  if (max < min) max = min;
  const annual = (v) => (v < 1000 ? v * 2080 : period === "month" && v < 20000 ? v * 12 : v);
  const rate = usd ? USD_TO_CAD : 1;
  return { cadMin: Math.round(annual(min) * rate), cadMax: Math.round(Math.max(annual(max), annual(min)) * rate) };
}
const payCache = new WeakMap();
function payOf(p) {
  if (!payCache.has(p)) payCache.set(p, parsePay(p.salary));
  return payCache.get(p);
}
/* Filter amounts are typed in the candidate's own currency. */
const toCad = (n) => (n == null ? null : currency() === "USD" ? n * USD_TO_CAD : n);

function modelOf(raw) {
  const s = String(raw || "").toLowerCase().split(/[(‒-―;,]/)[0];
  if (/hybrid/.test(s)) return "hybrid";
  if (/remote|work from home|\bwfh\b/.test(s)) return "remote";
  if (/on-?site|in-?office|in[- ]person|\bonsite\b/.test(s)) return "onsite";
  return "unclear";
}
function headcountOf(raw) {
  const s = String(raw || "").toLowerCase().replace(/[‒-―]/g, "-").replace(/(\d),(?=\d{3}\b)/g, "$1");
  if (/tens of thousands|thousands of/.test(s)) return 10000;
  const people = s.match(/(\d+)\s*(\+?)\s*(?:(?:-|to)\s*(\d+)\s*\+?\s*)?(?:full-time\s+)?(?:employees|people|staff|team members|ppl|persons?|fte|headcount)\b/);
  if (people) return people[3] ? Number(people[3]) : Number(people[1]) + (people[2] ? 1 : 0);
  const under = s.match(/<\s*(\d+)/);
  if (under) return Number(under[1]);
  const lead = s.match(/^\D{0,3}(\d+)/);
  return lead ? Number(lead[1]) : null;
}
function sizeOf(raw) {
  const n = headcountOf(raw);
  if (n == null) return "unknown";
  if (n <= 30) return "s30";
  if (n <= 100) return "s100";
  if (n <= 200) return "s200";
  if (n <= 1000) return "s1000";
  return "big";
}
const today = () => new Date().toLocaleDateString("en-CA");
function daysAgo(days) {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function matchesDate(raw, f) {
  if (f.preset === "any") return true;
  const day = raw ? String(raw).slice(0, 10) : "";
  if (!day) return f.unknown;
  if (f.preset === "custom") return !(f.from && day < f.from) && !(f.to && day > f.to);
  return day >= daysAgo(Number(f.preset));
}

/* "lite" is for screened-out rows, which carry no score, pay, place or model. */
function matchesJob(p, f, scope) {
  const q = f.q.trim().toLowerCase();
  if (q && !`${p.company} ${p.title} ${p.location || ""} ${p.source || ""} ${p.workModel || ""}`.toLowerCase().includes(q)) return false;
  const t = f.title.trim().toLowerCase();
  if (t && !String(p.title || "").toLowerCase().includes(t)) return false;
  if (!matchesDate(p.foundDate, f.added)) return false;
  if (scope === "lite") return true;
  if (!matchesDate(p.postedDate, f.posted)) return false;
  if (f.places.length && !f.places.includes(String(p.location || ""))) return false;
  if (f.models.length && !f.models.includes(modelOf(p.workModel))) return false;
  if (f.sizes.length && !f.sizes.includes(sizeOf(p.companySize))) return false;
  if (f.minScore > 0 && (p.scores ? p.scores.overall : 0) < f.minScore) return false;
  if (f.minMatch > 0 && (p.matchPct == null || p.matchPct < f.minMatch)) return false;
  if (f.payMin != null || f.payMax != null) {
    const pay = payOf(p);
    if (!pay) return f.payUnknown;
    if (f.payMin != null && pay.cadMax < toCad(f.payMin)) return false;
    if (f.payMax != null && pay.cadMin > toCad(f.payMax)) return false;
  }
  return true;
}
const filterJobs = (rows, scope = "full") => rows.filter((p) => matchesJob(p, S.filter, scope));

const money = (n) => `$${Math.round(n / 1000)}K`;
function dateWords(f) {
  if (f.preset === "custom") return `${f.from || "any"} to ${f.to || "now"}`;
  return ((DATE_PRESETS.find(([k]) => k === f.preset) || [])[1] || f.preset).toLowerCase();
}
function activeChips(f, scope) {
  const c = [];
  if (f.q.trim()) c.push(["q", `"${f.q.trim()}"`]);
  if (f.title.trim()) c.push(["title", `title: ${f.title.trim()}`]);
  if (f.added.preset !== "any") c.push(["added", `added: ${dateWords(f.added)}`]);
  if (scope === "lite") return c;
  if (f.posted.preset !== "any") c.push(["posted", `posted: ${dateWords(f.posted)}`]);
  if (f.places.length) c.push(["places", plural(f.places.length, "place")]);
  if (f.models.length) c.push(["models", f.models.map((k) => (WORK_MODELS.find(([x]) => x === k) || [k, k])[1]).join(", ")]);
  if (f.sizes.length) c.push(["sizes", `size: ${f.sizes.map((k) => (COMPANY_SIZES.find(([x]) => x === k) || [k, k])[1]).join(", ")}`]);
  if (f.minScore > 0) c.push(["minScore", `score ${f.minScore}+`]);
  if (f.minMatch > 0) c.push(["minMatch", `match ${f.minMatch}%+`]);
  if (f.payMin != null || f.payMax != null) {
    const range = f.payMin != null && f.payMax != null ? `${money(f.payMin)} to ${money(f.payMax)}`
      : f.payMin != null ? `${money(f.payMin)} and up` : `up to ${money(f.payMax)}`;
    c.push(["pay", `pay ${range}${f.payUnknown ? "" : ", pay stated"}`]);
  }
  return c;
}
function clearChip(key) {
  const f = S.filter;
  if (key === "pay") Object.assign(f, { payMin: null, payMax: null, payUnknown: true });
  else if (key === "posted" || key === "added") f[key] = anyDate();
  else f[key] = emptyFilter()[key];
}
function readMoney(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s.replace(/k$/, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return s.endsWith("k") || n < 1000 ? Math.round(n * 1000) : Math.round(n);
}
function commonest(rows, key) {
  const seen = new Map();
  for (const p of rows) {
    const v = String(p[key] || "").trim();
    if (v) seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

/* ── talking to the board ────────────────────────────────────────────── */

async function load() {
  S.loading = true;
  paintHead();
  try {
    const res = await fetch("/api/data", { cache: "no-store" });
    if (!res.ok) throw new Error(`the board answered ${res.status}`);
    S.raw = await res.json();
    S.room = buildRoom(S.raw);
    S.error = "";
    pruneSelection();
  } catch (e) {
    S.error = e && e.message ? e.message : String(e);
  }
  S.loading = false;
  S.checkedAt = new Date();
  render();
}

/* The selection only ever holds rows that are still in Review and still shown,
   so a bulk action can never touch a role that has moved on or is hidden. */
function pruneSelection() {
  if (!S.room) return;
  const live = new Set(filterJobs(S.room.review).map((p) => p.id));
  S.selected = new Set([...S.selected].filter((id) => live.has(id)));
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try { payload = await res.json(); } catch (_) { /* empty answer */ }
    return { ok: res.ok, status: res.status, body: payload };
  } catch (e) {
    return { ok: false, status: 0, body: { error: "The dashboard is not answering. It may have stopped; ask Claude to check it." } };
  }
}

async function patch(id, body, said) {
  S.busy = "patch";
  paintBusy();
  const res = await postJson(`/api/position/${encodeURIComponent(id)}`, body);
  S.busy = "";
  toast(res.ok ? said : `That did not save: ${res.body.error || `error ${res.status}`}.`);
  await load();
  return res.ok;
}

/* The same change across a selection, one at a time and in order, so the
   board's file lock never fights a burst of writes. */
async function patchMany(ids, body, said) {
  S.busy = "patch";
  paintBusy();
  let done = 0;
  const failed = [];
  for (const id of ids) {
    const res = await postJson(`/api/position/${encodeURIComponent(id)}`, body);
    if (res.ok) done += 1;
    else failed.push(id);
  }
  S.busy = "";
  if (!failed.length) {
    S.selected.clear();
    toast(`${said} (${done}).`);
  } else {
    toast(`${done} saved, ${failed.length} did not. Try those again.`);
    S.selected = new Set(failed);
  }
  await load();
}

async function startJob(name) {
  const said = {
    scan: "Search started. It usually takes 30 to 90 minutes; new roles land in Review.",
    apply: "Apply queue started. Watch it on the Apply queue tab.",
    inbox: "Reading your email now. This takes a few minutes; cards move on their own as replies are found.",
  };
  S.busy = `job-${name}`;
  paintBusy();
  const res = await postJson(`/api/jobs/${name}`);
  S.busy = "";
  const b = res.body || {};
  if (res.ok) toast(said[name]);
  else if (res.status === 409 || b.error === "already running") {
    toast(`That is already running${b.started_at ? `, started ${clock(b.started_at)}` : ""}${b.queued ? `, with ${b.queued} still on the queue` : ""}.`);
  } else if (b.error === "empty queue") toast("Nothing is waiting on the apply queue.");
  else toast(`Could not start it: ${b.error || `error ${res.status}`}.`);
  await load();
  if (name === "apply") loadProgress();
}

async function loadProgress() {
  try {
    const res = await fetch("/api/apply-progress", { cache: "no-store" });
    if (!res.ok) throw new Error(`the board answered ${res.status}`);
    S.progress = await res.json();
    S.progressErr = "";
  } catch (e) {
    S.progressErr = e && e.message ? e.message : String(e);
  }
  if (S.tab === "queue") {
    const box = $("#apply-progress");
    if (box) box.innerHTML = progressHtml();
  }
}

/* ── the head: who it is for, actions, status strip ──────────────────── */

function paintHead() {
  const first = firstName();
  $("#for-name").textContent = first ? `for ${first}` : "";
  const strip = $("#strip");
  if (S.error && !S.room) {
    strip.innerHTML = `<span class="strip-item" title="${esc(S.error)}"><span class="dot bad"></span><span class="strip-label">Job Search board</span><span class="strip-value">down</span></span>`;
  } else if (S.room) {
    strip.innerHTML = S.room.kpis.map((k) => `<span class="strip-item" title="${esc(`${k.hint} · source: ${k.source}`)}">
        <span class="dot ${k.tone}"></span><span class="strip-label">${esc(k.label)}</span><span class="strip-value">${esc(k.value)}</span>
      </span>`).join("");
  }
  const refresh = $("#btn-refresh span");
  refresh.textContent = S.loading ? "Checking" : "Refresh";
  $("#btn-refresh").title = S.checkedAt ? `Last read ${S.checkedAt.toLocaleTimeString()}` : "Read everything again";
  const scanRunning = S.room && S.room.scan.state === "running";
  $("#btn-scan span").textContent = S.busy === "job-scan" ? "Starting" : scanRunning ? "Searching" : "Search now";
  $("#btn-scan").title = `Look for new jobs right now, instead of waiting for ${searchTimesText()}`;
  $("#btn-apply span").textContent = S.busy === "job-apply" ? "Starting" : "Run apply queue";
  paintBusy();
}

function paintBusy() {
  document.querySelectorAll("[data-busy]").forEach((el) => { el.disabled = S.busy !== ""; });
  $("#btn-scan").disabled = S.busy !== "";
  $("#btn-apply").disabled = S.busy !== "";
  $("#btn-refresh").disabled = S.loading;
}

function paintAlerts() {
  const r = S.room;
  const out = [];
  if (S.error) {
    out.push(alertCard("The Job Search board is not answering", `${S.error}. The page keeps showing what it last read. Ask Claude: "my job search dashboard is not loading".`));
  }
  if (r && r.applyStuck) {
    out.push(alertCard("The apply queue is wedged, not running",
      `It has claimed to be running since ${shortWhen(r.apply.started_at)}. Nothing is being submitted. Ask Claude: "my apply queue is stuck". Resuming it sends real applications, so let Claude check first.`));
  }
  if (r && r.apply.state === "error") {
    out.push(alertCard("The last apply run failed", `${r.apply.message || "No reason given"} · finished ${shortWhen(r.apply.finished_at)}`));
  }
  if (r && r.scanStuck) {
    out.push(alertCard("The search looks stuck", `It has said "running" since ${shortWhen(r.scan.started_at)}. Ask Claude: "is my job search working?"`));
  }
  $("#alerts").innerHTML = out.join("");
  $("#alerts").hidden = !out.length;
}
const alertCard = (t, d) => `<div class="card alert-card"><div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></div></div>`;

/* ── shared pieces ───────────────────────────────────────────────────── */

const chip = (label, tone = "", extra = "") => `<span class="chip ${tone} ${extra}">${esc(label)}</span>`;
const scoreTone = (n) => (n >= 4 ? "ok" : n === 3 ? "warn" : "");

function whyHtml(p) {
  const w = p.why;
  if (!w) return "";
  const line = (label, reached, notHigher, top) => `<p><b>${esc(label)}</b>${reached ? ` ${esc(reached)}` : ""}${notHigher ? ` <b>${top ? "" : "Not higher:"}</b> ${esc(notHigher)}` : ""}</p>`;
  return `<div class="why">
    ${w.match && p.matchPct != null ? line(`${p.matchPct}% match:`, w.match.reached, w.match.notHigher, p.matchPct >= 100) : ""}
    ${line(`Score ${p.scores.overall || "?"}:`, w.score.reached, w.score.notHigher, p.scores.overall >= 5)}
  </div>`;
}

function metaLine(p) {
  return [p.location, p.workModel, p.salary || (p.compUnknown ? "pay not listed" : ""), p.companySize].filter(Boolean).join(" · ");
}

function rowHtml(p, { dense = false, choose = false, actions = "" } = {}) {
  return `<div class="row" data-id="${esc(p.id)}">
    <div class="row-top">
      <div class="row-id">
        ${choose ? `<input type="checkbox" data-act="choose" data-id="${esc(p.id)}" ${S.selected.has(p.id) ? "checked" : ""} aria-label="Select ${esc(p.company)}">` : ""}
        <div>
          <div class="company open-link" role="button" tabindex="0" data-act="open" data-id="${esc(p.id)}">${esc(p.company)}</div>
          <div class="sub">${esc(p.title)}</div>
          <div class="cap">${esc(metaLine(p))}</div>
        </div>
      </div>
      <div class="row-chips">
        ${p.matchPct != null ? chip(`${p.matchPct}% match`) : ""}
        ${chip(`Score ${p.scores.overall || "?"}`, scoreTone(p.scores.overall))}
      </div>
    </div>
    ${whyHtml(p)}
    ${!dense && p.summary ? `<p class="clamp">${esc(p.summary)}</p>` : ""}
    ${actions ? `<div class="row-actions">${actions}</div>` : ""}
  </div>`;
}

const postingBtn = (p) => (safeUrl(p.url) ? `<a class="btn small" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">Posting</a>` : "");
const moreBtn = (total) => (total > S.shown ? `<button class="btn more" data-act="more">Show ${Math.min(MORE, total - S.shown)} more</button>` : "");

function listPanel(rows, all, emptyAll, emptyFiltered, extra) {
  if (!rows.length) return `<p class="empty">${esc(all.length ? emptyFiltered : emptyAll)}</p>`;
  return rows.slice(0, S.shown).map((p) => rowHtml(p, { dense: true, actions: extra(p) })).join("") + moreBtn(rows.length);
}

/* ── the filter bar ──────────────────────────────────────────────────── */

const SCOPES = {
  review: ["review", "waiting on you", "full"],
  pipeline: ["pipelineAll", "in play", "full"],
  queue: ["queueTab", "queued", "full"],
  applied: ["applied", "applied", "full"],
  archive: ["archive", "turned down", "full"],
  rejected: ["rejected", "rejected", "full"],
  lost: ["lost", "lost", "full"],
  ignored: ["ignored", "screened out", "lite"],
};

function scopeRows(key) {
  const r = S.room;
  if (key === "pipelineAll") return STAGES.flatMap((s) => r.pipeline[s.key]);
  if (key === "queueTab") {
    const ids = new Set(r.queue.map((p) => p.id));
    return r.queue.concat(r.blocked.filter((p) => !ids.has(p.id)));
  }
  return r[key];
}

function filterBarHtml(rows, kept, noun, scope) {
  const f = S.filter;
  const full = scope === "full";
  const chips = activeChips(f, scope);
  const n = chips.length;
  const anywhere = activeChips(f, "full").length;
  const sel = (name, value, options) => `<select class="field" data-f="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const toggles = (name, list, on) => `<div class="chips-wrap">${list.map(([k, l]) => `<button class="chip ${on.includes(k) ? "on" : "off"}" data-act="toggle" data-f="${name}" data-v="${esc(k)}">${esc(l)}</button>`).join("")}</div>`;
  const dateBlock = (name, label, v, unknownLabel) => `<div class="fg">
      <label class="lbl">${esc(label)}</label>
      ${sel(`${name}.preset`, v.preset, DATE_PRESETS)}
      ${v.preset === "custom" ? `<div class="pair"><input class="field" type="date" data-f="${name}.from" value="${esc(v.from)}" aria-label="From"><input class="field" type="date" data-f="${name}.to" value="${esc(v.to)}" aria-label="To"></div>` : ""}
      ${unknownLabel && v.preset !== "any" ? `<label class="check"><input type="checkbox" data-f="${name}.unknown" ${v.unknown ? "checked" : ""}>${esc(unknownLabel)}</label>` : ""}
    </div>`;
  const places = full ? commonest(rows, "location") : [];
  const titles = commonest(rows, "title").slice(0, 200);
  const cur = currency();

  return `<div class="fbar">
    <div class="filter-line">
      <input class="field find" id="find" type="search" placeholder="Find a company, title or place" value="${esc(f.q)}" aria-label="Find">
      ${full ? QUICK.map(([v, l]) => `<button class="chip ${f.minScore === v ? "on" : "off"}" data-act="quick" data-v="${v}">${esc(l)}</button>`).join("") : ""}
      <button class="btn outlined ${n ? "" : "secondary"} small" data-act="filters">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
        ${n ? `Filters (${n})` : "Filters"}
      </button>
      <span class="cap" id="fcount">${kept === rows.length ? `${rows.length} ${esc(noun)}` : `${kept} of ${rows.length} ${esc(noun)}`}</span>
      <span class="grow"></span>
      ${anywhere ? `<button class="btn small" data-act="clear-filters">Clear filters</button>` : ""}
    </div>
    ${!full && anywhere > n ? `<p class="cap">${plural(anywhere - n, "filter")} set on the other tabs need a score, pay, place or work model, which these rows do not carry, so they are not applied here.</p>` : ""}
    ${n && !S.filterOpen ? `<div class="chips-wrap" style="margin-top:8px">${chips.map(([k, l]) => `<span class="chip primary">${esc(l)}<button class="x" data-act="unchip" data-v="${k}" aria-label="Remove">×</button></span>`).join("")}</div>` : ""}
    ${S.filterOpen ? `<div class="filter-grid" style="margin-top:10px">
      <div class="fg"><label class="lbl">Job title</label>
        <input class="field" list="titles" data-f="title" value="${esc(f.title)}" placeholder="Any title">
        <datalist id="titles">${titles.map((t) => `<option value="${esc(t)}">`).join("")}</datalist></div>
      ${full ? `<div class="fg"><label class="lbl">Location</label>
        <select class="field" data-f="places" multiple size="4">${places.map((pl) => `<option value="${esc(pl)}" ${f.places.includes(pl) ? "selected" : ""}>${esc(pl)}</option>`).join("")}</select>
        <span class="cap">Hold Command to pick more than one.</span></div>` : ""}
      ${full ? `<div class="fg"><label class="lbl">Remote, hybrid or in person</label>${toggles("models", WORK_MODELS, f.models)}</div>` : ""}
      ${full ? `<div class="fg"><label class="lbl">Company size (people)</label>${toggles("sizes", COMPANY_SIZES, f.sizes)}
        <span class="cap">Read from the posting's headcount note.</span></div>` : ""}
      ${full ? `<div class="fg"><label class="lbl">Score at least</label>${sel("minScore", f.minScore, [[0, "Any score"], [2, "2 and up"], [3, "3 and up"], [4, "4 and up"], [5, "5 only"]])}</div>` : ""}
      ${full ? `<div class="fg"><label class="lbl">Match at least</label>${sel("minMatch", f.minMatch, [[0, "Any match"], [50, "50% and up"], [60, "60% and up"], [70, "70% and up"], [80, "80% and up"], [90, "90% and up"]])}</div>` : ""}
      ${full ? `<div class="fg"><label class="lbl">Yearly pay (${cur})</label>
        <div class="pair"><input class="field" data-f="payMin" placeholder="from, e.g. 120k" value="${f.payMin == null ? "" : `${Math.round(f.payMin / 1000)}k`}"><input class="field" data-f="payMax" placeholder="to, e.g. 200k" value="${f.payMax == null ? "" : `${Math.round(f.payMax / 1000)}k`}"></div>
        <label class="check"><input type="checkbox" data-f="payUnknown" ${f.payUnknown ? "checked" : ""}>Keep roles that do not state pay</label>
        <span class="cap">Read from the posting's own wording, a year at a time. US and Canadian dollars are compared at ${USD_TO_CAD} to 1, a rough rate for sorting.</span></div>` : ""}
      ${dateBlock("added", "Added to the board", f.added)}
      ${full ? dateBlock("posted", "Posted by the company", f.posted, "Keep roles with no posted date") : ""}
    </div>` : ""}
  </div>`;
}

/* ── tabs ────────────────────────────────────────────────────────────── */

function tabCount(key) {
  const r = S.room;
  if (!r) return "";
  const n = {
    review: r.review.length,
    pipeline: STAGES.reduce((a, s) => a + r.pipeline[s.key].length, 0),
    queue: r.queue.length,
    applied: r.applied.length,
    startups: r.startups.length,
    archive: r.archive.length,
    rejected: r.rejected.length,
    lost: r.lost.length,
    ignored: r.ignored.length,
  }[key];
  return n == null ? "" : ` (${n})`;
}

function paintTabs() {
  $("#tabs").innerHTML = TABS.map(([k, l]) => `<a class="tab ${S.tab === k ? "on" : ""}" href="#${k}">${esc(l)}${tabCount(k)}</a>`).join("");
}

function render() {
  paintHead();
  paintAlerts();
  paintTabs();
  paintContent();
}

function paintContent() {
  pruneSelection();
  const root = $("#content");
  if (!S.room) {
    root.innerHTML = `<p class="empty">${S.error ? "Nothing to show until the board answers." : "Reading the board."}</p>`;
    return;
  }
  const scope = SCOPES[S.tab];
  let bar = "";
  if (scope) {
    const rows = scopeRows(scope[0]);
    bar = filterBarHtml(rows, filterJobs(rows, scope[2]).length, scope[1], scope[2]);
  }
  const body = {
    review: reviewHtml, pipeline: pipelineHtml, queue: queueHtml, applied: appliedHtml,
    startups: startupsHtml, archive: archiveHtml, rejected: rejectedHtml, lost: lostHtml,
    ignored: ignoredHtml, analytics: analyticsHtml, guide: guideHtml,
  }[S.tab] || reviewHtml;
  root.innerHTML = `${bar}<div class="card-body" id="results" style="padding:0">${body()}</div>`;
  paintBusy();
}

/* Typing in Find only redraws the results, so the box keeps its focus. */
function paintResults() {
  pruneSelection();
  const scope = SCOPES[S.tab];
  if (!scope) return;
  const rows = scopeRows(scope[0]);
  const kept = filterJobs(rows, scope[2]).length;
  const count = $("#fcount");
  if (count) count.textContent = kept === rows.length ? `${rows.length} ${scope[1]}` : `${kept} of ${rows.length} ${scope[1]}`;
  const body = {
    review: reviewHtml, pipeline: pipelineHtml, queue: queueHtml, applied: appliedHtml,
    archive: archiveHtml, rejected: rejectedHtml, lost: lostHtml, ignored: ignoredHtml,
  }[S.tab];
  $("#results").innerHTML = body();
  paintBusy();
}

/* Review */
function reviewHtml() {
  const all = S.room.review;
  const rows = filterJobs(all);
  const visible = rows.slice(0, S.shown);
  const allChosen = visible.length > 0 && visible.every((p) => S.selected.has(p.id));
  const sel = S.selected.size;
  const head = `<div class="row-actions">
      <button class="btn small" data-act="select-visible" ${visible.length ? "" : "disabled"}>${allChosen ? "Clear these" : `Select these ${visible.length}`}</button>
      ${rows.length > visible.length ? `<button class="btn small" data-act="select-all">Select all ${rows.length}</button>` : ""}
    </div>
    ${sel ? `<div class="selection"><b style="font-size:.875rem">${sel} selected</b><div class="row-actions">
      <button class="btn contained small" data-busy data-act="bulk-apply">Apply for me</button>
      <button class="btn outlined small" data-busy data-act="bulk-keep">Interested</button>
      <button class="btn outlined small" data-busy data-act="bulk-resume">Prepare resumes</button>
      <button class="btn danger small" data-busy data-act="bulk-reject">Not for me</button>
      <button class="btn small" data-act="clear-selection">Clear</button>
    </div></div>` : ""}`;
  if (!rows.length) {
    return `${head}<p class="empty">${all.length
      ? `None of the ${all.length} roles waiting match these filters. Clear them to see the rest.`
      : `Nothing waiting. The searches at ${esc(searchTimesText())} put new roles here, highest score first.`}</p>`;
  }
  return head + visible.map((p) => rowHtml(p, {
    choose: true,
    actions: `<button class="btn contained small" data-busy data-act="apply" data-id="${esc(p.id)}">Apply for me</button>
      <button class="btn outlined small" data-busy data-act="keep" data-id="${esc(p.id)}">Interested</button>
      <button class="btn danger small" data-busy data-act="reject" data-id="${esc(p.id)}">Not for me</button>
      ${postingBtn(p)}`,
  })).join("") + moreBtn(rows.length);
}

/* Pipeline */
function inboxChip() {
  const r = S.room;
  const st = r.inbox.state;
  if (r.inboxStuck) return chip(`stuck since ${shortWhen(r.inbox.started_at)}`, "bad");
  if (st === "running") return chip(`reading since ${shortWhen(r.inbox.started_at)}`, "warn");
  if (st === "error") return chip(`last check failed ${shortWhen(r.inbox.finished_at)}`, "bad");
  if (r.inbox.finished_at) return chip(`last checked ${shortWhen(r.inbox.finished_at)}`, "ok");
  return chip("never run");
}

function pipelineHtml() {
  const r = S.room;
  const reading = r.inbox.state === "running";
  const top = `<div class="row">
      <div class="row-top">
        <div style="min-width:0;flex:1">
          <div class="company">Check email for status updates</div>
          <div class="sub">Reads your recruiting email for replies from the companies below and moves the card itself: a no goes to Lost or Rejected, a first call to Screen, a later round to Interview, an offer to Offer. It writes a note on the card, never sends or replies, never marks anything read, and leaves Review and Turned down alone.</div>
        </div>
        <button class="btn contained small" data-busy data-act="inbox" ${reading ? "disabled" : ""}>${S.busy === "job-inbox" ? "Starting" : reading ? "Reading now" : "Check email now"}</button>
      </div>
      <div class="row-actions">${inboxChip()}<span class="cap">Source: /api/jobs inbox</span></div>
      ${r.inboxStuck || r.inbox.state === "error" ? `<p class="cap err">${esc(r.inboxStuck
        ? `It has claimed to be reading since ${shortWhen(r.inbox.started_at)}. Nothing is being checked. Ask Claude: "my email check is stuck".`
        : `The last check failed: ${r.inbox.message || "no reason given"}.`)}</p>` : ""}
    </div>`;
  const stages = STAGES.map((s) => {
    const all = r.pipeline[s.key];
    const rows = filterJobs(all);
    const head = `<div class="subtitle">${esc(s.label)} (${rows.length === all.length ? all.length : `${rows.length} of ${all.length}`})</div>`;
    const list = rows.length ? rows.map((p) => rowHtml(p, {
      dense: true,
      actions: `<select class="field" data-busy data-act="stage" data-id="${esc(p.id)}" aria-label="Stage">${[...STAGES.map((x) => x.key), "disqualified", "no_answer", "rejected"].map((k) => `<option value="${k}" ${k === p.status ? "selected" : ""}>${k.replace("_", " ")}</option>`).join("")}</select>${postingBtn(p)}`,
    })).join("") : `<p class="cap">${all.length ? `${all.length} here, none matching the filters.` : "Empty."}</p>`;
    return `<div class="stage">${head}${list}</div>`;
  }).join("");
  return `${top}<div class="stages">${stages}</div>`;
}

/* Apply queue */
function progressHtml() {
  const run = S.room ? S.room.apply : {};
  const p = S.progress;
  if (S.progressErr) return `<div class="notice warn">Could not read the apply progress: ${esc(S.progressErr)}</div>`;
  if (!p || (!p.running && !p.started_at)) {
    const running = run.state === "running";
    return `<div class="row">
      <div class="row-actions"><b style="font-size:.875rem">Apply queue</b>${chip(running ? "starting" : "not running")}</div>
      <div class="sub">${running ? "A run has just started. The steps appear here as the worker reports them." : "No run in progress."}${run.finished_at ? ` Last run finished ${esc(shortWhen(run.finished_at))}.` : ""}${run.message ? ` ${esc(String(run.message).replace(/\.$/, ""))}.` : ""}</div>
      <div class="cap">While a run is going this shows which role it is on, which step, and what happened to each one it finished.</div>
    </div>`;
  }
  const steps = arr(p.steps);
  const cur = p.current;
  const done = arr(p.done);
  const quietFor = p.updated_at ? (Date.now() - new Date(p.updated_at).getTime()) / 60000 : 0;
  const stale = p.running && quietFor > 4;
  const applied = done.filter((d) => d.outcome === "applied").length;
  const target = num(p.batch) || done.length || 0;
  const pct = target > 0 ? Math.min(100, Math.round((done.length / target) * 100)) : 0;
  let current = "";
  if (cur) {
    const at = num(cur.step_index);
    current = `<div style="display:flex;flex-direction:column;gap:4px">
      <b style="font-size:.875rem">${esc(cur.company || "Unnamed company")}${cur.title ? ` · ${esc(cur.title)}` : ""}</b>
      <div class="chips-wrap">${steps.map((s, i) => chip(s.label, at > 0 && i + 1 === at ? "primary" : at > 0 && i + 1 < at ? "ok" : "")).join("")}</div>
      <div class="cap">${at > 0 ? `Step ${at} of ${steps.length}: ${esc(cur.step_label || "")}` : "Started, no step reported yet"}${cur.step_at ? ` · ${since(cur.step_at)} on this step` : ""}${cur.note ? ` · ${esc(cur.note)}` : ""}</div>
      ${stale ? `<div class="cap warn">Nothing reported for ${Math.round(quietFor)} minutes. The step above is the last thing it said, not necessarily what it is doing now.</div>` : ""}
    </div>`;
  } else if (p.running) {
    current = `<div class="sub">Between roles.</div>`;
  }
  return `<div class="row">
    <div class="row-top">
      <div>
        <div class="row-actions"><b style="font-size:.875rem">Apply queue</b>${p.running ? chip(stale ? "quiet" : "running", stale ? "warn" : "ok") : chip("not running")}</div>
        <div class="cap">${done.length} of ${target} done this run${applied !== done.length ? ` · ${applied} submitted` : ""}${num(p.queued) ? ` · ${num(p.queued)} on the queue` : ""}${p.started_at ? ` · started ${esc(clock(p.started_at))}` : ""}</div>
      </div>
      <div class="big-num">${done.length}/${target || "?"}</div>
    </div>
    ${target > 0 ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ""}
    ${p.worker_gone ? `<div class="notice bad">The worker stopped without finishing its report. What it had done is below; anything it was part way through was not recorded, so treat the last role as unknown rather than applied.</div>` : ""}
    ${current}
    ${done.slice().reverse().map((d) => `<div class="row-top"><div style="min-width:0"><div class="sub">${esc(d.company || d.id)}${d.title ? ` · ${esc(d.title)}` : ""}</div>${d.note ? `<div class="cap">${esc(d.note)}</div>` : ""}</div>${chip(d.outcome || "", d.outcome === "applied" ? "ok" : d.outcome === "blocked" ? "bad" : "")}</div>`).join("")}
    <div class="cap">Source: /api/apply-progress, written by the worker as it goes.</div>
  </div>`;
}

function queueHtml() {
  const r = S.room;
  const blocked = filterJobs(r.blocked);
  const queue = filterJobs(r.queue);
  const minAuto = Number(rec(rec(S.raw.profile).auto_apply).min_overall) || 4;
  const autoOn = rec(rec(S.raw.profile).auto_apply).enabled !== false;
  return `<div id="apply-progress">${progressHtml()}</div>
    ${blocked.length ? `<div class="subtitle">Blocked, waiting on you</div>${blocked.map((p) => rowHtml(p, { dense: true, actions: `<span class="cap err">${esc(p.applyResult)}</span>${postingBtn(p)}` })).join("")}` : ""}
    <div class="subtitle">Queued to apply</div>
    ${queue.length ? queue.map((p) => rowHtml(p, {
      dense: true,
      actions: `${chip(p.canAuto ? `automatic: ${METHOD[p.applyMethod] || p.applyMethod}` : `needs you: ${METHOD[p.applyMethod] || p.applyMethod}`, p.canAuto ? "ok" : "warn")}
        ${p.resumePath ? chip("resume ready") : chip("tailored resume made first", "warn")}
        <button class="btn danger small" data-busy data-act="unqueue" data-id="${esc(p.id)}">Take off the queue</button>`,
    })).join("") : `<p class="empty">${r.queue.length
      ? `None of the ${r.queue.length} queued roles match these filters.`
      : `The queue is empty. ${autoOn ? `Anything scoring ${minAuto} or 5 lands here on its own, and` : "Roles land here when"} you press Apply for me on a role. Press Run apply queue to send them.`}</p>`}`;
}

/* Applied, Turned down, Rejected, Lost */
function appliedHtml() {
  const r = S.room;
  return listPanel(filterJobs(r.applied), r.applied, "Nothing submitted yet.", "None of the applications match these filters.",
    (p) => `<span class="cap">Applied ${esc(shortWhen(p.appliedAt) || p.appliedAt)}${p.autoApplied ? " · by the apply queue" : ""}${p.applyResult ? ` · ${esc(p.applyResult)}` : ""}</span>`);
}
function archiveHtml() {
  const r = S.room;
  return listPanel(filterJobs(r.archive), r.archive, "You have not turned anything down.", "None of the turned-down roles match these filters.",
    (p) => `<span class="cap">${esc(p.rejectReasons.join(", "))}${p.rejectNote ? ` · ${esc(p.rejectNote)}` : ""}</span>
      <button class="btn small" data-busy data-act="restore" data-id="${esc(p.id)}">Back to Review</button>`);
}
function insightsHtml() {
  const md = String(S.raw.insights_md || "").trim();
  if (!md) return "";
  return `<div class="row"><b style="font-size:.875rem">What the pattern says</b><p class="pre insights">${esc(md)}</p></div>`;
}
function rejectedHtml() {
  const r = S.room;
  return insightsHtml() + listPanel(filterJobs(r.rejected), r.rejected, "No employer has said no.", "None of the rejected roles match these filters.",
    (p) => `<span class="cap">${esc((p.dq && (p.dq.detail || p.dq.label)) || "")}</span>`);
}
function lostHtml() {
  const r = S.room;
  return insightsHtml() + listPanel(filterJobs(r.lost), r.lost, "Nothing lost for another reason.", "None of the lost roles match these filters.",
    (p) => `<span class="cap">${esc(p.status === "no_answer" ? "no answer" : (p.dq && p.dq.label) || "")}${p.dq && p.dq.detail ? ` · ${esc(p.dq.detail)}` : ""}${p.dq && p.dq.preventable ? " · this one was preventable" : ""}</span>`);
}

/* Startups */
function startupsHtml() {
  const list = S.room.startups;
  if (!list.length) return `<p class="empty">No startups on the watchlist yet. The search fills it as it finds small companies worth watching.</p>`;
  const sw = rec(CAND().startup_watch);
  const region = sw.region_label ? ` in ${esc(sw.region_label)}` : "";
  return `<p class="sub">Small companies${region}, checked every day for openings, even when they never post on the big job sites.</p>
    ${list.slice(0, S.shown).map((s) => `<div class="row flat">
      <div style="min-width:0">
        <div class="company">${esc(s.name)}</div>
        <div class="cap" style="color:var(--ink-2)">${esc([s.city, s.sector, s.employees, s.stage].filter(Boolean).join(" · "))}</div>
        ${s.notes ? `<div class="cap clamp" style="font-size:.75rem">${esc(s.notes)}</div>` : ""}
      </div>
      <div class="row-chips">
        ${s.openMatches > 0 ? chip(`${s.openMatches} open`, "ok") : ""}
        ${s.status ? chip(s.status) : ""}
        ${safeUrl(s.careersUrl) ? `<a class="btn small" href="${esc(safeUrl(s.careersUrl))}" target="_blank" rel="noopener">Careers</a>` : ""}
      </div>
    </div>`).join("")}${moreBtn(list.length)}`;
}

/* Screened out */
function ignoredHtml() {
  const all = S.room.ignored;
  const rows = filterJobs(all, "lite");
  if (!rows.length) return `<p class="empty">${all.length ? `None of the ${all.length} screened-out postings match these filters.` : "Nothing was screened out."}</p>`;
  return `<p class="sub">Postings the search saw and skipped before scoring, with why. If one of these should have been scored, ask Claude to change the rule that dropped it.</p>
    ${rows.slice(0, S.shown).map((x) => `<div class="row flat">
      <div style="min-width:0"><div class="company" style="font-size:.875rem">${esc(x.company)}</div><div class="sub">${esc(x.title)}</div><div class="cap">${esc(x.reason)}</div></div>
      <div class="row-chips">${x.source ? chip(x.source, "", "outlined") : ""}${safeUrl(x.url) ? `<a class="btn small" href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener">Posting</a>` : ""}</div>
    </div>`).join("")}${moreBtn(rows.length)}`;
}

/* Analytics */
function analyticsHtml() {
  const a = S.room.analytics;
  const list = (rows, empty) => (rows.length ? rows.map((x) => `<div class="kv"><span>${esc(x.k)}</span><span>${x.n}</span></div>`).join("") : `<p class="sub">${esc(empty)}</p>`);
  return `<div class="three">
      <div><div class="subtitle" style="margin-bottom:8px">Where every role stands</div>${list(a.byStatus, "Nothing yet.")}</div>
      <div><div class="subtitle" style="margin-bottom:8px">Where they came from</div>${list(a.bySource, "Nothing yet.")}</div>
      <div><div class="subtitle" style="margin-bottom:8px">How the closed ones ended</div>${list(a.dqCauses, "Nothing closed yet.")}</div>
    </div>
    <div class="facts">${[
      ["Roles tracked", a.total], ["Applied", a.applied], ["Of those, by the apply queue", a.autoApplied],
      ["In a conversation", a.interviews], ["Screened out before scoring", a.screenedOut], ["Startups watched", a.startups],
    ].map(([l, v]) => `<div class="fact"><div class="l">${esc(l)}</div><div class="v">${v}</div></div>`).join("")}</div>
    ${insightsHtml()}`;
}

/* Guide */
function guideHtml() {
  const first = firstName();
  const times = searchTimesText();
  const prof = rec(S.raw.profile);
  const minAuto = Number(rec(prof.auto_apply).min_overall) || 4;
  const autoOn = rec(prof.auto_apply).enabled !== false;
  const wd = rec(rec(CAND().schedule).weekly_digest);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekly = wd.enabled === false ? "The weekly email summary is switched off."
    : `Every ${days[Number(wd.weekday == null ? 5 : wd.weekday)] || "Friday"} at ${esc(fmtClock(wd.time || "10:00"))} it reads your recruiting email and writes you a short summary.`;
  const dl = (rows) => `<dl>${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>`;
  const empty = !S.room.positions.length;
  return `<div class="guide">
    <div><h2>${first ? `Hi ${esc(first)}. ` : ""}Here is how your job search works.</h2>
      <p>Your computer looks for new jobs for you, scores each one against what you told it you want, writes a resume tailored to the good ones, and keeps everything on this page. It never applies anywhere or contacts anyone unless you press a button that says so.</p></div>
    ${empty ? `<div><h3>Your first day</h3><ol>
      <li>Leave this page open. Nothing to do yet.</li>
      <li>Your first search runs at ${esc(times)}. If you would rather not wait, press <b>Search now</b> at the top. It takes 30 to 90 minutes.</li>
      <li>When it finishes, new jobs appear in <b>Review</b>. Press <b>Apply for me</b>, <b>Interested</b> or <b>Not for me</b> on each.</li>
      <li>Every <b>Not for me</b> teaches the search what you do not want, so the next results get better.</li>
    </ol></div>` : ""}
    <div><h3>When it runs</h3><ul>
      <li><b>Job search:</b> every day at ${esc(times)}. If your laptop is asleep then, it runs as soon as you open it.</li>
      <li><b>Weekly summary:</b> ${weekly}</li>
      <li><b>Applying:</b> only when you press <b>Run apply queue</b>. Nothing is sent while you are not looking.</li>
      <li><b>Reading email for replies:</b> only when you press <b>Check email now</b> on the Pipeline tab.</li>
      <li>The strip under the title always shows when the last search ran. Hover a pill to see what it means.</li>
    </ul></div>
    <div><h3>The tabs</h3>${dl([
      ["Review", "New jobs waiting for your opinion, highest score first. This is where you spend most of your time."],
      ["Pipeline", "Jobs you said yes to, by stage: Interested, Applied, Screen (first call), Interview, Offer. <b>Check email now</b> lives here."],
      ["Apply queue", "Jobs waiting to be sent, and while a run is going, which one it is on and how each one went."],
      ["Applied", "Every application sent, newest first."],
      ["Startups", "Small companies the search checks every day, even if they never post on the big job sites."],
      ["Turned down", "Jobs you said no to, with your reasons. <b>Back to Review</b> brings one back."],
      ["Rejected", "Applications where a company wrote back to say no."],
      ["Lost", "Jobs that ended without anyone saying no: the posting closed, a sign-in wall, or no reply."],
      ["Screened out", "Jobs the search skipped without scoring, with why."],
      ["Analytics", "Your numbers at a glance."],
    ])}</div>
    <div><h3>The numbers on every row</h3>${dl([
      ["Score 1 to 5", "How close the job is to what you described. Green at 4 and 5, gold at 3. Under it, one line says why it got that score and what kept it from being higher."],
      ["% match", "How much of the job's duties your experience already covers, with the strongest reason and the biggest gap."],
      ["Changing a score", "Open the job and click a dot. Your score wins, and the next search learns from it."],
    ])}</div>
    <div><h3>Buttons on a job in Review</h3>${dl([
      ["Apply for me", `Puts it on the apply queue. It is sent the next time you press <b>Run apply queue</b>.${autoOn ? ` Jobs scoring ${minAuto} or 5 are queued for you after each search.` : ""}`],
      ["Interested", "You like it but are not ready to apply. It moves to Pipeline."],
      ["Not for me", "Pick what was off (location, pay, industry, level, company size, role scope, other). The search learns from it."],
      ["Posting", "Opens the original job posting."],
      ["The checkbox", "Select several jobs. A bar appears with the same buttons, plus <b>Prepare resumes</b>, for all of them at once."],
      ["The company name", "Opens everything about the job: the full posting, scores, research, a tailored resume and a diary for notes."],
    ])}</div>
    <div><h3>Need help?</h3><p>Open <b>Job Search Assistant</b> on your Desktop and ask in plain words, for example "Change the search times to 9am and 5pm", "I care less about pay and more about remote work", or "Something looks broken on my dashboard, can you check?"</p></div>
  </div>`;
}

/* ── dialogs ─────────────────────────────────────────────────────────── */

const findPos = (id) => (S.room ? S.room.positions.find((p) => p.id === id) : null);

function closeDialog() {
  $("#dialogs").innerHTML = "";
  S.dialog = null;
  document.body.style.overflow = "";
}

function openReject(target) {
  S.dialog = { kind: "reject", target, reasons: [] };
  paintReject();
}
function paintReject() {
  const d = S.dialog;
  const title = d.target.bulk ? `Turn down ${plural(d.target.count, "role")}` : `Turn down ${d.target.company}`;
  $("#dialogs").innerHTML = `<div class="scrim" data-act="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dialog-head"><h2>${esc(title)}</h2></div>
    <div class="dialog-content">
      <p class="sub" style="margin:0">The reason goes back into the scoring, so the next search learns from it.${d.target.bulk ? " The same reason is recorded against every one you selected." : ""}</p>
      <div class="chips-wrap">${REJECT_REASONS.map(([k, l]) => `<button class="chip ${d.reasons.includes(k) ? "on" : "off"}" data-act="reason" data-v="${k}">${esc(l)}</button>`).join("")}</div>
      <textarea class="field" id="reject-note" rows="2" placeholder="Anything to add (optional)">${esc(d.note || "")}</textarea>
    </div>
    <div class="dialog-actions">
      <button class="btn" data-act="close">Cancel</button>
      <button class="btn contained danger" data-busy data-act="reject-go" ${d.reasons.length ? "" : "disabled"}>${d.target.bulk ? `Turn down ${d.target.count}` : "Turn it down"}</button>
    </div>
  </div></div>`;
  document.body.style.overflow = "hidden";
}

/* Sending real applications asks once first. */
async function openConfirmApply() {
  await load();
  const q = S.room ? S.room.queue : [];
  if (!q.length) {
    toast("Nothing is waiting on the apply queue. Press Apply for me on a job first.");
    return;
  }
  S.dialog = { kind: "confirm-apply" };
  $("#dialogs").innerHTML = `<div class="scrim" data-act="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="Send applications">
    <div class="dialog-head"><h2>Send ${plural(q.length, "application")}?</h2></div>
    <div class="dialog-content">
      <p class="sub" style="margin:0">These are real applications, sent in your name. Any that need you (a video, a question it cannot answer truthfully) are left for you with the next step.</p>
      <div>${q.slice(0, 8).map((p) => `<div class="sub" style="color:var(--ink)">${esc(p.company)} <span class="cap">${esc(p.title)}</span></div>`).join("")}${q.length > 8 ? `<div class="cap">and ${q.length - 8} more</div>` : ""}</div>
    </div>
    <div class="dialog-actions">
      <button class="btn" data-act="close">Not yet</button>
      <button class="btn contained" data-busy data-act="apply-go">Send ${q.length === 1 ? "it" : `all ${q.length}`}</button>
    </div>
  </div></div>`;
  document.body.style.overflow = "hidden";
}

async function submitReject() {
  const d = S.dialog;
  if (!d || !d.reasons.length) return;
  const note = ($("#reject-note") || {}).value || "";
  const body = { status: "rejected", reject_reasons: d.reasons, reject_note: note.trim() || null };
  const target = d.target;
  closeDialog();
  if (target.bulk) {
    pruneSelection();
    await patchMany([...S.selected], body, "Turned down");
  }
  else await patch(target.id, body, `Turned down ${target.company}.`);
}

async function openDetail(id) {
  S.dialog = { kind: "detail", id, full: null, failed: "" };
  paintDetail();
  try {
    const res = await fetch(`/api/position/${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `error ${res.status}`);
    if (S.dialog && S.dialog.id === id) S.dialog.full = toPosition(body);
  } catch (e) {
    if (S.dialog && S.dialog.id === id) S.dialog.failed = e && e.message ? e.message : String(e);
  }
  if (S.dialog && S.dialog.id === id) paintDetail();
}

function detailPanel(title, inner) {
  return `<div class="panel"><h4>${esc(title)}</h4>${inner}</div>`;
}

function paintDetail() {
  const d = S.dialog;
  if (!d || d.kind !== "detail") return;
  const live = findPos(d.id);
  if (!live && !d.full) { closeDialog(); return; }
  // The live row wins on what the list refreshes; the full read fills in the
  // heavy parts the list may leave out.
  const p = live ? (d.full ? { ...live, jdText: d.full.jdText || live.jdText, researchMd: d.full.researchMd, events: d.full.events, statusHistory: d.full.statusHistory } : live) : d.full;
  const keep = document.querySelector("#detail-note");
  const noteDraft = keep ? keep.value : "";
  const busy = S.busy !== "" ? "disabled" : "";

  const resumeBtn = p.resumePath
    ? `<a class="btn outlined small" href="/files/${encodeURIComponent(p.resumePath)}" target="_blank" rel="noopener">Tailored resume</a>`
    : p.resumeRequested ? chip("resume queued for the next run", "warn")
      : `<button class="btn outlined small" data-busy data-act="d-resume">Prepare a tailored resume</button>`;

  const applying = (p.applySummary || p.applyResult || p.status !== "review") ? detailPanel("Applying", `
      <div class="sub">${esc(METHOD[p.applyMethod] || p.applyMethod)}${p.canAuto ? " · the apply queue can do this one" : " · needs you"}${p.applyManualReason ? ` · ${esc(p.applyManualReason)}` : ""}</div>
      ${p.applySummary ? `<div class="sub" style="color:var(--ink)">${esc(p.applySummary)}</div>` : ""}
      ${p.applyResult ? `<div class="sub" style="color:${p.applyResult.toLowerCase().startsWith("needs input") ? "var(--bad-ink)" : "var(--ink-2)"}">${esc(p.applyResult)}</div>` : ""}
      ${p.appliedAt ? `<span class="cap">Applied ${esc(shortWhen(p.appliedAt) || p.appliedAt)}</span>`
        : CLOSED.has(p.status) ? ""
          : !p.applyRequested ? `<div><button class="btn contained small" data-busy data-act="d-apply">Apply for me</button></div>`
            : `<div>${chip("on the apply queue", "warn")}</div>`}`) : "";

  const o = p.outreach || {};
  const outreach = o.status && o.status !== "none" ? detailPanel("Reaching out", `
      <div>${chip(o.status.replace("_", " "), o.status === "sent" ? "ok" : o.status === "blocked" ? "bad" : "warn", "cap")}</div>
      ${o.people.map((w) => `<div class="sub">${esc(w.name)}${w.title ? ` · ${esc(w.title)}` : ""}${w.role ? ` · ${esc(w.role.replace("_", " "))}` : ""}${safeUrl(w.linkedin) ? ` <a href="${esc(safeUrl(w.linkedin))}" target="_blank" rel="noopener">LinkedIn</a>` : ""}</div>`).join("")}
      ${o.message ? `<p class="pre" style="color:var(--ink)">${esc(o.message)}</p>` : ""}
      ${o.blockedReason ? `<span class="cap err">${esc(o.blockedReason)}</span>` : ""}
      ${o.status === "ready" ? `<div><button class="btn contained small" data-busy data-act="d-send">Send it</button></div>` : ""}`) : "";

  const fit = p.strengths.length || p.gaps.length ? detailPanel("Why you, and what is thin",
    p.strengths.map((x) => `<div class="sub" style="color:var(--ink)"><span class="pos">+</span> ${esc(x)}</div>`).join("")
    + p.gaps.map((x) => `<div class="sub"><span class="neg">−</span> ${esc(x)}</div>`).join("")) : "";

  const events = p.events.length ? detailPanel("What has happened", p.events.slice(-12).reverse().map((e) => `<div>
      <div class="sub" style="color:var(--ink)">${esc(e.title || e.type || "")} <span class="cap">${esc(String(e.at || "").slice(0, 10))}</span></div>
      ${e.detail ? `<div class="cap" style="color:var(--ink-2)">${esc(String(e.detail).slice(0, 400))}</div>` : ""}
    </div>`).join("")) : "";

  const scores = detailPanel("Scores", `<span class="cap">Click a dot to change it. Your score wins and the next search learns from it.</span>
    ${DIMENSIONS.map((dim) => `<div>
      <div class="score-line"><span>${esc(DIM_LABEL[dim] || dim)}</span><div class="dots">${[1, 2, 3, 4, 5].map((n) => `<button class="score-dot ${(p.scores[dim] || 0) >= n ? "on" : ""}" title="${esc(`${DIM_LABEL[dim] || dim} = ${n}`)}" aria-label="${esc(`${dim} ${n}`)}" data-busy data-act="d-score" data-dim="${dim}" data-v="${n}" ${busy}></button>`).join("")}</div></div>
      ${p.rationale[dim] ? `<div class="cap" style="color:var(--ink-2)">${esc(p.rationale[dim])}</div>` : ""}
    </div>`).join("")}
    ${p.scoreOverridden ? `<span class="cap">You have changed these.</span>` : ""}`);

  const details = detailPanel("Details", [
    ["Found", p.foundDate], ["Posted", p.postedDate], ["Source", p.source], ["Location", p.location],
    ["Work model", p.workModel], ["Pay", p.salary || (p.compUnknown ? "not listed" : "")],
    ["Company", p.companyUrl],
    ["Status history", p.statusHistory.map((h) => `${h.status.replace("_", " ")} ${String(h.at).slice(0, 10)}`).join(" → ")],
  ].filter(([, v]) => v).map(([k, v]) => `<div class="detail-kv"><span>${esc(k)}</span><span>${k === "Company" && safeUrl(v) ? `<a href="${esc(safeUrl(v))}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}</span></div>`).join(""));

  const ended = p.dq ? detailPanel("How it ended", `<div>${chip(p.dq.label || p.dq.cause)}</div>
    ${p.dq.detail ? `<div class="sub" style="color:var(--ink)">${esc(p.dq.detail)}</div>` : ""}
    ${p.dq.preventable != null ? `<span class="cap ${p.dq.preventable ? "warn" : ""}">${p.dq.preventable ? "This one was preventable." : "Nothing you could have done."}</span>` : ""}`) : "";

  const turned = p.rejectReasons.length ? detailPanel("Why you turned it down", `<div class="chips-wrap">${p.rejectReasons.map((r) => chip(r)).join("")}</div>${p.rejectNote ? `<div class="sub">${esc(p.rejectNote)}</div>` : ""}`) : "";

  const rc = p.resumeCheck ? detailPanel("Resume keywords", `<div class="sub" style="color:${p.resumeCheck.ok ? "var(--ink-2)" : "var(--watch-ink)"}">${esc(p.resumeCheck.ok ? "The tailored resume covers the posting." : `Still missing: ${p.resumeCheck.missing.join(", ")}`)}</div>${p.resumeCheck.note ? `<span class="cap">${esc(p.resumeCheck.note)}</span>` : ""}`) : "";

  const posting = detailPanel("The posting", `<p class="pre">${esc(p.jdText || p.summary || "No description on file.")}</p>
    ${!d.full && !d.failed && !p.jdText ? `<span class="cap">Reading the full posting.</span>` : ""}
    ${d.failed ? `<span class="cap err">The full posting could not be read: ${esc(d.failed)}. The summary above is what the list already had.</span>` : ""}`);

  const stageOpts = ALL_STAGES.map((s) => `<option value="${s}" ${s === (ALL_STAGES.includes(p.status) ? p.status : "review") ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("");

  $("#dialogs").innerHTML = `<div class="scrim" data-act="scrim"><div class="dialog lg" role="dialog" aria-modal="true" aria-label="${esc(p.title)}">
    <div class="dialog-head">
      <div style="min-width:0"><h2>${esc(p.title)}</h2><div class="sub">${esc([p.company, p.companySize, p.companyFunding].filter(Boolean).join(" · "))}</div></div>
      <button class="btn icon" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="dialog-content">
      <div class="row-actions">
        <label class="cap" for="d-stage">Stage</label>
        <select class="field" id="d-stage" data-busy data-act="d-stage" ${busy}>${stageOpts}</select>
        ${safeUrl(p.url) ? `<a class="btn contained small" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">Open the posting</a>` : ""}
        ${resumeBtn}
        ${p.matchPct != null ? chip(`${p.matchPct}% match`) : ""}
        ${p.autoApplied ? chip("applied by the apply queue", "ok") : ""}
      </div>
      ${whyHtml(p)}
      <div class="chips-wrap">${[p.location, p.workModel, p.salary || (p.compUnknown ? "pay not listed" : ""), p.source, p.easyApply ? "Easy Apply" : ""].filter(Boolean).map((c) => chip(c, "", "outlined")).join("")}</div>
      <div class="detail-grid">
        <div class="col">
          ${applying}${rc}${outreach}${fit}${events}
          ${detailPanel("Add a note", `<div class="row-actions" style="align-items:flex-start"><textarea class="field" id="detail-note" rows="2" placeholder="Goes on this job's diary" style="flex:1;min-width:220px">${esc(noteDraft)}</textarea><button class="btn outlined small" data-busy data-act="d-note">Add</button></div>`)}
          ${p.researchMd ? detailPanel("Research", `<p class="pre">${esc(p.researchMd)}</p>`) : ""}
          ${posting}
        </div>
        <div class="col">${scores}<div class="divider"></div>${details}${ended}${turned}</div>
      </div>
    </div>
  </div></div>`;
  document.body.style.overflow = "hidden";
  paintBusy();
}

/* A change in the panel re-reads the posting, since it can add an event or a
   line of status history. */
async function detailChange(body, said) {
  const id = S.dialog.id;
  await patch(id, body, said);
  if (S.dialog && S.dialog.id === id) openDetail(id);
}

/* ── events ──────────────────────────────────────────────────────────── */

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const p = id ? findPos(id) : null;

  if (act === "scrim") {
    if (e.target === el) closeDialog();
    return;
  }
  switch (act) {
    case "open": openDetail(id); break;
    case "more": S.shown += MORE; if (SCOPES[S.tab]) paintResults(); else paintContent(); break;
    case "apply": await patch(id, { status: "interested", apply_requested: true }, `Queued ${p ? p.company : "it"} to apply.`); break;
    case "keep": await patch(id, { status: "interested" }, `Kept ${p ? p.company : "it"}.`); break;
    case "reject": if (p) openReject(p); break;
    case "restore": await patch(id, { status: "review" }, `${p ? p.company : "It"} is back in Review.`); break;
    case "unqueue": await patch(id, { apply_requested: false }, `Took ${p ? p.company : "it"} off the queue.`); break;
    case "inbox": await startJob("inbox"); break;
    case "choose":
      if (el.checked) S.selected.add(id); else S.selected.delete(id);
      paintResults();
      break;
    case "select-visible": {
      const vis = filterJobs(S.room.review).slice(0, S.shown);
      const all = vis.every((x) => S.selected.has(x.id));
      if (all) S.selected.clear(); else vis.forEach((x) => S.selected.add(x.id));
      paintResults();
      break;
    }
    case "select-all": filterJobs(S.room.review).forEach((x) => S.selected.add(x.id)); paintResults(); break;
    case "clear-selection": S.selected.clear(); paintResults(); break;
    case "bulk-apply": pruneSelection(); await patchMany([...S.selected], { status: "interested", apply_requested: true }, "Queued to apply"); break;
    case "bulk-keep": pruneSelection(); await patchMany([...S.selected], { status: "interested" }, "Kept"); break;
    case "bulk-resume": pruneSelection(); await patchMany([...S.selected], { resume_requested: true }, "Resumes queued for"); break;
    case "bulk-reject": pruneSelection(); if (!S.selected.size) break; openReject({ bulk: true, count: S.selected.size }); break;
    case "quick": S.filter.minScore = Number(el.dataset.v); S.shown = PAGE; paintContent(); break;
    case "filters": S.filterOpen = !S.filterOpen; paintContent(); break;
    case "clear-filters": S.filter = emptyFilter(); S.shown = PAGE; paintContent(); break;
    case "unchip": clearChip(el.dataset.v); S.shown = PAGE; paintContent(); break;
    case "toggle": {
      const list = S.filter[el.dataset.f];
      const v = el.dataset.v;
      S.filter[el.dataset.f] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
      S.shown = PAGE;
      paintContent();
      break;
    }
    case "close": closeDialog(); break;
    case "reason": {
      const d = S.dialog;
      d.note = ($("#reject-note") || {}).value || "";
      const v = el.dataset.v;
      d.reasons = d.reasons.includes(v) ? d.reasons.filter((x) => x !== v) : [...d.reasons, v];
      paintReject();
      break;
    }
    case "reject-go": await submitReject(); break;
    case "apply-go": closeDialog(); await startJob("apply"); break;
    case "d-apply": { const cur = findPos(S.dialog.id); if (!cur || CLOSED.has(cur.status) || cur.appliedAt) break; } await detailChange({ status: "interested", apply_requested: true }, "Queued to apply."); break;
    case "d-resume": await detailChange({ resume_requested: true }, "Resume queued for the next run."); break;
    case "d-send": await detailChange({ outreach_action: "send" }, "Queued to send."); break;
    case "d-score": {
      const cur = findPos(S.dialog.id);
      if (!cur) break;
      const dim = el.dataset.dim;
      const v = Number(el.dataset.v);
      await detailChange({ scores: { ...cur.scores, [dim]: v } }, `${DIM_LABEL[dim] || dim} set to ${v}.`);
      break;
    }
    case "d-note": {
      const box = $("#detail-note");
      const note = box ? box.value.trim() : "";
      if (!note) break;
      box.value = "";
      await detailChange({ diary_note: note }, "Note added.");
      break;
    }
    default: break;
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.act === "stage") {
    const p = findPos(el.dataset.id);
    await patch(el.dataset.id, { status: el.value }, `${p ? p.company : "It"} moved to ${el.value.replace("_", " ")}.`);
    return;
  }
  if (el.dataset.act === "d-stage") {
    await detailChange({ status: el.value }, `Moved to ${el.value.replace("_", " ")}.`);
    return;
  }
  const f = el.dataset.f;
  if (!f || el.id === "find") return;
  const F = S.filter;
  if (f.includes(".")) {
    const [group, key] = f.split(".");
    F[group][key] = el.type === "checkbox" ? el.checked : el.value;
  } else if (f === "places") {
    F.places = [...el.selectedOptions].map((o) => o.value);
  } else if (f === "minScore" || f === "minMatch") {
    F[f] = Number(el.value);
  } else if (f === "payMin" || f === "payMax") {
    F[f] = readMoney(el.value);
  } else if (f === "payUnknown") {
    F.payUnknown = el.checked;
  } else if (f === "title") {
    F.title = el.value;
  }
  S.shown = PAGE;
  paintContent();
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "find") return;
  S.filter.q = e.target.value;
  S.shown = PAGE;
  paintResults();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.dialog) { closeDialog(); return; }
  const el = e.target.closest && e.target.closest('[data-act="open"]');
  if (el && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openDetail(el.dataset.id);
  }
});

window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (!TABS.some(([k]) => k === next) || next === S.tab) return;
  S.tab = next;
  S.shown = PAGE;
  render();
  if (next === "queue") loadProgress();
});

$("#btn-scan").addEventListener("click", () => startJob("scan"));
$("#btn-apply").addEventListener("click", () => openConfirmApply());
$("#btn-refresh").addEventListener("click", () => load());
$("#btn-theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("js-theme", next); } catch (_) { /* private window */ }
});

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 5000);
}

/* ── start ───────────────────────────────────────────────────────────── */

(async function start() {
  const want = location.hash.slice(1);
  if (TABS.some(([k]) => k === want)) S.tab = want;
  await load();
  // A brand-new install opens on the Guide, so the first thing seen is an
  // explanation rather than an empty board.
  if (!want && S.room && !S.room.positions.length) {
    S.tab = "guide";
    render();
  }
  if (S.tab === "queue") loadProgress();

  // Keep it current without a refresh: the board every minute (every 15
  // seconds while something is running), apply progress fast during a run.
  let last = 0;
  setInterval(() => {
    if (document.hidden || S.busy || S.dialog) return;
    const focus = document.activeElement;
    if (focus && focus.closest && focus.closest("#content") && /^(INPUT|SELECT|TEXTAREA)$/.test(focus.tagName)) return;
    const r = S.room;
    const live = r && [r.scan, r.apply, r.inbox].some((j) => j.state === "running");
    if (Date.now() - last >= (live ? 15000 : 60000)) {
      last = Date.now();
      load();
    }
  }, 5000);
  setInterval(() => {
    if (document.hidden || S.tab !== "queue") return;
    const running = (S.room && S.room.apply.state === "running") || (S.progress && S.progress.running);
    if (running || Date.now() % 30000 < 5000) loadProgress();
  }, 5000);
})();
