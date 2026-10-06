"use strict";

const STAGES = [
  ["interested", "Interested"],
  ["applied", "Applied"],
  ["screen", "Screen"],
  ["interview", "Interview"],
  ["offer", "Offer"],
  ["disqualified", "Disqualified"],
  ["no_answer", "No answer"],
];
const CONVERSATION = new Set(["screen", "interview", "offer", "ongoing"]);
const APPLIED_FUNNEL = new Set(["applied", "screen", "interview", "offer", "ongoing", "no_answer"]);
const STAGE_LABEL = {
  review: "review",
  rejected: "rejected",
  interested: "interested",
  applied: "applied",
  screen: "screen",
  interview: "interview",
  offer: "offer",
  ongoing: "interview",
  disqualified: "disqualified",
  no_answer: "no answer",
};
function isConversation(p) {
  return CONVERSATION.has(p.status);
}
const REJECT_REASONS = [
  ["location", "Location / work model"],
  ["comp", "Compensation"],
  ["industry", "Industry"],
  ["seniority", "Seniority / level"],
  ["company-stage", "Company stage / size"],
  ["role-scope", "Role scope"],
  ["other", "Other"],
];

let DB = { positions: [], profile: {}, candidate: {}, insights_md: "" };
let JOBS = { scan: {}, apply: {}, inbox: {} };
let jobPoll = null;
const LIST_UI = {
  startups: { q: "", cities: [], sort: "date", dir: "desc" },
  archive: { q: "", cities: [], reason: "", score: "", sort: "score", dir: "desc" },
  ignored: { q: "", cities: [], reason: "", source: "", sort: "date", dir: "desc" },
  rejected: { q: "", cities: [], score: "", model: "", sort: "date", dir: "desc" },
  review: {
    q: "", score: "", model: "", pay: "", size: "", posted: "", easy: "",
    sort: "score", dir: "desc",
  },
};
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// job-posting data is external content — only ever link to http(s) URLs
const safeUrl = (u) => /^https?:\/\//i.test(String(u ?? "")) ? esc(u) : "#";
// company name always links out: official site when known, otherwise a search
const companyLink = (p) => {
  const href = /^https?:\/\//i.test(String(p.company_url ?? ""))
    ? esc(p.company_url)
    : `https://www.google.com/search?q=${encodeURIComponent(p.company)}`;
  return `<a class="company" href="${href}" target="_blank" rel="noopener">${esc(p.company)} ↗</a>`;
};

/* ── data ─────────────────────────────────── */
async function load() {
  const res = await fetch("/api/data");
  const raw = await res.json();
  DB = {
    positions: (raw.positions && raw.positions.positions) || [],
    profile: raw.profile || {},
    candidate: raw.candidate || {},
    insights_md: raw.insights_md || "",
    startups: (raw.startups && raw.startups.startups) || [],
    ignored: (raw.ignored && raw.ignored.ignored) || [],
    companies: (raw.companies && raw.companies.companies) || [],
  };
  if (raw.jobs) JOBS = raw.jobs;
}

/* ── who the search is for (profile/candidate.json) ── */
function CAND() {
  return DB.candidate || {};
}

/* "16:00" → "4:00 pm" */
function fmtClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return String(hhmm || "");
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "pm" : "am"}`;
}

/* "8:00 am and 4:00 pm" from candidate.schedule.search_times */
function searchTimesText() {
  const times = (CAND().schedule?.search_times || ["08:00", "16:00"]).map(fmtClock);
  if (times.length <= 1) return times[0] || "the scheduled time";
  return `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
}

/* pay thresholds for the Review pay filter, from scoring-profile.json */
function payBands() {
  const comp = DB.profile?.dimensions?.comp || {};
  const floor = Number(comp.floor_cad || comp.floor) || 0;
  const bonus = Number(comp.bonus_cad || comp.bonus) || 0;
  return { floor, bonus, cur: CAND().currency || "CAD" };
}
const kFmt = (n) => `$${Math.round(n / 1000)}K`;

async function loadJobs() {
  const res = await fetch("/api/jobs");
  if (!res.ok) return;
  JOBS = await res.json();
}

