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

  // ---------- 通知音(Web Audio で合成。外部アセット不要) ----------
  const SOUND_KEY = "anonqa:sound"; // "off" のときのみ無効(既定 ON)
  let audioCtx = null;

  function soundEnabled() {
    return localStorage.getItem(SOUND_KEY) !== "off";
  }

  function setSoundEnabled(on) {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  }

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  // ブラウザの autoplay 制限対策: 初回ユーザー操作で AudioContext を用意する
  function primeAudioOnce() {
    ensureAudio();
    document.removeEventListener("pointerdown", primeAudioOnce);
    document.removeEventListener("keydown", primeAudioOnce);
  }
  document.addEventListener("pointerdown", primeAudioOnce, { once: true });
  document.addEventListener("keydown", primeAudioOnce, { once: true });

  // 新着通知の短いポップ音(2 音の上昇)。soundEnabled() が false なら鳴らさない
  function playNotify() {
    if (!soundEnabled()) return;
    const ctx = ensureAudio();
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  // ミュート切替ボタンの初期化(3 ページ共通)。🔔 = ON / 🔕 = OFF
  function initSoundToggle(button) {
    if (!button) return;
    const reflect = () => {
      const on = soundEnabled();
      button.textContent = on ? "🔔" : "🔕";
      button.setAttribute("aria-pressed", String(on));
      button.title = on ? "通知音: ON(クリックでミュート)" : "通知音: OFF(クリックで有効化)";
    };
    button.addEventListener("click", () => {
      setSoundEnabled(!soundEnabled());
      if (soundEnabled()) playNotify(); // 有効化時に確認音
      reflect();
    });
    reflect();
  }

  // ---------- 画像ライトボックス(3 ページ共通) ----------
  // a[data-lightbox] の左クリックだけを横取りしてページ内中央に拡大表示する。
  // href / target="_blank" はそのまま残すため、⌘/Ctrl/中クリックでの別タブ表示や
  // JS 無効時のフォールバックは従来どおり動く。
  let lightbox = null;
  let lightboxImg = null;
  let lightboxCloseBtn = null;
  let lightboxHideTimer = null;
  let lightboxLastFocus = null;

  function ensureLightbox() {
    if (lightbox) return lightbox;
    lightbox = document.createElement("div");
    lightbox.className = "lightbox";
    lightbox.hidden = true;
    lightbox.setAttribute("role", "dialog");
    lightbox.setAttribute("aria-modal", "true");
    lightbox.setAttribute("aria-label", "添付画像");

    lightboxCloseBtn = document.createElement("button");
    lightboxCloseBtn.type = "button";
    lightboxCloseBtn.className = "lightbox-close";
    lightboxCloseBtn.setAttribute("aria-label", "閉じる");
    lightboxCloseBtn.textContent = "×";

    lightboxImg = document.createElement("img");
    lightboxImg.className = "lightbox-img";
    lightboxImg.alt = "添付画像";

    lightbox.append(lightboxCloseBtn, lightboxImg);
    document.body.appendChild(lightbox);

    lightboxCloseBtn.addEventListener("click", closeLightbox);
    // 背景(オーバーレイ自身)のクリックのみで閉じる。画像のクリックでは閉じない
    lightbox.addEventListener("click", (ev) => {
      if (ev.target === lightbox) closeLightbox();
    });
    return lightbox;
  }

  function lightboxOpen() {
    return lightbox !== null && !lightbox.hidden;
  }

  function openLightbox(src) {
    ensureLightbox();
    clearTimeout(lightboxHideTimer);
    lightboxLastFocus = document.activeElement;
    lightboxImg.src = src;
    lightbox.hidden = false;
    document.body.classList.add("no-scroll");
    // hidden 解除と同フレームでクラスを足すと transition が走らないため 1 フレーム待つ
    requestAnimationFrame(() => lightbox.classList.add("open"));
    lightboxCloseBtn.focus();
  }

  function closeLightbox() {
    if (!lightboxOpen()) return;
    lightbox.classList.remove("open");
    document.body.classList.remove("no-scroll");
    // フェードアウトの完了を待って hidden にする(transitionend が来ない環境の保険付き)
    clearTimeout(lightboxHideTimer);
    lightboxHideTimer = setTimeout(() => {
      lightbox.hidden = true;
      lightboxImg.removeAttribute("src");
    }, 250);
    if (lightboxLastFocus && lightboxLastFocus.focus) lightboxLastFocus.focus();
    lightboxLastFocus = null;
  }

  document.addEventListener("click", (ev) => {
    // 修飾キー付き / 左クリック以外は既定動作(別タブ)に任せる
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const link = ev.target.closest ? ev.target.closest("a[data-lightbox]") : null;
    if (!link || !link.href) return;
    ev.preventDefault();
    openLightbox(link.href);
  });

  document.addEventListener("keydown", (ev) => {
    if (!lightboxOpen()) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeLightbox();
      return;
    }
    // フォーカス可能要素は閉じるボタンのみ。オーバーレイ外へ Tab 移動させない
    if (ev.key === "Tab") {
      ev.preventDefault();
      lightboxCloseBtn.focus();
    }
  });

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

  return {
    anonToken, getEntryToken, setEntryToken, api, escapeHtml, linkify, formatJst, formatJstDate, connectWs,
    playNotify, soundEnabled, setSoundEnabled, initSoundToggle,
  };
})();
