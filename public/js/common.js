// 参加者共通ユーティリティ。匿名トークンは localStorage のみで保持し、サーバへは
// ヘッダで送る(サーバ側はハッシュ化して保存)。
window.AnonQA = (() => {
  const ANON_KEY = "anonqa:anon";

  function anonToken() {
    let token = localStorage.getItem(ANON_KEY);
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem(ANON_KEY, token);
    }
    return token;
  }

  function getEntryToken(code) {
    return localStorage.getItem(`anonqa:entry:${code}`);
  }

  function setEntryToken(code, token) {
    localStorage.setItem(`anonqa:entry:${code}`, token);
  }

  async function api(code, path, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (typeof options.body === "string") headers["Content-Type"] = "application/json";
    headers["X-Entry-Token"] = getEntryToken(code) || "";
    headers["X-Anon-Token"] = anonToken();
    const res = await fetch(`/api/s/${encodeURIComponent(code)}${path}`, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      location.href = `/?code=${encodeURIComponent(code)}`;
      throw new Error("再入室が必要です");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "エラーが発生しました");
    return data;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  // 本文表示用: エスケープした上で URL のみアンカー化する。
  // 必ずこの関数内でエスケープする(エスケープ済みテキスト以外にリンク化を適用すると XSS になるため)。
  // URL は ASCII の URL 構成文字に限定(直後にスペースなしで日本語が続いても取り込まない)。
  // エスケープ済みテキスト上で動くため、URL 内の & " ' は &amp; &quot; &#39; として現れる
  function linkify(value) {
    return escapeHtml(value).replace(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g, (url) => {
      // 文末の約物・引用符(エンティティ形)はリンクに含めない
      const m = url.match(/(?:&(?:quot|#39);|[),.!?])+$/);
      const trail = m ? m[0] : "";
      const href = trail ? url.slice(0, -trail.length) : url;
      if (!href.replace(/^https?:\/\//, "")) return url;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trail}`;
    });
  }

  // 保存は UTC(epoch ms)、表示は JST
  function formatJst(ms) {
    return new Date(ms).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatJstDate(ms) {
    return new Date(ms).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  }

  // 自動再接続付き WebSocket。onStatus("open" | "reconnecting")
  function connectWs({ code, token, onMessage, onStatus }) {
    let ws = null;
    let closed = false;
    let retryMs = 1000;
    let pingTimer = null;

    function open() {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      ws = new WebSocket(`${proto}://${location.host}/api/ws/${encodeURIComponent(code)}${query}`);
      ws.addEventListener("open", () => {
        retryMs = 1000;
        if (onStatus) onStatus("open");
        pingTimer = setInterval(() => {
          try { ws.send("ping"); } catch (e) { /* 切断中は無視 */ }
        }, 25000);
      });
      ws.addEventListener("message", (ev) => {
        if (ev.data === "pong") return;
        try {
          onMessage(JSON.parse(ev.data));
        } catch (e) { /* 不正なメッセージは無視 */ }
      });
      ws.addEventListener("close", () => {
        clearInterval(pingTimer);
        if (closed) return;
        if (onStatus) onStatus("reconnecting");
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10000);
      });
      ws.addEventListener("error", () => {
        try { ws.close(); } catch (e) { /* already closed */ }
      });
    }

    open();
    return {
      close() {
        closed = true;
        try { ws && ws.close(); } catch (e) { /* already closed */ }
      },
    };
  }

  return { anonToken, getEntryToken, setEntryToken, api, escapeHtml, linkify, formatJst, formatJstDate, connectWs };
})();
