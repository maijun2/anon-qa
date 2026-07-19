// admin ダッシュボード: セッション一覧・作成、テンプレート管理
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = AnonQA.escapeHtml;
  let templates = [];
  let editingTemplateId = null;

  init();

  async function init() {
    try {
      await AdminQA.api("/me");
    } catch (e) {
      return; // /admin へリダイレクト済み
    }
    $("held-on-input").value = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    await Promise.all([loadSessions(), loadTemplates()]);
  }

  $("logout-btn").addEventListener("click", async () => {
    await AdminQA.api("/logout", { method: "POST" }).catch(() => {});
    location.href = "/admin";
  });

  // ---------- セッション ----------
  async function loadSessions() {
    const data = await AdminQA.api("/sessions");
    const rows = data.sessions.map((s) => `
      <tr data-id="${esc(s.id)}" data-code="${esc(s.code)}">
        <td><span class="session-code">${esc(s.code)}</span></td>
        <td>${esc(s.courseName)}</td>
        <td>${esc(s.heldOn)}</td>
        <td><span class="badge badge-status-${esc(s.status)}">${s.status === "active" ? "開催中" : "終了"}</span></td>
        <td>${s.questionCount}</td>
        <td class="muted small">${AnonQA.formatJstDate(s.expiresAt)}</td>
        <td>
          <div class="actions-inline">
            <a class="btn btn-small btn-primary" href="/admin/s/${esc(s.id)}">管理</a>
            <a class="btn btn-small btn-ghost" href="/admin/s/${esc(s.id)}/present" target="_blank" rel="noopener">投影</a>
            ${s.status === "active" ? '<button class="btn btn-small btn-ghost" data-action="end">終了</button>' : ""}
            <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete">削除</button>
          </div>
        </td>
      </tr>`).join("");
    $("session-rows").innerHTML = rows;
    $("session-empty").hidden = data.sessions.length > 0;
  }

  $("session-rows").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = tr.dataset.id;
    try {
      if (btn.dataset.action === "end") {
        if (!confirm("このセッションを終了しますか?(参加者は閲覧のみ可能になります)")) return;
        await AdminQA.api(`/sessions/${id}/end`, { method: "POST" });
      }
      if (btn.dataset.action === "delete") {
        if (!confirm("このセッションを削除しますか?質問・画像・アンケートを含む全データが削除されます。")) return;
        await AdminQA.api(`/sessions/${id}`, { method: "DELETE" });
      }
      await loadSessions();
    } catch (e) {
      alert(e.message);
    }
  });

  $("create-session-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const data = await AdminQA.api("/sessions", {
        method: "POST",
        body: JSON.stringify({
          courseName: $("course-name-input").value,
          heldOn: $("held-on-input").value,
          templateId: $("template-select").value || undefined,
        }),
      });
      const s = data.session;
      const joinUrl = `${location.origin}/?code=${encodeURIComponent(s.code)}`;
      const resultEl = $("create-result");
      resultEl.innerHTML =
        `作成しました。アクセスコード: <span class="session-code">${esc(s.code)}</span> / ` +
        `参加 URL: <a href="${esc(joinUrl)}" target="_blank" rel="noopener">${esc(joinUrl)}</a>`;
      resultEl.hidden = false;
      $("course-name-input").value = "";
      await loadSessions();
    } catch (e) {
      alert(e.message);
    }
  });

  // ---------- テンプレート ----------
  async function loadTemplates() {
    const data = await AdminQA.api("/templates");
    templates = data.templates;
    $("template-list").innerHTML = templates.map((t) => `
      <div class="card" data-id="${esc(t.id)}">
        <div class="form-row" style="margin: 0;">
          <div>
            <strong>${esc(t.name)}</strong>
            <span class="muted small">参考情報 ${t.materialCount} 件 / アンケート ${t.surveyCount} 件</span>
          </div>
          <div class="actions-inline">
            <button class="btn btn-small btn-ghost" data-action="edit-template">編集</button>
            <button class="btn btn-small btn-ghost btn-danger-text" data-action="delete-template">削除</button>
          </div>
        </div>
      </div>`).join("");
    $("template-empty").hidden = templates.length > 0;
    const select = $("template-select");
    select.innerHTML =
      '<option value="">(使用しない)</option>' +
      templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  }

  $("template-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.closest("[data-id]").dataset.id;
    if (btn.dataset.action === "delete-template") {
      if (!confirm("このテンプレートを削除しますか?")) return;
      try {
        await AdminQA.api(`/templates/${id}`, { method: "DELETE" });
        await loadTemplates();
      } catch (e) {
        alert(e.message);
      }
    }
    if (btn.dataset.action === "edit-template") {
      try {
        const data = await AdminQA.api(`/templates/${id}`);
        openTemplateEditor(data.template, id);
      } catch (e) {
        alert(e.message);
      }
    }
  });

  $("new-template-btn").addEventListener("click", () => openTemplateEditor(null, null));
  $("cancel-template").addEventListener("click", closeTemplateEditor);
  $("add-material-row").addEventListener("click", () => addMaterialRow());
  $("add-survey-row").addEventListener("click", () => addSurveyRow());

  function openTemplateEditor(template, id) {
    editingTemplateId = id;
    $("template-editor-title").textContent = id ? "テンプレート編集" : "新規テンプレート";
    $("template-name-input").value = template ? template.name : "";
    $("template-materials").innerHTML = "";
    $("template-surveys").innerHTML = "";
    (template ? template.materials : []).forEach(addMaterialRow);
    (template ? template.surveys : []).forEach(addSurveyRow);
    $("template-error").hidden = true;
    $("template-editor").classList.remove("hidden");
    $("template-name-input").focus();
  }

  function closeTemplateEditor() {
    editingTemplateId = null;
    $("template-editor").classList.add("hidden");
  }

  function addMaterialRow(material) {
    const row = document.createElement("div");
    row.className = "card";
    row.style.marginBottom = "8px";
    row.dataset.role = "material-row";
    row.innerHTML = `
      <div class="form-row" style="margin: 0 0 8px;">
        <input class="input" data-field="module" placeholder="Module(例: Module 1)" style="flex: 1;"
          value="${material ? esc(material.module || "") : ""}">
        <input class="input" data-field="title" placeholder="タイトル(必須)" style="flex: 2;"
          value="${material ? esc(material.title || "") : ""}">
        <button type="button" class="btn btn-small btn-ghost btn-danger-text" data-action="remove-row">削除</button>
      </div>
      <input class="input" data-field="url" placeholder="URL(任意)" style="margin-bottom: 8px;"
        value="${material ? esc(material.url || "") : ""}">
      <textarea class="textarea" data-field="body" rows="2" placeholder="メモ(任意)">${material ? esc(material.body || "") : ""}</textarea>`;
    $("template-materials").appendChild(row);
  }

  function addSurveyRow(survey) {
    const row = document.createElement("div");
    row.className = "card";
    row.style.marginBottom = "8px";
    row.dataset.role = "survey-row";
    row.innerHTML = `
      <div class="form-row" style="margin: 0 0 8px;">
        <input class="input" data-field="title" placeholder="質問文(必須)" style="flex: 2;"
          value="${survey ? esc(survey.title || "") : ""}">
        <label class="small" style="white-space: nowrap;">
          <input type="checkbox" data-field="isMulti" ${survey && survey.isMulti ? "checked" : ""}> 複数選択可
        </label>
        <button type="button" class="btn btn-small btn-ghost btn-danger-text" data-action="remove-row">削除</button>
      </div>
      <textarea class="textarea" data-field="options" rows="3"
        placeholder="選択肢(1 行に 1 つ、2 つ以上)">${survey ? esc((survey.options || []).join("\n")) : ""}</textarea>`;
    $("template-surveys").appendChild(row);
  }

  $("template-editor").addEventListener("click", (ev) => {
    const btn = ev.target.closest('[data-action="remove-row"]');
    if (btn) btn.closest("[data-role]").remove();
  });

  $("template-editor").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errorEl = $("template-error");
    errorEl.hidden = true;
    const payload = {
      name: $("template-name-input").value,
      materials: [...document.querySelectorAll('[data-role="material-row"]')].map((row) => ({
        module: row.querySelector('[data-field="module"]').value,
        title: row.querySelector('[data-field="title"]').value,
        url: row.querySelector('[data-field="url"]').value,
        body: row.querySelector('[data-field="body"]').value,
      })),
      surveys: [...document.querySelectorAll('[data-role="survey-row"]')].map((row) => ({
        title: row.querySelector('[data-field="title"]').value,
        isMulti: row.querySelector('[data-field="isMulti"]').checked,
        options: row.querySelector('[data-field="options"]').value.split("\n").map((s) => s.trim()).filter(Boolean),
      })),
    };
    try {
      if (editingTemplateId) {
        await AdminQA.api(`/templates/${editingTemplateId}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await AdminQA.api("/templates", { method: "POST", body: JSON.stringify(payload) });
      }
      closeTemplateEditor();
      await loadTemplates();
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
    }
  });
})();
