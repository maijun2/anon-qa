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

  // サーバ側と同じラスタ画像のみ許可(SVG は XSS 対策で除外)
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const isAllowedImage = (type) => ALLOWED_IMAGE_TYPES.includes(type);

  const state = {
    session: null,
    ended: false,
    questions: [],
    materials: [],
    surveys: [],
    // 絞り込み(講師画面と同じ命名): open / done / mine / all
    filter: "open",
    sort: "new",
    pendingImage: null,
    replyPendingImage: null,
    editingId: null,
    replyingId: null,
    editingAnswerId: null,
    // 自分の返信 ID。ブロードキャストの isMine は常に false のため、ここで復元する
    myAnswerIds: new Set(),
    // カーソルページネーション(50 件ずつ)。null は最終ページ到達済み
    nextCursor: null,
    loadingMore: false,
    // 新着ピル: 他の参加者の新規質問はここに溜め、クリックで初めて一覧へ反映する
    // (閲覧位置のスクロール暴れを防ぐ。自分の投稿は従来どおり即時反映)
    pendingNew: [],
    // ピル反映直後に一瞬ハイライトする質問 ID
    flashIds: new Set(),
    // 未読管理(メモリ内のみ。匿名性維持のためサーバ保存や localStorage は使わない):
    // 質問 ID → 確認済みの講師回答数。増加を検知したら unreadIds に積む
    seenInstructorAnswers: new Map(),
    unreadIds: new Set(),
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
      AnonQA.initSoundToggle($("sound-toggle"));
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
    state.nextCursor = data.nextCursor || null;
    for (const q of state.questions) {
      for (const a of q.answers) if (a.isMine) state.myAnswerIds.add(a.id);
      // 初期ロード分は既読扱い(以降の増加のみ未読にする)
      state.seenInstructorAnswers.set(q.id, instructorAnswerCount(q));
    }
    renderQuestions();
  }

  // 無限スクロール: 番兵が画面に入ったら次ページ(50 件)を追加取得する。
  // WebSocket で既に受信済みの質問は id で重複排除する
  async function loadMoreQuestions() {
    if (!state.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    $("question-loading").hidden = false;
    try {
      const data = await AnonQA.api(code, `/questions?cursor=${encodeURIComponent(state.nextCursor)}`);
      state.nextCursor = data.nextCursor || null;
      for (const q of data.questions) {
        if (state.questions.some((x) => x.id === q.id)) continue;
        state.questions.push(q);
        for (const a of q.answers) if (a.isMine) state.myAnswerIds.add(a.id);
        state.seenInstructorAnswers.set(q.id, instructorAnswerCount(q));
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
      case "question:new": {
        // 自分の投稿(楽観反映済みで一覧に存在)は即時更新。
        // 他の参加者の新規質問はバッファしてピルで通知し、閲覧位置を動かさない
        if (state.questions.some((x) => x.id === p.question.id)) {
          upsertQuestion(p.question);
          renderQuestions();
          break;
        }
        if (!state.pendingNew.some((x) => x.id === p.question.id)) {
          state.pendingNew.push(p.question);
          updateNewPill();
          AnonQA.playNotify();
        }
        break;
      }
      case "question:updated": {
        const buffered = state.pendingNew.find((x) => x.id === p.question.id);
        if (buffered) {
          Object.assign(buffered, p.question);
          break;
        }
        upsertQuestion(p.question);
        trackUnread(p.question.id);
        renderQuestions();
        break;
      }
      case "question:deleted":
        state.questions = state.questions.filter((q) => q.id !== p.questionId);
        state.pendingNew = state.pendingNew.filter((q) => q.id !== p.questionId);
        state.unreadIds.delete(p.questionId);
        updateBellUnread();
        updateNewPill();
        renderQuestions();
        break;
      case "vote:changed": {
        const buffered = state.pendingNew.find((x) => x.id === p.questionId);
        if (buffered) { buffered.votes = p.votes; break; }
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
    let target;
    if (existing) {
      Object.assign(existing, question, { isMine: existing.isMine, voted: existing.voted });
      target = existing;
    } else {
      target = Object.assign({ isMine: false, voted: false }, question);
      state.questions.unshift(target);
    }
    for (const a of target.answers || []) {
      a.isMine = a.isMine || state.myAnswerIds.has(a.id);
    }
  }

  // ---------- 新着ピル / 未読 ----------
  function instructorAnswerCount(q) {
    return (q.answers || []).filter((a) => a.authorRole === "instructor").length;
  }

  // 自分が投稿 or 返信したスレッドか(未読ドットの対象)
  function isMyThread(q) {
    return q.isMine || (q.answers || []).some((a) => a.isMine || state.myAnswerIds.has(a.id));
  }

  // 講師回答数の増加を検知して未読にする。初見の質問は既読扱いで基準値のみ記録
  function trackUnread(questionId) {
    const q = state.questions.find((x) => x.id === questionId);
    if (!q) return;
    const count = instructorAnswerCount(q);
    const seen = state.seenInstructorAnswers.get(q.id);
    if (seen !== undefined && count > seen && isMyThread(q)) {
      state.unreadIds.add(q.id);
    }
    state.seenInstructorAnswers.set(q.id, count);
    updateBellUnread();
  }

  // 未読が 1 件以上あるあいだ、ヘッダのベル(通知音トグル)に赤ドットを重畳する。
  // 通知音の ON/OFF 機能(initSoundToggle)には手を入れず、クラスの付け外しのみ行う
  function updateBellUnread() {
    $("sound-toggle").classList.toggle("has-unread", state.unreadIds.size > 0);
  }

  function updateNewPill() {
    const n = state.pendingNew.length;
    $("new-question-pill").hidden = n === 0;
    $("new-question-count").textContent = String(n);
  }

  // ピルのクリックで初めてバッファ分を一覧へ反映する(反映分は一瞬ハイライト)
  function applyPendingNew() {
    const items = state.pendingNew.splice(0);
    for (const q of items) {
      if (state.questions.some((x) => x.id === q.id)) continue;
      upsertQuestion(q);
      state.seenInstructorAnswers.set(q.id, instructorAnswerCount(q));
      state.flashIds.add(q.id);
    }
    updateNewPill();
    renderQuestions();
    state.flashIds.clear();
  }

  $("new-question-pill").addEventListener("click", applyPendingNew);

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

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.filter === btn.dataset.status) return;
      state.filter = btn.dataset.status;
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderQuestions();
    });
  });

  function matchesFilter(q) {
    if (state.filter === "open") return !q.isAnswered;
    if (state.filter === "done") return q.isAnswered;
    if (state.filter === "mine") return q.isMine;
    return true;
  }

  // 件数バッジは読み込み済みの質問に対する集計。
  // 絞り込みで一覧が短くなると番兵が可視域に入り、既存の追加読み込みで残りも順次反映される
  function updateFilterCounts() {
    const all = state.questions.length;
    const done = state.questions.filter((q) => q.isAnswered).length;
    const mine = state.questions.filter((q) => q.isMine).length;
    $("count-open").textContent = String(all - done);
    $("count-done").textContent = String(done);
    $("count-mine").textContent = String(mine);
    $("count-all").textContent = String(all);
  }

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
    if (q.isMine) classes.push("mine");
    if (state.flashIds.has(q.id)) classes.push("flash");
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
      : `<p class="question-body">${AnonQA.linkify(q.body)}</p>`;
    return `
      <article class="${classes.join(" ")}" data-id="${esc(q.id)}">
        <div class="question-head">
          <span class="muted small">${AnonQA.formatJst(q.createdAt)}${q.updatedAt > q.createdAt ? "(編集済み)" : ""}</span>
          ${q.isAnswered ? '<span class="badge badge-answered">回答済み</span>' : ""}
          ${q.isMine ? '<span class="badge badge-mine">あなたの質問</span>' : ""}
          ${state.unreadIds.has(q.id) ? '<span class="unread-note">新しい回答</span>' : ""}
          ${q.pending ? '<span class="muted small">送信中…</span>' : ""}
        </div>
        ${bodyHtml}
        ${q.imageKey ? `<a href="${imageUrl(q.imageKey)}" target="_blank" rel="noopener" data-lightbox><img class="question-image" src="${imageUrl(q.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
        ${q.answers.length ? `<div class="answers">${q.answers.map((a) => answerHtml(a)).join("")}</div>` : ""}
        ${state.replyingId === q.id ? `
          <div class="field reply-form">
            <textarea class="textarea reply-input" rows="2" placeholder="返信を入力(匿名で投稿されます。画像の貼り付け・添付も可能)"></textarea>
            ${state.replyPendingImage ? `
              <div class="image-preview">
                <img src="${state.replyPendingImage.previewUrl}" alt="添付画像プレビュー">
                <button type="button" class="btn btn-ghost btn-small" data-action="reply-image-remove">添付を取り消す</button>
              </div>` : ""}
            <div class="form-row">
              <label class="btn btn-ghost btn-small file-label">
                画像を添付
                <input type="file" class="reply-image-input" accept="image/png,image/jpeg,image/gif,image/webp">
              </label>
              <div class="admin-item-actions">
                <button class="btn btn-primary btn-small" data-action="submit-reply">返信を送信</button>
                <button class="btn btn-ghost btn-small" data-action="cancel-reply">キャンセル</button>
              </div>
            </div>
          </div>` : ""}
        <div class="question-actions">
          <button class="vote-btn${q.voted ? " voted" : ""}" data-action="vote" aria-pressed="${q.voted}"
            ${state.ended || q.pending ? "disabled" : ""} aria-label="いいね">
            👍 <span class="vote-count">${q.votes}</span>
          </button>
          ${!state.ended && !q.pending && state.replyingId !== q.id
            ? '<button class="btn btn-ghost btn-small" data-action="reply">返信する</button>' : ""}
          ${editable && !isEditing ? `
            <button class="btn btn-ghost btn-small" data-action="edit">編集</button>
            <button class="btn btn-ghost btn-small btn-danger-text" data-action="delete">削除</button>` : ""}
        </div>
      </article>`;
  }

  function answerHtml(a) {
    if (state.editingAnswerId === a.id) {
      return `
        <div class="answer" data-answer-id="${esc(a.id)}">
          <div class="field">
            <textarea class="textarea answer-edit-input" rows="2">${esc(a.body)}</textarea>
            <div class="admin-item-actions">
              <button class="btn btn-primary btn-small" data-action="save-edit-answer">保存</button>
              <button class="btn btn-ghost btn-small" data-action="cancel-edit-answer">キャンセル</button>
            </div>
          </div>
        </div>`;
    }
    const isInstructor = a.authorRole === "instructor";
    const editable = a.isMine && !state.ended;
    return `
      <div class="answer${isInstructor ? "" : " answer-participant"}" data-answer-id="${esc(a.id)}">
        <span class="answer-label${isInstructor ? "" : " answer-label-participant"}">${isInstructor ? "講師" : "参加者"}</span>
        ${a.isMine ? '<span class="badge badge-mine">自分の返信</span>' : ""}
        ${a.body ? `<p>${AnonQA.linkify(a.body)}</p>` : ""}
        ${a.imageKey ? `<a href="${imageUrl(a.imageKey)}" target="_blank" rel="noopener" data-lightbox><img class="answer-image" src="${imageUrl(a.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
        <span class="muted small">${AnonQA.formatJst(a.createdAt)}${a.updatedAt > a.createdAt ? "(編集済み)" : ""}</span>
        ${editable ? `
          <button class="btn btn-ghost btn-small" data-action="edit-answer">編集</button>
          <button class="btn btn-ghost btn-small btn-danger-text" data-action="delete-answer">削除</button>` : ""}
      </div>`;
  }

  function imageUrl(imageKey) {
    return `/api/s/${encodeURIComponent(code)}/images/${encodeURIComponent(imageKey)}`;
  }

  function renderQuestions() {
    const items = sortQuestions(state.questions.filter(matchesFilter));
    $("question-list").innerHTML = items.map(questionCard).join("");
    updateFilterCounts();
    // 1 件も無い(初回)場合と、絞り込みで 0 件の場合で文言を出し分ける
    $("question-empty").textContent = state.questions.length === 0
      ? "まだ質問はありません。最初の質問を投稿してみましょう。"
      : "該当する質問はありません。";
    $("question-empty").hidden = items.length > 0;
  }

  // 質問一覧のイベントは委譲で 1 箇所にまとめる(カードは再描画のたびに作り直されるため)
  // 未読ドットはカードのタップで既読化する。
  // 全再描画すると同一クリック中の他ハンドラが detached DOM を掴むため、その場で除去する
  $("question-list").addEventListener("click", (ev) => {
    const cardEl = ev.target.closest(".question-card");
    if (cardEl && state.unreadIds.delete(cardEl.dataset.id)) {
      const note = cardEl.querySelector(".unread-note");
      if (note) note.remove();
      updateBellUnread();
    }
  });

  $("question-list").addEventListener("click", (ev) => {
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
    if (action === "reply") {
      state.replyingId = q.id;
      clearReplyPendingImage();
      renderQuestions();
      const input = document.querySelector(`[data-id="${CSS.escape(q.id)}"] .reply-input`);
      if (input) input.focus();
    }
    if (action === "cancel-reply") { state.replyingId = null; clearReplyPendingImage(); renderQuestions(); }
    if (action === "reply-image-remove") { clearReplyPendingImage(); renderQuestions(); }
    if (action === "submit-reply") submitReply(q, card.querySelector(".reply-input").value);
    const answerEl = btn.closest("[data-answer-id]");
    const answerId = answerEl ? answerEl.dataset.answerId : null;
    if (action === "edit-answer") { state.editingAnswerId = answerId; renderQuestions(); }
    if (action === "cancel-edit-answer") { state.editingAnswerId = null; renderQuestions(); }
    if (action === "save-edit-answer") saveAnswerEdit(q, answerId, answerEl.querySelector(".answer-edit-input").value);
    if (action === "delete-answer") deleteAnswer(q, answerId);
  });

  // 返信フォームの画像添付(ファイル選択)
  $("question-list").addEventListener("change", (ev) => {
    const input = ev.target.closest(".reply-image-input");
    if (!input || !input.files || !input.files[0]) return;
    setReplyPendingImage(input.files[0]);
    input.value = "";
  });

  // 返信フォームへの画像貼り付け
  $("question-list").addEventListener("paste", (ev) => {
    if (!ev.target.closest(".reply-input")) return;
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (isAllowedImage(item.type)) {
        ev.preventDefault();
        setReplyPendingImage(item.getAsFile());
        return;
      }
    }
  });

  function setReplyPendingImage(file) {
    if (!file) return;
    if (!isAllowedImage(file.type)) {
      alert("画像は PNG / JPEG / GIF / WebP 形式のみ添付できます");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("画像は 1 枚 5MB 以下にしてください");
      return;
    }
    clearReplyPendingImage();
    state.replyPendingImage = { file, previewUrl: URL.createObjectURL(file) };
    renderQuestions();
  }

  function clearReplyPendingImage() {
    if (state.replyPendingImage) URL.revokeObjectURL(state.replyPendingImage.previewUrl);
    state.replyPendingImage = null;
  }

  // ---------- 返信スレッド ----------
  async function submitReply(q, text) {
    const body = text.trim();
    const pending = state.replyPendingImage;
    if (!body && !pending) return;
    try {
      let imageKey;
      if (pending) {
        const form = new FormData();
        form.append("file", pending.file);
        imageKey = (await AnonQA.api(code, "/images", { method: "POST", body: form })).imageKey;
      }
      const res = await AnonQA.api(code, `/questions/${q.id}/answers`, {
        method: "POST",
        body: JSON.stringify({ body, imageKey }),
      });
      state.myAnswerIds.add(res.answerId);
      state.replyingId = null;
      clearReplyPendingImage();
      upsertQuestion(res.question);
      trackUnread(q.id);
    } catch (e) {
      alert(e.message);
    }
    renderQuestions();
  }

  async function saveAnswerEdit(q, answerId, text) {
    const body = text.trim();
    if (!body) return;
    try {
      const res = await AnonQA.api(code, `/questions/${q.id}/answers/${answerId}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      state.editingAnswerId = null;
      upsertQuestion(res.question);
      trackUnread(q.id);
    } catch (e) {
      alert(e.message);
    }
    renderQuestions();
  }

  async function deleteAnswer(q, answerId) {
    if (!confirm("この返信を削除しますか?")) return;
    try {
      const res = await AnonQA.api(code, `/questions/${q.id}/answers/${answerId}`, { method: "DELETE" });
      upsertQuestion(res.question);
      trackUnread(q.id);
    } catch (e) {
      alert(e.message);
    }
    renderQuestions();
  }

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
      if (isAllowedImage(item.type)) {
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
    if (file && isAllowedImage(file.type)) setPendingImage(file);
  });

  function setPendingImage(file) {
    if (!file) return;
    if (!isAllowedImage(file.type)) {
      alert("画像は PNG / JPEG / GIF / WebP 形式のみ添付できます");
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
      // WebSocket broadcast が API 応答より先に届いてバッファ済みの場合は取り除く(二重反映防止)
      state.pendingNew = state.pendingNew.filter((q) => q.id !== res.question.id);
      updateNewPill();
      const existing = state.questions.find((q) => q.id === res.question.id);
      if (existing) {
        Object.assign(existing, res.question);
      } else {
        state.questions.unshift(res.question);
      }
      state.seenInstructorAnswers.set(res.question.id, instructorAnswerCount(res.question));
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
          ${m.body ? `<p class="material-body">${AnonQA.linkify(m.body)}</p>` : ""}
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
