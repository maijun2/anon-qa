import { handleAdminApi } from "./api/admin";
import { handleEnter, handleParticipantApi } from "./api/participant";
import { verifyAdmin, verifyEntry } from "./auth";
import { cleanupExpiredSessions } from "./cron";
import { getSessionByCode } from "./db";
import { errorJson, json } from "./http";
import { forwardWebSocket } from "./realtime";
import { SessionDO } from "./session-do";
import type { Env } from "./types";

export { SessionDO };

/**
 * 全レスポンスに共通のセキュリティヘッダを付与する。
 * - X-Frame-Options: clickjacking 防止(admin を含め iframe 埋め込み不可)
 * - X-Content-Type-Options: MIME スニフィング抑止
 * - Referrer-Policy: 外部リンク遷移時に参加ページ URL を漏らさない(匿名性)
 * WebSocket の Upgrade(101)レスポンスは webSocket プロパティを保持するため対象外。
 */
function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res;
  const headers = new Headers(res.headers);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const seg = url.pathname.split("/").filter(Boolean);

    let res: Response;
    if (seg[0] === "api") {
      try {
        res = await handleApi(request, env, seg.slice(1));
      } catch (err) {
        // 匿名性維持のため、リクエスト内容(IP・ヘッダ等)はログに出さない
        console.error("api error:", err instanceof Error ? err.stack : String(err));
        res = errorJson("サーバエラーが発生しました", 500);
      }
    } else {
      res = await handlePage(request, env, seg, url);
    }
    return withSecurityHeaders(res);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(cleanupExpiredSessions(env));
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, seg: string[]): Promise<Response> {
  if (seg[0] === "config" && request.method === "GET") {
    return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY });
  }
  if (seg[0] === "enter" && request.method === "POST") {
    return handleEnter(request, env);
  }
  if (seg[0] === "ws" && seg.length === 2) {
    return handleWebSocket(request, env, seg[1]);
  }
  if (seg[0] === "s" && seg.length >= 2) {
    return handleParticipantApi(request, env, seg[1], seg.slice(2));
  }
  if (seg[0] === "admin") {
    return handleAdminApi(request, env, seg.slice(1));
  }
  return errorJson("not found", 404);
}

/** WebSocket は参加者(入室トークン)と講師(admin Cookie)の両方を受け付ける */
async function handleWebSocket(request: Request, env: Env, code: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorJson("WebSocket 接続が必要です", 426);
  }
  const session = await getSessionByCode(env, code.toUpperCase());
  if (!session) return errorJson("セッションが見つかりません", 404);
  const authorized = (await verifyEntry(env, request, session.code)) || (await verifyAdmin(env, request));
  if (!authorized) return errorJson("入室情報が無効です", 401);
  return forwardWebSocket(env, session.code, request);
}

function assetRequest(url: URL, path: string): Request {
  const rewritten = new URL(url);
  rewritten.pathname = path;
  return new Request(rewritten.toString(), { method: "GET" });
}

/** SPA ではないため、パスごとに対応する静的 HTML へ書き換えて配信する */
async function handlePage(request: Request, env: Env, seg: string[], url: URL): Promise<Response> {
  if (seg[0] === "s" && seg.length === 2) {
    return env.ASSETS.fetch(assetRequest(url, "/session.html"));
  }
  if (seg[0] === "admin") {
    if (seg.length === 1) return env.ASSETS.fetch(assetRequest(url, "/admin/login.html"));
    if (seg.length === 2 && seg[1] === "dashboard") return env.ASSETS.fetch(assetRequest(url, "/admin/dashboard.html"));
    if (seg.length === 3 && seg[1] === "s") return env.ASSETS.fetch(assetRequest(url, "/admin/session.html"));
    if (seg.length === 4 && seg[1] === "s" && seg[3] === "present") {
      return env.ASSETS.fetch(assetRequest(url, "/admin/present.html"));
    }
  }
  return env.ASSETS.fetch(request);
}
