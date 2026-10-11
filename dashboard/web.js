"use strict";

/* Web mode additions to the panel (loaded before app.js, only in web mode).
 *
 * Adds the My answers tab, the Assistant drawer (a chat that can change
 * anything), Sign out, the Portuguese translation of the panel, and a Guide
 * that points at the Assistant instead of a Desktop icon. Talks to
 * /api/answers, /api/chat and /api/gmail (dashboard/webmode.py).
 */

(function () {
  const T = (s) => window.I18N.t(s);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const A = { data: null, dirty: false, saving: false };

  /* ── My answers ─────────────────────────────────────────────────────── */

  const SOURCES = [
    ["linkedin_sweep", "LinkedIn job search (without signing in)"],
    ["linkedin_alert_emails", "LinkedIn job alert emails in my Gmail"],
    ["yc_jobs", "Y Combinator startup jobs"],
    ["wellfound", "Wellfound startup jobs"],
    ["communitech", "Communitech (Canadian tech)"],
    ["startup_watch", "Small local startups watchlist"],
  ];

  function pairRow(kind, a, b, pa, pb) {
    return `<div class="ans-item" data-row="${kind}">
      <input class="field" data-k="a" value="${esc(a)}" placeholder="${esc(T(pa))}">
      <input class="field" data-k="b" value="${esc(b)}" placeholder="${esc(T(pb))}">
      <button type="button" class="btn small" data-web="remove" title="${esc(T("Remove"))}" aria-label="${esc(T("Remove"))}">×</button>
    </div>`;
  }

  function answersHtml() {
    const d = A.data;
    if (!d) return `<p class="empty">${esc(T("Reading the board."))}</p>`;
    const g = d.gmail || {};
    const cur = esc(d.currency || "CAD");
    return `<form class="answers" id="answers" autocomplete="off">
      <p class="intro">${esc(T("Everything the search uses to find and score jobs for you. Change anything and press Save. For anything not here, ask the assistant."))}</p>

      ${d.summary ? `<div class="ans-group"><h3>${esc(T("What the assistant understood about you"))}</h3><p class="ans-summary" data-no-i18n>${esc(d.summary)}</p></div>` : ""}

      <div class="ans-group">
        <h3>${esc(T("Job titles to search for"))}</h3>
        <p class="hint">${esc(T("One per line works best: the titles a company would put on the posting."))}</p>
        <textarea class="field" name="titles" rows="5" data-no-i18n>${esc((d.titles || []).join("\n"))}</textarea>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Companies I am interested in"))}</h3>
        <p class="hint">${esc(T("The search checks their careers pages for roles like yours, and a job at one of these scores a little higher."))}</p>
        <div class="ans-list" id="companies" data-no-i18n>${(d.companies || []).map((c) => pairRow("company", c.name, c.url, "Company name", "Careers page link (optional)")).join("")}</div>
        <div><button type="button" class="btn outlined small" data-web="add-company">+ ${esc(T("Add a company"))}</button></div>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Other job sites to check"))}</h3>
        <p class="hint">${esc(T("Any site with job listings: a job board, a company page, a search you saved."))}</p>
        <div class="ans-list" id="sites" data-no-i18n>${(d.sites || []).map((s) => pairRow("site", s.url, s.note, "Link", "What to look for there (optional)")).join("")}</div>
        <div><button type="button" class="btn outlined small" data-web="add-site">+ ${esc(T("Add a site"))}</button></div>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Where I want to work"))}</h3>
        <div class="ans-grid">
          <label>${esc(T("Home area (city or region)"))}<input class="field" name="home_label" value="${esc(d.home_label)}" data-no-i18n></label>
          <label>${esc(T("How far I would travel (km)"))}<input class="field" name="radius_km" type="number" min="0" max="500" value="${esc(d.radius_km)}"></label>
          <label>${esc(T("Office days a week, at most"))}<select class="field" name="max_office_days">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${Number(d.max_office_days) === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="relocate" ${d.relocate ? "checked" : ""}>${esc(T("I would move for the right job"))}</label>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Pay"))} (${cur})</h3>
        <div class="ans-grid">
          <label>${esc(T("Lowest yearly pay I would accept"))}<input class="field" name="pay_floor" inputmode="numeric" value="${d.pay_floor ? esc(d.pay_floor) : ""}" placeholder="80000"></label>
          <label>${esc(T("Yearly pay that would make me really happy"))}<input class="field" name="pay_goal" inputmode="numeric" value="${d.pay_goal ? esc(d.pay_goal) : ""}" placeholder="100000"></label>
        </div>
        <p class="hint">${esc(T("Jobs that do not show pay are never held against a job."))}</p>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Industries I will not work in"))}</h3>
        <textarea class="field" name="off_limits" rows="3" data-no-i18n>${esc((d.off_limits || []).join("\n"))}</textarea>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Where to look"))}</h3>
        ${SOURCES.map(([k, l]) => `<label class="check"><input type="checkbox" data-source="${k}" ${d.sources && d.sources[k] ? "checked" : ""}>${esc(T(l))}</label>`).join("")}
        <div class="gmail-line">
          <b>${esc(T("Gmail"))}:</b>
          ${g.connected
            ? `<span>${esc(T("Connected as"))} <span data-no-i18n>${esc(g.email)}</span></span><button type="button" class="btn small" data-web="gmail-off">${esc(T("Disconnect"))}</button>`
            : `<span class="cap">${esc(T("Not connected. The search uses it to read job alert emails and replies from companies. It can only read; it cannot send or delete anything."))}</span>
               <a class="btn contained small" href="/oauth/google/start">${esc(T("Connect Gmail"))}</a>`}
        </div>
      </div>

      <div class="ans-group">
        <h3>${esc(T("When the search runs"))}</h3>
        <p class="hint">${esc(T("Times of day, like 08:00 and 16:00."))}</p>
        <div class="ans-grid">${[0, 1, 2].map((i) => `<input class="field" type="time" data-time="${i}" value="${esc((d.search_times || [])[i] || "")}">`).join("")}</div>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Language"))}</h3>
        <div class="row-actions">
          <label class="check"><input type="radio" name="language" value="pt" ${d.language === "pt" ? "checked" : ""}>Português</label>
          <label class="check"><input type="radio" name="language" value="en" ${d.language !== "pt" ? "checked" : ""}>English</label>
        </div>
      </div>

      <div class="ans-group">
        <h3>${esc(T("Anything else, in your own words"))}</h3>
        <p class="hint">${esc(T("Ask for any change in your own words, for example \"I also want remote jobs in the US\" or \"Add this job: <link>\"."))}</p>
        <div><button type="button" class="btn outlined small" data-web="assistant">${esc(T("Ask the assistant"))}</button></div>
      </div>

      <div class="ans-save">
        <button type="submit" class="btn contained" id="ans-save">${esc(T("Save"))}</button>
        <span class="cap" id="ans-note">${A.dirty ? esc(T("Unsaved changes")) : ""}</span>
      </div>
    </form>`;
  }

  async function loadAnswers(root) {
    try {
      const res = await fetch("/api/answers", { cache: "no-store" });
      if (res.status === 401) { location.href = "/login"; return; }
      A.data = await res.json();
    } catch (_) {
      A.data = null;
    }
    A.dirty = false;
    root.innerHTML = answersHtml();
  }

  function collect() {
    const f = document.getElementById("answers");
    const lines = (name) => f.elements[name].value.split("\n").map((x) => x.trim()).filter(Boolean);
    const pairs = (kind) => [...f.querySelectorAll(`[data-row="${kind}"]`)].map((r) => [r.querySelector('[data-k="a"]').value.trim(), r.querySelector('[data-k="b"]').value.trim()]).filter(([a]) => a);
    const sources = {};
    f.querySelectorAll("[data-source]").forEach((el) => { sources[el.dataset.source] = el.checked; });
    const lang = (f.querySelector('input[name="language"]:checked') || {}).value || "en";
    return {
      titles: lines("titles"),
      companies: pairs("company").map(([name, url]) => ({ name, url })),
      sites: pairs("site").map(([url, note]) => ({ url, note })),
      home_label: f.elements.home_label.value,
      radius_km: f.elements.radius_km.value,
      max_office_days: f.elements.max_office_days.value,
      relocate: f.elements.relocate.checked,
      pay_floor: f.elements.pay_floor.value,
      pay_goal: f.elements.pay_goal.value,
      off_limits: lines("off_limits"),
      sources,
      search_times: [...f.querySelectorAll("[data-time]")].map((el) => el.value).filter(Boolean),
      language: lang,
    };
  }

  async function saveAnswers() {
    if (A.saving) return;
    A.saving = true;
    const btn = document.getElementById("ans-save");
    if (btn) btn.disabled = true;
    const body = collect();
    let ok = false;
    let said = "";
    try {
      const res = await fetch("/api/answers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      ok = res.ok;
      said = ok ? T(out.reschedule ? "Saved. The new search times are switched on." : "Saved. The next search uses your new answers.") : `${T("Did not save:")} ${out.error || res.status}`;
    } catch (_) {
      said = `${T("Did not save:")} ${T("The page is not answering. Check that you are on the home Wi-Fi.")}`;
    }
    A.saving = false;
    toast(said);
    if (ok) {
      const langChanged = body.language !== document.documentElement.dataset.lang;
      if (langChanged) { location.reload(); return; }
      const root = document.getElementById("content");
      await loadAnswers(root);
    } else if (btn) btn.disabled = false;
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._wt);
    el._wt = setTimeout(() => el.classList.remove("show"), 6000);
  }

  /* ── the Assistant drawer ───────────────────────────────────────────── */

  let drawer = null;
  function openAssistant() {
    if (drawer) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="drawer-scrim" data-web="close-assistant"></div>
      <aside class="drawer" role="dialog" aria-label="${esc(T("Assistant"))}">
        <div class="chat-head">
          <h1><span class="hero-dot"></span>${esc(T("Assistant"))}</h1>
          <div class="actions">
            <button class="btn small" data-web="restart-assistant">${esc(T("Start over"))}</button>
            <button class="btn icon" data-web="close-assistant" aria-label="${esc(T("Close"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          </div>
        </div>
        <p class="chat-note">${esc(T("Ask for any change in your own words, for example \"I also want remote jobs in the US\" or \"Add this job: <link>\"."))}</p>
        <div id="assistant-chat" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>
      </aside>`;
    document.body.appendChild(wrap);
    document.body.style.overflow = "hidden";
    const chat = window.JSChat.mount(wrap.querySelector("#assistant-chat"), { mode: "assistant" });
    drawer = { wrap, chat };
    chat.focus();
  }
  function closeAssistant() {
    if (!drawer) return;
    drawer.chat.destroy();
    drawer.wrap.remove();
    drawer = null;
    document.body.style.overflow = "";
    // What the assistant changed should show straight away.
    document.getElementById("btn-refresh")?.click();
    if (location.hash === "#answers") loadAnswers(document.getElementById("content"));
  }

  /* ── Guide words for web mode ──────────────────────────────────────── */

  function guide(html, g) {
    const helpEn = `<div><h3>Need help?</h3><p>Press <b>Assistant</b> at the top and ask in plain words, for example "Change the search times to 9am and 5pm", "I care less about pay and more about remote work", or "Add this job: &lt;link&gt;". To change your answers yourself, open <b>My answers</b>.</p></div>`;
    if (I18N.lang() !== "pt") return html.replace(/<div><h3>Need help\?<\/h3>[\s\S]*?<\/div>\s*<\/div>\s*$/, `${helpEn}</div>`);
    const name = g.first ? `Oi, ${esc(g.first)}. ` : "";
    // "9:00 am and 5:00 pm" reads as "9h e 17h" in Portuguese.
    g = { ...g, times: String(g.times || "").replace(/(\d{1,2}):(\d{2}) (am|pm)/g, (_, h, m, ap) => {
      const hh = (Number(h) % 12) + (ap === "pm" ? 12 : 0);
      return m === "00" ? `${hh}h` : `${hh}h${m}`;
    }).replace(/ and /g, " e ") };
    return `<div class="guide" data-no-i18n>
      <div><h2>${name}Veja como funciona a sua busca de emprego.</h2>
        <p>Um computador aqui de casa procura vagas para você, dá uma nota para cada uma conforme o que você disse que quer, prepara um currículo adaptado para as boas e mostra tudo nesta página. Ele nunca se candidata nem fala com ninguém sem você clicar num botão que diga isso.</p></div>
      ${g.empty ? `<div><h3>O primeiro dia</h3><ol>
        <li>Nada para fazer ainda.</li>
        <li>A primeira busca acontece às ${esc(g.times)}. Se não quiser esperar, clique em <b>Buscar agora</b> lá em cima. Leva de 30 a 90 minutos.</li>
        <li>Quando terminar, as vagas novas aparecem em <b>Revisar</b>. Em cada uma, clique em <b>Candidatar-me</b>, <b>Tenho interesse</b> ou <b>Não é pra mim</b>.</li>
        <li>Cada <b>Não é pra mim</b> ensina a busca o que você não quer, e os próximos resultados melhoram.</li>
      </ol></div>` : ""}
      <div><h3>Quando ela roda</h3><ul>
        <li><b>Busca de vagas:</b> todo dia às ${esc(g.times)}.</li>
        <li><b>Candidaturas:</b> só quando você clica em <b>Enviar candidaturas</b>. Nada é enviado sem você ver.</li>
        <li><b>Leitura do e-mail:</b> só quando você clica em <b>Verificar e-mail agora</b>, na aba Andamento.</li>
      </ul></div>
      <div><h3>As abas</h3><dl>
        <dt>Revisar</dt><dd>Vagas novas esperando sua opinião, com as maiores notas primeiro. É aqui que você passa mais tempo.</dd>
        <dt>Andamento</dt><dd>Vagas em que você disse sim, por etapa: Interesse, Enviada, Primeira conversa, Entrevista, Oferta.</dd>
        <dt>Fila de envio</dt><dd>Vagas esperando para serem enviadas e, durante um envio, em qual delas ele está.</dd>
        <dt>Enviadas</dt><dd>Todas as candidaturas enviadas, das mais novas para as mais antigas.</dd>
        <dt>Recusadas por mim / pela empresa</dt><dd>As que você recusou, com seus motivos, e as em que a empresa respondeu que não.</dd>
        <dt>Perdidas</dt><dd>As que terminaram sem ninguém dizer não: a vaga fechou ou não houve resposta.</dd>
        <dt>Minhas respostas</dt><dd>Tudo o que você contou na entrevista: cargos, empresas, sites, salário, horários. Mude quando quiser.</dd>
      </dl></div>
      <div><h3>Os números em cada vaga</h3><dl>
        <dt>Nota de 1 a 5</dt><dd>O quanto a vaga se parece com o que você descreveu. Verde em 4 e 5, amarelo em 3. Embaixo, uma linha explica a nota (em inglês, como a vaga).</dd>
        <dt>% compatível</dt><dd>Quanto das tarefas da vaga a sua experiência já cobre.</dd>
        <dt>Mudar uma nota</dt><dd>Abra a vaga e clique num ponto. Sua nota vale, e a próxima busca aprende com ela.</dd>
      </dl></div>
      <div><h3>Precisa de ajuda?</h3><p>Clique em <b>Assistente</b> lá em cima e peça com suas palavras, por exemplo "muda os horários da busca para 9h e 17h", "salário importa menos, quero trabalho remoto" ou "adicione esta vaga: &lt;link&gt;".</p></div>
    </div>`;
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */

  window.JobSearchExtra = {
    tabs: [{
      key: "answers",
      label: "My answers",
      render: () => answersHtml(),
      after: (root) => loadAnswers(root),
    }],
    guide,
  };

  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-web]");
    if (!el) return;
    const act = el.dataset.web;
    if (act === "assistant") openAssistant();
    else if (act === "close-assistant") closeAssistant();
    else if (act === "restart-assistant") {
      if (!confirm(T("Start this conversation over? What you already saved stays saved."))) return;
      await fetch("/api/chat/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "assistant" }) });
      closeAssistant();
      openAssistant();
    } else if (act === "logout") {
      await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      location.href = "/login";
    } else if (act === "remove") {
      el.closest(".ans-item").remove();
      markDirty();
    } else if (act === "add-company" || act === "add-site") {
      const list = document.getElementById(act === "add-company" ? "companies" : "sites");
      list.insertAdjacentHTML("beforeend", act === "add-company"
        ? pairRow("company", "", "", "Company name", "Careers page link (optional)")
        : pairRow("site", "", "", "Link", "What to look for there (optional)"));
      list.lastElementChild.querySelector("input").focus();
      markDirty();
    } else if (act === "gmail-off") {
      if (!confirm(T("Disconnect Gmail? The search will stop reading job alert emails and replies."))) return;
      await fetch("/api/gmail/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      loadAnswers(document.getElementById("content"));
    }
  });
  function markDirty() {
    A.dirty = true;
    const note = document.getElementById("ans-note");
    if (note) note.textContent = T("Unsaved changes");
  }
  document.addEventListener("input", (e) => { if (e.target.closest("#answers")) markDirty(); });
  document.addEventListener("change", (e) => { if (e.target.closest("#answers")) markDirty(); });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "answers") return;
    e.preventDefault();
    saveAnswers();
  });
  window.addEventListener("beforeunload", (e) => {
    if (A.dirty && location.hash === "#answers") { e.preventDefault(); e.returnValue = ""; }
  });

  document.addEventListener("DOMContentLoaded", () => {
    const actions = document.querySelector(".head .actions");
    if (actions) {
      actions.insertAdjacentHTML("afterbegin", `<button class="btn outlined" data-web="assistant" title="${esc(T("Ask the assistant"))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>${esc(T("Assistant"))}</span></button>`);
      actions.insertAdjacentHTML("beforeend", `<button class="btn icon" data-web="logout" title="${esc(T("Sign out"))}" aria-label="${esc(T("Sign out"))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg></button>`);
    }
    const src = document.getElementById("source-line");
    if (src) src.hidden = true;
    const q = new URLSearchParams(location.search);
    if (q.get("gmail") === "connected") toast(T("Gmail is connected."));
    if (q.get("gmail") === "error") toast(`${T("Gmail was not connected:")} ${q.get("why") || ""}`);
    if (q.get("gmail")) history.replaceState(null, "", location.pathname + location.hash);
    window.I18N.watch();
  });
})();
