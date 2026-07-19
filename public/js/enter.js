(async () => {
  const codeInput = document.getElementById("code-input");
  const errorEl = document.getElementById("enter-error");
  const submitBtn = document.getElementById("enter-btn");
  const params = new URLSearchParams(location.search);
  if (params.get("code")) codeInput.value = params.get("code").toUpperCase();

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  let widgetId = null;
  let siteKey = null;
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    siteKey = cfg.turnstileSiteKey;
  } catch (e) {
    showError("設定の取得に失敗しました。再読み込みしてください");
    return;
  }

  (function renderTurnstile() {
    if (window.turnstile) {
      widgetId = window.turnstile.render("#turnstile-widget", { sitekey: siteKey });
    } else {
      setTimeout(renderTurnstile, 100);
    }
  })();

  document.getElementById("enter-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;
    const turnstileToken = window.turnstile && widgetId !== null ? window.turnstile.getResponse(widgetId) : "";
    if (!turnstileToken) {
      showError("スパム検証が完了していません。少し待ってから再試行してください");
      return;
    }
    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/enter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, turnstileToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "入室に失敗しました");
      AnonQA.setEntryToken(data.session.code, data.entryToken);
      location.href = `/s/${encodeURIComponent(data.session.code)}`;
    } catch (e) {
      showError(e.message);
      if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
