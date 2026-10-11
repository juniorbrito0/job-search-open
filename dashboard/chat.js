"use strict";

/* The chat with the job search assistant (web mode).
 *
 * Used twice: full page for the first-run interview (welcome.html) and as the
 * Assistant drawer on the panel (web.js). Talks to /api/chat; the server runs
 * one Claude turn at a time and streams it into memory, so this just polls.
 *
 * Claude can end a message with markers the server turns into structure:
 * choices (tap-to-answer buttons), buttons (Connect Gmail, Upload my resume,
 * Open my panel, Search now) and files (a link to a resume PDF).
 */

(function () {
  const T = (s) => (window.I18N ? window.I18N.t(s) : s);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* Just enough Markdown for chat: paragraphs, bullets, numbers, bold, italics, links. */
  function md(text) {
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?]|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    for (const line of String(text || "").split("\n")) {
      const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flush();
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      } else if (!line.trim()) {
        flush();
        close();
      } else {
        close();
        para.push(line.replace(/^#+\s*/, ""));
      }
    }
    flush();
    close();
    return out.join("");
  }

  const BUTTON_LABEL = {
    "connect-gmail": "Connect Gmail",
    "upload-resume": "Upload my resume",
    "open-panel": "Open my job search panel",
    "search-now": "Search for jobs now",
  };
  const ALLOWED = [".pdf", ".docx", ".doc", ".txt", ".rtf", ".md", ".odt", ".pages", ".png", ".jpg", ".jpeg"];

  function mount(root, opts) {
    const mode = opts.mode;
    const st = { messages: [], busy: false, partial: "", status: "", error: "", sending: false, started: false, local: null };
    root.innerHTML = `<div class="chat">
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-err" hidden></div>
      <form class="chat-input">
        <input type="file" hidden accept="${ALLOWED.join(",")}">
        <button type="button" class="btn icon" data-chat="attach" title="${esc(T("Attach a file"))}" aria-label="${esc(T("Attach a file"))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
        </button>
        <textarea class="field" rows="1" placeholder="${esc(T("Type your answer"))}"></textarea>
        <button type="submit" class="btn contained">${esc(T("Send"))}</button>
      </form>
    </div>`;
    const log = root.querySelector(".chat-log");
    const err = root.querySelector(".chat-err");
    const form = root.querySelector("form");
    const box = root.querySelector("textarea");
    const file = root.querySelector("input[type=file]");
    let lastPaint = "";

    function showError(msg) {
      err.textContent = msg || "";
      err.hidden = !msg;
    }

    function messageHtml(m, isLast) {
      if (m.role === "user") {
        const att = m.attachment ? `<span class="att">📎 ${esc(m.attachment)}</span>` : "";
        const text = m.attachment ? "" : md(m.text);
        return `<div class="msg user">${att}${text}</div>`;
      }
      const live = isLast && !st.busy;
      const choices = (m.choices || []).map((c) => `<button class="choice" data-chat="choice" data-v="${esc(c)}" ${live ? "" : "disabled"}>${esc(c)}</button>`).join("");
      const buttons = (m.buttons || []).map((b) => `<button class="btn ${b === "open-panel" || b === "connect-gmail" ? "contained" : "outlined"} small" data-chat="button" data-v="${esc(b)}" ${live || b === "open-panel" ? "" : "disabled"}>${esc(T(BUTTON_LABEL[b] || b))}</button>`).join("");
      const files = (m.files || []).map((f) => `<a class="btn outlined small" href="/files/${encodeURI(f)}" target="_blank" rel="noopener">📄 ${esc(f.split("/").pop())}</a>`).join("");
      const actions = choices || buttons || files ? `<div class="msg-actions">${buttons}${files}${choices}</div>` : "";
      return `<div class="msg assistant" data-no-i18n>${md(m.text)}${actions}</div>`;
    }

    function paint() {
      const msgs = st.local ? st.messages.concat([st.local]) : st.messages;
      let html = msgs.map((m, i) => messageHtml(m, i === msgs.length - 1)).join("");
      if (st.busy || st.sending) {
        const status = st.status ? T(st.status) : T("thinking");
        html += `<div class="msg assistant typing" data-no-i18n>${st.partial ? md(st.partial) : ""}
          <div class="status"><span class="dots-anim"><span></span><span></span><span></span></span>${esc(status)}</div></div>`;
      }
      if (html === lastPaint) return;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      lastPaint = html;
      log.innerHTML = html;
      if (atBottom || st.sending) log.scrollTop = log.scrollHeight;
      form.querySelector("[type=submit]").disabled = st.busy || st.sending;
    }

    async function refresh() {
      try {
        const res = await fetch(`/api/chat?mode=${mode}`, { cache: "no-store" });
        if (res.status === 401) { location.href = "/login"; return; }
        const body = await res.json();
        st.messages = body.messages || [];
        st.busy = Boolean(body.busy);
        st.partial = body.partial || "";
        st.status = body.status || "";
        if (!st.busy) st.local = null;
        showError(body.error ? `${T("Something went wrong:")} ${body.error}` : "");
        paint();
        if (!st.started && opts.autoStart && !st.messages.length && !st.busy && !body.other_busy) {
          st.started = true;
          send(opts.autoStart(), { hidden: true });
        }
        if (opts.onState) opts.onState(body);
      } catch (_) {
        showError(T("The page is not answering. Check that you are on the home Wi-Fi."));
      }
    }

    async function send(text, extra = {}) {
      text = String(text || "").trim();
      if (!text || st.busy || st.sending) return;
      st.sending = true;
      if (!extra.hidden) st.local = { role: "user", text, attachment: extra.attachment };
      paint();
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, text, hidden: Boolean(extra.hidden), attachment: extra.attachment || null }),
        });
        if (res.status === 409) showError(T("The assistant is busy with another conversation. Try again in a minute."));
        else if (!res.ok) showError(`${T("Something went wrong:")} ${res.status}`);
      } catch (_) {
        showError(T("The page is not answering. Check that you are on the home Wi-Fi."));
      }
      st.sending = false;
      await refresh();
    }

    async function upload(f) {
      const ext = (f.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      if (!ALLOWED.includes(ext)) { showError(T("That file type is not supported. Use PDF, Word or a text file.")); return; }
      if (f.size > 15 * 1024 * 1024) { showError(T("That file is too big (15 MB at most).")); return; }
      st.sending = true;
      st.status = "Uploading";
      paint();
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        const body = await res.json();
        st.sending = false;
        if (!res.ok) throw new Error(body.error || res.status);
        await send(`I uploaded a file: ${body.path} (it was called "${body.name}"). Please read it.`, { attachment: body.name });
      } catch (_) {
        st.sending = false;
        showError(T("The upload did not work. Try again."));
        paint();
      }
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = box.value;
      box.value = "";
      box.style.height = "";
      send(text);
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    box.addEventListener("input", () => {
      box.style.height = "auto";
      box.style.height = `${Math.min(180, box.scrollHeight)}px`;
    });
    file.addEventListener("change", () => {
      if (file.files && file.files[0]) upload(file.files[0]);
      file.value = "";
    });
    root.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-chat]");
      if (!el || el.disabled) return;
      const act = el.dataset.chat;
      if (act === "attach") file.click();
      else if (act === "choice") send(el.dataset.v);
      else if (act === "button") {
        const v = el.dataset.v;
        if (v === "connect-gmail") location.href = "/oauth/google/start";
        else if (v === "upload-resume") file.click();
        else if (v === "open-panel") location.href = "/";
        else if (v === "search-now") {
          el.disabled = true;
          await fetch("/api/jobs/scan", { method: "POST", headers: { "Content-Type": "application/json" } });
          send("I pressed Search now.");
        }
        if (opts.onAction) opts.onAction(v);
      }
    });

    refresh();
    let timer = null;
    let alive = true;
    const loop = () => {
      clearTimeout(timer);
      if (!alive) return;
      timer = setTimeout(async () => {
        if (!document.hidden || st.busy) await refresh();
        loop();
      }, st.busy || st.sending ? 900 : 5000);
    };
    loop();
    return { send, refresh, focus: () => box.focus(), destroy: () => { alive = false; clearTimeout(timer); } };
  }

  window.JSChat = { mount, md };
})();