async function patch(id, body) {
  const res = await fetch(`/api/position/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { toast("Save failed"); return null; }
  const updated = await res.json();
  const i = DB.positions.findIndex((p) => p.id === id);
  if (i >= 0) DB.positions[i] = updated;
  return updated;
}

const SELECTED = new Set();

/* review is rendered in score bands 5→1, so "next" has to follow what's on screen,
   not the raw array order */
function reviewQueue() {
  return DB.positions.filter((p) => p.status === "review");
}

function reviewQueueInDisplayOrder() {
  return visibleReview();
}

function nextAfter(id) {
  const ordered = reviewQueueInDisplayOrder();
  const i = ordered.findIndex((p) => p.id === id);
  if (i < 0) return null;
  return ordered[i + 1] || ordered[i - 1] || null;
}

/* called after a position leaves the review queue, so the triage flow lands on the
   next one instead of dumping you back at the top of the list */
function advanceTo(next, onDetail) {
  if (onDetail) {
    if (next) location.hash = `#position/${next.id}`;
    else { location.hash = "#review"; toast("Queue is clear"); }
    return;
  }
  render();
  if (!next) return;
  const card = document.querySelector(`.card[data-id="${CSS.escape(next.id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("next-up");
  setTimeout(() => card.classList.remove("next-up"), 1600);
}

function selectedPositions() {
  return DB.positions.filter((p) => SELECTED.has(p.id));
}

function selectBox(p) {
  return `<label class="sel-box" title="Select">
    <input type="checkbox" data-select="${esc(p.id)}"${SELECTED.has(p.id) ? " checked" : ""}>
  </label>`;
}

/* the server validates and locks per position, so bulk work is just a sequential
   fan-out over the same endpoint — no second write path to keep in sync */
async function patchMany(positions, bodyFor) {
  let done = 0;
  for (const p of positions) {
    const body = bodyFor(p);
    if (!body) continue;
    if (await patch(p.id, body)) done += 1;
  }
  return done;
}

/* "2026-08-28T08:14:03-04:00" → "28 Aug, 8:14 am" */
function formatWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = `${d.getDate()} ${d.toLocaleString("en-CA", { month: "short" })}`;
  const dated = d.getFullYear() === new Date().getFullYear() ? day : `${day} ${d.getFullYear()}`;
  let hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${dated}, ${hours}:${mins} ${ampm}`;
}

function jobState(name) {
  return JOBS[name] || {};
}

function lastSearchLabel() {
  const job = jobState("scan");
  if (job.state === "running") {
    const started = formatWhen(job.started_at);
    return started ? `Search started ${started}. Still working.` : "Search is running.";
  }
  if (job.state === "error") {
    const when = formatWhen(job.finished_at);
    return when ? `Last search hit a problem (${when}).` : "Last search hit a problem.";
  }
  const when = formatWhen(job.finished_at);
  return when ? `Last search: ${when}` : "No search recorded yet";
}

function paintJobControls() {
  const last = $("#scan-last");
  if (last) last.textContent = lastSearchLabel();
  const dot = $("#scan-dot");
  if (dot) dot.hidden = jobState("scan").state !== "running";
  const runningScan = jobState("scan").state === "running";
  document.querySelectorAll("[data-runjob='scan']").forEach((scanBtn) => {
    scanBtn.disabled = runningScan;
    scanBtn.classList.toggle("busy", runningScan);
    scanBtn.textContent = runningScan ? "Searching…" : "Search now";
    scanBtn.title = `Look for new jobs right now, instead of waiting for ${searchTimesText()}`;
  });
  const applyBtn = $("#btn-apply-queue");
  if (applyBtn) {
    const job = jobState("apply");
    const running = job.state === "running";
    const queued = Number(job.queued) || 0;
    applyBtn.disabled = running || queued === 0;
    applyBtn.classList.toggle("busy", running);
    applyBtn.textContent = running
      ? "Applying…"
      : queued ? `Apply queue now (${queued})` : "Apply queue now";
    applyBtn.title = queued
      ? `Apply to the ${queued} role${queued === 1 ? "" : "s"} waiting. It applies to as many as fit in one run, then stops. Press again for the rest.`
      : "Nothing is waiting to apply";
  }
  const applyMeta = $("#apply-queue-meta");
  if (applyMeta) {
    // A run that was cut short used to read here as an ordinary finish. On
    // 2026-09-09 one submitted 10 applications, was killed at its 60-minute
    // limit with 23 still queued, and this line said "Last apply: yesterday".
    const state = jobState("apply");
    const when = formatWhen(state.finished_at);
    if (state.state === "error" && state.message) {
      applyMeta.textContent = when ? `${state.message} · ${when}` : state.message;
    } else {
      applyMeta.textContent = when ? `Last apply: ${when}` : "Has not applied from here yet";
    }
    applyMeta.classList.toggle("run-meta-bad", state.state === "error");
  }
  const inboxBtn = $("#btn-inbox");
  if (inboxBtn) {
    const running = jobState("inbox").state === "running";
    inboxBtn.disabled = running;
    inboxBtn.classList.toggle("busy", running);
    inboxBtn.textContent = running ? "Reading email…" : "Update from email";
  }
  const inboxMeta = $("#inbox-meta");
  if (inboxMeta) {
    const when = formatWhen(jobState("inbox").finished_at);
    inboxMeta.textContent = when ? `Last email check: ${when}` : "Has not checked email from here yet";
  }
}

function anyJobRunning() {
  return ["scan", "apply", "inbox"].some((k) => jobState(k).state === "running");
}

function stopJobPoll() {
  if (!jobPoll) return;
  clearInterval(jobPoll);
  jobPoll = null;
}

async function refreshJobs() {
  const prev = {
    scan: jobState("scan").state,
    apply: jobState("apply").state,
    inbox: jobState("inbox").state,
  };
  await loadJobs();
  paintJobControls();
  const labels = { scan: "Search", apply: "Apply", inbox: "Email update" };
  let finished = false;
  for (const key of ["scan", "apply", "inbox"]) {
    if (prev[key] === "running" && jobState(key).state !== "running") {
      finished = true;
      if (jobState(key).state === "error") toast(`${labels[key]} hit a problem.`);
      else toast(`${labels[key]} finished. The board is updated.`);
    }
  }
  if (finished) {
    await load();
    render();
  }
  if (anyJobRunning()) startJobPoll();
  else stopJobPoll();
}

function startJobPoll() {
  if (jobPoll) return;
  jobPoll = setInterval(refreshJobs, 4000);
}

async function startJob(name) {
  if (jobState(name).state === "running") {
    toast("That job is already running.");
    return;
  }
  JOBS[name] = { ...jobState(name), state: "running", started_at: new Date().toISOString() };
  paintJobControls();
  let res;
  try {
    res = await fetch(`/api/jobs/${name}`, { method: "POST" });
  } catch (_) {
    toast("The dashboard is not running, so Search cannot start. I will try to bring it back.");
    await refreshJobs();
    return;
  }
  let payload = {};
  try { payload = await res.json(); } catch (_) { /* empty */ }
  if (res.status === 409) {
    toast("That job is already running.");
    await refreshJobs();
    return;
  }
  if (res.status === 400 && payload.error === "empty queue") {
    toast("Nothing is waiting to apply.");
    await refreshJobs();
    return;
  }
  if (!res.ok) {
    toast("Could not start that job.");
    await refreshJobs();
    return;
  }
  JOBS[name] = payload;
  paintJobControls();
  const started = {
    scan: "Search started. This usually takes 30 to 90 minutes.",
    apply: "Applying now. I'll move cards to Applied as they go through.",
    inbox: "Reading email now. I'll move cards when an employer wrote back.",
  };
  toast(started[name] || "Started.");
  startJobPoll();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ── shared pieces ────────────────────────── */
const SOURCE_LABELS = {
  "alert-email": ["email alert", "Found in a LinkedIn job-alert email"],
  "linkedin-sweep": ["LinkedIn sweep", "Found by the LinkedIn search sweep"],
  "startup-watch": ["startup watchlist", "Found on a watchlist startup's careers page"],
  "manual": ["you added", "Added at your request"],
  "yc-jobs": ["Y Combinator", "Found on the Y Combinator startup job board"],
  "wellfound": ["Wellfound", "Found on Wellfound, a startup job board"],
  "communitech": ["Communitech", "Found on the Communitech job board"],
  "networking": ["networking", "Came through your network: a referral, intro or direct approach"],
};

function sourceChip(p) {
  const [label, title] = SOURCE_LABELS[p.source] || [p.source || "unknown", "Source not recorded"];
  return `<span class="chip src src-${esc(p.source || "unknown")}" title="${esc(title)}">${esc(label)}</span>`;
}

function chips(p) {
  const items = [sourceChip(p)];
  items.push(p.easy_apply
    ? `<span class="chip easy">⚡ Easy Apply</span>`
    : `<span class="chip external">↗ company site</span>`);
  if (p.work_model) items.push(`<span class="chip">${esc(p.work_model)}</span>`);
  if (p.location) items.push(`<span class="chip">${esc(p.location)}</span>`);
  items.push(p.salary_text
    ? `<span class="chip">${esc(p.salary_text)}</span>`
    : `<span class="chip warn">comp unknown</span>`);
  if (p.company_size) items.push(`<span class="chip co-fact">👥 ${esc(p.company_size)}</span>`);
  if (p.company_funding) items.push(`<span class="chip co-fact">💰 ${esc(p.company_funding)}</span>`);
  if (p.posted_date) items.push(`<span class="chip date-fact">📅 posted ${esc(p.posted_date)}</span>`);
  if (p.applied_at) items.push(`<span class="chip date-fact applied-fact">✓ applied ${esc(p.applied_at)}</span>`);
  if (p.auto_applied) items.push(`<span class="chip auto-applied" title="Submitted automatically after a score of 4 or 5">auto-applied</span>`);
  else if (p.auto_apply_queued) items.push(`<span class="chip auto-applied" title="Score 4 or 5: waiting for the next time you press Apply queue now">queued to auto-apply</span>`);
  return `<div class="meta-row">${items.join("")}</div>`;
}

function scoreStrip(p) {
  const s = p.scores;
  return `<div class="score-strip">
    <span>int <b>${s.interests}</b></span><span>goal <b>${s.goals}</b></span>
    <span>loc <b>${s.location}</b></span><span>comp <b>${s.comp}</b></span>
  </div>`;
}

function overallBadge(p) {
  return `<div class="badges">
    <span class="score-pair"><span class="score-cap">Dream</span>
      <button class="overall-badge s${p.scores.overall}" data-editscore="${esc(p.id)}"
        title="Dream fit ${p.scores.overall}/5: how close this is to the job you want. Click to change">${p.scores.overall}</button></span>
    ${worthBadge(p)}${matchBadge(p)}
  </div>`;
}

/* Worth applying: computed by scripts/score_worth_applying.py, so it is read-only here */
function worthBadge(p, withCap = true) {
  const n = p.scores?.worth_applying;
  if (!Number.isFinite(n)) return "";
  const why = (p.score_rationale || {}).worth_applying || "";
  const badge = `<span class="worth-badge w${n}" title="Worth applying ${n}/5. ${esc(why)}">${n}</span>`;
  return withCap ? `<span class="score-pair"><span class="score-cap">Worth</span>${badge}</span>` : badge;
}

function matchBadge(p) {
  if (!Number.isFinite(p.match_pct)) return "";
  const tier = p.match_pct >= 80 ? "high" : p.match_pct >= 60 ? "mid" : "low";
  return `<span class="match-pct match-${tier}" title="How much of this job's duties your experience already covers">${p.match_pct}%</span>`;
}

/* card header: title + company on the left, badges on the right — no overlap */
function cardHead(p) {
  return `<div class="card-head">
    <div class="card-id">
      <h3><a href="#position/${esc(p.id)}">${esc(p.title)}</a></h3>
      ${companyLink(p)}
    </div>
    ${overallBadge(p)}
  </div>`;
}

/* ── review view ──────────────────────────── */
const REVIEW_BANDS = [[5, "strong match"], [4, "worth a look"], [3, "maybe"], [2, "weak"], [1, "poor fit"]];

function payCadMax(text) {
  if (!text) return null;
  const t = String(text);
  const nums = [...t.replace(/,/g, "").matchAll(/\d{4,7}/g)].map((m) => Number(m[0]));
  const ks = [...t.matchAll(/(\d{2,3})\s*[kK]\b/g)].map((m) => Number(m[1]) * 1000);
  const all = nums.concat(ks).filter((n) => n >= 20000 && n <= 800000);
  if (!all.length) return null;
  let max = Math.max(...all);
  if (/\bUSD\b|US\$/i.test(t) && !/\bCAD\b|CA\$/i.test(t)) max = Math.round(max * 1.35);
  return max;
}

function modelBucket(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return "unclear";
  if (s.includes("hybrid")) return "hybrid";
  if (s.startsWith("remote") || (/\bremote\b/.test(s) && !s.includes("on-site") && !s.includes("onsite"))) {
    return "remote";
  }
  if (s.includes("on-site") || s.includes("onsite") || s.includes("in-office") || s.startsWith("on site")) {
    return "onsite";
  }
  if (s.startsWith("unclear")) return "unclear";
  return "unclear";
}

function sizeBucket(raw) {
  const n = parseSize(raw);
  if (n < 0) return "unknown";
  if (n <= 30) return "30";
  if (n <= 100) return "100";
  if (n <= 200) return "200";
  if (n <= 1000) return "1000";
  return "1000plus";
}

function postedDaysAgo(p) {
  const t = dateKey(p.posted_date || p.found_date);
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function reviewSortVal(p, key) {
  if (key === "pay") return payCadMax(p.salary_text) ?? -1;
  if (key === "size") return parseSize(p.company_size);
  if (key === "posted") return dateKey(p.posted_date || p.found_date);
  if (key === "company") return p.company || "";
  if (key === "worth") return p.scores?.worth_applying ?? 0;
  return p.scores?.overall ?? 0;
}

function matchesReview(p) {
  const ui = LIST_UI.review;
  const q = ui.q.trim().toLowerCase();
  if (q && !hay([p.title, p.company, p.location, p.work_model, p.salary_text, p.company_size]).includes(q)) {
    return false;
  }
  if (ui.score) {
    const n = p.scores?.overall ?? 0;
    if (ui.score.endsWith("+")) {
      if (n < parseInt(ui.score, 10)) return false;
    } else if (String(n) !== ui.score) return false;
  }
  if (ui.model && modelBucket(p.work_model) !== ui.model) return false;
  if (ui.pay === "unknown") {
    if (payCadMax(p.salary_text) !== null) return false;
  } else if (ui.pay) {
    const cad = payCadMax(p.salary_text);
    if (cad === null) return false;
    const { floor, bonus } = payBands();
    if (ui.pay === "top" && cad < (bonus || floor)) return false;
    if (ui.pay === "mid" && (cad < floor || (bonus && cad >= bonus))) return false;
    if (ui.pay === "under" && cad >= floor) return false;
  }
  if (ui.size && sizeBucket(p.company_size) !== ui.size) return false;
  if (ui.posted) {
    const days = postedDaysAgo(p);
    if (days === null) return false;
    if (ui.posted === "older") {
      if (days < 14) return false;
    } else if (days > Number(ui.posted)) return false;
  }
  if (ui.easy === "yes" && !p.easy_apply) return false;
  if (ui.easy === "no" && p.easy_apply) return false;
  return true;
}

function visibleReview() {
  const ui = LIST_UI.review;
  const rows = reviewQueue().filter(matchesReview);
  const sorted = rows.slice().sort((a, b) => compareList(a, b, "review", reviewSortVal));
  if (ui.sort === "score") {
    return [5, 4, 3, 2, 1].flatMap((n) => sorted.filter((p) => p.scores.overall === n));
  }
  return sorted;
}

function reviewFiltersOn() {
  const ui = LIST_UI.review;
  return Boolean(ui.q || ui.score || ui.model || ui.pay || ui.size || ui.posted || ui.easy);
}

function opt(value, label, current) {
  return `<option value="${esc(value)}"${current === value ? " selected" : ""}>${esc(label)}</option>`;
}

function payOptions(current) {
  const { floor, bonus, cur } = payBands();
  if (!floor) return "";
  const parts = [];
  if (bonus && bonus > floor) {
    parts.push(opt("top", `${kFmt(bonus)}+ ${cur}`, current));
    parts.push(opt("mid", `${kFmt(floor)} to ${kFmt(bonus)} ${cur}`, current));
  } else {
    parts.push(opt("top", `${kFmt(floor)}+ ${cur}`, current));
  }
  parts.push(opt("under", `Under ${kFmt(floor)} ${cur}`, current));
  return parts.join("");
}

function reviewToolbar() {
  const ui = LIST_UI.review;
  return `<div class="listbar review-bar" data-listbar="review">
    <input class="list-q" data-listq type="search" value="${esc(ui.q)}"
      placeholder="Find a company, title, or city" autocomplete="off">
    <label class="list-sort-label">Score
      <select class="list-select" data-review="score">
        ${opt("", "Any score", ui.score)}
        ${opt("4+", "4 and 5", ui.score)}
        ${opt("3+", "3 and up", ui.score)}
        ${opt("5", "5 only", ui.score)}
        ${opt("4", "4 only", ui.score)}
        ${opt("3", "3 only", ui.score)}
        ${opt("2", "2 only", ui.score)}
        ${opt("1", "1 only", ui.score)}
      </select>
    </label>
    <label class="list-sort-label">Work model
      <select class="list-select" data-review="model">
        ${opt("", "Any model", ui.model)}
        ${opt("remote", "Remote", ui.model)}
        ${opt("hybrid", "Hybrid", ui.model)}
        ${opt("onsite", "On-site", ui.model)}
        ${opt("unclear", "Unclear", ui.model)}
      </select>
    </label>
    <label class="list-sort-label">Pay
      <select class="list-select" data-review="pay">
        ${opt("", "Any pay", ui.pay)}
        ${payOptions(ui.pay)}
        ${opt("unknown", "Pay not listed", ui.pay)}
      </select>
    </label>
    <label class="list-sort-label">Company size
      <select class="list-select" data-review="size">
        ${opt("", "Any size", ui.size)}
        ${opt("30", "Up to 30 people", ui.size)}
        ${opt("100", "31 to 100", ui.size)}
        ${opt("200", "101 to 200", ui.size)}
        ${opt("1000", "201 to 1,000", ui.size)}
        ${opt("1000plus", "1,000+", ui.size)}
        ${opt("unknown", "Size unknown", ui.size)}
      </select>
    </label>
    <label class="list-sort-label">Posted
      <select class="list-select" data-review="posted">
        ${opt("", "Any date", ui.posted)}
        ${opt("3", "Last 3 days", ui.posted)}
        ${opt("7", "Last 7 days", ui.posted)}
        ${opt("14", "Last 14 days", ui.posted)}
        ${opt("older", "Older than 14 days", ui.posted)}
      </select>
    </label>
    <label class="list-sort-label">Apply
      <select class="list-select" data-review="easy">
        ${opt("", "Any apply path", ui.easy)}
        ${opt("yes", "Easy Apply", ui.easy)}
        ${opt("no", "Company site", ui.easy)}
      </select>
    </label>
    <label class="list-sort-label">Sort
      <select class="list-select" data-listsort>
        ${opt("score", "Dream fit", ui.sort)}
        ${opt("worth", "Worth applying", ui.sort)}
        ${opt("posted", "Date posted", ui.sort)}
        ${opt("pay", "Pay", ui.sort)}
        ${opt("size", "Company size", ui.sort)}
        ${opt("company", "Company name", ui.sort)}
      </select>
    </label>
    <button type="button" class="btn small" data-listdir>${ui.dir === "asc" ? "Low → high" : "High → low"}</button>
    ${reviewFiltersOn() ? `<button type="button" class="btn small" data-listclear>Clear filters</button>` : ""}
    <span class="list-meta" data-listmeta></span>
  </div>`;
}

function reviewResultsHtml(shown, total) {
  if (!shown.length) {
    return `<div class="empty"><h2>Nothing matches</h2>
      <p>No Review cards fit these filters. Clear them to see all ${total}.</p>
      <p class="empty-action"><button class="btn" data-listclear="review">Clear filters</button></p></div>`;
  }
  if (LIST_UI.review.sort !== "score") {
    return `<section class="score-band">
      <div class="band-head">
        <h2>Filtered</h2>
        <span class="band-label">${shown.length} of ${total}</span>
      </div>
      <div class="cards">${shown.map(reviewCard).join("")}</div>
    </section>`;
  }
  return REVIEW_BANDS.map(([n, label]) => {
    const group = shown.filter((p) => p.scores.overall === n);
    if (!group.length) return "";
    const allSelected = group.every((p) => SELECTED.has(p.id));
    return `<section class="score-band">
      <div class="band-head">
        <h2>Score ${n}</h2>
        <span class="band-label">${label} · ${group.length}</span>
        <button class="btn tiny band-select" data-selectband="${n}">${allSelected ? "Deselect all" : "Select all"}</button>
      </div>
      <div class="cards">${group.map(reviewCard).join("")}</div>
    </section>`;
  }).join("");
}

function paintReview() {
  const total = reviewQueue().length;
  const shown = visibleReview();
  const dest = $("#review-results");
  if (dest) dest.innerHTML = reviewResultsHtml(shown, total);
  paintListMeta("review", shown.length, total);
}

function renderReview(root) {
  const queue = reviewQueue();
  if (!queue.length) {
    const never = !DB.positions.length;
    root.innerHTML = never
      ? `<div class="empty"><h2>No jobs yet</h2>
      <p>Your first search runs at ${esc(searchTimesText())}. If you don't want to wait, press Search now. It takes 30 to 90 minutes, and you can close this page meanwhile.</p>
      <p class="empty-action"><button class="btn primary" data-runjob="scan">Search now</button> <a class="btn" href="#guide">How this works</a></p></div>`
      : `<div class="empty"><h2>All caught up</h2>
      <p>${esc(lastSearchLabel())}. The next search runs at ${esc(searchTimesText())}. Jobs you agreed with are in the Pipeline tab.</p>
      <p class="empty-action"><button class="btn primary" data-runjob="scan">Search now</button></p></div>`;
    return;
  }
  root.innerHTML = `${reviewToolbar()}<div id="review-results"></div>`;
  paintReview();
}

function reviewCard(p) {
  return `<article class="card${SELECTED.has(p.id) ? " selected" : ""}" data-id="${esc(p.id)}">
    ${selectBox(p)}
    ${cardHead(p)}
    ${chips(p)}
    ${scoreStrip(p)}
    <div class="card-actions">
      <button class="btn agree" data-agree="${esc(p.id)}">Agree → pipeline</button>
      <button class="btn disagree" data-disagree="${esc(p.id)}">Disagree</button>
      <a class="btn" href="${safeUrl(p.url)}" target="_blank" rel="noopener">Posting ↗</a>
    </div>
    <div class="reject-slot"></div>
  </article>`;
}

function openRejectPanel(container, id) {
  const slot = $(".reject-slot", container);
  slot.innerHTML = `<div class="reject-panel">
    <p>What was off? Pick all that apply. The search learns from this.</p>
    <div class="reason-chips">${REJECT_REASONS.map(([k, label]) =>
      `<span class="chip" data-reason="${k}">${label}</span>`).join("")}</div>
    <textarea placeholder="Optional note…"></textarea>
    <div class="card-actions">
      <button class="btn primary" data-confirmreject="${id}">Confirm</button>
      <button class="btn" data-cancelreject>Cancel</button>
    </div>
  </div>`;
}

/* ── pipeline kanban view ─────────────────── */
/* Deliberately sparse: title, company, the two dates that tell you where a
   position sits in time, and the score. Everything else lives on the detail
   page — the board is for scanning, not reading. */
function renderBoard(root) {
  const columns = STAGES.map(([key, label]) => {
    const rows = DB.positions.filter((p) => p.status === key);
    return `<section class="kb-col" data-stage="${key}">
      <div class="kb-colhead"><span>${label}</span><span class="kb-count">${rows.length}</span></div>
      ${rows.length
        ? `<div class="kb-stack">${rows.map((p) => kanbanCard(p, key === "interested")).join("")}</div>`
        : `<p class="kb-empty">Nothing here</p>`}
    </section>`;
  }).join("");
  const queued = Number(jobState("apply").queued) || 0;
  root.innerHTML = `<div class="runbar">
      <div class="runbar-actions">
        <div class="run-action">
          <button class="btn agree" id="btn-apply-queue" data-runjob="apply"
            title="Apply to every role waiting in the queue, right now">Apply queue now${queued ? ` (${queued})` : ""}</button>
          <span class="run-meta" id="apply-queue-meta"></span>
        </div>
        <div class="run-action">
          <button class="btn" id="btn-inbox" data-runjob="inbox"
            title="Read recruiting email and move cards when an employer wrote back">Update from email</button>
          <span class="run-meta" id="inbox-meta"></span>
        </div>
      </div>
    </div>
    <div class="kanban">${columns}</div>`;
}

/* dates are the only metadata on the card, so they have to read at a glance:
   "posted" anchors how stale a listing is, "applied" how long you've waited */
function kanbanDates(p) {
  const bits = [];
  if (p.posted_date) bits.push(`<span title="Date the role was posted">posted ${esc(shortDate(p.posted_date))}</span>`);
  if (p.applied_at) bits.push(`<span class="kb-applied" title="Date you applied">applied ${esc(shortDate(p.applied_at))}</span>`);
  if (!bits.length) return "";
  return `<div class="kb-dates">${bits.join("")}</div>`;
}

/* "2026-08-04" → "4 Aug" — the year is noise on a board covering weeks */
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return String(iso);
  const label = `${d.getDate()} ${d.toLocaleString("en-CA", { month: "short" })}`;
  return d.getFullYear() === new Date().getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/* the board shows the overall score alone — match % is a second number competing
   for the same glance, and it's one click away on the detail page */
function scoreOnlyBadge(p) {
  return `<span class="badges"><button class="overall-badge s${p.scores.overall}" data-editscore="${esc(p.id)}"
    title="Dream fit ${p.scores.overall}/5 · match ${Number.isFinite(p.match_pct) ? p.match_pct + "%" : "n/a"} · click to change">${p.scores.overall}</button>${worthBadge(p, false)}</span>`;
}

function autoApplyFlag(p) {
  if (p.auto_applied) {
    if ((p.apply_requested && p.apply_result) || (!p.applied_at && p.apply_result)) {
      return `<p class="kb-flag needs-you">Auto-applied · needs you</p>`;
    }
    return `<p class="kb-flag auto-applied">Auto-applied</p>`;
  }
  if (p.auto_apply_queued) {
    if (p.apply_result) return `<p class="kb-flag needs-you">Auto-apply · needs you</p>`;
    return `<p class="kb-flag auto-applied">Queued to auto-apply</p>`;
  }
  return "";
}

function outreachFlag(p) {
  const o = p.stakeholder_outreach;
  if (!o || !o.status || o.status === "none") return "";
  if (o.status === "sent") return `<p class="kb-flag outreach-sent">Message sent</p>`;
  if (o.status === "send_requested" || o.send_requested) {
    return `<p class="kb-flag outreach-queued">Send queued</p>`;
  }
  if (o.status === "blocked") return `<p class="kb-flag needs-you">Message blocked</p>`;
  if (o.status === "ready" || o.status === "researching") {
    return `<p class="kb-flag outreach-ready">Message ready</p>`;
  }
  return "";
}

function kanbanCard(p, showApply) {
  // a queued or blocked apply request is the one thing worth interrupting the
  // board's calm for, so it gets a line of its own
  let flag = autoApplyFlag(p);
  if (!flag && showApply && p.apply_requested) {
    flag = `<p class="kb-flag${p.apply_result ? " needs-you" : ""}">${p.apply_result ? "Needs you" : "Queued to apply"}</p>`;
  }
  flag += outreachFlag(p);
  return `<article class="kb-card${SELECTED.has(p.id) ? " selected" : ""}" data-id="${esc(p.id)}">
    ${selectBox(p)}
    <div class="kb-top">
      <h3 title="${esc(p.title)}"><a href="#position/${esc(p.id)}">${esc(p.title)}</a></h3>
      ${scoreOnlyBadge(p)}
    </div>
    ${companyLink(p)}
    ${kanbanDates(p)}
    ${flag}
    ${showApply && !p.apply_requested ? `<div class="kb-actions">${applyAction(p)}</div>` : ""}
  </article>`;
}

/* one-card Apply only queues the role. Apply queue now on this board starts the
   apply job itself. There is no schedule behind it any more: it has been on
   demand since 2026-09-08, so nothing is submitted while you are not looking. */
function applyAction(p) {
  if (p.apply_requested && p.apply_result) {
    return `<span class="apply-hint">Needs you: open the card</span>`;
  }
  if (p.apply_requested) {
    return `<span class="apply-hint">Queued. Press Apply queue now to send.</span>`;
  }
  return `<button class="btn agree small" data-requestapply="${esc(p.id)}"
    title="Add to the apply queue. A tailored resume is made first if needed.">Apply</button>`;
}

/* skips forward past anything already actioned, so it always lands on something
   still in the review queue */
function nextButton(p) {
  const ordered = reviewQueueInDisplayOrder();
  if (!ordered.length) return "";
  const i = ordered.findIndex((x) => x.id === p.id);
  // once a position is actioned it leaves the queue, so fall back to the top of
  // what's left rather than stranding the page with no way forward
  const next = i >= 0 ? ordered[i + 1] : ordered[0];
  if (!next) {
    return ordered.length > 1
      ? `<a class="btn" href="#position/${esc(ordered[0].id)}" title="Back to the top of the queue">Next: wrap to start ↻</a>`
      : "";
  }
  return `<a class="btn" href="#position/${esc(next.id)}"
    title="${esc(next.company)}, Dream fit ${next.scores.overall}">Next ${esc(next.company)} →</a>`;
}


/* Scraped JDs arrive as one unbroken line with all whitespace collapsed, so
   structure has to be re-derived: known section headings become headings, and
   "Label: detail" runs inside a section become list items. */
const JD_HEADINGS = [
  "About the Company", "About the Role", "About Us", "About the Team", "About",
  "Who We Are", "Who You Are", "The Opportunity", "The Role", "Overview",
  "What You Will Do", "What You'll Do", "What you will do", "What you'll do",
  "Responsibilities", "Key Responsibilities", "Your Responsibilities",
  "What You Bring", "What you bring", "What We're Looking For", "What we're looking for",
  "Qualifications", "Required Qualifications", "Requirements", "Minimum Qualifications",
  "Preferred Qualifications", "Preferred", "Nice to have", "Bonus Points",
  "Benefits", "Perks", "What We Offer", "What we offer", "Compensation",
  "Why Join Us", "Why join us", "How To Apply", "How to Apply",
  "Equal Opportunity", "Our Values", "Remote Work and Location", "Location",
];

function formatJD(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return `<p class="row-empty">No description captured</p>`;

  const headingRe = new RegExp(
    "(?=\\s(?:" + JD_HEADINGS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?=[\\s:.]))",
    "g");
  const chunks = text.split(headingRe).map((c) => c.trim()).filter(Boolean);

  return chunks.map((chunk) => {
    const head = JD_HEADINGS.find((h) => chunk.toLowerCase().startsWith(h.toLowerCase()));
    let body = chunk;
    let out = "";
    if (head) {
      body = chunk.slice(head.length).replace(/^[\s:.•-]+/, "");
      out += `<h5 class="jd-head">${esc(head)}</h5>`;
    }
    if (!body) return out;

    // "Lead the team: Manage, coach..." style runs are the JD's real bullets
    const bulletRe = /(?:^|\s)([A-Z][A-Za-z0-9'&/()\- ]{2,44}):\s/g;
    const marks = [];
    let m;
    while ((m = bulletRe.exec(body)) !== null) marks.push({ at: m.index, label: m[1], end: m.index + m[0].length });

    if (marks.length >= 3) {
      const lead = body.slice(0, marks[0].at).trim();
      if (lead) out += `<p>${esc(lead)}</p>`;
      out += "<ul class='jd-list'>" + marks.map((mk, i) => {
        const stop = i + 1 < marks.length ? marks[i + 1].at : body.length;
        const detail = body.slice(mk.end, stop).trim().replace(/[;,]$/, "");
        return `<li><b>${esc(mk.label)}:</b> ${esc(detail)}</li>`;
      }).join("") + "</ul>";
      return out;
    }

    // otherwise break the wall into readable paragraphs on sentence boundaries
    const sentences = body.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [body];
    let buf = [], paras = [];
    sentences.forEach((s) => {
      buf.push(s.trim());
      if (buf.join(" ").length > 320) { paras.push(buf.join(" ")); buf = []; }
    });
    if (buf.length) paras.push(buf.join(" "));
    out += paras.map((p) => `<p>${esc(p)}</p>`).join("");
    return out;
  }).join("");
}

/* ── detail view ──────────────────────────── */
function renderDetail(root, id) {
  const p = DB.positions.find((x) => x.id === id);
  if (!p) { root.innerHTML = `<div class="empty"><h2>Not found</h2></div>`; return; }
  const inPipeline = p.status !== "review" && p.status !== "rejected";
  root.innerHTML = `<div class="detail">
    <a class="back" href="#${inPipeline ? "board" : "review"}">← back</a>
    <div class="detail-head">
      <div class="detail-id">
        <h2>${esc(p.title)}</h2>
        ${companyLink(p)}
      </div>
      <div class="detail-controls">
        ${p.status === "review" ? `
          <button class="btn agree" data-agree="${esc(p.id)}">Agree → pipeline</button>
          <button class="btn disagree" data-disagree="${esc(p.id)}">Disagree</button>` : ""}
        ${nextButton(p)}
        <a class="btn primary posting-link" href="${safeUrl(p.url)}" target="_blank" rel="noopener">Open posting ↗</a>
        <select class="stage-select" data-stagefor="${esc(p.id)}" title="Stage">
          ${["review", ...STAGES.map(([k]) => k), "rejected"].map((k) =>
            `<option value="${k}" ${p.status === k ? "selected" : ""}>${STAGE_LABEL[k] || k}</option>`).join("")}
        </select>
        ${overallBadge(p)}
      </div>
    </div>
    ${chips(p)}
    <div class="reject-slot"></div>
    <div style="height:18px"></div>
    <div class="detail-grid">
      <div>
        ${applyPanel(p)}
        ${outreachPanel(p)}
        ${resumeCheckLine(p)}
        ${fitPanel(p)}
        ${diaryPanel(p)}
        ${companyPanel(p)}
        ${p.research_md ? `<div class="panel"><h4>Research</h4><div class="research">${mdToHtml(p.research_md)}</div></div>` : ""}
        <div class="panel"><h4>Job description</h4><div class="jd">${formatJD(p.jd_text || p.jd_summary)}</div></div>
      </div>
      <div>
        <div class="panel"><h4>Scores (click a dot to change)</h4>
          <div class="score-rows">${["interests", "goals", "location", "comp", "overall"].map((dim) => {
            const why = esc((p.score_rationale || {})[dim] || "");
            return `<div class="score-row">
              <div class="score-row-top">
                <span class="dim">${dim === "overall" ? "dream fit" : dim}</span>
                <span class="dots">${[1, 2, 3, 4, 5].map((n) =>
                  `<button class="${p.scores[dim] >= n ? "on" : ""}" data-setscore="${esc(p.id)}|${dim}|${n}" title="${dim} = ${n}"></button>`).join("")}</span>
              </div>
              ${why ? `<p class="why">${why}</p>` : ""}
            </div>`;
          }).join("")}${Number.isFinite(p.scores?.worth_applying) ? `<div class="score-row">
              <div class="score-row-top">
                <span class="dim">worth applying</span>
                <span class="dots">${[1, 2, 3, 4, 5].map((n) =>
                  `<span class="dot-ro ${p.scores.worth_applying >= n ? "on" : ""}"></span>`).join("")}</span>
              </div>
              <p class="why">${esc((p.score_rationale || {}).worth_applying || "")} Calculated from the posting, so it updates itself.</p>
            </div>` : ""}</div>
        </div>
        <div class="panel"><h4>Details</h4>
          <dl class="kv">
            ${!p.resume_path ? `<dt>resume</dt><dd>${p.resume_requested
              ? `on its way: ready after the next search (or ask Claude now)`
              : `<button class="btn small" data-requestresume="${esc(p.id)}">Prepare tailored resume</button>`}</dd>` : ""}
            ${p.company_url ? `<dt>company</dt><dd><a href="${safeUrl(p.company_url)}" target="_blank" rel="noopener">${esc(p.company_url)}</a></dd>` : ""}
            ${p.resume_path ? `<dt>resume</dt><dd><a href="/files/${encodeURIComponent(p.resume_path)}" target="_blank">tailored PDF ↗</a></dd>` : ""}
            <dt>found</dt><dd>${esc(p.found_date)}</dd>
            ${p.posted_date ? `<dt>posted</dt><dd>${esc(p.posted_date)}</dd>` : ""}
            <dt>source</dt><dd>${esc(p.source)}</dd>
            ${p.score_overridden ? `<dt>scores</dt><dd>edited by you</dd>` : ""}
          </dl>
        </div>
      </div>
    </div>
  </div>`;
}

function applyPanel(p) {
  const ap = p.apply_process;
  if (!ap && !p.applied_at && !p.auto_applied && !p.apply_requested) return "";
  const methodLabel = { easy_apply: "⚡ LinkedIn Easy Apply", ats: "company application form", careers_form: "careers page form", email: "email", unknown: "not sure yet" }[ap?.method] || "not sure yet";
  const minAuto = Number(DB.profile?.auto_apply?.min_overall) || 4;
  let action = "";
  let autoLabel = "";
  if (p.auto_applied) {
    autoLabel = `<p class="apply-queued">Applied automatically (Dream fit ${minAuto} or higher)</p>`;
  } else if (p.auto_apply_queued) {
    autoLabel = `<p class="apply-queued">In the apply queue because it scored ${minAuto} or higher. It goes out the next time you press Apply queue now.</p>`;
  }
  const applyResult = typeof p.apply_result === "string" ? p.apply_result : "";
  if (p.applied_at) {
    action = `${autoLabel}<p class="apply-done">✓ Applied ${esc(p.applied_at)}${applyResult ? `: ${esc(applyResult)}` : ""}</p>`;
  } else if (p.apply_requested && applyResult) {
    action = `${autoLabel}<p class="apply-manual"><b>Needs you:</b> ${esc(applyResult)}</p>
      <p class="apply-hint">Once you've applied yourself, set this job's stage to "Applied" and it will stop asking.</p>`;
  } else if (p.apply_requested) {
    action = `${autoLabel}<p class="apply-queued">Application queued. It goes out the next time you press Apply queue now, and this page will show the confirmation.</p>`;
  } else if (ap?.can_auto) {
    action = `<button class="btn agree" data-requestapply="${esc(p.id)}">Apply for me</button>
      <span class="apply-hint">${p.resume_path ? "uses the tailored resume" : "a tailored resume will be generated first"}</span>`;
  } else if (ap) {
    action = `<p class="apply-manual">Needs you: ${esc(ap.manual_reason || "this one has to be done by hand")}.</p>`;
  }
  return `<div class="panel"><h4>How to apply: ${esc(methodLabel)}${ap ? (ap.can_auto ? " · can be done for you" : " · you do this one") : ""}</h4>
    ${ap?.summary ? `<p class="apply-summary">${esc(ap.summary)}</p>` : ""}
    ${action}
  </div>`;
}

function outreachPanel(p) {
  const score = Number((p.scores || {}).overall || 0);
  const applied = p.applied_at || ["applied", "screen", "interview", "offer", "ongoing"].includes(p.status);
  if (score < 4 || !applied) return "";
  const o = p.stakeholder_outreach;
  if (!o || !o.status || o.status === "none") {
    return `<div class="panel outreach-panel">
      <h4>Hiring people</h4>
      <p class="muted">Find the hiring manager or recruiter and draft a short note to them. Nothing is sent until you press Send.</p>
      <button class="btn agree" data-prepareoutreach="${esc(p.id)}">Prepare message</button>
    </div>`;
  }
  const people = o.people || [];
  const peopleHtml = people.length
    ? `<ul class="outreach-people">${people.map((person) => `
        <li class="outreach-person">
          <p class="outreach-name">${person.linkedin_url
            ? `<a href="${safeUrl(person.linkedin_url)}" target="_blank" rel="noopener">${esc(person.name)}</a>`
            : esc(person.name)}</p>
          <p class="outreach-title">${esc(person.title || person.role || "")}</p>
          ${person.summary ? `<p class="outreach-summary">${esc(person.summary)}</p>` : ""}
          ${person.email ? `<p class="outreach-email">${esc(person.email)}</p>` : ""}
        </li>`).join("")}</ul>`
    : `<p class="muted">The posting doesn't name a hiring manager or recruiter. They'll be looked up on LinkedIn before anything is sent.</p>`;
  let statusLine = "";
  let action = "";
  if (o.status === "sent") {
    const who = (o.sent_to || []).join(", ");
    statusLine = `<p class="apply-done">Message sent${o.sent_via ? ` via ${esc(o.sent_via)}` : ""}${o.sent_at ? ` · ${esc(shortDate(o.sent_at))}` : ""}${who ? ` · ${esc(who)}` : ""}</p>`;
  } else if (o.status === "send_requested" || o.send_requested) {
    statusLine = `<p class="apply-queued">Ready to send. It goes out on LinkedIn (or by email) the next time you press Apply queue now.</p>`;
  } else if (o.status === "blocked") {
    statusLine = `<p class="apply-manual">${esc(o.blocked_reason || "Could not send.")}</p>`;
    action = `<button class="btn agree" data-sendoutreach="${esc(p.id)}">Try send again</button>`;
  } else {
    action = `<button class="btn agree" data-sendoutreach="${esc(p.id)}">Send this message</button>
      <button class="btn small" data-copyoutreach="${esc(p.id)}">Copy</button>`;
  }
  return `<div class="panel outreach-panel">
    <h4>Hiring people</h4>
    ${peopleHtml}
    ${o.blocked_reason && o.status === "ready" ? `<p class="muted">${esc(o.blocked_reason)}</p>` : ""}
    <label class="outreach-msg-label" for="outreach-msg-${esc(p.id)}">Message</label>
    <textarea id="outreach-msg-${esc(p.id)}" class="outreach-msg" data-outreach-msg="${esc(p.id)}" rows="3">${esc(o.message || "")}</textarea>
    ${statusLine}
    <div class="outreach-actions">${action}</div>
  </div>`;
}

function resumeCheckLine(p) {
  const c = p.resume_check;
  if (!c) return "";
  const label = c.ok
    ? "Resume checked against the posting"
    : (c.fixed ? "Resume updated to match the posting" : "Resume checked. A few things the posting asks for aren't in your experience, so they were left off.");
  return `<p class="resume-check">${esc(label)}</p>`;
}

function companyMemory(name) {
  const key = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!key) return null;
  const rows = DB.companies || [];
  return rows.find((c) => c.key === key)
    || rows.find((c) => key.includes(c.key) || (c.key && c.key.includes(key)));
}

function companyPanel(p) {
  const mem = companyMemory(p.company);
  if (!mem || p.research_md) return "";
  if (!mem.summary && !mem.size && !mem.funding) return "";
  return `<div class="panel"><h4>Company</h4>
    ${mem.summary ? `<p>${esc(mem.summary)}</p>` : ""}
    <p class="muted">${[mem.size, mem.funding].filter(Boolean).map(esc).join(" · ")}</p>
  </div>`;
}

function diaryTypeLabel(type) {
  return ({
    applied: "Applied",
    email: "Email",
    screen: "Screen",
    interview: "Interview",
    offer: "Offer",
    rejection: "They said no",
    note: "Note",
    whisper: "Meeting notes",
    status: "Status",
    outreach: "Outreach",
  })[type] || type;
}

function diaryPanel(p) {
  const events = [...(p.events || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const items = events.length
    ? `<ol class="diary">${events.map((e) => `<li class="diary-item t-${esc(e.type)}">
        <div class="diary-at">${esc(shortDate(e.at))}</div>
        <div>
          <p class="diary-title"><span class="diary-type">${esc(diaryTypeLabel(e.type))}</span> ${esc(e.title || "")}</p>
          ${e.detail ? `<p class="diary-detail">${esc(e.detail)}</p>` : ""}
        </div>
      </li>`).join("")}</ol>`
    : `<p class="row-empty">Nothing logged yet. Email, meeting notes, and status changes land here.</p>`;
  return `<div class="panel"><h4>Diary</h4>
    ${items}
    <form class="diary-add" data-diary="${esc(p.id)}">
      <textarea name="note" rows="2" placeholder="Add a note" required></textarea>
      <button class="btn small" type="submit">Add note</button>
    </form>
  </div>`;
}

function fitPanel(p) {
  const fit = p.fit_analysis;
  if (!fit || (!fit.strengths?.length && !fit.gaps?.length)) return "";
  const li = (items) => items.map((s) => `<li>${esc(s)}</li>`).join("");
  return `<div class="panel"><h4>How you fit${Number.isFinite(p.match_pct) ? ` (${p.match_pct}% match)` : ""}</h4>
    ${fit.strengths?.length ? `<p class="fit-label strong-label">Why you're strong</p><ul class="fit-list fit-strong">${li(fit.strengths)}</ul>` : ""}
    ${fit.gaps?.length ? `<p class="fit-label gap-label">What you'd need to work on</p><ul class="fit-list fit-gap">${li(fit.gaps)}</ul>` : ""}
  </div>`;
}

/* minimal markdown → html (headers, bold, links, lists, paragraphs) */
function mdToHtml(md) {
  const lines = esc(md).split("\n");
  let html = "", inList = false;
  const inline = (s) => s
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    if (h) html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

/* ── list sort + filter (Startups, Archive, Screened out) ─ */
/* Headcount from free text such as "~38,000 employees", "Ideal 51-200 employees
   (founded 1985)" or "LinkedIn 51-200". Reads the first number tied to a people
   word, so years, office counts and parent-company figures later in the text do
   not win. -1 when the text gives no headcount. */
function parseSize(raw) {
  const s = String(raw || "").toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1");
  if (/tens of thousands|thousands of/.test(s)) return 10000;
  const people = s.match(
    /(\d+)\s*(\+?)\s*(?:(?:-|to)\s*(\d+)\s*\+?\s*)?(?:full-time\s+)?(?:employees|people|staff|team members|ppl|persons?|fte|headcount)\b/);
  if (people) return people[3] ? Number(people[3]) : Number(people[1]) + (people[2] ? 1 : 0);
  const under = s.match(/<\s*(\d+)/);
  if (under) return Number(under[1]);
  const linkedin = s.match(/linkedin\D{0,12}(\d+)\s*(?:-\s*(\d+)|\+)/);
  if (linkedin) return Number(linkedin[2] || linkedin[1]);
  const lead = s.match(/^\D{0,3}(\d+)/);
  return lead ? Number(lead[1]) : -1;
}

function dateKey(raw) {
  if (!raw) return 0;
  const t = Date.parse(String(raw).slice(0, 10));
  return Number.isNaN(t) ? 0 : t;
}

function hay(parts) {
  return parts.map((p) => String(p || "").toLowerCase()).join(" ");
}

function uniqueCities(rows, getCity) {
  return [...new Set(rows.map(getCity).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function sortMarker(view, key) {
  const ui = LIST_UI[view];
  if (ui.sort !== key) return "";
  return ui.dir === "asc" ? " ↑" : " ↓";
}

function selectedCities(ui) {
  if (Array.isArray(ui.cities)) return ui.cities;
  return ui.city ? [ui.city] : [];
}

function cityButtonLabel(selected) {
  if (!selected.length) return "All cities";
  if (selected.length === 1) return selected[0];
  if (selected.length === 2) return `${selected[0]} + ${selected[1]}`;
  return `${selected.length} cities`;
}

function cityFilterHtml(view, cities) {
  if (!cities.length) return "";
  const selected = selectedCities(LIST_UI[view]);
  const items = cities.map((c) => {
    const on = selected.includes(c);
    return `<label class="city-opt">
      <input type="checkbox" data-cityopt="${esc(c)}"${on ? " checked" : ""}>
      <span>${esc(c)}</span>
    </label>`;
  }).join("");
  return `<div class="city-filter" data-cityfilter="${esc(view)}">
    <button type="button" class="list-select city-toggle" data-citytoggle
      aria-haspopup="listbox" aria-expanded="false">${esc(cityButtonLabel(selected))}</button>
    <div class="city-menu" hidden>
      <label class="city-opt city-all">
        <input type="checkbox" data-cityall${!selected.length ? " checked" : ""}>
        <span>All cities</span>
      </label>
      ${items}
    </div>
  </div>`;
}

function setCityMenuOpen(filter, open) {
  const btn = $("[data-citytoggle]", filter);
  const menu = $(".city-menu", filter);
  if (!btn || !menu) return;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  menu.hidden = !open;
}

function paintCityFilter(view) {
  const filter = document.querySelector(`[data-cityfilter="${view}"]`);
  if (!filter) return;
  const ui = LIST_UI[view];
  const selected = selectedCities(ui);
  const btn = $("[data-citytoggle]", filter);
  if (btn) btn.textContent = cityButtonLabel(selected);
  const all = $("[data-cityall]", filter);
  if (all) all.checked = !selected.length;
  filter.querySelectorAll("[data-cityopt]").forEach((box) => {
    box.checked = selected.includes(box.dataset.cityopt);
  });
}

function applyCityChange(view, { all, city, checked }) {
  const ui = LIST_UI[view];
  if (all) {
    ui.cities = [];
  } else if (city) {
    const set = new Set(selectedCities(ui));
    if (checked) set.add(city);
    else set.delete(city);
    ui.cities = [...set];
  }
  paintCityFilter(view);
  refreshListView(view, false);
}

function listToolbar(view, { cities, sorts, placeholder, extras }) {
  const ui = LIST_UI[view];
  const sortOpts = sorts.map(([k, label]) =>
    `<option value="${k}"${ui.sort === k ? " selected" : ""}>${label}</option>`).join("");
  const dirLabel = ui.dir === "asc" ? "A → Z / oldest" : "Z → A / newest";
  const extra = extras || "";
  const filtered = Boolean(
    ui.q || ui.reason || ui.source
    || (ui.score && view !== "review")
    || (ui.model && view !== "review")
    || selectedCities(ui).length
  );
  return `<div class="listbar" data-listbar="${view}">
    <input class="list-q" data-listq type="search" value="${esc(ui.q)}"
      placeholder="${esc(placeholder)}" autocomplete="off">
    ${cityFilterHtml(view, cities || [])}
    ${extra}
    <label class="list-sort-label">Sort
      <select class="list-select" data-listsort>${sortOpts}</select>
    </label>
    <button type="button" class="btn small" data-listdir>${dirLabel}</button>
    ${filtered ? `<button type="button" class="btn small" data-listclear>Clear filters</button>` : ""}
    <span class="list-meta" data-listmeta></span>
  </div>`;
}

function applyListQuery(rows, view, getHay, getCity) {
  const ui = LIST_UI[view];
  const q = ui.q.trim().toLowerCase();
  const cities = selectedCities(ui);
  return rows.filter((row) => {
    if (cities.length && !cities.includes(getCity(row))) return false;
    if (q && !getHay(row).includes(q)) return false;
    return true;
  });
}

function compareList(a, b, view, get) {
  const ui = LIST_UI[view];
  const dir = ui.dir === "asc" ? 1 : -1;
  const av = get(a, ui.sort);
  const bv = get(b, ui.sort);
  if (typeof av === "number" && typeof bv === "number") {
    if (av !== bv) return (av - bv) * dir;
  } else {
    const cmp = String(av || "").localeCompare(String(bv || ""), undefined, { sensitivity: "base" });
    if (cmp) return cmp * dir;
  }
  return String(get(a, "name") || get(a, "company") || "").localeCompare(
    String(get(b, "name") || get(b, "company") || ""),
    undefined,
    { sensitivity: "base" }
  );
}

function refreshListView(view, remount) {
  const root = $("#view");
  if (!root) return;
  if (view === "review") {
    if (remount) renderReview(root);
    else paintReview();
    renderBulkBar();
    return;
  }
  if (view === "startups") {
    if (remount) renderStartups(root);
    else paintStartups();
    return;
  }
  if (view === "ignored") {
    if (remount) renderIgnored(root);
    else paintIgnored();
    return;
  }
  if (view === "archive") {
    if (remount) renderArchive(root);
    else paintArchive();
    return;
  }
  if (view === "rejected") {
    if (remount) paintRejectedChrome();
    else paintRejectedLedger();
  }
}

function resetListView(view) {
  const ui = LIST_UI[view];
  if (!ui) return;
  ui.q = "";
  if ("cities" in ui) ui.cities = [];
  if ("reason" in ui) ui.reason = "";
  if ("source" in ui) ui.source = "";
  if (view === "review") {
    ui.score = ui.model = ui.pay = ui.size = ui.posted = ui.easy = "";
    ui.sort = "score";
    ui.dir = "desc";
  } else if (view === "startups") {
    ui.sort = "date";
    ui.dir = "desc";
  } else if (view === "ignored") {
    ui.sort = "date";
    ui.dir = "desc";
  } else if (view === "archive") {
    ui.score = "";
    ui.sort = "score";
    ui.dir = "desc";
  } else if (view === "rejected") {
    ui.score = "";
    ui.model = "";
    ui.sort = "date";
    ui.dir = "desc";
  }
  refreshListView(view, true);
}

function paintListMeta(view, shown, total) {
  const el = document.querySelector(`[data-listbar="${view}"] [data-listmeta]`);
  if (!el) return;
  el.textContent = shown === total ? `${total} in this list` : `${shown} of ${total}`;
}

/* ── startups watchlist view ──────────────── */
function startupCity(s) { return (s.city || "").trim(); }
function startupHay(s) {
  return hay([s.name, s.city, s.sector, s.notes, s.employees_est, s.careers_url ? "has careers" : "none found"]);
}
function startupSortVal(s, key) {
  if (key === "size") return parseSize(s.employees_est);
  if (key === "date") return dateKey(s.last_checked);
  if (key === "city") return s.city || "";
  if (key === "sector") return s.sector || "";
  return s.name || "";
}
function visibleStartups() {
  const rows = applyListQuery(DB.startups, "startups", startupHay, startupCity);
  return rows.slice().sort((a, b) => compareList(a, b, "startups", startupSortVal));
}
function startupRowsHtml(list) {
  if (!list.length) {
    return `<tr><td colspan="7" class="list-empty">Nothing matches. Clear the find box or choose All cities.</td></tr>`;
  }
  return list.map((s) => `<tr>
    <td><a href="${safeUrl(s.website)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a></td>
    <td>${esc(s.city || "")}</td>
    <td>${esc(s.employees_est || "?")}</td>
    <td>${esc(s.sector || "")}</td>
    <td>${esc(s.notes || "")}</td>
    <td>${s.careers_url ? `<a href="${safeUrl(s.careers_url)}" target="_blank" rel="noopener">page ↗</a>` : "none found"}</td>
    <td>${esc(s.last_checked || "never")}${s.open_matches ? ` · <b>${esc(String(s.open_matches))} match</b>` : ""}</td>
  </tr>`).join("");
}
function paintStartups() {
  const rows = visibleStartups();
  const body = $("[data-listrows='startups']");
  if (body) body.innerHTML = startupRowsHtml(rows);
  paintListMeta("startups", rows.length, DB.startups.length);
}
function startupBlurb() {
  const sw = CAND().startup_watch || {};
  const where = sw.region_label ? ` in the ${sw.region_label}` : " near you";
  return `A watchlist of small companies${where}, under ${Number(sw.max_employees) || 100} people.`;
}

function renderStartups(root) {
  const list = DB.startups;
  if (!list.length) {
    root.innerHTML = `<div class="empty"><h2>No startups yet</h2>
      <p>${esc(startupBlurb())} New finds land here after each search.</p></div>`;
    return;
  }
  const cities = uniqueCities(list, startupCity);
  root.innerHTML = `<p class="startups-intro">${esc(startupBlurb())} Their job pages are checked on every search, and any matching job goes straight into Review.</p>
  ${listToolbar("startups", {
    cities,
    sorts: [["date", "Last checked"], ["size", "Team size"], ["name", "Company"], ["city", "City"], ["sector", "Sector"]],
    placeholder: "Find a company, city, or word",
  })}
  <div class="table-wrap"><table class="archive-table startups-table">
    <thead><tr>
      <th data-listsort="name">Company${sortMarker("startups", "name")}</th>
      <th data-listsort="city">City${sortMarker("startups", "city")}</th>
      <th data-listsort="size">Size${sortMarker("startups", "size")}</th>
      <th data-listsort="sector">Sector${sortMarker("startups", "sector")}</th>
      <th>Why interesting</th>
      <th>Careers</th>
      <th data-listsort="date">Last checked${sortMarker("startups", "date")}</th>
    </tr></thead>
    <tbody data-listrows="startups"></tbody>
  </table></div>`;
  paintStartups();
}

/* ── screened-out (ignored) view ──────────── */
function ignoreReasonBucket(reason) {
  const s = String(reason || "").toLowerCase();
  if (/on-site|onsite|in-office/.test(s)) return "onsite";
  if (/pay-floor|pay floor|under \$120/.test(s)) return "pay";
  if (/french|bilingual|language/.test(s)) return "language";
  if (/duplicate|already.tracked|already-tracked|same multi-city/.test(s)) return "duplicate";
  if (/part-time|intern|co-op|contract|gig|marketplace/.test(s)) return "employment";
  if (/gambling|nicotine|addiction/.test(s)) return "industry";
  if (/us-only|us only|us-in-office|work auth|work permit|united states only/.test(s)) return "usonly";
  if (/posting-age|months ago|stale/.test(s)) return "stale";
  if (/title-level/.test(s)) return "level";
  if (/not ops|not-ops|not a target|wrong function|doesn't match the target|does not match the target|title \(/.test(s)) return "notops";
  if (/location|outside/.test(s)) return "location";
  return "other";
}

function ignoredHay(p) {
  return hay([p.title, p.company, p.reason, p.source, p.found_date]);
}
function ignoredSortVal(p, key) {
  if (key === "date") return dateKey(p.found_date);
  if (key === "company") return p.company || "";
  if (key === "reason") return p.reason || "";
  return p.title || "";
}
function visibleIgnored() {
  const ui = LIST_UI.ignored;
  const q = ui.q.trim().toLowerCase();
  const rows = DB.ignored.filter((p) => {
    if (q && !ignoredHay(p).includes(q)) return false;
    if (ui.reason && ignoreReasonBucket(p.reason) !== ui.reason) return false;
    if (ui.source && (p.source || "") !== ui.source) return false;
    return true;
  });
  return rows.slice().sort((a, b) => compareList(a, b, "ignored", ignoredSortVal));
}
function ignoredRowsHtml(list) {
  if (!list.length) {
    return `<tr><td colspan="5" class="list-empty">Nothing matches. Clear the find box or filters.</td></tr>`;
  }
  return list.map((p) => `<tr>
    <td>${esc(p.title)}</td>
    <td>${esc(p.company)}</td>
    <td>${esc(p.reason || "")}</td>
    <td>${esc(p.found_date || "")}</td>
    <td><a class="btn small" href="${safeUrl(p.url)}" target="_blank" rel="noopener">Posting ↗</a></td>
  </tr>`).join("");
}
function paintIgnored() {
  const rows = visibleIgnored();
  const body = $("[data-listrows='ignored']");
  if (body) body.innerHTML = ignoredRowsHtml(rows);
  paintListMeta("ignored", rows.length, DB.ignored.length);
}
function renderIgnored(root) {
  const list = DB.ignored;
  if (!list.length) {
    root.innerHTML = `<div class="empty"><h2>Nothing screened out yet</h2>
      <p>Jobs the search skipped without scoring land here: duplicates, and jobs that break one of your hard rules. You can check them any time.</p></div>`;
    return;
  }
  const ui = LIST_UI.ignored;
  root.innerHTML = `<p class="startups-intro">Jobs the search saw but did not score: duplicates, and jobs that break one of your hard rules. Everything else in your field is scored and shown in Review, even weak matches.</p>
  ${listToolbar("ignored", {
    cities: [],
    sorts: [["date", "Date found"], ["company", "Company"], ["title", "Position"], ["reason", "Why ignored"]],
    placeholder: "Find a company, title, or reason",
    extras: `<label class="list-sort-label">Why
      <select class="list-select" data-listfilter="reason">
        ${opt("", "Any reason", ui.reason)}
        ${opt("onsite", "On-site", ui.reason)}
        ${opt("notops", "Not your field", ui.reason)}
        ${opt("level", "Entry-level title", ui.reason)}
        ${opt("duplicate", "Duplicate", ui.reason)}
        ${opt("language", "Language required", ui.reason)}
        ${opt("employment", "Part-time, internship or short contract", ui.reason)}
        ${opt("location", "Location", ui.reason)}
        ${opt("pay", "Pay too low", ui.reason)}
        ${opt("stale", "Too old", ui.reason)}
        ${opt("industry", "Off-limits industry", ui.reason)}
        ${opt("usonly", "Work permit needed", ui.reason)}
        ${opt("other", "Other", ui.reason)}
      </select>
    </label>
    <label class="list-sort-label">Source
      <select class="list-select" data-listfilter="source">
        ${opt("", "Any source", ui.source)}
        ${opt("alert-email", "Email alert", ui.source)}
        ${opt("yc-jobs", "Y Combinator", ui.source)}
        ${opt("wellfound", "Wellfound", ui.source)}
        ${opt("communitech", "Communitech", ui.source)}
        ${opt("linkedin-sweep", "LinkedIn sweep", ui.source)}
        ${opt("startup-watch", "Startup watchlist", ui.source)}
        ${opt("manual", "Added by you", ui.source)}
      </select>
    </label>`,
  })}
  <div class="table-wrap"><table class="archive-table ignored-table">
    <thead><tr>
      <th data-listsort="title">Position${sortMarker("ignored", "title")}</th>
      <th data-listsort="company">Company${sortMarker("ignored", "company")}</th>
      <th data-listsort="reason">Why ignored${sortMarker("ignored", "reason")}</th>
      <th data-listsort="date">Found${sortMarker("ignored", "date")}</th>
      <th></th>
    </tr></thead>
    <tbody data-listrows="ignored"></tbody>
  </table></div>`;
  paintIgnored();
}

/* ── archive view ─────────────────────────── */
function archiveRows() {
  return DB.positions.filter((p) => p.status === "rejected");
}
function archiveHay(p) {
  return hay([p.title, p.company, p.location, ...(p.reject_reasons || []), p.reject_note]);
}
function archiveSortVal(p, key) {
  if (key === "score") return Number(p.scores?.overall) || 0;
  if (key === "company") return p.company || "";
  if (key === "reason") return (p.reject_reasons || []).join(", ");
  return p.title || "";
}
function rejectReasonText(p) {
  const labels = (p.reject_reasons || []).map((k) =>
    (REJECT_REASONS.find(([kk]) => kk === k) || [k, k])[1]);
  const text = labels.join(", ") || "No reason logged";
  return p.reject_note ? `${text}: ${p.reject_note}` : text;
}
function visibleArchive() {
  const ui = LIST_UI.archive;
  const q = ui.q.trim().toLowerCase();
  return archiveRows().filter((p) => {
    if (q && !archiveHay(p).includes(q)) return false;
    if (ui.score && String(p.scores?.overall) !== ui.score) return false;
    if (ui.reason && !(p.reject_reasons || []).includes(ui.reason)) return false;
    return true;
  }).sort((a, b) => compareList(a, b, "archive", archiveSortVal));
}
function archiveRowsHtml(list) {
  if (!list.length) {
    return `<tr><td colspan="5" class="list-empty">Nothing matches. Clear the find box or filters.</td></tr>`;
  }
  return list.map((p) => `<tr>
    <td><a href="#position/${esc(p.id)}">${esc(p.title)}</a></td>
    <td>${esc(p.company)}</td>
    <td>${p.scores?.overall ?? ""}</td>
    <td>${esc(rejectReasonText(p))}</td>
    <td><button class="btn small" data-restore="${esc(p.id)}">Restore</button></td>
  </tr>`).join("");
}
function paintArchive() {
  const rows = visibleArchive();
  const body = $("[data-listrows='archive']");
  if (body) body.innerHTML = archiveRowsHtml(rows);
  paintListMeta("archive", rows.length, archiveRows().length);
}
function renderArchive(root) {
  const rejected = archiveRows();
  if (!rejected.length) {
    root.innerHTML = `<div class="empty"><h2>Nothing here yet</h2><p>Jobs you press Disagree on land here, with the reasons you gave. The search learns from them.</p></div>`;
    return;
  }
  const ui = LIST_UI.archive;
  root.innerHTML = `${listToolbar("archive", {
    cities: [],
    sorts: [["score", "Score"], ["company", "Company"], ["title", "Position"], ["reason", "Why you said no"]],
    placeholder: "Find a company, title, or reason",
    extras: `<label class="list-sort-label">Score
      <select class="list-select" data-listfilter="score">
        ${opt("", "Any score", ui.score)}
        ${[5, 4, 3, 2, 1].map((n) => opt(String(n), String(n), ui.score)).join("")}
      </select>
    </label>
    <label class="list-sort-label">Why
      <select class="list-select" data-listfilter="reason">
        ${opt("", "Any reason", ui.reason)}
        ${REJECT_REASONS.map(([k, label]) => opt(k, label, ui.reason)).join("")}
      </select>
    </label>`,
  })}
  <div class="table-wrap"><table class="archive-table rejected-table">
    <thead><tr>
      <th data-listsort="title">Position${sortMarker("archive", "title")}</th>
      <th data-listsort="company">Company${sortMarker("archive", "company")}</th>
      <th data-listsort="score">Score${sortMarker("archive", "score")}</th>
      <th data-listsort="reason">Why you said no${sortMarker("archive", "reason")}</th>
      <th></th>
    </tr></thead>
    <tbody data-listrows="archive"></tbody>
  </table></div>`;
  paintArchive();
}


/* ── analytics view ───────────────────────── */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isoWeekStart(d) {
  const t = new Date(d);
  if (isNaN(t)) return null;
  const day = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - day);
  t.setHours(0, 0, 0, 0);
  return t;
}

function fmtWeek(d) {
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function statTile(value, label, note) {
  return `<div class="stat-tile">
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-label">${esc(label)}</div>
    ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}
  </div>`;
}

/* magnitude comparison — one hue, length carries the value */
function barChart(rows, opts = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return `<div class="bars">${rows.map((r) => {
    const pct = (r.value / max) * 100;
    const share = total ? Math.round((r.value / total) * 100) : 0;
    return `<div class="bar-row" title="${esc(r.label)}: ${r.value}${opts.showShare ? ` (${share}%)` : ""}">
      <div class="bar-label">${esc(r.label)}</div>
      <div class="bar-track">${r.value ? `<div class="bar-fill${r.tone ? " tone-" + r.tone : ""}" style="width:${pct}%"></div>` : ""}</div>
      <div class="bar-value">${r.value}${opts.suffix || ""}${opts.showShare ? `<span class="bar-share">${share}%</span>` : ""}</div>
    </div>`;
  }).join("")}</div>`;
}

function lineChart(series, opts = {}) {
  const pts = series.filter((s) => s.points.length);
  if (!pts.length) return `<p class="row-empty">Not enough history yet</p>`;
  const all = pts.flatMap((s) => s.points);
  const maxY = Math.max(1, ...all.map((p) => p.y));
  const labels = pts[0].points.map((p) => p.label);
  const W = 640, H = 160, PAD_L = 28, PAD_B = 22, PAD_T = 8;
  const n = Math.max(1, labels.length - 1);
  const x = (i) => PAD_L + (i / n) * (W - PAD_L - 8);
  const y = (v) => PAD_T + (1 - v / maxY) * (H - PAD_T - PAD_B);
  const grid = [0, 0.5, 1].map((f) => {
    const v = Math.round(maxY * f);
    return `<line x1="${PAD_L}" y1="${y(v)}" x2="${W - 8}" y2="${y(v)}" class="grid"/>
      <text x="${PAD_L - 6}" y="${y(v) + 4}" class="axis-label" text-anchor="end">${v}</text>`;
  }).join("");
  const paths = pts.map((s, si) => {
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
    const dots = s.points.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="3.5" class="dot s${si}"><title>${esc(p.label)}, ${esc(s.name)}: ${p.y}</title></circle>`).join("");
    return `<path d="${d}" class="line s${si}"/>${dots}`;
  }).join("");
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const xlabels = labels.map((l, i) =>
    i % step === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" class="axis-label" text-anchor="middle">${esc(l)}</text>` : "").join("");
  const legend = pts.length > 1
    ? `<div class="chart-legend">${pts.map((s, i) =>
        `<span class="legend-item"><i class="swatch s${i}"></i>${esc(s.name)}</span>`).join("")}</div>`
    : "";
  return `${legend}<div class="chart-scroll"><svg viewBox="0 0 ${W} ${H}" class="linechart" role="img"
    aria-label="${esc(opts.aria || "activity over time")}">${grid}${paths}${xlabels}</svg></div>`;
}

function weeklySeries(dates, weeks) {
  const buckets = new Map(weeks.map((w) => [w.getTime(), 0]));
  dates.forEach((d) => {
    const w = isoWeekStart(d);
    if (!w) return;
    const k = w.getTime();
    if (buckets.has(k)) buckets.set(k, buckets.get(k) + 1);
  });
  return weeks.map((w) => ({ label: fmtWeek(w), y: buckets.get(w.getTime()) || 0 }));
}

/* location groups come from candidate.location_buckets: regex patterns tried in
   order, an empty pattern is the catch-all */
function locationBucket(text) {
  const s = String(text || "").toLowerCase();
  const buckets = Array.isArray(CAND().location_buckets) && CAND().location_buckets.length
    ? CAND().location_buckets
    : [{ label: "Remote", pattern: "remote" }, { label: "Other / unclear", pattern: "" }];
  for (const b of buckets) {
    if (!b.pattern) return b.label;
    try {
      if (new RegExp(b.pattern, "i").test(s)) return b.label;
    } catch (_) { /* a bad pattern in the profile should not break the page */ }
  }
  return "Other / unclear";
}

function renderAnalytics(root) {
  const P = DB.positions;
  const ignored = DB.ignored || [];
  const log = (DB.profile && DB.profile.learning_log) || [];

  const by = (s) => P.filter((p) => p.status === s);
  const applied = by("applied"), interested = by("interested"), review = by("review");
  const rejected = by("rejected"), disqualified = by("disqualified");
  const ongoing = P.filter(isConversation);
  const noAnswer = by("no_answer");
  const agreedEver = P.filter((p) => (p.status_history || []).some((h) => h.status === "interested") ||
    ["interested", "applied", "screen", "interview", "offer", "ongoing", "no_answer"].includes(p.status));
  const sourced = P.length + ignored.length;
  const rate = (a, b) => b ? `${Math.round((a / b) * 100)}%` : "?";

  const tiles = [
    statTile(sourced, "postings sourced", `${P.length} scored · ${ignored.length} screened out`),
    statTile(P.length, "scored & reviewed", `${review.length} still in the queue`),
    statTile(agreedEver.length, "you agreed with", `${rate(agreedEver.length, P.length)} of scored`),
    statTile(applied.length + ongoing.length + noAnswer.length, "applied", `${rate(applied.length + ongoing.length + noAnswer.length, agreedEver.length)} of agreed`),
    statTile(ongoing.length, "in conversation", ongoing.length ? "active processes" : "none active yet"),
  ].join("");

  const funnel = barChart([
    { label: "Sourced", value: sourced },
    { label: "Scored into Review", value: P.length },
    { label: "You agreed", value: agreedEver.length },
    { label: "Applied", value: applied.length + ongoing.length + noAnswer.length },
    { label: "In conversation", value: ongoing.length, tone: "good" },
  ]);

  const reasonCounts = {};
  P.forEach((p) => (p.reject_reasons || []).forEach((r) => { reasonCounts[r] = (reasonCounts[r] || 0) + 1; }));
  const reasonRows = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: (REJECT_REASONS.find(([kk]) => kk === k) || [k, k])[1], value: v, tone: "bad" }));

  const scoreRows = [5, 4, 3, 2, 1].map((n) => ({
    label: `Score ${n}`, value: P.filter((p) => p.scores && p.scores.overall === n).length,
  }));

  const srcRows = Object.entries(P.reduce((m, p) => { m[p.source || "unknown"] = (m[p.source || "unknown"] || 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: (SOURCE_LABELS[k] || [k])[0], value: v }));

  const locBucket = (p) => locationBucket(`${p.location || ""} ${p.work_model || ""}`);
  const locRows = Object.entries(P.reduce((m, p) => { const b = locBucket(p); m[b] = (m[b] || 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v }));

  const allDates = P.map((p) => p.found_date).filter(Boolean).sort();
  const first = isoWeekStart(allDates[0] || new Date());
  const last = isoWeekStart(new Date());
  const weeks = [];
  for (let t = first ? first.getTime() : last.getTime(); t <= last.getTime(); t += WEEK_MS) weeks.push(new Date(t));
  const trend = lineChart([
    { name: "Sourced", points: weeklySeries(P.map((p) => p.found_date), weeks) },
    { name: "Applied", points: weeklySeries(P.map((p) => p.applied_at).filter(Boolean), weeks) },
  ], { aria: "positions sourced and applications submitted per week" });

  const appliedRows = P.filter((p) => p.applied_at)
    .sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)))
    .map((p) => `<tr>
      <td>${esc(String(p.applied_at).slice(0, 10))}</td>
      <td><a href="#position/${esc(p.id)}">${esc(p.company)}</a></td>
      <td>${esc(p.title)}</td>
      <td><span class="pill st-${esc(p.status)}">${esc(p.status.replace("_", " "))}</span></td>
      <td>${p.scores ? p.scores.overall : "?"}</td>
    </tr>`).join("");

  const outcome = applied.length + ongoing.length + noAnswer.length;
  root.innerHTML = `<div class="analytics">
    <div class="stat-row">${tiles}</div>

    <section class="panel">
      <h3>Funnel</h3>
      <p class="panel-note">Every posting that entered the system, and where it ended up.</p>
      ${funnel}
    </section>

    <section class="panel">
      <h3>Activity per week</h3>
      <p class="panel-note">Postings sourced versus applications actually submitted.</p>
      ${trend}
    </section>

    <div class="analytics-grid">
      <section class="panel">
        <h3>Why you said no</h3>
        <p class="panel-note">${log.length} decisions recorded. These train the scoring.</p>
        ${reasonRows.length ? barChart(reasonRows, { showShare: true }) : `<p class="row-empty">No rejections recorded yet</p>`}
      </section>
      <section class="panel">
        <h3>Score distribution</h3>
        <p class="panel-note">How the ${P.length} scored postings landed.</p>
        ${barChart(scoreRows, { showShare: true })}
      </section>
      <section class="panel">
        <h3>Where they came from</h3>
        <p class="panel-note">Which source is actually producing.</p>
        ${barChart(srcRows, { showShare: true })}
      </section>
      <section class="panel">
        <h3>Location mix</h3>
        <p class="panel-note">Grouped by the areas you told the search you care about.</p>
        ${barChart(locRows, { showShare: true })}
      </section>
    </div>

    <section class="panel">
      <h3>Applications submitted (${outcome})</h3>
      <p class="panel-note">Most recent first.</p>
      ${appliedRows
        ? `<div class="table-wrap"><table class="data-table">
            <tr><th>Applied</th><th>Company</th><th>Role</th><th>Status</th><th>Score</th></tr>
            ${appliedRows}</table></div>`
        : `<p class="row-empty">Nothing applied yet</p>`}
    </section>
  </div>`;
}

