// admin 共通: セッション Cookie ベースの API ラッパ(401 でログインへ)
window.AdminQA = (() => {
  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (typeof options.body === "string") headers["Content-Type"] = "application/json";
    const res = await fetch(`/api/admin${path}`, Object.assign({}, options, { headers }));
    if (res.status === 401 && path !== "/login") {
      location.href = "/admin";
      throw new Error("ログインが必要です");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "エラーが発生しました");
    return data;
  }

  return { api };
})();
