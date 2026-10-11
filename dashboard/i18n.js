"use strict";

/* Web mode translations (Brazilian Portuguese).
 *
 * Two jobs. `I18N.t("English text")` for the web-mode pages, which are written
 * with it. And `I18N.watch()`, which translates the plain dashboard (app.js)
 * in place: every text node, placeholder, title and aria-label that exactly
 * matches an English string below, plus a few patterns for sentences with
 * numbers in them. app.js stays English-only and untouched by this; anything
 * not listed simply stays in English. Job postings, scores' reasons and other
 * text written by the search stay in the language they were written in.
 *
 * The language comes from <html data-lang="pt|en">, which the server sets from
 * profile/candidate.json → language.
 */

(function () {
  const PT = {
    // ── login, first run, chat
    "Job Search": "Busca de Emprego",
    "Password": "Senha",
    "Sign in": "Entrar",
    "Signing in": "Entrando",
    "Wrong password. Try again.": "Senha errada. Tente de novo.",
    "Too many tries. Wait a moment and try again.": "Muitas tentativas. Espere um pouco e tente de novo.",
    "The page is not answering. Check that you are on the home Wi-Fi.": "A página não está respondendo. Confira se você está no Wi-Fi de casa.",
    "Your private job search page.": "Sua página particular de busca de emprego.",
    "Which language do you prefer?": "Qual idioma você prefere?",
    "You can change this any time.": "Dá para mudar isso quando quiser.",
    "Your job search assistant": "Seu assistente de busca de emprego",
    "Type your answer": "Escreva sua resposta",
    "Send": "Enviar",
    "Attach a file": "Anexar arquivo",
    "Upload my resume": "Enviar meu currículo",
    "Connect Gmail": "Conectar o Gmail",
    "Open my job search panel": "Abrir meu painel de vagas",
    "Search for jobs now": "Buscar vagas agora",
    "Open": "Abrir",
    "thinking": "pensando",
    "writing": "escrevendo",
    "reading": "lendo",
    "saving": "salvando",
    "working": "trabalhando",
    "planning": "planejando",
    "looking through files": "olhando os arquivos",
    "reading a web page": "lendo uma página",
    "searching the web": "pesquisando na internet",
    "Uploading": "Enviando",
    "That file type is not supported. Use PDF, Word or a text file.": "Esse tipo de arquivo não é aceito. Use PDF, Word ou texto.",
    "That file is too big (15 MB at most).": "Esse arquivo é grande demais (no máximo 15 MB).",
    "The upload did not work. Try again.": "O envio não funcionou. Tente de novo.",
    "I uploaded my resume:": "Enviei meu currículo:",
    "The assistant is busy with another conversation. Try again in a minute.": "O assistente está ocupado em outra conversa. Tente de novo em um minuto.",
    "Something went wrong:": "Algo deu errado:",
    "Gmail is connected.": "O Gmail está conectado.",
    "Gmail was not connected:": "O Gmail não foi conectado:",
    "Sign out": "Sair",
    "Start over": "Recomeçar",
    "Start this conversation over? What you already saved stays saved.": "Recomeçar esta conversa? O que já foi salvo continua salvo.",
    "Close": "Fechar",
    "Assistant": "Assistente",
    "Ask the assistant": "Falar com o assistente",
    "Ask for any change in your own words, for example \"I also want remote jobs in the US\" or \"Add this job: <link>\".":
      "Peça qualquer mudança com suas palavras, por exemplo \"também quero vagas remotas nos EUA\" ou \"adicione esta vaga: <link>\".",
    "Your setup is done.": "Sua configuração está pronta.",

    // ── My answers
    "My answers": "Minhas respostas",
    "Everything the search uses to find and score jobs for you. Change anything and press Save. For anything not here, ask the assistant.":
      "Tudo o que a busca usa para encontrar e dar nota às vagas. Mude o que quiser e clique em Salvar. Para o que não estiver aqui, fale com o assistente.",
    "What the assistant understood about you": "O que o assistente entendeu sobre você",
    "Language": "Idioma",
    "Job titles to search for": "Cargos para buscar",
    "One per line works best: the titles a company would put on the posting.": "Um por linha: os cargos como uma empresa escreveria na vaga.",
    "Companies I am interested in": "Empresas que me interessam",
    "The search checks their careers pages for roles like yours, and a job at one of these scores a little higher.":
      "A busca confere a página de vagas delas, e uma vaga numa dessas ganha um pouco mais de nota.",
    "Company name": "Nome da empresa",
    "Careers page link (optional)": "Link da página de vagas (opcional)",
    "Add a company": "Adicionar empresa",
    "Other job sites to check": "Outros sites de vagas",
    "Any site with job listings: a job board, a company page, a search you saved.": "Qualquer site com vagas: um portal, a página de uma empresa, uma busca salva.",
    "Link": "Link",
    "What to look for there (optional)": "O que procurar lá (opcional)",
    "Add a site": "Adicionar site",
    "Where I want to work": "Onde quero trabalhar",
    "Home area (city or region)": "Minha região (cidade ou região)",
    "How far I would travel (km)": "Até quantos km eu viajaria",
    "Office days a week, at most": "Dias no escritório por semana, no máximo",
    "I would move for the right job": "Eu me mudaria pela vaga certa",
    "Pay": "Salário",
    "Lowest yearly pay I would accept": "Menor salário anual que eu aceitaria",
    "Yearly pay that would make me really happy": "Salário anual que me deixaria muito feliz",
    "Jobs that do not show pay are never held against a job.": "Vagas sem salário informado nunca perdem nota por isso.",
    "Industries I will not work in": "Setores em que não quero trabalhar",
    "When the search runs": "Quando a busca acontece",
    "Times of day, like 08:00 and 16:00.": "Horários do dia, como 08:00 e 16:00.",
    "Where to look": "Onde procurar",
    "LinkedIn job search (without signing in)": "Busca de vagas do LinkedIn (sem fazer login)",
    "LinkedIn job alert emails in my Gmail": "E-mails de alerta de vagas do LinkedIn no meu Gmail",
    "Y Combinator startup jobs": "Vagas de startups da Y Combinator",
    "Wellfound startup jobs": "Vagas de startups do Wellfound",
    "Communitech (Canadian tech)": "Communitech (tecnologia no Canadá)",
    "Small local startups watchlist": "Lista de pequenas startups da região",
    "Gmail": "Gmail",
    "Not connected. The search uses it to read job alert emails and replies from companies. It can only read; it cannot send or delete anything.":
      "Não conectado. A busca usa o Gmail para ler alertas de vagas e respostas das empresas. Só pode ler; não envia nem apaga nada.",
    "Connected as": "Conectado como",
    "Disconnect": "Desconectar",
    "Disconnect Gmail? The search will stop reading job alert emails and replies.": "Desconectar o Gmail? A busca vai parar de ler alertas e respostas.",
    "Remove": "Remover",
    "Save": "Salvar",
    "Saved. The next search uses your new answers.": "Salvo. A próxima busca já usa suas novas respostas.",
    "Saved. The new search times are switched on.": "Salvo. Os novos horários de busca estão valendo.",
    "Did not save:": "Não salvou:",
    "Unsaved changes": "Mudanças não salvas",
    "Anything else, in your own words": "Qualquer outra coisa, com suas palavras",

    // ── the plain dashboard (app.js)
    "Search now": "Buscar agora",
    "Searching": "Buscando",
    "Starting": "Iniciando",
    "Run apply queue": "Enviar candidaturas",
    "Refresh": "Atualizar",
    "Checking": "Verificando",
    "Reading the board": "Lendo o painel",
    "Reading the board.": "Lendo o painel.",
    "Nothing to show until the board answers.": "Nada para mostrar até o painel responder.",
    "Job Search board": "Painel",
    "Last search": "Última busca",
    "Apply queue": "Fila de envio",
    "Waiting on you": "Esperando você",
    "In play": "Em andamento",
    "up": "no ar",
    "down": "fora do ar",
    "never": "nunca",
    "stuck": "travada",
    "Review": "Revisar",
    "Pipeline": "Andamento",
    "Applied": "Enviadas",
    "Startups": "Startups",
    "Turned down": "Recusadas por mim",
    "Rejected": "Recusadas pela empresa",
    "Lost": "Perdidas",
    "Screened out": "Filtradas",
    "Analytics": "Números",
    "Guide": "Guia",
    "Interested": "Tenho interesse",
    "Screen": "Primeira conversa",
    "Interview": "Entrevista",
    "Offer": "Oferta",
    "Apply for me": "Candidatar-me",
    "Not for me": "Não é pra mim",
    "Posting": "Vaga",
    "Prepare resumes": "Preparar currículos",
    "Clear": "Limpar",
    "Clear these": "Desmarcar estas",
    "Filters": "Filtros",
    "Clear filters": "Limpar filtros",
    "everything": "tudo",
    "3 and up": "3 ou mais",
    "the strong ones": "as fortes",
    "Back to Review": "Voltar para Revisar",
    "Take off the queue": "Tirar da fila",
    "Check email for status updates": "Verificar e-mail para atualizações",
    "Check email now": "Verificar e-mail agora",
    "Reading now": "Lendo agora",
    "never run": "nunca rodou",
    "Careers": "Vagas",
    "Cancel": "Cancelar",
    "Not yet": "Ainda não",
    "Turn it down": "Recusar",
    "Open the posting": "Abrir a vaga",
    "Tailored resume": "Currículo adaptado",
    "Prepare a tailored resume": "Preparar currículo adaptado",
    "resume queued for the next run": "currículo na fila para a próxima busca",
    "Add": "Adicionar",
    "Send it": "Enviar",
    "Stage": "Etapa",
    "Applying": "Candidatura",
    "Reaching out": "Contato",
    "Why you, and what is thin": "Por que você, e o que falta",
    "What has happened": "O que aconteceu",
    "Scores": "Notas",
    "Details": "Detalhes",
    "How it ended": "Como terminou",
    "Why you turned it down": "Por que você recusou",
    "Resume keywords": "Palavras-chave do currículo",
    "The posting": "A vaga",
    "Add a note": "Adicionar nota",
    "Research": "Pesquisa",
    "Goes on this job's diary": "Vai para o diário desta vaga",
    "Click a dot to change it. Your score wins and the next search learns from it.": "Clique num ponto para mudar. Sua nota vale, e a próxima busca aprende com ela.",
    "You have changed these.": "Você mudou estas notas.",
    "Found": "Encontrada",
    "Posted": "Publicada",
    "Source": "Fonte",
    "Location": "Local",
    "Work model": "Modelo de trabalho",
    "Company": "Empresa",
    "Status history": "Histórico",
    "interests": "interesses",
    "goals": "objetivos",
    "location": "local",
    "pay": "salário",
    "overall": "geral",
    "industry": "setor",
    "level": "nível",
    "company size": "tamanho da empresa",
    "role scope": "escopo da vaga",
    "other": "outro",
    "pay not listed": "salário não informado",
    "not listed": "não informado",
    "on the apply queue": "na fila de envio",
    "applied by the apply queue": "enviada pela fila",
    "Job title": "Cargo",
    "Any title": "Qualquer cargo",
    "Find a company, title or place": "Buscar empresa, cargo ou local",
    "Find": "Buscar",
    "Remote, hybrid or in person": "Remoto, híbrido ou presencial",
    "Company size (people)": "Tamanho da empresa (pessoas)",
    "Read from the posting's headcount note.": "Lido da descrição da vaga.",
    "Score at least": "Nota mínima",
    "Match at least": "Compatibilidade mínima",
    "Added to the board": "Adicionada ao painel",
    "Posted by the company": "Publicada pela empresa",
    "Keep roles that do not state pay": "Manter vagas sem salário informado",
    "Keep roles with no posted date": "Manter vagas sem data de publicação",
    "Hold Command to pick more than one.": "Segure Command para escolher mais de um.",
    "Remote": "Remoto",
    "Hybrid": "Híbrido",
    "In person": "Presencial",
    "Not stated": "Não informado",
    "Up to 30": "Até 30",
    "31 to 100": "31 a 100",
    "101 to 200": "101 a 200",
    "201 to 1,000": "201 a 1.000",
    "1,000+": "1.000+",
    "Any time": "Qualquer data",
    "Last 7 days": "Últimos 7 dias",
    "Last 14 days": "Últimos 14 dias",
    "Last 30 days": "Últimos 30 dias",
    "Last 90 days": "Últimos 90 dias",
    "Between two dates": "Entre duas datas",
    "Any score": "Qualquer nota",
    "2 and up": "2 ou mais",
    "4 and up": "4 ou mais",
    "5 only": "Só 5",
    "Any match": "Qualquer",
    "50% and up": "50% ou mais",
    "60% and up": "60% ou mais",
    "70% and up": "70% ou mais",
    "80% and up": "80% ou mais",
    "90% and up": "90% ou mais",
    "From": "De",
    "To": "Até",
    "Blocked, waiting on you": "Bloqueadas, esperando você",
    "Queued to apply": "Na fila para envio",
    "resume ready": "currículo pronto",
    "tailored resume made first": "currículo adaptado será feito antes",
    "not running": "parada",
    "running": "rodando",
    "starting": "iniciando",
    "quiet": "silenciosa",
    "No run in progress.": "Nenhum envio em andamento.",
    "Between roles.": "Entre uma vaga e outra.",
    "While a run is going this shows which role it is on, which step, and what happened to each one it finished.":
      "Durante um envio, aqui aparece em qual vaga ele está, em que etapa e o que aconteceu com cada uma.",
    "Nothing submitted yet.": "Nada enviado ainda.",
    "You have not turned anything down.": "Você ainda não recusou nada.",
    "No employer has said no.": "Nenhuma empresa disse não.",
    "Nothing lost for another reason.": "Nada perdido por outro motivo.",
    "Nothing was screened out.": "Nada foi filtrado.",
    "Nothing yet.": "Nada ainda.",
    "Nothing closed yet.": "Nada encerrado ainda.",
    "Empty.": "Vazio.",
    "What the pattern says": "O que o padrão mostra",
    "Where every role stands": "Onde cada vaga está",
    "Where they came from": "De onde vieram",
    "How the closed ones ended": "Como as encerradas terminaram",
    "Roles tracked": "Vagas acompanhadas",
    "Of those, by the apply queue": "Destas, pela fila de envio",
    "In a conversation": "Em conversa",
    "Screened out before scoring": "Filtradas antes da nota",
    "Startups watched": "Startups acompanhadas",
    "No startups on the watchlist yet. The search fills it as it finds small companies worth watching.":
      "Ainda não há startups na lista. A busca adiciona pequenas empresas que valem a pena acompanhar.",
    "Postings the search saw and skipped before scoring, with why. If one of these should have been scored, ask Claude to change the rule that dropped it.":
      "Vagas que a busca viu e pulou antes de dar nota, com o motivo. Se alguma devia ter recebido nota, peça ao assistente para mudar a regra.",
    "The reason goes back into the scoring, so the next search learns from it.":
      "O motivo volta para as notas, e a próxima busca aprende com ele.",
    "Anything to add (optional)": "Algo a acrescentar (opcional)",
    "These are real applications, sent in your name. Any that need you (a video, a question it cannot answer truthfully) are left for you with the next step.":
      "São candidaturas de verdade, enviadas em seu nome. As que precisarem de você (um vídeo, uma pergunta que não dá para responder com certeza) ficam para você, com o próximo passo.",
    "Nothing is waiting on the apply queue.": "Não há nada na fila de envio.",
    "Nothing is waiting on the apply queue. Press Apply for me on a job first.": "Não há nada na fila. Clique em Candidatar-me numa vaga primeiro.",
    "Search started. It usually takes 30 to 90 minutes; new roles land in Review.":
      "Busca iniciada. Costuma levar de 30 a 90 minutos; as vagas novas aparecem em Revisar.",
    "Apply queue started. Watch it on the Apply queue tab.": "Envio iniciado. Acompanhe na aba Fila de envio.",
    "Reading your email now. This takes a few minutes; cards move on their own as replies are found.":
      "Lendo seu e-mail agora. Leva alguns minutos; os cartões se movem sozinhos quando aparecem respostas.",
    "Queued to apply.": "Na fila para envio.",
    "Resume queued for the next run.": "Currículo na fila para a próxima busca.",
    "Note added.": "Nota adicionada.",
    "Queued to send.": "Na fila para enviar.",
    "Automatic": "Automático",
    "LinkedIn Easy Apply": "Candidatura simplificada do LinkedIn",
    "Company application form": "Formulário da empresa",
    "Careers-page form": "Formulário da página de vagas",
    "Email": "E-mail",
    "Not worked out yet": "Ainda não identificado",
    "Top score.": "Nota máxima.",
    "Nothing missing.": "Nada faltando.",
    "Not higher:": "Por que não mais:",
  };

  const NOUNS = {
    "waiting on you": "esperando você", "in play": "em andamento", "queued": "na fila", "applied": "enviadas",
    "turned down": "recusadas", "rejected": "recusadas", "lost": "perdidas", "screened out": "filtradas",
  };
  const STAGE = { Interested: "Tenho interesse", Applied: "Enviada", Screen: "Primeira conversa", Interview: "Entrevista", Offer: "Oferta" };
  const TAB = {
    Review: "Revisar", Pipeline: "Andamento", "Apply queue": "Fila de envio", Applied: "Enviadas", Startups: "Startups",
    "Turned down": "Recusadas por mim", Rejected: "Recusadas pela empresa", Lost: "Perdidas", "Screened out": "Filtradas",
    Analytics: "Números", Guide: "Guia", "My answers": "Minhas respostas",
  };

  const RULES = [
    [/^for (\S+)$/, (m) => `de ${m[1]}`],
    [/^Score (\d|\?)(:?)$/, (m) => `Nota ${m[1]}${m[2]}`],
    [/^(\d+)% match(:?)$/, (m) => `${m[1]}% compatível${m[2]}`],
    [/^Show (\d+) more$/, (m) => `Mostrar mais ${m[1]}`],
    [/^Select these (\d+)$/, (m) => `Selecionar estas ${m[1]}`],
    [/^Select all (\d+)$/, (m) => `Selecionar todas as ${m[1]}`],
    [/^(\d+) selected$/, (m) => `${m[1]} selecionadas`],
    [/^Filters \((\d+)\)$/, (m) => `Filtros (${m[1]})`],
    [/^Turn down (\d+)$/, (m) => `Recusar ${m[1]}`],
    [/^Turn down (.+)$/, (m) => `Recusar ${m[1]}`],
    [/^Send (\d+) applications?\?$/, (m) => `Enviar ${m[1]} candidatura${m[1] === "1" ? "" : "s"}?`],
    [/^Send all (\d+)$/, (m) => `Enviar todas as ${m[1]}`],
    [/^and (\d+) more$/, (m) => `e mais ${m[1]}`],
    [/^(\d+) of (\d+) (.+)$/, (m) => (NOUNS[m[3]] ? `${m[1]} de ${m[2]} ${NOUNS[m[3]]}` : null)],
    [/^(\d+) (.+)$/, (m) => (NOUNS[m[2]] ? `${m[1]} ${NOUNS[m[2]]}` : null)],
    [/^(.+?) \((\d+)\)$/, (m) => (TAB[m[1]] ? `${TAB[m[1]]} (${m[2]})` : STAGE[m[1]] ? `${STAGE[m[1]]} (${m[2]})` : null)],
    [/^(Interested|Applied|Screen|Interview|Offer) \((\d+) of (\d+)\)$/, (m) => `${STAGE[m[1]]} (${m[2]} de ${m[3]})`],
    [/^Queued (.+) to apply\.$/, (m) => `${m[1]} entrou na fila de envio.`],
    [/^Kept (.+)\.$/, (m) => `${m[1]} guardada.`],
    [/^Turned down (.+)\.$/, (m) => `${m[1]} recusada.`],
    [/^(.+) is back in Review\.$/, (m) => `${m[1]} voltou para Revisar.`],
    [/^Took (.+) off the queue\.$/, (m) => `${m[1]} saiu da fila.`],
    [/^(.+) moved to (.+)\.$/, (m) => `${m[1]} foi para ${m[2]}.`],
    [/^last checked (.+)$/, (m) => `última verificação ${m[1]}`],
    [/^Applied (.+)$/, (m) => `Enviada ${m[1]}`],
    [/^Nothing waiting\. The searches at (.+) put new roles here, highest score first\.$/,
      (m) => `Nada esperando. As buscas das ${m[1]} colocam vagas novas aqui, com as maiores notas primeiro.`],
    [/^None of the (\d+) (.+) match these filters\.(.*)$/, (m) => `Nenhuma das ${m[1]} vagas combina com estes filtros.`],
    [/^None of the (.+) match these filters\.$/, () => "Nada combina com estes filtros."],
    [/^The queue is empty\..*$/, () => "A fila está vazia. As vagas entram aqui quando você clica em Candidatar-me. Depois clique em Enviar candidaturas."],
  ];

  const lang = () => (document.documentElement.dataset.lang === "pt" ? "pt" : "en");

  function t(s) {
    if (lang() !== "pt") return s;
    return Object.prototype.hasOwnProperty.call(PT, s) ? PT[s] : s;
  }

  function translateText(raw) {
    const s = raw.trim();
    if (!s || s.length > 400) return null;
    if (Object.prototype.hasOwnProperty.call(PT, s)) return raw.replace(s, PT[s]);
    for (const [re, fn] of RULES) {
      const m = re.exec(s);
      if (m) {
        const out = fn(m);
        if (out) return raw.replace(s, out);
      }
    }
    return null;
  }

  const ATTRS = ["placeholder", "title", "aria-label"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE"]);

  function apply(root) {
    if (lang() !== "pt" || !root) return;
    if (root.nodeType === 3) {
      const out = translateText(root.nodeValue);
      if (out != null && out !== root.nodeValue) root.nodeValue = out;
      return;
    }
    if (root.nodeType !== 1 || SKIP.has(root.tagName) || root.closest("[data-no-i18n]")) return;
    for (const a of ATTRS) {
      const v = root.getAttribute && root.getAttribute(a);
      if (v) {
        const out = translateText(v);
        if (out != null && out !== v) root.setAttribute(a, out);
      }
    }
    if (root.tagName === "OPTION" && root.textContent) {
      const out = translateText(root.textContent);
      if (out != null) root.textContent = out;
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1 && (SKIP.has(n.tagName) || n.hasAttribute("data-no-i18n"))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const todo = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) todo.push(n);
    for (const n of todo) {
      if (n.nodeType === 3) {
        const out = translateText(n.nodeValue);
        if (out != null && out !== n.nodeValue) n.nodeValue = out;
      } else {
        for (const a of ATTRS) {
          const v = n.getAttribute(a);
          if (v) {
            const out = translateText(v);
            if (out != null && out !== v) n.setAttribute(a, out);
          }
        }
      }
    }
  }

  function watch() {
    if (lang() !== "pt") return;
    apply(document.body);
    // Translating changes text, which is itself a mutation; the translated
    // string never matches an English key again, so this settles at once.
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") apply(m.target);
        else m.addedNodes.forEach((n) => apply(n));
        if (m.type === "attributes") apply(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  window.I18N = { t, apply, watch, lang };
})();