/* ── post-mortem view ─────────────────────── */
const DQ_CAUSES = [
  ["closed-before-applying", "Posting closed before you applied", "bad"],
  ["blocked-then-closed", "Closed while blocked on a sign-in", "bad"],
  ["rule-onsite", "Too many office days (your rule)", "warn"],
  ["rule-us-only", "Needs a work permit you don't have", "warn"],
  ["rule-other", "Your call", "neutral"],
  ["employer-rejected", "Applied and rejected", "good"],
  ["unclassified", "Not yet classified", "neutral"],
];
const DQ_LABEL = Object.fromEntries(DQ_CAUSES.map(([k, l]) => [k, l]));
const DQ_TONE = Object.fromEntries(DQ_CAUSES.map(([k, , t]) => [k, t]));

const AGE_BUCKETS = [
  ["0-1 days", (n) => n <= 1],
  ["2-3 days", (n) => n <= 3],
  ["4-7 days", (n) => n <= 7],
  ["8-14 days", (n) => n <= 14],
  ["15+ days", () => true],
];

const bucketOf = (n) => (AGE_BUCKETS.find(([, test]) => test(n)) || AGE_BUCKETS[4])[0];

function daysBetween(a, b) {
  const t0 = Date.parse(String(a || "").slice(0, 10));
  const t1 = Date.parse(String(b || "").slice(0, 10));
  if (isNaN(t0) || isNaN(t1)) return null;
  return Math.round((t1 - t0) / 86400000);
}

