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
    // トリアージ・検索・並べ替え(絞り込みはサーバサイド)。UI 既定は「未回答 × いいね順」
    filter: "open",
    sort: "votes",
    q: "",
    counts: { open: 0, done: 0, total: 0 },
    // 2 ペイン: 右ペインに表示中の質問 ID と、描画で消えないよう退避する回答下書き
    selectedId: null,
    answerDraft: "",
    answerPendingImage: null,
    editingMaterialId: null,
    // 一括モデレーション(選択モード)
    bulkMode: false,
    checkedIds: new Set(),
    bulkDeleting: false,
    // 新着ピル: 新規質問はここに溜め、クリックで初めて一覧へ反映する
    pendingNew: [],
    flashIds: new Set(),
    // カーソルページネーション(50 件ずつ)。null は最終ページ到達済み(votes/検索時は一括取得)
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

  /** 質問一覧のクエリ(トリアージ・並べ替え・検索 + カーソル)を組み立てる */
  function listQuery(cursor) {
    const params = new URLSearchParams({ status: state.filter, sort: state.sort });
    if (state.q) params.set("q", state.q);
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }

  async function init() {
    let data;
    try {
      data = await AdminQA.api(`/sessions/${sessionId}?${listQuery()}`);
    } catch (e) {
      return;
    }
    state.session = data.session;
    state.questions = data.questions;
    state.nextCursor = data.nextCursor || null;
    state.counts = data.counts;
    state.materials = data.materials;
    state.surveys = data.surveys;
    renderHeader();
    renderCounts();
    renderQuestions();
    renderDetail();
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
      const data = await AdminQA.api(`/sessions/${sessionId}/questions?${listQuery(state.nextCursor)}`);
      state.nextCursor = data.nextCursor || null;
      state.counts = data.counts;
      for (const q of data.questions) {
        if (!state.questions.some((x) => x.id === q.id)) state.questions.push(q);
      }
      renderCounts();
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

  // フィルタ/ソート/検索の変更時は一覧を作り直す(チェック状態はリセット)
  async function reloadQuestions() {
    try {
      const data = await AdminQA.api(`/sessions/${sessionId}/questions?${listQuery()}`);
      state.questions = data.questions;
      state.nextCursor = data.nextCursor || null;
      state.counts = data.counts;
      state.checkedIds.clear();
      renderCounts();
      renderBulkbar();
      renderQuestions();
      renderDetail();
    } catch (e) {
      alert(e.message);
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

  /** isAnswered の変化を counts に反映しつつ質問を更新する(自操作・WS の両方から使う) */
  function applyQuestionUpdate(q, updated) {
    if (q.isAnswered !== updated.isAnswered) {
      state.counts.open += updated.isAnswered ? -1 : 1;
      state.counts.done += updated.isAnswered ? 1 : -1;
    }
    Object.assign(q, updated);
  }

  /** 一覧から質問を取り除き counts / 選択状態を整合させる(自操作・WS の両方から使う) */
  function removeQuestionLocal(questionId) {
    const existing = state.questions.find((q) => q.id === questionId);
    if (existing) {
      state.counts.total -= 1;
      state.counts[existing.isAnswered ? "done" : "open"] -= 1;
      state.questions = state.questions.filter((q) => q.id !== questionId);
    }
    state.checkedIds.delete(questionId);
    if (state.selectedId === questionId) state.selectedId = null;
  }

  function handleWsMessage(msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case "question:new": {
        // 新規質問はバッファしてピルで通知し、閲覧位置を勝手に動かさない。
        // 件数バッジはサーバの実数に合わせて受信時点で更新する
        if (state.questions.some((q) => q.id === p.question.id)) break;
        state.counts.open += 1;
        state.counts.total += 1;
        renderCounts();
        if (!state.pendingNew.some((q) => q.id === p.question.id)) {
          state.pendingNew.push(p.question);
          updateNewPill();
          AnonQA.playNotify();
        }
        break;
      }
      case "question:updated": {
        const buffered = state.pendingNew.find((x) => x.id === p.question.id);
        if (buffered) {
          if (buffered.isAnswered !== p.question.isAnswered) {
            state.counts.open += p.question.isAnswered ? -1 : 1;
            state.counts.done += p.question.isAnswered ? 1 : -1;
            renderCounts();
          }
          Object.assign(buffered, p.question);
          break;
        }
        const existing = state.questions.find((q) => q.id === p.question.id);
        if (existing) applyQuestionUpdate(existing, p.question);
        else state.questions.unshift(p.question);
        renderCounts();
        renderQuestions();
        renderDetail();
        break;
      }
      case "question:deleted": {
        const buffered = state.pendingNew.find((x) => x.id === p.questionId);
        if (buffered) {
          state.pendingNew = state.pendingNew.filter((x) => x.id !== p.questionId);
          state.counts.total -= 1;
          state.counts[buffered.isAnswered ? "done" : "open"] -= 1;
          renderCounts();
          updateNewPill();
          break;
        }
        removeQuestionLocal(p.questionId);
        renderCounts();
        renderBulkbar();
        renderQuestions();
        renderDetail();
        break;
      }
      case "vote:changed": {
        const buffered = state.pendingNew.find((x) => x.id === p.questionId);
        if (buffered) {
          buffered.votes = p.votes;
          break;
        }
        const q = state.questions.find((x) => x.id === p.questionId);
        if (q) {
          q.votes = p.votes;
          renderQuestions();
          renderDetail();
        }
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

  // ---------- 質問管理(トリアージ / 検索 / 並べ替え / 2 ペイン) ----------
  const FILTER_LABEL = { open: "未回答", done: "回答済み", all: "すべて" };
  const SORT_LABEL = { votes: "いいね順", new: "新着順", old: "古い順" };

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.filter === btn.dataset.status) return;
      state.filter = btn.dataset.status;
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      reloadQuestions();
    });
  });

  $("question-sort").addEventListener("change", () => {
    state.sort = $("question-sort").value;
    reloadQuestions();
  });

  // 検索はデバウンス(250ms)してサーバへ問い合わせる
  let searchTimer = null;
  $("question-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const value = $("question-search").value.trim();
      if (value === state.q) return;
      state.q = value;
      reloadQuestions();
    }, 250);
  });

  function renderCounts() {
    $("count-open").textContent = String(state.counts.open);
    $("count-done").textContent = String(state.counts.done);
    $("count-all").textContent = String(state.counts.total);
  }

  function matchesFilter(q) {
    if (state.filter === "open") return !q.isAnswered;
    if (state.filter === "done") return q.isAnswered;
    return true;
  }

  // サーバ絞り込み済みの一覧に WebSocket 更新が混ざるため、表示直前にも同じ条件を適用する
  function visibleQuestions() {
    const keyword = state.q.toLowerCase();
    return state.questions
      .filter((q) => matchesFilter(q) && (!keyword || q.body.toLowerCase().includes(keyword)))
      .sort((a, b) => {
        if (state.sort === "votes") return b.votes - a.votes || b.createdAt - a.createdAt;
        if (state.sort === "old") return a.createdAt - b.createdAt;
        return b.createdAt - a.createdAt;
      });
  }

  function statusBadge(q) {
    return q.isAnswered
      ? '<span class="badge badge-answered">回答済み</span>'
      : '<span class="badge badge-open">未回答</span>';
  }

  function qitemHtml(q) {
    const classes = ["qitem"];
    if (q.id === state.selectedId) classes.push("sel");
    if (state.flashIds.has(q.id)) classes.push("flash");
    return `
      <div class="${classes.join(" ")}" data-id="${esc(q.id)}" role="button" tabindex="0">
        ${state.bulkMode ? `<input type="checkbox" class="bulk-check" data-role="bulk-item" ${state.checkedIds.has(q.id) ? "checked" : ""} aria-label="一括操作の対象にする">` : ""}
        <div class="votecol${q.votes >= 5 ? " hot" : ""}"><span class="votecol-n">${q.votes}</span><span class="votecol-l">いいね</span></div>
        <div class="qmain">
          <div class="qmeta">
            <span>${AnonQA.formatJst(q.createdAt)}</span>
            ${statusBadge(q)}
            ${q.answers.length ? `<span>💬 ${q.answers.length}</span>` : ""}
            ${q.imageKey ? "<span>🖼 画像</span>" : ""}
          </div>
          <div class="qtext">${esc(q.body)}</div>
        </div>
      </div>`;
  }

  function renderQuestions() {
    const items = visibleQuestions();
    $("list-heading").textContent =
      `${FILTER_LABEL[state.filter]}(${SORT_LABEL[state.sort]})${state.q ? " ・検索中" : ""}`;
    $("question-list").innerHTML = items.map(qitemHtml).join("");
    $("question-empty").hidden = items.length > 0;
    state.flashIds.clear();
  }

  // ---------- 新着ピル ----------
  function updateNewPill() {
    const n = state.pendingNew.length;
    $("new-question-pill").hidden = n === 0;
    $("new-question-count").textContent = String(n);
  }

  // ピルのクリックで初めて一覧へ反映する(反映分は一瞬ハイライト)。
  // 挿入位置は visibleQuestions() の再フィルタ・再ソートで現在の表示条件に整合する
  function applyPendingNew() {
    const items = state.pendingNew.splice(0);
    for (const q of items) {
      if (state.questions.some((x) => x.id === q.id)) continue;
      state.questions.unshift(q);
      state.flashIds.add(q.id);
    }
    updateNewPill();
    renderQuestions();
  }

  $("new-question-pill").addEventListener("click", applyPendingNew);

  function answerHtml(a) {
    const isInstructor = a.authorRole === "instructor";
    return `
      <div class="answer${isInstructor ? "" : " answer-participant"}" data-answer-id="${esc(a.id)}">
        <span class="answer-label${isInstructor ? "" : " answer-label-participant"}">${isInstructor ? "講師" : "参加者"}</span>
        ${a.body ? `<p>${AnonQA.linkify(a.body)}</p>` : ""}
        ${a.imageKey ? `<a href="${imageUrl(a.imageKey)}" target="_blank" rel="noopener"><img class="answer-image" src="${imageUrl(a.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
        <span class="muted small">${AnonQA.formatJst(a.createdAt)}${a.updatedAt > a.createdAt ? "(編集済み)" : ""}</span>
        <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete-answer">削除</button>
      </div>`;
  }

  // 右ペイン(詳細 + 回答入力)。WebSocket 更新で再描画されても入力中の回答と
  // フォーカス位置が失われないよう、textarea の状態を退避して復元する
  function renderDetail() {
    const detail = $("question-detail");
    const prevInput = detail.querySelector(".answer-input");
    if (prevInput) state.answerDraft = prevInput.value;
    const hadFocus = prevInput && document.activeElement === prevInput;
    const selStart = hadFocus ? prevInput.selectionStart : 0;
    const selEnd = hadFocus ? prevInput.selectionEnd : 0;

    const q = state.questions.find((x) => x.id === state.selectedId);
    if (!q) {
      detail.innerHTML = '<p class="detail-empty">左の一覧から質問を選択してください</p>';
      $("detail-pane").classList.remove("mobile-show");
      return;
    }
    detail.innerHTML = `
      <div class="question-head">
        <span class="muted small">${AnonQA.formatJst(q.createdAt)}</span>
        ${statusBadge(q)}
        <span class="muted small">👍 ${q.votes}</span>
      </div>
      <p class="question-body">${AnonQA.linkify(q.body)}</p>
      ${q.imageKey ? `<a href="${imageUrl(q.imageKey)}" target="_blank" rel="noopener"><img class="question-image" src="${imageUrl(q.imageKey)}" alt="添付画像" loading="lazy"></a>` : ""}
      ${q.answers.length ? `<div class="answers">${q.answers.map(answerHtml).join("")}</div>` : ""}
      <div class="field" style="margin-top: 12px;">
        <textarea class="textarea answer-input" rows="3"
          placeholder="回答を入力(画像の貼り付け・添付も可能)。送信すると自動で回答済みになります">${esc(state.answerDraft)}</textarea>
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
            <button class="btn btn-primary btn-small" data-action="submit-answer">回答する</button>
            <button class="btn btn-small btn-ghost" data-action="toggle-answered">${q.isAnswered ? "未回答に戻す" : "回答済みにする"}</button>
            <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete">質問を削除</button>
          </div>
        </div>
      </div>`;
    if (hadFocus) {
      const input = detail.querySelector(".answer-input");
      input.focus();
      input.setSelectionRange(selStart, selEnd);
    }
  }

  function selectQuestion(id) {
    if (state.selectedId !== id) {
      state.selectedId = id;
      state.answerDraft = "";
      clearAnswerPendingImage();
    }
    renderQuestions();
    renderDetail();
    // 狭幅(1 カラム)では選択時に詳細を表示してスクロールする
    $("detail-pane").classList.add("mobile-show");
    if (window.innerWidth < 768) {
      $("detail-pane").scrollIntoView({ behavior: "smooth" });
    }
  }

  function imageUrl(imageKey) {
    return `/api/s/${encodeURIComponent(state.session.code)}/images/${encodeURIComponent(imageKey)}`;
  }

  // 左一覧: クリック(または Enter/Space)で右ペインに表示。選択モード中はチェックのみ
  $("question-list").addEventListener("click", (ev) => {
    const item = ev.target.closest(".qitem");
    if (!item) return;
    const checkbox = ev.target.closest('[data-role="bulk-item"]');
    if (checkbox) {
      if (checkbox.checked) state.checkedIds.add(item.dataset.id);
      else state.checkedIds.delete(item.dataset.id);
      renderBulkbar();
      return;
    }
    selectQuestion(item.dataset.id);
  });

  $("question-list").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const item = ev.target.closest(".qitem");
    if (!item || ev.target.closest("input")) return;
    ev.preventDefault();
    selectQuestion(item.dataset.id);
  });

  // 右ペインの操作(回答 / 未回答戻し / 削除 / 返信削除)。既存 API をそのまま使う
  $("question-detail").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const q = state.questions.find((x) => x.id === state.selectedId);
    if (!q) return;
    const action = btn.dataset.action;
    try {
      if (action === "answer-image-remove") {
        clearAnswerPendingImage();
        renderDetail();
      }
      if (action === "submit-answer") {
        const body = $("question-detail").querySelector(".answer-input").value.trim();
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
        applyQuestionUpdate(q, data.question);
        state.answerDraft = "";
        clearAnswerPendingImage();
        renderCounts();
        renderQuestions();
        renderDetail();
      }
      if (action === "toggle-answered") {
        const data = await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}/answered`, {
          method: "PATCH",
          body: JSON.stringify({ isAnswered: !q.isAnswered }),
        });
        applyQuestionUpdate(q, data.question);
        renderCounts();
        renderQuestions();
        renderDetail();
      }
      if (action === "delete") {
        if (!confirm("この質問を削除しますか?")) return;
        await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}`, { method: "DELETE" });
        removeQuestionLocal(q.id);
        renderCounts();
        renderBulkbar();
        renderQuestions();
        renderDetail();
      }
      if (action === "delete-answer") {
        if (!confirm("この返信を削除しますか?")) return;
        const answerId = btn.closest("[data-answer-id]").dataset.answerId;
        const data = await AdminQA.api(`/sessions/${sessionId}/questions/${q.id}/answers/${answerId}`, {
          method: "DELETE",
        });
        applyQuestionUpdate(q, data.question);
        renderQuestions();
        renderDetail();
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
    renderDetail();
  }

  function clearAnswerPendingImage() {
    if (state.answerPendingImage) URL.revokeObjectURL(state.answerPendingImage.previewUrl);
    state.answerPendingImage = null;
  }

  $("question-detail").addEventListener("change", (ev) => {
    const input = ev.target.closest(".answer-image-input");
    if (!input || !input.files || !input.files[0]) return;
    setAnswerPendingImage(input.files[0]);
    input.value = "";
  });

  $("question-detail").addEventListener("paste", (ev) => {
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

  // ---------- 一括モデレーション ----------
  function renderBulkbar() {
    $("bulkbar").hidden = !state.bulkMode;
    $("bulk-toggle-btn").textContent = state.bulkMode ? "選択を解除" : "選択";
    $("bulk-count").textContent = String(state.checkedIds.size);
    const total = visibleQuestions().length;
    $("bulk-select-all").checked = total > 0 && state.checkedIds.size >= total;
    // チェック数が変わったら確認 UI はいったん引っ込める(誤操作防止)
    $("bulk-confirm").hidden = true;
    $("bulk-delete-btn").disabled = state.checkedIds.size === 0 || state.bulkDeleting;
  }

  $("bulk-toggle-btn").addEventListener("click", () => {
    state.bulkMode = !state.bulkMode;
    state.checkedIds.clear();
    renderBulkbar();
    renderQuestions();
  });

  $("bulk-cancel-btn").addEventListener("click", () => {
    state.bulkMode = false;
    state.checkedIds.clear();
    renderBulkbar();
    renderQuestions();
  });

  $("bulk-select-all").addEventListener("change", () => {
    if ($("bulk-select-all").checked) {
      for (const q of visibleQuestions()) state.checkedIds.add(q.id);
    } else {
      state.checkedIds.clear();
    }
    renderBulkbar();
    renderQuestions();
  });

  // 破壊的操作のため画面内の確認 UI を挟む(CSP 方針によりブラウザモーダルは使わない)
  $("bulk-delete-btn").addEventListener("click", () => {
    if (state.checkedIds.size === 0) return;
    $("bulk-confirm-label").textContent = `${state.checkedIds.size} 件の質問を削除します。よろしいですか?`;
    $("bulk-confirm").hidden = false;
  });

  $("bulk-delete-cancel-btn").addEventListener("click", () => {
    $("bulk-confirm").hidden = true;
  });

  // 既存の単一 DELETE(画像後始末 + broadcast 込み)を 1 件ずつ確実に呼ぶ。
  // まとめ削除専用の API は作らない
  $("bulk-delete-confirm-btn").addEventListener("click", async () => {
    if (state.bulkDeleting) return;
    state.bulkDeleting = true;
    $("bulk-confirm").hidden = true;
    $("bulk-delete-btn").disabled = true;
    const targets = [...state.checkedIds];
    const failed = [];
    for (const id of targets) {
      try {
        await AdminQA.api(`/sessions/${sessionId}/questions/${id}`, { method: "DELETE" });
        removeQuestionLocal(id);
        renderCounts();
        renderQuestions();
      } catch (e) {
        failed.push(id);
      }
    }
    state.bulkDeleting = false;
    if (failed.length > 0) {
      // 失敗分はチェックを残し、残件が分かるようにする
      state.checkedIds = new Set(failed);
      alert(`${failed.length} 件の削除に失敗しました。チェックが残っている質問を確認してください`);
    } else {
      state.bulkMode = false;
      state.checkedIds.clear();
    }
    renderBulkbar();
    renderQuestions();
    renderDetail();
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
