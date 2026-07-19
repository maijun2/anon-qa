// 投影モード: 質問・アンケート結果を大画面向けに表示(操作 UI は最小限)
(() => {
  const sessionId = decodeURIComponent(location.pathname.split("/")[3] || "");
  const $ = (id) => document.getElementById(id);
  const esc = AnonQA.escapeHtml;

  const state = { session: null, questions: [], surveys: [], sort: "votes", showAnswered: false };

  init();

  async function init() {
    let data;
    try {
      data = await AdminQA.api(`/sessions/${sessionId}`);
    } catch (e) {
      return;
    }
    state.session = data.session;
    state.questions = data.questions;
    state.surveys = data.surveys;
    $("course-name").textContent = state.session.courseName;
    document.title = `${state.session.courseName} - 投影モード`;
    $("session-code").textContent = state.session.code;
    renderQuestions();
    renderSurveys();
    AnonQA.connectWs({
      code: state.session.code,
      token: null, // admin Cookie 認証
      onMessage: handleWsMessage,
      onStatus: (s) => { $("conn-status").hidden = s === "open"; },
    });
  }

  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderQuestions();
    });
  });

  $("show-answered").addEventListener("change", (ev) => {
    state.showAnswered = ev.target.checked;
    renderQuestions();
  });

  function handleWsMessage(msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case "question:new":
      case "question:updated": {
        const existing = state.questions.find((q) => q.id === p.question.id);
        if (existing) Object.assign(existing, p.question);
        else state.questions.unshift(p.question);
        renderQuestions();
        break;
      }
      case "question:deleted":
        state.questions = state.questions.filter((q) => q.id !== p.questionId);
        renderQuestions();
        break;
      case "vote:changed": {
        const q = state.questions.find((x) => x.id === p.questionId);
        if (q) { q.votes = p.votes; renderQuestions(); }
        break;
      }
      case "survey:published":
      case "survey:closed":
      case "survey:results": {
        const existing = state.surveys.find((s) => s.id === p.survey.id);
        if (existing) Object.assign(existing, p.survey);
        else state.surveys.push(p.survey);
        renderSurveys();
        break;
      }
      case "survey:deleted":
        state.surveys = state.surveys.filter((s) => s.id !== p.surveyId);
        renderSurveys();
        break;
    }
  }

  function renderQuestions() {
    let list = state.showAnswered ? [...state.questions] : state.questions.filter((q) => !q.isAnswered);
    list.sort((a, b) =>
      state.sort === "votes" ? b.votes - a.votes || b.createdAt - a.createdAt : b.createdAt - a.createdAt,
    );
    $("question-list").innerHTML = list.map((q) => `
      <article class="card question-card${q.isAnswered ? " answered" : ""}">
        <div class="question-head">
          <span class="vote-display">👍 ${q.votes}</span>
          ${q.isAnswered ? '<span class="badge badge-answered">回答済み</span>' : ""}
        </div>
        <p class="question-body">${esc(q.body)}</p>
        ${q.answers.length ? `<div class="answers">${q.answers.map((a) => `
          <div class="answer"><span class="answer-label">回答</span><p>${esc(a.body)}</p></div>`).join("")}</div>` : ""}
      </article>`).join("");
    $("question-empty").hidden = list.length > 0;
  }

  function renderSurveys() {
    // 投影では配信中・終了済みのみ(下書きは表示しない)
    const visible = state.surveys.filter((s) => s.status !== "draft").reverse();
    $("survey-list").innerHTML = visible.map((s) => {
      const total = Math.max(s.totalRespondents, 1);
      return `
      <div class="card">
        <div class="question-head">
          <span class="badge badge-status-${esc(s.status)}">${s.status === "published" ? "受付中" : "終了"}</span>
        </div>
        <h3>${esc(s.title)}</h3>
        ${s.options.map((o) => `
          <div class="survey-result-row">
            <div class="survey-result-label"><span>${esc(o.label)}</span><span>${o.count}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round((o.count / total) * 100)}%"></div></div>
          </div>`).join("")}
        <p class="muted small">回答者: ${s.totalRespondents} 人</p>
      </div>`;
    }).join("");
  }
})();
