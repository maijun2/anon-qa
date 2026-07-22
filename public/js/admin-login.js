// 講師ログインページ。CSP(script-src 'self')に適合させるため外部ファイルで提供する
(async () => {
  // ログイン済みならダッシュボードへ(素の fetch で 401 リダイレクトループを回避)
  const me = await fetch("/api/admin/me").catch(() => null);
  if (me && me.ok) {
    location.href = "/admin/dashboard";
    return;
  }

  const errorEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  document.getElementById("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    btn.disabled = true;
    try {
      await AdminQA.api("/login", {
        method: "POST",
        body: JSON.stringify({ password: document.getElementById("password-input").value }),
      });
      location.href = "/admin/dashboard";
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
})();
