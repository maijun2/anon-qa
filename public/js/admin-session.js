// admin セッション管理: 質問(回答/回答済み/削除)、参考情報 CRUD + 並び替え、アンケート配信
(() => {
  const sessionId = decodeURIComponent(location.pathname.split("/")[3] || "");
  const $ = (id) => document.getElementById(id);
  const esc = AnonQA.escapeHtml;

  const state = {
    session: null,
    questions: [],
    materials: [],
    surveys: [],
    sort: "new",
    answeringId: null,
    answerPendingImage: null,
    editingMaterialId: null,
    // カーソルページネーション(50 件ずつ)。null は最終ページ到達済み
    nextCursor: null,
    loadingMore: false,
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
      });
      ["questions", "materials", "surveys"].forEach((n) => {
        $(`tab-${n}`).hidden = n !== tab.dataset.tab;
      });
    });
  });

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
    state.nextCursor = data.nextCursor || null;
    state.materials = data.materials;
    state.surveys = data.surveys;
    renderHeader();
    renderQuestions();
    renderMaterials();
    renderSurveys();
    AnonQA.connectWs({
      code: state.session.code,
      token: null, // admin は Cookie 認証
      onMessage: handleWsMessage,
      onStatus: (s) => { $("conn-status").hidden = s === "open"; },
    });
    AnonQA.initSoundToggle($("sound-toggle"));
  }

  // 無限スクロール: 番兵が画面に入ったら次ページ(50 件)を追加取得する。
  // WebSocket で既に受信済みの質問は id で重複排除する
  async function loadMoreQuestions() {
    if (!state.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    $("question-loading").hidden = false;
    try {
      const data = await AdminQA.api(
        `/sessions/${sessionId}/questions?cursor=${encodeURIComponent(state.nextCursor)}`,
      );
      state.nextCursor = data.nextCursor || null;
      for (const q of data.questions) {
        if (!state.questions.some((x) => x.id === q.id)) state.questions.push(q);
      }
      renderQuestions();
      // 追加後も番兵が画面内に残っている(リストが短い)場合は続けて取得する
      if (state.nextCursor && $("question-sentinel").getBoundingClientRect().top < window.innerHeight) {
        setTimeout(loadMoreQuestions, 0);
      }
    } catch (e) {
      // 失敗しても次に番兵が見えたタイミングで再試行される
    } finally {
      state.loadingMore = false;
      $("question-loading").hidden = true;
    }
  }

  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMoreQuestions();
  }).observe($("question-sentinel"));

  function renderHeader() {
    const s = state.session;
    $("course-name").textContent = `${s.courseName}(${s.heldOn})`;
    document.title = `${s.courseName} - セッション管理`;
    $("session-code").textContent = s.code;
    $("session-status").innerHTML =
      s.status === "active"
        ? '<span class="badge badge-status-active">開催中</span>'
        : '<span class="badge badge-status-ended">終了</span>';
    $("present-link").href = `/admin/s/${encodeURIComponent(s.id)}/present`;
    $("end-session-btn").hidden = s.status !== "active";
  }

  $("copy-url-btn").addEventListener("click", async () => {
    const url = `${location.origin}/?code=${encodeURIComponent(state.session.code)}`;
    try {
      await navigator.clipboard.writeText(url);
      $("copy-url-btn").textContent = "コピーしました";
      setTimeout(() => { $("copy-url-btn").textContent = "参加URLをコピー"; }, 1500);
    } catch (e) {
      prompt("参加 URL:", url);
    }
  });

  $("end-session-btn").addEventListener("click", async () => {
    if (!confirm("このセッションを終了しますか?(参加者は閲覧のみ可能になります)")) return;
    try {
      const data = await AdminQA.api(`/sessions/${sessionId}/end`, { method: "POST" });
      state.session = data.session;
      renderHeader();
    } catch (e) {
      alert(e.message);
    }
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
        if (msg.type === "question:new" && !existing) AnonQA.playNotify();
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
      case "material:changed":
        state.materials = p.materials || [];
        renderMaterials();
        break;
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

  // ---------- 質問管理 ----------
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderQuestions();
    });
  });

  function renderQuestions() {
    const sorted = [...state.questions].sort((a, b) =>
      state.sort === "votes" ? b.votes - a.votes || b.createdAt - a.createdAt : b.createdAt - a.createdAt,
    );
    $("question-list").innerHTML = sorted.map((q) => `
      <article class="card question-card${q.isAnswered ? " answered" : ""}" data-id="${esc(q.id)}">
        <div class="question-head">
          <span class="muted small">${AnonQA.formatJst(q.createdAt)}</span>
          <span class="muted small">👍 ${q.votes}</span>
          ${q.isAnswered ? '<span class="badge badge-answered">回答済み</span>' : ""}
        </div>
        <p class="question-body">${AnonQA.linkify(q.body)}</p>
        ${q.imageKey ? `<a href="${imageUrl(q.imageKey)}" target="_blank" rel="noopener"><img class="question-image" src="${imageUrl(q.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
        ${q.answers.length ? `<div class="answers">${q.answers.map((a) => `
          <div class="answer${a.authorRole === "instructor" ? "" : " answer-participant"}" data-answer-id="${esc(a.id)}">
            <span class="answer-label${a.authorRole === "instructor" ? "" : " answer-label-participant"}">${a.authorRole === "instructor" ? "講師" : "参加者"}</span>
            ${a.body ? `<p>${AnonQA.linkify(a.body)}</p>` : ""}
            ${a.imageKey ? `<a href="${imageUrl(a.imageKey)}" target="_blank" rel="noopener"><img class="answer-image" src="${imageUrl(a.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
            <span class="muted small">${AnonQA.formatJst(a.createdAt)}${a.updatedAt > a.createdAt ? "(編集済み)" : ""}</span>
            <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete-answer">削除</button>
          </div>`).join("")}</div>` : ""}
        ${state.answeringId === q.id ? `
          <div class="field" style="margin-top: 8px;">
            <textarea class="textarea answer-input" rows="3" placeholder="回答を入力(画像の貼り付け・添付も可能)"></textarea>
            ${state.answerPendingImage ? `
              <div class="image-preview">
                <img src="${state.answerPendingImage.previewUrl}" alt="添付画像プレビュー">
                <button type="button" class="btn btn-ghost btn-small" data-action="answer-image-remove">添付を取り消す</button>
              </div>` : ""}
            <div class="form-row">
              <label class="btn btn-ghost btn-small file-label">
                画像を添付
                <input type="file" class="answer-image-input" accept="image/png,image/jpeg,image/gif,image/webp">
              </label>
              <div class="admin-item-actions">
                <button class="btn btn-primary btn-small" data-action="submit-answer">回答を送信</button>
                <button class="btn btn-ghost btn-small" data-action="cancel-answer">キャンセル</button>
              </div>
            </div>
          </div>` : ""}
        <div class="admin-item-actions">
          ${state.answeringId !== q.id ? '<button class="btn btn-small btn-primary" data-action="answer">回答する</button>' : ""}
          <button class="btn btn-small btn-ghost" data-action="toggle-answered">${q.isAnswered ? "未回答に戻す" : "回答済みにする"}</button>
          <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete">削除</button>
        </div>
      </article>`).join("");
    $("question-empty").hidden = state.questions.length > 0;
  }

  function imageUrl(imageKey) {
    return `/api/s/${encodeURIComponent(state.session.code)}/images/${encodeURIComponent(imageKey)}`;
  }

  $("question-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const card = btn.closest(".question-card");
    const q = state.questions.find((x) => x.id === card.dataset.id);
    if (!q) return;
    const action = btn.dataset.action;
    try {
      if (action === "answer") {
        state.answeringId = q.id;
        clearAnswerPendingImage();
        renderQuestions();
        const input = document.querySelector(`[data-id="${CSS.escape(q.id)}"] .answer-input`);
        if (input) input.focus();
      }
      if (action === "cancel-answer") {
        state.answeringId = null;
        clearAnswerPendingImage();
        renderQuestions();
      }
      if (action === "answer-image-remove") {
        clearAnswerPendingImage();
        renderQuestions();
      }
      if (action === "submit-answer") {
        const body = card.querySelector(".answer-input").value.trim();
        const pending = state.answerPendingImage;
        if (!body && !pending) return;
        let imageKey;
        if (pending) {
          const form = new FormData();
          form.append("file", pending.file);
          imageKey = (await AdminQA.api(`/sessions/${sessionId}/images`, { method: "POST", body: form })).imageKey;
        }
        const data = await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}/answers`, {
          method: "POST",
          body: JSON.stringify({ body, imageKey }),
        });
        Object.assign(q, data.question);
        state.answeringId = null;
        clearAnswerPendingImage();
        renderQuestions();
      }
      if (action === "toggle-answered") {
        const data = await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}/answered`, {
          method: "PATCH",
          body: JSON.stringify({ isAnswered: !q.isAnswered }),
        });
        Object.assign(q, data.question);
        renderQuestions();
      }
      if (action === "delete") {
        if (!confirm("この質問を削除しますか?")) return;
        await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}`, { method: "DELETE" });
        state.questions = state.questions.filter((x) => x.id !== q.id);
        renderQuestions();
      }
      if (action === "delete-answer") {
        if (!confirm("この返信を削除しますか?")) return;
        const answerId = btn.closest("[data-answer-id]").dataset.answerId;
        const data = await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}/answers/${answerId}`, {
          method: "DELETE",
        });
        Object.assign(q, data.question);
        renderQuestions();
      }
    } catch (e) {
      alert(e.message);
    }
  });

  // ---------- 回答フォームの画像添付 ----------
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const isAllowedImage = (type) => ALLOWED_IMAGE_TYPES.includes(type);

  function setAnswerPendingImage(file) {
    if (!file) return;
    if (!isAllowedImage(file.type)) {
      alert("画像は PNG / JPEG / GIF / WebP 形式のみ添付できます");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("画像は 1 枚 5MB 以下にしてください");
      return;
    }
    clearAnswerPendingImage();
    state.answerPendingImage = { file, previewUrl: URL.createObjectURL(file) };
    renderQuestions();
  }

  function clearAnswerPendingImage() {
    if (state.answerPendingImage) URL.revokeObjectURL(state.answerPendingImage.previewUrl);
    state.answerPendingImage = null;
  }

  $("question-list").addEventListener("change", (ev) => {
    const input = ev.target.closest(".answer-image-input");
    if (!input || !input.files || !input.files[0]) return;
    setAnswerPendingImage(input.files[0]);
    input.value = "";
  });

  $("question-list").addEventListener("paste", (ev) => {
    if (!ev.target.closest(".answer-input")) return;
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (isAllowedImage(item.type)) {
        ev.preventDefault();
        setAnswerPendingImage(item.getAsFile());
        return;
      }
    }
  });

  // ---------- 参考情報 ----------
  function renderMaterials() {
    $("material-list").innerHTML = state.materials.map((m, index) => `
      <div class="card" data-id="${esc(m.id)}">
        ${state.editingMaterialId === m.id ? `
          <div class="form-row" style="margin: 0 0 8px;">
            <input class="input" data-field="module" value="${esc(m.module)}" placeholder="Module" style="flex: 1;">
            <input class="input" data-field="title" value="${esc(m.title)}" placeholder="タイトル" style="flex: 2;">
          </div>
          <input class="input" data-field="url" value="${esc(m.url || "")}" placeholder="URL" style="margin-bottom: 8px;">
          <textarea class="textarea" data-field="body" rows="2" placeholder="メモ">${esc(m.body || "")}</textarea>
          <div class="admin-item-actions">
            <button class="btn btn-primary btn-small" data-action="save-material">保存</button>
            <button class="btn btn-ghost btn-small" data-action="cancel-material">キャンセル</button>
          </div>` : `
          <div class="question-head">
            ${m.module ? `<span class="badge badge-mine">${esc(m.module)}</span>` : ""}
            ${m.url
              ? `<a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(m.title)}</strong></a>`
              : `<strong>${esc(m.title)}</strong>`}
          </div>
          ${m.body ? `<p class="material-body">${AnonQA.linkify(m.body)}</p>` : ""}
          <div class="admin-item-actions">
            <button class="btn btn-small btn-ghost" data-action="move-up" ${index === 0 ? "disabled" : ""}>↑</button>
            <button class="btn btn-small btn-ghost" data-action="move-down" ${index === state.materials.length - 1 ? "disabled" : ""}>↓</button>
            <button class="btn btn-small btn-ghost" data-action="edit-material">編集</button>
            <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete-material">削除</button>
          </div>`}
      </div>`).join("");
    $("material-empty").hidden = state.materials.length > 0;
  }

  $("material-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await AdminQA.api(`/sessions/${sessionId}/materials`, {
        method: "POST",
        body: JSON.stringify({
          module: $("material-module").value,
          title: $("material-title").value,
          url: $("material-url").value,
          body: $("material-body").value,
        }),
      });
      $("material-title").value = "";
      $("material-url").value = "";
      $("material-body").value = "";
      await reloadMaterials();
    } catch (e) {
      alert(e.message);
    }
  });

  async function reloadMaterials() {
    const data = await AdminQA.api(`/sessions/${sessionId}/materials`);
    state.materials = data.materials;
    renderMaterials();
  }

  $("material-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const card = btn.closest("[data-id]");
    const m = state.materials.find((x) => x.id === card.dataset.id);
    if (!m) return;
    const action = btn.dataset.action;
    try {
      if (action === "edit-material") {
        state.editingMaterialId = m.id;
        renderMaterials();
      }
      if (action === "cancel-material") {
        state.editingMaterialId = null;
        renderMaterials();
      }
      if (action === "save-material") {
        await AdminQA.api(`/sessions/${sessionId}/materials/${m.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            module: card.querySelector('[data-field="module"]').value,
            title: card.querySelector('[data-field="title"]').value,
            url: card.querySelector('[data-field="url"]').value,
            body: card.querySelector('[data-field="body"]').value,
          }),
        });
        state.editingMaterialId = null;
        await reloadMaterials();
      }
      if (action === "delete-material") {
        if (!confirm("この参考情報を削除しますか?")) return;
        await AdminQA.api(`/sessions/${sessionId}/materials/${m.id}`, { method: "DELETE" });
        await reloadMaterials();
      }
      if (action === "move-up" || action === "move-down") {
        const ids = state.materials.map((x) => x.id);
        const index = ids.indexOf(m.id);
        const target = action === "move-up" ? index - 1 : index + 1;
        if (target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        const data = await AdminQA.api(`/sessions/${sessionId}/materials/order`, {
          method: "PUT",
          body: JSON.stringify({ ids }),
        });
        state.materials = data.materials;
        renderMaterials();
      }
    } catch (e) {
      alert(e.message);
    }
  });

  // ---------- アンケート ----------
  function renderSurveys() {
    const statusLabel = { draft: "下書き", published: "配信中", closed: "終了" };
    $("survey-list").innerHTML = [...state.surveys].reverse().map((s) => {
      const total = Math.max(s.totalRespondents, 1);
      return `
      <div class="card" data-id="${esc(s.id)}">
        <div class="question-head">
          <span class="badge badge-status-${esc(s.status)}">${statusLabel[s.status]}</span>
          ${s.isMulti ? '<span class="muted small">複数選択可</span>' : ""}
        </div>
        <h3>${esc(s.title)}</h3>
        <div class="survey-results">
          ${s.options.map((o) => `
            <div class="survey-result-row">
              <div class="survey-result-label"><span>${esc(o.label)}</span><span>${o.count} 票</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.round((o.count / total) * 100)}%"></div></div>
            </div>`).join("")}
          <p class="muted small">回答者: ${s.totalRespondents} 人</p>
        </div>
        <div class="admin-item-actions">
          ${s.status === "draft" ? '<button class="btn btn-small btn-primary" data-action="publish">配信する</button>' : ""}
          ${s.status === "published" ? '<button class="btn btn-small btn-ghost" data-action="close">受付を終了する</button>' : ""}
          <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete-survey">削除</button>
        </div>
      </div>`;
    }).join("");
    $("survey-empty").hidden = state.surveys.length > 0;
  }

  $("survey-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const data = await AdminQA.api(`/sessions/${sessionId}/surveys`, {
        method: "POST",
        body: JSON.stringify({
          title: $("survey-title").value,
          isMulti: $("survey-multi").checked,
          options: $("survey-options").value.split("\n").map((s) => s.trim()).filter(Boolean),
        }),
      });
      state.surveys.push(data.survey);
      $("survey-title").value = "";
      $("survey-options").value = "";
      $("survey-multi").checked = false;
      renderSurveys();
    } catch (e) {
      alert(e.message);
    }
  });

  $("survey-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const card = btn.closest("[data-id]");
    const s = state.surveys.find((x) => x.id === card.dataset.id);
    if (!s) return;
    try {
      if (btn.dataset.action === "publish") {
        const data = await AdminQA.api(`/sessions/${sessionId}/surveys/${s.id}/publish`, { method: "POST" });
        Object.assign(s, data.survey);
      }
      if (btn.dataset.action === "close") {
        const data = await AdminQA.api(`/sessions/${sessionId}/surveys/${s.id}/close`, { method: "POST" });
        Object.assign(s, data.survey);
      }
      if (btn.dataset.action === "delete-survey") {
        if (!confirm("このアンケートを削除しますか?")) return;
        await AdminQA.api(`/sessions/${sessionId}/surveys/${s.id}`, { method: "DELETE" });
        state.surveys = state.surveys.filter((x) => x.id !== s.id);
      }
      renderSurveys();
    } catch (e) {
      alert(e.message);
    }
  });
})();