function appliedDate(p) {
  return p.applied_at || (p.status_history || []).find((h) => h.status === "applied")?.at || null;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* two distributions over the same buckets, drawn as paired bars and shown as a
   share of each series — the series have different totals, so raw counts would
   compare the wrong thing */
function pairedBars(buckets, series) {
  const totals = series.map((s) => Object.values(s.values).reduce((a, b) => a + b, 0) || 1);
  const pct = (v, i) => (v / totals[i]) * 100;
  const max = Math.max(...buckets.flatMap((b) => series.map((s, i) => pct(s.values[b] || 0, i))));
  const legend = `<div class="chart-legend">${series.map((s, i) =>
    `<span class="legend-item"><i class="swatch block s${i}"></i>${esc(s.name)} <span class="legend-n">n=${totals[i]}</span></span>`).join("")}</div>`;
  const rows = buckets.map((b) => `<div class="paired-row">
    <div class="bar-label">${esc(b)}</div>
    <div class="paired-track">${series.map((s, i) => {
      const v = s.values[b] || 0;
      return `<div class="paired-bar" title="${esc(s.name)}, ${esc(b)}: ${v} (${Math.round(pct(v, i))}%)">
        <div class="paired-fill s${i}" style="width:${max ? (pct(v, i) / max) * 100 : 0}%"></div>
        <span class="paired-val">${Math.round(pct(v, i))}%</span>
      </div>`;
    }).join("")}</div>
  </div>`).join("");
  return `${legend}<div class="paired">${rows}</div>`;
}

const ARCHETYPES = [
  ["founding-generalist", "Build the function", "Nobody does this job yet. You would own several areas at once."],
  ["exec-support", "Support an executive", "The company is already set up; you support a leader."],
  ["single-function", "Run one lane", "One specialist area, with a team already around it."],
];

const GATE_KIND = {
  "years": "Years of experience",
  "years-in-function": "Years in one function",
  "credential": "Credential / pedigree",
  "people-leadership": "People leadership",
  "altitude": "Seniority",
  "domain": "Domain",
  "authorization": "Work authorization",
};

/* asked-years per posting against what the résumé can evidence — the threshold
   line is the point of the chart, so it is drawn, not described */
function gateYearsChart(rows, threshold) {
  const max = Math.max(threshold, ...rows.map((r) => r.years)) + 1;
  const bars = rows.map((r) => `<div class="bar-row">
    <div class="bar-label" title="${esc(r.label)}">${esc(r.label)}</div>
    <div class="bar-track gate-track">
      <div class="bar-fill ${r.clears ? "tone-good" : "tone-bad"}" style="width:${(r.years / max) * 100}%"></div>
      <div class="gate-threshold" style="left:${(threshold / max) * 100}%"></div>
    </div>
    <div class="bar-value">${r.years}y</div>
  </div>`).join("");
  return `<div class="bars">${bars}</div>
    <p class="gate-key"><i class="gate-threshold-key"></i> your ${threshold} years of experience, as shown on your resume</p>`;
}
/* Positions split into the two questions worth asking separately:
   #rejected — an employer read the application and wrote back no
   #lost     — everything else that died, none of which ever reached a person */
function rejectedPositions() {
  return DB.positions.filter((p) => p.dq_analysis?.cause === "employer-rejected");
}

function lostPositions() {
  return DB.positions.filter((p) =>
    p.status === "disqualified" && p.dq_analysis && p.dq_analysis.cause !== "employer-rejected");
}

function stalePositions() {
  return DB.positions
    .filter((p) => p.status === "applied" && appliedDate(p))
    .map((p) => ({ p, age: daysBetween(appliedDate(p), new Date().toISOString()) }))
    .filter((r) => r.age !== null && r.age >= 14)
    .sort((a, b) => b.age - a.age);
}

const causePill = (c) =>
  `<span class="pill dq-${esc(DQ_TONE[c] || "neutral")}">${esc(DQ_LABEL[c] || c)}</span>`;

/* ── tab 1: rejected ──────────────────────── */
function insightsPanel(emptyText) {
  const md = String(DB.insights_md || "").trim();
  if (md) {
    return `<section class="panel conclusions insights">
      <h3>Insights</h3>
      <p class="panel-note">Written by Claude after reading your results. Ask for a fresh version any time.</p>
      <div class="research">${mdToHtml(md)}</div>
    </section>`;
  }
  return `<section class="panel insights">
    <h3>Insights</h3>
    <p class="panel-note">${esc(emptyText)}</p>
  </section>`;
}

function everTalked(p) {
  return isConversation(p) || (p.status_history || []).some((h) => CONVERSATION.has(h.status));
}

function renderRejected(root) {
  const rejected = rejectedPositions();
  if (!rejected.length) {
    root.innerHTML = `<div class="empty"><h2>No employer has said no yet</h2>
      <p>When a company writes back to turn you down, that application moves here. Seeing them side by side
      shows patterns that are hard to spot one email at a time.</p></div>`;
    return;
  }

  const P = DB.positions;
  const years = Number(CAND().experience_years?.in_function) || 0;
  const fn = CAND().experience_years?.function_label || "relevant";
  const gated = rejected.filter((p) => p.gate);
  const failed = gated.filter((p) => !p.gate.clears);
  const rejectDays = rejected.map((p) => p.dq_analysis.days_to_outcome).filter((n) => n !== null && n !== undefined);
  const matches = rejected.map((p) => p.match_pct).filter(Boolean);
  const talked = P.filter(everTalked);
  const fast = rejected.filter((p) => p.dq_analysis.days_to_outcome <= 6);
  const slow = rejected.filter((p) => p.dq_analysis.days_to_outcome > 6);
  const medMatch = (set) => Math.round(median(set.map((p) => p.match_pct).filter(Boolean)) || 0);
  const medDays = median(rejectDays);
  const maxDays = rejectDays.length ? Math.max(...rejectDays) : null;

  const tiles = [
    statTile(rejected.length, "told you no", "a company read it and wrote back"),
    gated.length ? statTile(`${failed.length}/${gated.length}`, "asked for more than the resume shows", "the posting's own requirement") : "",
    statTile(medDays === null ? "?" : `${medDays}d`, "typical time to hear no", maxDays === null ? "" : `slowest was ${maxDays} days`),
    statTile(talked.length, talked.length === 1 ? "conversation so far" : "conversations so far", "screens, interviews and offers"),
    statTile(matches.length ? `${Math.round(median(matches))}%` : "?", "typical match", "how well these fit your experience"),
  ].join("");

  const yearRows = gated
    .filter((p) => p.gate.asked_years)
    .sort((a, b) => b.gate.asked_years - a.gate.asked_years)
    .map((p) => ({ label: `${p.company}: ${p.gate.asked_years}+ asked`, years: p.gate.asked_years, clears: p.gate.clears }));

  const applied = P.filter((p) => p.archetype);
  const archRows = ARCHETYPES.map(([key, label, blurb]) => {
    const group = applied.filter((p) => p.archetype === key);
    return {
      label, blurb, n: group.length,
      rej: group.filter((x) => x.dq_analysis?.cause === "employer-rejected").length,
      conv: group.filter(everTalked).length,
    };
  });
  const bestArch = [...archRows].filter((r) => r.n).sort((a, b) => (b.conv / b.n) - (a.conv / a.n))[0];

  const speedRows = AGE_BUCKETS.map(([b]) => ({
    label: b, value: rejectDays.filter((n) => bucketOf(n) === b).length, tone: "neutral",
  }));

  const gateRows = [...gated]
    .sort((a, b) => (a.dq_analysis.days_to_outcome || 0) - (b.dq_analysis.days_to_outcome || 0))
    .map((p) => `<tr class="${p.gate.clears ? "gate-ok" : ""}">
      <td><a href="#position/${esc(p.id)}">${esc(p.company)}</a>
        <div class="gate-sub">${esc(p.title)}</div></td>
      <td><span class="pill dq-neutral">${esc(GATE_KIND[p.gate.kind] || p.gate.kind)}</span>
        <div class="gate-sub">${esc(p.gate.asked)}</div></td>
      <td class="gate-has">${esc(p.gate.resume_shows)}</td>
      <td>${p.gate.clears
        ? `<span class="pill dq-good">you meet it</span>`
        : `<span class="pill dq-bad">you don't yet</span>`}</td>
      <td class="num">${p.dq_analysis.days_to_outcome ?? "?"}d</td>
    </tr>
    ${p.gate.note ? `<tr class="gate-note-row"><td colspan="5">${esc(p.gate.note)}</td></tr>` : ""}`).join("");

  root.innerHTML = `<div class="analytics postmortem">
    <section class="verdict verdict-alt">
      <h2>${rejected.length} ${rejected.length === 1 ? "company has" : "companies have"} said no. Here is what they have in common.</h2>
      <p>These are the only applications where a person (or their screening software) read what you sent
      and replied. One at a time they feel personal. Lined up together they usually point at one or two
      fixable things: the kind of role, the size of company, or a requirement the resume does not show yet.</p>
    </section>

    <div class="stat-row">${tiles}</div>

    ${gated.length ? `<section class="panel">
      <h3>What each posting asked for, and what your resume shows</h3>
      <p class="panel-note">Fastest replies first. A no within a few days is usually software; a slow no is usually a person.</p>
      <div class="table-wrap"><table class="data-table gate-table">
        <tr><th>Role</th><th>What they asked for</th><th>What the resume shows</th><th>Result</th><th>No after</th></tr>
        ${gateRows}
      </table></div>
    </section>` : ""}

    <div class="analytics-grid">
      ${yearRows.length && years ? `<section class="panel">
        <h3>Years asked for, compared with yours</h3>
        <p class="panel-note">Every no that named a number of years. The line is your ${years} years of ${esc(fn)} experience.</p>
        ${gateYearsChart(yearRows, years)}
      </section>` : ""}
      ${applied.length ? `<section class="panel">
        <h3>Which kind of role answers you</h3>
        <p class="panel-note">All ${applied.length} applications, grouped by the shape of the job.</p>
        <div class="arch">${archRows.map((r) => `<div class="arch-row">
          <div class="arch-head"><strong>${esc(r.label)}</strong><span class="arch-n">${r.n} applied</span></div>
          <div class="arch-blurb">${esc(r.blurb)}</div>
          <div class="arch-stats">
            <span class="arch-stat bad">${r.rej} said no</span>
            <span class="arch-stat ${r.conv ? "good" : "flat"}">${r.conv} conversation${r.conv === 1 ? "" : "s"}</span>
          </div>
        </div>`).join("")}</div>
        ${bestArch && bestArch.conv ? `<p class="callout">Your best response rate so far is in <strong>${esc(bestArch.label)}</strong>
        roles: ${bestArch.conv} conversation${bestArch.conv === 1 ? "" : "s"} from ${bestArch.n} applications.</p>` : ""}
      </section>` : ""}
    </div>

    <section class="panel">
      <h3>How fast the no came</h3>
      <p class="panel-note">Days from applying to hearing back, across ${rejectDays.length === 1 ? "the 1 reply" : `all ${rejectDays.length} replies`}.</p>
      ${barChart(speedRows, { showShare: true })}
      ${fast.length && slow.length ? `<p class="callout">The ${fast.length} quick no's had a typical match of
      <strong>${medMatch(fast)}%</strong>; the ${slow.length} slower ones had <strong>${medMatch(slow)}%</strong>.
      ${maxDays !== null ? `The slowest reply ever took ${maxDays} days, so an application silent for longer than that is very likely a no.` : ""}</p>` : ""}
    </section>

    ${insightsPanel("Once a few companies have replied, ask Claude: \"Look at my rejections and write me some insights.\" The advice will appear here.")}

    <section class="panel">
      <h3>Every no</h3>
      <p class="panel-note">Search and sort this list. The charts above always use everything.</p>
      ${rejectedChromeHtml()}
    </section>
  </div>`;
  paintRejectedLedger();
}

function rejectedChromeHtml() {
  const ui = LIST_UI.rejected;
  return `<div data-rejectedchrome>
      ${listToolbar("rejected", {
        cities: [],
        sorts: [["date", "Date heard"], ["score", "Score"], ["match", "Match %"], ["company", "Company"]],
        placeholder: "Find a company, title, or what happened",
        extras: `<label class="list-sort-label">Score
          <select class="list-select" data-listfilter="score">
            ${opt("", "Any score", ui.score)}
            ${[5, 4, 3, 2, 1].map((n) => opt(String(n), String(n), ui.score)).join("")}
          </select>
        </label>
        <label class="list-sort-label">Work model
          <select class="list-select" data-listfilter="model">
            ${opt("", "Any model", ui.model)}
            ${opt("remote", "Remote", ui.model)}
            ${opt("hybrid", "Hybrid", ui.model)}
            ${opt("onsite", "On-site", ui.model)}
            ${opt("unclear", "Unclear", ui.model)}
          </select>
        </label>`,
      })}
      <div class="table-wrap"><table class="data-table ledger-table">
        <thead><tr>
          <th data-listsort="date">Heard${sortMarker("rejected", "date")}</th>
          <th data-listsort="company">Company${sortMarker("rejected", "company")}</th>
          <th>Role</th>
          <th data-listsort="score">Score${sortMarker("rejected", "score")}</th>
          <th data-listsort="match">Match${sortMarker("rejected", "match")}</th>
          <th>What happened</th>
        </tr></thead>
        <tbody data-listrows="rejected"></tbody>
      </table></div>
    </div>`;
}

function rejectedHay(p) {
  return hay([p.company, p.title, p.location, p.work_model, p.dq_analysis?.detail]);
}
function rejectedSortVal(p, key) {
  if (key === "date") return dateKey(p.dq_analysis?.closed_at);
  if (key === "score") return Number(p.scores?.overall) || 0;
  if (key === "match") return Number(p.match_pct) || 0;
  if (key === "company") return p.company || "";
  return p.title || "";
}
function visibleRejected() {
  const ui = LIST_UI.rejected;
  const q = ui.q.trim().toLowerCase();
  return rejectedPositions().filter((p) => {
    if (q && !rejectedHay(p).includes(q)) return false;
    if (ui.score && String(p.scores?.overall) !== ui.score) return false;
    if (ui.model && modelBucket(p.work_model) !== ui.model) return false;
    return true;
  }).sort((a, b) => compareList(a, b, "rejected", rejectedSortVal));
}
function rejectedLedgerRowsHtml(list) {
  if (!list.length) {
    return `<tr><td colspan="6" class="list-empty">Nothing matches. Clear the find box or filters.</td></tr>`;
  }
  return list.map((p) => `<tr>
    <td>${esc(String(p.dq_analysis.closed_at || "").slice(0, 10) || "-")}</td>
    <td><a href="#position/${esc(p.id)}">${esc(p.company)}</a></td>
    <td>${esc(p.title)}</td>
    <td class="num">${p.scores ? p.scores.overall : "-"}</td>
    <td class="num">${p.match_pct ? p.match_pct + "%" : "-"}</td>
    <td class="dq-detail">${esc(p.dq_analysis.detail)}</td>
  </tr>`).join("");
}
function paintRejectedLedger() {
  const all = rejectedPositions();
  const rows = visibleRejected();
  const body = $("[data-listrows='rejected']");
  if (body) body.innerHTML = rejectedLedgerRowsHtml(rows);
  paintListMeta("rejected", rows.length, all.length);
}
function paintRejectedChrome() {
  const host = $("[data-rejectedchrome]");
  if (!host) return;
  host.outerHTML = rejectedChromeHtml();
  paintRejectedLedger();
}

/* ── tab 2: lost ──────────────────────────── */
function renderLost(root) {
  const lost = lostPositions();
  const unTagged = DB.positions.filter((p) => p.status === "disqualified" && !p.dq_analysis).length;
  const stale = stalePositions();
  if (!lost.length && !stale.length) {
    root.innerHTML = `<div class="empty"><h2>Nothing lost yet</h2>
      <p>A job lands here when it ends without a company ever answering: the posting closed, a sign-in
      wall stopped the application, or one of your own rules ruled it out. Applications with no reply
      after 14 days show here too.</p></div>`;
    return;
  }

  const P = DB.positions;
  const of = (c) => lost.filter((p) => p.dq_analysis.cause === c);
  const diedWaiting = [...of("closed-before-applying"), ...of("blocked-then-closed")];
  const ownRules = [...of("rule-onsite"), ...of("rule-us-only")];
  const yourCall = of("rule-other");

  const everApplied = P.filter((p) => appliedDate(p));
  const closeDays = diedWaiting.map((p) => p.dq_analysis.days_in_hand).filter((n) => n !== null && n !== undefined);
  const applyDays = everApplied.map((p) => daysBetween(p.found_date, appliedDate(p)))
    .filter((n) => n !== null && n >= 0);
  const unsentLife = of("closed-before-applying")
    .map((p) => p.dq_analysis.days_in_hand).filter((n) => n !== null && n !== undefined);
  const survivedToDay = (n) => unsentLife.filter((d) => d >= n).length;

  const wastedResumes = lost.filter((p) => p.resume_path).length;
  const medianClose = median(closeDays);
  const medianApply = median(applyDays);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  const tiles = [
    statTile(lost.length, "ended without an answer", `${unTagged ? unTagged + " not sorted yet · " : ""}nobody said no`),
    statTile(diedWaiting.length, "closed before you applied", `${pct(diedWaiting.length, lost.length)}% of these`),
    statTile(ownRules.length + yourCall.length, "ruled out by your rules", "office days, work permit, or your call"),
    statTile(medianClose === null ? "?" : `${medianClose}d`, "typical time before closing", "for postings that closed"),
    statTile(stale.length, "silent for 14+ days", "applied, no reply yet"),
  ].join("");

  const causeRows = DQ_CAUSES
    .filter(([k]) => k !== "employer-rejected")
    .map(([k, label, tone]) => ({ label, value: of(k).length, tone }))
    .filter((r) => r.value);

  const timing = pairedBars(AGE_BUCKETS.map(([b]) => b), [
    { name: "How long a posting stayed open", values: closeDays.reduce((m, n) => (m[bucketOf(n)] = (m[bucketOf(n)] || 0) + 1, m), {}) },
    { name: "How long it took to apply", values: applyDays.reduce((m, n) => (m[bucketOf(n)] = (m[bucketOf(n)] || 0) + 1, m), {}) },
  ]);

  const expensive = lost
    .filter((p) => (p.scores?.overall || 0) >= 3 || (p.match_pct || 0) >= 72)
    .sort((a, b) => (b.scores?.overall || 0) - (a.scores?.overall || 0) || (b.match_pct || 0) - (a.match_pct || 0));

  const expensiveRows = expensive.map((p) => `<tr>
    <td><a href="#position/${esc(p.id)}">${esc(p.company)}</a></td>
    <td>${esc(p.title)}</td>
    <td class="num">${p.scores ? p.scores.overall : "?"}</td>
    <td class="num">${p.match_pct ? p.match_pct + "%" : "?"}</td>
    <td>${causePill(p.dq_analysis.cause)}</td>
  </tr>`).join("");

  const ledgerRows = [...lost]
    .sort((a, b) => String(a.dq_analysis.cause).localeCompare(String(b.dq_analysis.cause)) ||
      String(b.dq_analysis.closed_at).localeCompare(String(a.dq_analysis.closed_at)))
    .map((p) => `<tr>
      <td>${esc(String(p.dq_analysis.closed_at || "").slice(0, 10) || "?")}</td>
      <td><a href="#position/${esc(p.id)}">${esc(p.company)}</a></td>
      <td>${esc(p.title)}</td>
      <td>${causePill(p.dq_analysis.cause)}</td>
      <td class="dq-detail">${esc(p.dq_analysis.detail || "")}</td>
    </tr>`).join("");

  const tips = [];
  if (diedWaiting.length && unsentLife.length) {
    const was = (n) => `${n} ${n === 1 ? "was" : "were"}`;
    tips.push(`<li><strong>Apply sooner.</strong> Of the ${unsentLife.length} posting${unsentLife.length === 1 ? "" : "s"} that closed before you
      applied, ${was(survivedToDay(1))} still open after one day and ${survivedToDay(3)} after three days.
      ${medianApply !== null ? `Right now it typically takes you ${medianApply} day${medianApply === 1 ? "" : "s"} to apply.` : ""}</li>`);
  }
  if (of("blocked-then-closed").length) {
    tips.push(`<li><strong>Sign-in walls cost you ${of("blocked-then-closed").length} job${of("blocked-then-closed").length === 1 ? "" : "s"}.</strong>
      Some company sites make you create an account before applying. When a card says "Needs you", doing that
      step the same day keeps the job alive.</li>`);
  }
  const rulesWithResume = ownRules.filter((p) => p.resume_path).length;
  if (rulesWithResume) {
    tips.push(`<li><strong>${rulesWithResume} resume${rulesWithResume === 1 ? " was" : "s were"} made for jobs your own rules later ruled out.</strong>
      Ask Claude to check office days and work permits before it writes a resume.</li>`);
  }
  if (stale.length) {
    tips.push(`<li><strong>${stale.length} application${stale.length === 1 ? " has" : "s have"} been silent for two weeks or more.</strong>
      Either send a short follow-up or move ${stale.length === 1 ? "it" : "them"} to "No answer" so your pipeline shows the truth.</li>`);
  }

  root.innerHTML = `<div class="analytics postmortem">
    <section class="verdict">
      <h2>Nobody said no to these. They just ended.</h2>
      <p><strong>${lost.length}</strong> job${lost.length === 1 ? "" : "s"} ended without a company ever answering.
      <strong>${diedWaiting.length}</strong> closed while waiting in your queue, and
      <strong>${ownRules.length + yourCall.length}</strong> were ruled out by rules or decisions you made.
      None of this is a judgement on you. It is about timing and process, which means it can be fixed
      without changing your resume.</p>
    </section>

    <div class="stat-row">${tiles}</div>

    ${causeRows.length ? `<section class="panel">
      <h3>What ended them</h3>
      <p class="panel-note">Red could have been saved by moving faster. Gold could have been filtered out earlier.
      Grey is a decision you made on purpose.</p>
      ${barChart(causeRows, { showShare: true })}
    </section>` : ""}

    ${closeDays.length || applyDays.length ? `<section class="panel">
      <h3>How fast postings close, compared with how fast you apply</h3>
      <p class="panel-note">Each bar is a share of its own group. Only postings that closed are counted in
      the first group, so it shows how quickly the losses happen, not how long a typical posting lasts.</p>
      ${timing}
    </section>` : ""}

    <section class="panel">
      <h3>The ones that hurt (${expensive.length})</h3>
      <p class="panel-note">Good matches lost to timing or to a rule.</p>
      ${expensiveRows ? `<div class="table-wrap"><table class="data-table">
        <tr><th>Company</th><th>Role</th><th>Dream fit</th><th>Match</th><th>What happened</th></tr>
        ${expensiveRows}</table></div>` : `<p class="row-empty">None. Nice.</p>`}
    </section>

    <section class="panel">
      <h3>Applications with no reply (${stale.length})</h3>
      <p class="panel-note">Still marked applied, and older than 14 days. Most replies come well before that.</p>
      ${stale.length ? `<div class="table-wrap"><table class="data-table">
        <tr><th>Days</th><th>Company</th><th>Role</th><th>Dream fit</th></tr>
        ${stale.map(({ p, age }) => `<tr>
          <td class="num">${age}d</td>
          <td><a href="#position/${esc(p.id)}">${esc(p.company)}</a></td>
          <td>${esc(p.title)}</td>
          <td class="num">${p.scores ? p.scores.overall : "?"}</td>
        </tr>`).join("")}</table></div>`
        : `<p class="row-empty">Nothing waiting too long</p>`}
    </section>

    ${tips.length ? `<section class="panel conclusions">
      <h3>What the numbers suggest</h3>
      <ol>${tips.join("")}</ol>
    </section>` : ""}

    ${insightsPanel("Ask Claude: \"Look at my lost jobs and write me some insights.\" The advice will appear here.")}

    ${ledgerRows ? `<section class="panel">
      <h3>Full list (${lost.length})</h3>
      <p class="panel-note">Every job that ended without an answer, grouped by what happened.</p>
      <div class="table-wrap"><table class="data-table ledger-table">
        <tr><th>Ended</th><th>Company</th><th>Role</th><th>Cause</th><th>What happened</th></tr>
        ${ledgerRows}</table></div>
    </section>` : ""}
  </div>`;
}

/* ── guide ────────────────────────────────── */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function guideSection(title, body) {
  return `<section class="panel guide-section"><h3>${title}</h3>${body}</section>`;
}

function guideList(rows) {
  return `<dl class="guide-list">${rows.map(([term, text]) =>
    `<dt>${term}</dt><dd>${text}</dd>`).join("")}</dl>`;
}

function renderGuide(root) {
  const c = CAND();
  const first = c.first_name || (c.name || "").split(" ")[0] || "";
  const times = searchTimesText();
  const wd = c.schedule?.weekly_digest || {};
  const weekly = wd.enabled === false
    ? "The weekly email summary is switched off."
    : `Every ${WEEKDAYS[Number(wd.weekday ?? 5)] || "Friday"} at ${esc(fmtClock(wd.time || "10:00"))}, it also reads your recruiting email and writes a short weekly summary for you.`;
  const minAuto = Number(DB.profile?.auto_apply?.min_overall) || 4;
  const autoOn = DB.profile?.auto_apply?.enabled !== false;
  const empty = !DB.positions.length;

  const firstDay = empty ? guideSection("Your first day", `<ol class="guide-steps">
      <li>Leave this page open. Nothing to do yet.</li>
      <li>Your first search runs at ${esc(times)}. If you'd rather not wait, press <b>Search now</b> at the top right. It takes 30 to 90 minutes.</li>
      <li>When it finishes, new jobs appear in the <b>Review</b> tab. Go through them and press <b>Agree</b> or <b>Disagree</b> on each.</li>
      <li>Every Disagree teaches the search what you don't want, so the next results get better.</li>
      <li>Stuck or curious? Open Terminal, type <b>claude</b>, and ask anything in plain words.</li>
    </ol>`) : "";

  root.innerHTML = `<div class="analytics guide">
    <section class="verdict">
      <h2>${first ? `Hi ${esc(first)}. ` : ""}Here is how your job search works.</h2>
      <p>Your computer looks for new jobs for you, scores each one against what you told it you want,
      writes a resume tailored to the good ones, and keeps everything organised on this page. It never
      applies anywhere or contacts anyone unless you press a button that says so.</p>
    </section>

    ${firstDay}

    ${guideSection("When it runs", `<ul class="guide-bullets">
      <li><b>Job search:</b> every day at ${esc(times)}. If your laptop is asleep or closed at that time, it runs as soon as you open it.</li>
      <li><b>Weekly summary:</b> ${weekly}</li>
      <li><b>Applying:</b> only when you press <b>Apply queue now</b>. Nothing is sent while you aren't looking.</li>
      <li><b>Reading email for replies:</b> only when you press <b>Update from email</b>.</li>
      <li>The top left of the page always shows when the last search ran.</li>
    </ul>`)}

    ${guideSection("The tabs", guideList([
      ["Review", "New jobs waiting for your opinion, grouped by Dream fit score from 5 (best) to 1. This is where you spend most of your time."],
      ["Pipeline", "Jobs you said yes to, as columns: Interested, Applied, Screen (first call), Interview, Offer, Disqualified, No answer. The <b>Apply queue now</b> and <b>Update from email</b> buttons live here."],
      ["Startups", "A watchlist of small companies near you that the search checks every day, even if they never post on LinkedIn."],
      ["Archive", "Jobs you said no to, with the reasons you gave. Press <b>Restore</b> to bring one back to Review."],
      ["Screened out", "Jobs the search skipped without scoring: duplicates, and jobs that break one of your hard rules (for example pay too low, or an off-limits industry)."],
      ["Analytics", "Your numbers: how many jobs were found, how many you liked, how many you applied to, and where they came from."],
      ["Rejected", "Applications where a company wrote back to say no. Lined up together, they show patterns."],
      ["Lost", "Jobs that ended without anyone saying no: the posting closed, a sign-in wall got in the way, or no reply after 14 days."],
      ["Guide", "This page."],
    ]))}

    ${guideSection("The scores on every card", `${guideList([
      [`<span class="overall-badge s4 guide-chip">4</span> Dream fit`, "From 1 to 5: how close this is to the job you described in your interview. 5 means a great fit, 1 means a poor one. The square is coloured: 5 is the accent colour, 4 is gold, 3 is slate, 1 and 2 are pale grey. Click the number to change it."],
      [`<span class="worth-badge w3 guide-chip">3</span> Worth applying`, "From 1 to 5: how likely an application is to get a reply, based on the years asked for, company size, pay and location. A green outline means 4 or 5. It learns from which companies actually answer you, so it gets sharper over time. You can't edit this one."],
      [`<span class="match-pct match-high guide-chip">82%</span> Match`, "How much of the job's duties your experience already covers. Green is 80% or more, gold is 60 to 79%, grey is below 60%."],
      ["The four small scores", "int (interests), goal (career goals), loc (location and office days) and comp (pay), each from 1 to 5. Dream fit is built from these."],
    ])}<p class="panel-note">Want the scoring to weigh things differently, for example care more about pay or less about location? Ask Claude: "Change how my jobs are scored."</p>`)}

    ${guideSection("Buttons on the top bar", guideList([
      ["Search now", "Runs a job search right away instead of waiting for the next scheduled time."],
      ["◐", "Switches between light and dark mode."],
    ]))}

    ${guideSection("Buttons on a job card in Review", guideList([
      ["Agree → pipeline", "You like it. It moves to Pipeline as Interested, and a tailored resume and company research are prepared for it."],
      ["Disagree", "You don't want it. Pick what was off (location, pay, industry, level, company size, scope, other) and add a note if you like. The search learns from this."],
      ["Posting ↗", "Opens the original job posting."],
      ["The checkbox", "Select several cards at once. A bar appears at the bottom with <b>Agree</b>, <b>Disagree</b>, <b>Apply for me</b>, <b>Request resume</b> and <b>Clear</b> for all of them. <b>Select all</b> next to each score group selects that whole group."],
      ["Filters above the cards", "Narrow the list by score, work model (remote, hybrid, on-site), pay, company size, date posted, or Easy Apply. <b>Clear filters</b> shows everything again."],
    ]))}

    ${guideSection("Buttons on a job's own page", guideList([
      ["Open posting ↗", "The original job posting."],
      ["Next →", "Jumps to the next job waiting in Review."],
      ["The stage menu", "Moves the job to any stage by hand, for example to Interview after a call you set up yourself."],
      ["Score dots", "Click a dot to change one of the scores. The search remembers you changed it."],
      ["Apply for me", "Adds the job to your apply queue. It is sent the next time you press <b>Apply queue now</b>."],
      ["Prepare tailored resume", "Asks for a resume written for this job. It is ready after the next search, or straight away if you ask Claude."],
      ["Prepare message / Send this message / Copy", "After you apply to a strong match, a short note to the hiring manager is drafted. Edit it, then press Send (or Copy to send it yourself). Nothing is sent until you press Send."],
      ["Add note", "Write anything in the job's diary: a call you had, a name to remember."],
    ]))}

    ${guideSection("Buttons on the Pipeline tab", guideList([
      ["Apply queue now", `Applies to every job waiting in the queue, right now. The number in brackets is how many are waiting. ${autoOn ? `Jobs with a Dream fit of ${minAuto} or 5 are added to the queue automatically after each search;` : "Automatic queueing is switched off;"} everything else is added only when you press <b>Apply</b> or <b>Apply for me</b>. Some applications need you (for example a site that asks for a video); those cards say <b>Needs you</b> with the exact next step.`],
      ["Apply", "On an Interested card: puts that one job in the apply queue."],
      ["Update from email", "Reads your recruiting email and moves cards when a company replied: a screen call, an interview, an offer or a no. It never sends or deletes email."],
    ]))}

    ${guideSection("What the colours mean", guideList([
      ["Green", "Good news: a strong match, applied, a conversation, you meet a requirement."],
      ["Gold", "Worth a look, or something to keep an eye on, like pay not listed."],
      ["Red", "A no, or something that needs you (for example a card that says <b>Needs you</b>)."],
      ["Grey", "Neutral information, or a weak score."],
    ]))}

    ${guideSection("Need help?", `<p>Open Terminal, type <b>claude</b> and press Enter, then ask in plain words. For example:</p>
      <ul class="guide-bullets">
        <li>"Explain how my job search works."</li>
        <li>"Change the search times to 9am and 5pm."</li>
        <li>"I want to care less about pay and more about remote work."</li>
        <li>"Add Project Manager to the job titles I'm looking for."</li>
        <li>"Something looks broken on my dashboard, can you check?"</li>
      </ul>`)}
  </div>`;
}

/* ── router + events ──────────────────────── */
function render() {
  const root = $("#view");
  // brand-new install: start on the Guide so the first thing seen is an explanation
  const hash = location.hash || (DB.positions.length ? "#review" : "#guide");
  document.querySelectorAll(".tabs a").forEach((a) =>
    a.classList.toggle("active", hash.startsWith(a.getAttribute("href"))));
  const brand = $("#brand-sub-name");
  if (brand) {
    const first = CAND().first_name || "";
    brand.textContent = first ? `For ${first}` : "";
    const sep = $(".brand-sep");
    if (sep) sep.hidden = !first;
  }
  $("#count-review").textContent = DB.positions.filter((p) => p.status === "review").length || "";
  $("#count-board").textContent = DB.positions.filter((p) =>
    STAGES.some(([k]) => k === p.status) || p.status === "ongoing").length || "";

  const startupCount = $("#count-startups");
  if (startupCount) startupCount.textContent = DB.startups.length || "";
  const archiveCount = $("#count-archive");
  if (archiveCount) archiveCount.textContent = DB.positions.filter((p) => p.status === "rejected").length || "";
  const ignoredCount = $("#count-ignored");
  if (ignoredCount) ignoredCount.textContent = DB.ignored.length || "";
  const rejCount = $("#count-rejected");
  if (rejCount) rejCount.textContent = rejectedPositions().length || "";
  const lostCount = $("#count-lost");
  if (lostCount) lostCount.textContent = lostPositions().length || "";

  if (hash.startsWith("#position/")) renderDetail(root, hash.slice("#position/".length));
  else if (hash === "#board") renderBoard(root);
  else if (hash === "#archive") renderArchive(root);
  else if (hash === "#startups") renderStartups(root);
  else if (hash === "#ignored") renderIgnored(root);
  else if (hash === "#analytics") renderAnalytics(root);
  else if (hash === "#rejected") renderRejected(root);
  else if (hash === "#lost") renderLost(root);
  else if (hash === "#guide") renderGuide(root);
  else renderReview(root);

  renderBulkBar();
  paintJobControls();
}

function renderBulkBar() {
  const bar = $("#bulkbar");
  const visible = new Set(Array.from(document.querySelectorAll("[data-select]")).map((el) => el.dataset.select));
  for (const id of SELECTED) if (!visible.has(id)) SELECTED.delete(id);

  const picked = selectedPositions();
  bar.classList.toggle("show", picked.length > 0);
  if (!picked.length) { bar.innerHTML = ""; return; }

  const inReview = picked.filter((p) => p.status === "review").length;
  const canApply = picked.filter((p) => p.status === "interested" && !p.apply_requested).length;
  const noResume = picked.filter((p) => !p.resume_path).length;

  bar.innerHTML = `<div class="bulk-main">
    <strong>${picked.length} selected</strong>
    <div class="bulk-actions">
      ${inReview ? `<button class="btn agree" data-bulkagree>Agree → pipeline (${inReview})</button>
        <button class="btn disagree" data-bulkdisagree>Disagree (${inReview})</button>` : ""}
      ${canApply ? `<button class="btn agree" data-bulkapply>Apply for me (${canApply})</button>` : ""}
      ${noResume ? `<button class="btn" data-bulkresume>Request resume (${noResume})</button>` : ""}
      <button class="btn" data-bulkclear>Clear</button>
    </div>
  </div>
  <div class="bulk-slot"></div>`;
}

function openBulkRejectPanel() {
  $(".bulk-slot").innerHTML = `<div class="reject-panel">
    <p>What was off with all ${selectedPositions().filter((p) => p.status === "review").length}? Pick all that apply. The search learns from this.</p>
    <div class="reason-chips">${REJECT_REASONS.map(([k, label]) =>
      `<span class="chip" data-reason="${k}">${label}</span>`).join("")}</div>
    <textarea placeholder="Optional note applied to all…"></textarea>
    <div class="card-actions">
      <button class="btn primary" data-bulkconfirmreject>Confirm</button>
      <button class="btn" data-bulkcancelreject>Cancel</button>
    </div>
  </div>`;
}

function syncListBar(el) {
  const bar = el.closest("[data-listbar]");
  if (!bar) return false;
  const view = bar.dataset.listbar;
  const ui = LIST_UI[view];
  if (!ui) return false;
  if (el.dataset.listq !== undefined) ui.q = el.value;
  if (el.dataset.listsort !== undefined) ui.sort = el.value;
  if (el.dataset.listfilter) ui[el.dataset.listfilter] = el.value;
  if (el.dataset.review) ui[el.dataset.review] = el.value;
  const typing = el.dataset.listq !== undefined;
  refreshListView(view, !typing);
  return true;
}

document.addEventListener("input", (e) => {
  if (e.target.closest("[data-listq]")) syncListBar(e.target);
});

document.addEventListener("change", (e) => {
  const cityAll = e.target.closest("[data-cityall]");
  const cityOpt = e.target.closest("[data-cityopt]");
  if (cityAll || cityOpt) {
    const filter = e.target.closest("[data-cityfilter]");
    if (filter) {
      applyCityChange(filter.dataset.cityfilter, {
        all: Boolean(cityAll),
        city: cityOpt ? cityOpt.dataset.cityopt : "",
        checked: e.target.checked,
      });
    }
    return;
  }
  if (e.target.closest("[data-listbar]") && !e.target.closest("[data-select]")) {
    syncListBar(e.target);
    return;
  }
  const box = e.target.closest("[data-select]");
  if (!box) return;
  if (box.checked) SELECTED.add(box.dataset.select);
  else SELECTED.delete(box.dataset.select);
  box.closest(".card, .row-item, .kb-card").classList.toggle("selected", box.checked);
  renderBulkBar();
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-diary]");
  if (!form) return;
  e.preventDefault();
  const text = (form.querySelector("textarea")?.value || "").trim();
  if (!text) return;
  await patch(form.dataset.diary, { diary_note: text });
  toast("Note saved");
  render();
});

document.addEventListener("click", async (e) => {
  const cityToggle = e.target.closest("[data-citytoggle]");
  if (cityToggle) {
    const filter = cityToggle.closest("[data-cityfilter]");
    const open = cityToggle.getAttribute("aria-expanded") !== "true";
    document.querySelectorAll("[data-cityfilter]").forEach((el) => {
      setCityMenuOpen(el, el === filter && open);
    });
    return;
  }
  if (!e.target.closest("[data-cityfilter]")) {
    document.querySelectorAll("[data-cityfilter]").forEach((el) => setCityMenuOpen(el, false));
  }
  if (e.target.closest("[data-listdir]")) {
    const bar = e.target.closest("[data-listbar]");
    if (bar && LIST_UI[bar.dataset.listbar]) {
      const ui = LIST_UI[bar.dataset.listbar];
      ui.dir = ui.dir === "asc" ? "desc" : "asc";
      refreshListView(bar.dataset.listbar, true);
    }
    return;
  }
  const clearBtn = e.target.closest("[data-listclear]");
  if (clearBtn) {
    const view = clearBtn.dataset.listclear
      || clearBtn.closest("[data-listbar]")?.dataset.listbar
      || "review";
    resetListView(view);
    return;
  }
  const headSort = e.target.closest("th[data-listsort]");
  if (headSort) {
    const table = headSort.closest("table");
    const view = table?.querySelector("[data-listrows]")?.dataset.listrows;
    const ui = view && LIST_UI[view];
    if (ui) {
      const key = headSort.dataset.listsort;
      if (ui.sort === key) ui.dir = ui.dir === "asc" ? "desc" : "asc";
      else {
        ui.sort = key;
        ui.dir = ["date", "score", "worth", "match", "size", "pay", "posted"].includes(key) ? "desc" : "asc";
      }
      refreshListView(view, true);
    }
    return;
  }

  const run = e.target.closest("[data-runjob]");
  if (run) {
    const name = run.dataset.runjob;
    if (name === "apply") {
      const queued = Number(jobState("apply").queued) || 0;
      if (!queued) { toast("Nothing is waiting to apply."); return; }
      const ok = window.confirm(
        `Apply to the ${queued} role${queued === 1 ? "" : "s"} waiting in the queue right now? This sends real applications.`
      );
      if (!ok) return;
    }
    await startJob(name);
    return;
  }

  const b = e.target.closest("[data-selectband],[data-bulkagree],[data-bulkdisagree],[data-bulkapply],[data-bulkresume],[data-bulkclear],[data-bulkconfirmreject],[data-bulkcancelreject]");
  if (b) {
    if (b.dataset.selectband !== undefined) {
      const n = Number(b.dataset.selectband);
      const group = visibleReview().filter((p) => p.scores.overall === n);
      const allSelected = group.every((p) => SELECTED.has(p.id));
      group.forEach((p) => allSelected ? SELECTED.delete(p.id) : SELECTED.add(p.id));
      render();
      return;
    }
    if (b.hasAttribute("data-bulkclear")) { SELECTED.clear(); render(); return; }
    if (b.hasAttribute("data-bulkdisagree")) { openBulkRejectPanel(); return; }
    if (b.hasAttribute("data-bulkcancelreject")) { $(".bulk-slot").innerHTML = ""; return; }

    if (b.hasAttribute("data-bulkagree")) {
      const targets = selectedPositions().filter((p) => p.status === "review");
      const n = await patchMany(targets, (p) => ({ status: "interested", ...(!p.resume_path && { resume_requested: true }) }));
      SELECTED.clear();
      toast(`${n} moved to Pipeline. Resumes and research are on the way.`);
      render();
      return;
    }
    if (b.hasAttribute("data-bulkapply")) {
      const targets = selectedPositions().filter((p) => p.status === "interested" && !p.apply_requested);
      const n = await patchMany(targets, (p) => ({ apply_requested: true, ...(!p.resume_path && { resume_requested: true }) }));
      SELECTED.clear();
      toast(`${n} added to the apply queue. Press Apply queue now on the Pipeline tab to send.`);
      render();
      return;
    }
    if (b.hasAttribute("data-bulkresume")) {
      const targets = selectedPositions().filter((p) => !p.resume_path);
      const n = await patchMany(targets, () => ({ resume_requested: true }));
      SELECTED.clear();
      toast(`${n} tailored resumes queued`);
      render();
      return;
    }
    if (b.hasAttribute("data-bulkconfirmreject")) {
      const panel = b.closest(".reject-panel");
      const reasons = Array.from(panel.querySelectorAll(".chip.on")).map((c) => c.dataset.reason);
      if (!reasons.length) { toast("Pick at least one reason"); return; }
      const note = panel.querySelector("textarea").value.trim() || null;
      const targets = selectedPositions().filter((p) => p.status === "review");
      const n = await patchMany(targets, () => ({ status: "rejected", reject_reasons: reasons, reject_note: note }));
      SELECTED.clear();
      toast(`${n} moved to Archive. Similar jobs will score lower from now on.`);
      render();
      return;
    }
  }

  const t = e.target.closest("[data-agree],[data-disagree],[data-confirmreject],[data-cancelreject],[data-reason],[data-setscore],[data-editscore],[data-restore],[data-requestresume],[data-requestapply],[data-prepareoutreach],[data-sendoutreach],[data-copyoutreach]");
  if (!t) return;

  if (t.dataset.prepareoutreach) {
    await patch(t.dataset.prepareoutreach, { outreach_action: "prepare" });
    toast("Message drafted. Review it, then tap Send.");
    render();
    return;
  }
  if (t.dataset.copyoutreach) {
    const box = document.querySelector(`[data-outreach-msg="${CSS.escape(t.dataset.copyoutreach)}"]`);
    const text = box ? box.value : "";
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    }
    return;
  }
  if (t.dataset.sendoutreach) {
    const box = document.querySelector(`[data-outreach-msg="${CSS.escape(t.dataset.sendoutreach)}"]`);
    const message = box ? box.value.trim() : "";
    await patch(t.dataset.sendoutreach, { outreach_action: "send", outreach_message: message });
    toast("Queued to send. The apply job will send the LinkedIn note.");
    render();
    return;
  }

  if (t.dataset.requestapply) {
    const pos = DB.positions.find((x) => x.id === t.dataset.requestapply);
    const needsResume = pos && !pos.resume_path;
    await patch(t.dataset.requestapply, { apply_requested: true, ...(needsResume && { resume_requested: true }) });
    toast(needsResume
      ? "Added to the apply queue. A tailored resume is made first."
      : "Added to the apply queue. Press Apply queue now to send.");
    render();
    return;
  }

  if (t.dataset.agree) {
    const pos = DB.positions.find((x) => x.id === t.dataset.agree);
    const needsResume = pos && !pos.resume_path;
    const onDetail = location.hash.startsWith("#position/");
    const next = nextAfter(t.dataset.agree);
    await patch(t.dataset.agree, { status: "interested", ...(needsResume && { resume_requested: true }) });
    toast(needsResume
      ? "Moved to Pipeline. A tailored resume and company research are on the way."
      : "Moved to Pipeline. Company research is on the way.");
    advanceTo(next, onDetail);
    return;
  } else if (t.dataset.requestresume) {
    await patch(t.dataset.requestresume, { resume_requested: true });
    toast("Resume requested. It's ready after the next search, or ask Claude now.");
    render();
  } else if (t.dataset.disagree) {
    openRejectPanel(t.closest(".card, .detail"), t.dataset.disagree);
  } else if (t.dataset.reason !== undefined) {
    t.classList.toggle("on");
  } else if (t.dataset.cancelreject !== undefined) {
    t.closest(".reject-slot").innerHTML = "";
  } else if (t.dataset.confirmreject) {
    const panel = t.closest(".reject-panel");
    const reasons = [...panel.querySelectorAll(".chip.on")].map((c) => c.dataset.reason);
    const note = panel.querySelector("textarea").value.trim() || null;
    const onDetail = location.hash.startsWith("#position/");
    const next = nextAfter(t.dataset.confirmreject);
    await patch(t.dataset.confirmreject, { status: "rejected", reject_reasons: reasons, reject_note: note });
    toast(next ? "Got it. Next one up." : "Got it. Future scores will take that into account.");
    advanceTo(next, onDetail);
  } else if (t.dataset.setscore) {
    const [id, dim, n] = t.dataset.setscore.split("|");
    await patch(id, { scores: { [dim]: Number(n) } });
    render();
  } else if (t.dataset.editscore) {
    const id = t.dataset.editscore;
    const p = DB.positions.find((x) => x.id === id);
    const answer = prompt(`Dream fit for ${p.company}, from 1 (poor) to 5 (great):`, p.scores.overall);
    const n = Number(answer);
    if (answer !== null && Number.isInteger(n) && n >= 1 && n <= 5) {
      await patch(id, { scores: { overall: n } });
      render();
    }
  } else if (t.dataset.restore) {
    await patch(t.dataset.restore, { status: "review" });
    toast("Back in the review queue");
    render();
  }
});

document.addEventListener("click", (e) => {
  const row = e.target.closest(".row-item, .kb-card");
  if (!row || e.target.closest("a,button,label,input,select,.sel-box")) return;
  location.hash = `#position/${row.dataset.id}`;
});

document.addEventListener("change", async (e) => {
  if (e.target.dataset.stagefor) {
    await patch(e.target.dataset.stagefor, { status: e.target.value });
    toast(`Moved to ${(STAGE_LABEL[e.target.value] || e.target.value).replace("_", " ")}`);
    render();
  }
});

/* theme */
const themeBtn = $("#theme-toggle");
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem("js-theme", mode); } catch (_) { /* private window */ }
}
themeBtn.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
let savedTheme = null;
try { savedTheme = localStorage.getItem("js-theme"); } catch (_) { /* private window */ }
applyTheme(savedTheme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

/* the position header sticks directly under the topbar, whose height changes
   when the nav wraps — measure it rather than hard-coding an offset */
function syncTopbarHeight() {
  const bar = document.querySelector(".topbar");
  if (bar) document.documentElement.style.setProperty("--topbar-h", `${Math.round(bar.offsetHeight)}px`);
}
addEventListener("resize", syncTopbarHeight);
syncTopbarHeight();

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll("[data-cityfilter]").forEach((el) => setCityMenuOpen(el, false));
  }
});

window.addEventListener("hashchange", render);
load().then(() => {
  render();
  if (anyJobRunning()) startJobPoll();
}).catch(() => {
  $("#view").innerHTML = `<div class="empty"><h2>Can't reach the server</h2>
    <p>The dashboard isn't answering. It normally restarts itself, so try reloading in a few seconds.
    If it's still down, open Terminal, type <b>claude</b>, and say "my dashboard isn't loading".</p></div>`;
});
