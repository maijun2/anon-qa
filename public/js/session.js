// 参加者ページ: 質問 / 参考情報 / アンケートの 3 タブ。
// 投稿・投票は楽観的 UI 更新(失敗時ロールバック)、WebSocket で即時反映。
(() => {
  const code = decodeURIComponent(location.pathname.split("/")[2] || "");
  const entryToken = AnonQA.getEntryToken(code);
  if (!entryToken) {
    location.href = `/?code=${encodeURIComponent(code)}`;
    return;
  }

  const $ = (id) => document.getElementById(id);
  const esc = AnonQA.escapeHtml;

  const state = {
    session: null,
    ended: false,
    questions: [],
    materials: [],
    surveys: [],
    sort: "new",
    pendingImage: null,
    editingId: null,
  };

  // ---------- タブ ----------
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });
    ["questions", "materials", "surveys"].forEach((n) => {
      $(`tab-${n}`).hidden = n !== name;
    });
  }

  // ---------- 初期化 ----------
  init();

  async function init() {
    try {
      const meta = await AnonQA.api(code, "");
      state.session = meta.session;
      state.ended = meta.session.status === "ended";
      renderHeader();
      await Promise.all([loadQuestions(), loadMaterials(), loadSurveys()]);
      AnonQA.connectWs({
        code,
        token: entryToken,
        onMessage: handleWsMessage,
        onStatus: (s) => { $("conn-status").hidden = s === "open"; },
      });
    } catch (e) {
      // 401 は api() 内で入室ページへリダイレクト済み
    }
  }

  function renderHeader() {
    const s = state.session;
    $("course-name").textContent = s.courseName;
    document.title = `${s.courseName} - 匿名Q&A`;
    $("session-meta").textContent =
      `コード: ${s.code} / ${s.heldOn}${s.status === "ended" ? " / 終了済み" : ""}`;
    applyEndedState();
  }

  function applyEndedState() {
    $("session-ended-note").hidden = !state.ended;
    $("question-input").disabled = state.ended;
    $("question-submit").disabled = state.ended;
    $("image-input").disabled = state.ended;
  }

  async function loadQuestions() {
    const data = await AnonQA.api(code, "/questions");
    state.questions = data.questions;
    renderQuestions();
  }

  async function loadMaterials() {
    const data = await AnonQA.api(code, "/materials");
    state.materials = data.materials;
    renderMaterials();
  }

  async function loadSurveys() {
    const data = await AnonQA.api(code, "/surveys");
    state.surveys = data.surveys;
    renderSurveys();
  }

  // ---------- WebSocket ----------
  function handleWsMessage(msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case "question:new":
      case "question:updated":
        upsertQuestion(p.question);
        renderQuestions();
        break;
      case "question:deleted":
        state.questions = state.questions.filter((q) => q.id !== p.questionId);
        renderQuestions();
        break;
      case "vote:changed": {
        const q = state.questions.find((x) => x.id === p.questionId);
        if (q) { q.votes = p.votes; renderQuestions(); }
        break;
      }
      case "material:changed":
        state.materials = p.materials || [];
        renderMaterials();
        break;
      case "survey:published":
        upsertSurvey(p.survey);
        renderSurveys();
        switchTab("surveys");
        break;
      case "survey:closed":
      case "survey:results":
        upsertSurvey(p.survey);
        renderSurveys();
        break;
      case "survey:deleted":
        state.surveys = state.surveys.filter((s) => s.id !== p.surveyId);
        renderSurveys();
        break;
      case "session:ended":
        state.ended = true;
        state.session.status = "ended";
        renderHeader();
        renderQuestions();
        renderSurveys();
        break;
      case "session:deleted":
        alert("このセッションは削除されました");
        location.href = "/";
        break;
    }
  }

  function upsertQuestion(question) {
    if (!question) return;
    const existing = state.questions.find((q) => q.id === question.id);
    if (existing) {
      Object.assign(existing, question, { isMine: existing.isMine, voted: existing.voted });
    } else {
      state.questions.unshift(Object.assign({ isMine: false, voted: false }, question));
    }
  }

  function upsertSurvey(survey) {
    if (!survey) return;
    const existing = state.surveys.find((s) => s.id === survey.id);
    if (existing) {
      Object.assign(existing, survey, { myOptionIds: existing.myOptionIds });
    } else {
      state.surveys.push(Object.assign({ myOptionIds: [] }, survey));
    }
  }

  // ---------- 質問 ----------
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderQuestions();
    });
  });

  function sortQuestions(list) {
    const sorted = [...list];
    if (state.sort === "votes") {
      sorted.sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt);
    } else {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    }
    return sorted;
  }

  function questionCard(q) {
    const classes = ["card", "question-card"];
    if (q.isAnswered) classes.push("answered");
    if (q.pending) classes.push("pending");
    const editable = q.isMine && !state.ended && !q.pending;
    const isEditing = state.editingId === q.id;
    const bodyHtml = isEditing
      ? `<div class="field">
           <textarea class="textarea edit-input" rows="3">${esc(q.body)}</textarea>
           <div class="admin-item-actions">
             <button class="btn btn-primary btn-small" data-action="save-edit">保存</button>
             <button class="btn btn-ghost btn-small" data-action="cancel-edit">キャンセル</button>
           </div>
         </div>`
      : `<p class="question-body">${esc(q.body)}</p>`;
    return `
      <article class="${classes.join(" ")}" data-id="${esc(q.id)}">
        <div class="question-head">
          <span class="muted small">${AnonQA.formatJst(q.createdAt)}${q.updatedAt > q.createdAt ? "(編集済み)" : ""}</span>
          ${q.isAnswered ? '<span class="badge badge-answered">回答済み</span>' : ""}
          ${q.isMine ? '<span class="badge badge-mine">自分の質問</span>' : ""}
          ${q.pending ? '<span class="muted small">送信中…</span>' : ""}
        </div>
        ${bodyHtml}
        ${q.imageKey ? `<a href="${imageUrl(q.imageKey)}" target="_blank" rel="noopener"><img class="question-image" src="${imageUrl(q.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
        ${q.answers.length ? `<div class="answers">${q.answers.map((a) => `
          <div class="answer">
            <span class="answer-label">講師の回答</span>
            <p>${esc(a.body)}</p>
            <span class="muted small">${AnonQA.formatJst(a.createdAt)}</span>
          </div>`).join("")}</div>` : ""}
        <div class="question-actions">
          <button class="vote-btn${q.voted ? " voted" : ""}" data-action="vote" aria-pressed="${q.voted}"
            ${state.ended || q.pending ? "disabled" : ""} aria-label="いいね">
            👍 <span class="vote-count">${q.votes}</span>
          </button>
          ${editable && !isEditing ? `
            <button class="btn btn-ghost btn-small" data-action="edit">編集</button>
            <button class="btn btn-ghost btn-small btn-danger-text" data-action="delete">削除</button>` : ""}
        </div>
      </article>`;
  }

  function imageUrl(imageKey) {
    return `/api/s/${encodeURIComponent(code)}/images/${encodeURIComponent(imageKey)}`;
  }

  function renderQuestions() {
    const open = sortQuestions(state.questions.filter((q) => !q.isAnswered));
    const answered = sortQuestions(state.questions.filter((q) => q.isAnswered));
    $("question-list").innerHTML = open.map(questionCard).join("");
    $("answered-list").innerHTML = answered.map(questionCard).join("");
    $("answered-count").textContent = String(answered.length);
    $("question-empty").hidden = open.length > 0 || answered.length > 0;
    $("answered-section").style.display = answered.length > 0 ? "" : "none";
  }

  ["question-list", "answered-list"].forEach((listId) => {
    $(listId).addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const card = btn.closest(".question-card");
      const q = state.questions.find((x) => x.id === card.dataset.id);
      if (!q) return;
      const action = btn.dataset.action;
      if (action === "vote") toggleVote(q);
      if (action === "edit") { state.editingId = q.id; renderQuestions(); }
      if (action === "cancel-edit") { state.editingId = null; renderQuestions(); }
      if (action === "save-edit") saveEdit(q, card.querySelector(".edit-input").value);
      if (action === "delete") deleteQuestion(q);
    });
  });

  async function toggleVote(q) {
    if (state.ended) return;
    const wasVoted = q.voted;
    q.voted = !wasVoted;
    q.votes += q.voted ? 1 : -1;
    renderQuestions();
    try {
      const res = await AnonQA.api(code, `/questions/${q.id}/vote`, { method: wasVoted ? "DELETE" : "PUT" });
      q.votes = res.votes;
      q.voted = res.voted;
    } catch (e) {
      q.voted = wasVoted;
      q.votes += wasVoted ? 1 : -1;
      alert(e.message);
    }
    renderQuestions();
  }

  async function saveEdit(q, newBody) {
    const text = newBody.trim();
    if (!text) return;
    const oldBody = q.body;
    q.body = text;
    state.editingId = null;
    renderQuestions();
    try {
      const res = await AnonQA.api(code, `/questions/${q.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: text }),
      });
      Object.assign(q, res.question, { isMine: true, voted: q.voted });
    } catch (e) {
      q.body = oldBody;
      alert(e.message);
    }
    renderQuestions();
  }

  async function deleteQuestion(q) {
    if (!confirm("この質問を削除しますか?")) return;
    const index = state.questions.indexOf(q);
    state.questions = state.questions.filter((x) => x.id !== q.id);
    renderQuestions();
    try {
      await AnonQA.api(code, `/questions/${q.id}`, { method: "DELETE" });
    } catch (e) {
      state.questions.splice(index, 0, q);
      renderQuestions();
      alert(e.message);
    }
  }

  // ---------- 質問投稿(画像添付対応) ----------
  const questionForm = $("question-form");
  const questionInput = $("question-input");
  const imageInput = $("image-input");

  questionForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitQuestion();
  });

  // Enter で送信、Shift+Enter で改行(キーボードのみで投稿完結)
  questionInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submitQuestion();
    }
  });

  imageInput.addEventListener("change", () => {
    if (imageInput.files && imageInput.files[0]) setPendingImage(imageInput.files[0]);
    imageInput.value = "";
  });

  questionInput.addEventListener("paste", (ev) => {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        ev.preventDefault();
        setPendingImage(item.getAsFile());
        return;
      }
    }
  });

  questionForm.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    questionForm.classList.add("drop-target");
  });
  questionForm.addEventListener("dragleave", () => questionForm.classList.remove("drop-target"));
  questionForm.addEventListener("drop", (ev) => {
    ev.preventDefault();
    questionForm.classList.remove("drop-target");
    const file = ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) setPendingImage(file);
  });

  function setPendingImage(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("画像ファイルのみ添付できます");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("画像は 1 枚 5MB 以下にしてください");
      return;
    }
    clearPendingImage();
    state.pendingImage = { file, previewUrl: URL.createObjectURL(file) };
    $("image-preview-img").src = state.pendingImage.previewUrl;
    $("image-preview").hidden = false;
  }

  function clearPendingImage() {
    if (state.pendingImage) URL.revokeObjectURL(state.pendingImage.previewUrl);
    state.pendingImage = null;
    $("image-preview").hidden = true;
  }

  $("image-remove").addEventListener("click", clearPendingImage);

  async function submitQuestion() {
    if (state.ended) return;
    const text = questionInput.value.trim();
    if (!text && !state.pendingImage) return;

    const temp = {
      id: `temp-${Date.now()}`,
      body: text,
      imageKey: null,
      isAnswered: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      votes: 0,
      answers: [],
      isMine: true,
      voted: false,
      pending: true,
    };
    const restore = { text, image: state.pendingImage };
    state.questions.unshift(temp);
    questionInput.value = "";
    state.pendingImage = null;
    $("image-preview").hidden = true;
    renderQuestions();

    try {
      let imageKey;
      if (restore.image) {
        const form = new FormData();
        form.append("file", restore.image.file);
        imageKey = (await AnonQA.api(code, "/images", { method: "POST", body: form })).imageKey;
      }
      const res = await AnonQA.api(code, "/questions", {
        method: "POST",
        body: JSON.stringify({ body: text, imageKey }),
      });
      state.questions = state.questions.filter((q) => q.id !== temp.id);
      const existing = state.questions.find((q) => q.id === res.question.id);
      if (existing) {
        Object.assign(existing, res.question);
      } else {
        state.questions.unshift(res.question);
      }
      if (restore.image) URL.revokeObjectURL(restore.image.previewUrl);
    } catch (e) {
      // 失敗時ロールバック: 一時カードを消して入力を復元
      state.questions = state.questions.filter((q) => q.id !== temp.id);
      questionInput.value = restore.text;
      if (restore.image) {
        state.pendingImage = restore.image;
        $("image-preview-img").src = restore.image.previewUrl;
        $("image-preview").hidden = false;
      }
      alert(`投稿に失敗しました: ${e.message}`);
    }
    renderQuestions();
  }

  // ---------- 参考情報 ----------
  function renderMaterials() {
    const byModule = new Map();
    for (const m of state.materials) {
      const key = m.module || "その他";
      if (!byModule.has(key)) byModule.set(key, []);
      byModule.get(key).push(m);
    }
    let html = "";
    for (const [module, items] of byModule) {
      html += `<h3 class="module-title">${esc(module)}</h3><div class="stack">`;
      html += items.map((m) => `
        <div class="card">
          ${m.url
            ? `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(m.title)}</strong></a>`
            : `<strong>${esc(m.title)}</strong>`}
          ${m.body ? `<p class="material-body">${esc(m.body)}</p>` : ""}
        </div>`).join("");
      html += "</div>";
    }
    $("material-list").innerHTML = html;
    $("material-empty").hidden = state.materials.length > 0;
  }

  // ---------- アンケート ----------
  function surveyCard(s) {
    const answered = s.myOptionIds.length > 0;
    const canAnswer = s.status === "published" && !state.ended;
    const inputType = s.isMulti ? "checkbox" : "radio";
    const total = Math.max(s.totalRespondents, 1);
    return `
      <div class="card" data-survey-id="${esc(s.id)}">
        <div class="question-head">
          <span class="badge badge-status-${esc(s.status)}">${s.status === "published" ? "受付中" : "終了"}</span>
          ${answered ? '<span class="badge badge-mine">回答済み</span>' : ""}
        </div>
        <h3>${esc(s.title)}</h3>
        ${canAnswer ? `
          <div class="survey-form">
            ${s.options.map((o) => `
              <label class="survey-option-row">
                <input type="${inputType}" name="survey-${esc(s.id)}" value="${esc(o.id)}"
                  ${s.myOptionIds.includes(o.id) ? "checked" : ""}>
                <span>${esc(o.label)}</span>
              </label>`).join("")}
            <button class="btn btn-primary btn-small" data-action="respond">${answered ? "回答を変更する" : "回答する"}</button>
          </div>` : ""}
        <div class="survey-results">
          ${s.options.map((o) => `
            <div class="survey-result-row">
              <div class="survey-result-label"><span>${esc(o.label)}</span><span>${o.count} 票</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.round((o.count / total) * 100)}%"></div></div>
            </div>`).join("")}
          <p class="muted small">回答者: ${s.totalRespondents} 人</p>
        </div>
      </div>`;
  }

  function renderSurveys() {
    const visible = [...state.surveys].reverse();
    $("survey-list").innerHTML = visible.map(surveyCard).join("");
    $("survey-empty").hidden = visible.length > 0;
  }

  $("survey-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest('[data-action="respond"]');
    if (!btn) return;
    const cardEl = btn.closest("[data-survey-id]");
    const survey = state.surveys.find((s) => s.id === cardEl.dataset.surveyId);
    if (!survey) return;
    const optionIds = [...cardEl.querySelectorAll("input:checked")].map((i) => i.value);
    if (optionIds.length === 0) {
      alert("選択肢を選んでください");
      return;
    }
    btn.disabled = true;
    try {
      const res = await AnonQA.api(code, `/surveys/${survey.id}/responses`, {
        method: "POST",
        body: JSON.stringify({ optionIds }),
      });
      Object.assign(survey, res.survey);
      renderSurveys();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
    }
  });
})();
