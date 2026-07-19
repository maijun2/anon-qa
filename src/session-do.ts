import { errorJson, json } from "./http";

interface RateLimitBody {
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * セッション(アクセスコード)単位の WebSocket hub。
 * Hibernation API を使用し、接続維持中の duration 課金を抑える。
 * rate limit カウンタは IP 由来のキーを含むためメモリ内のみで保持し、
 * storage への永続化・ログ出力は行わない(hibernation でリセットされるのは許容)。
 */
export class SessionDO implements DurableObject {
  private buckets = new Map<string, number[]>();

  constructor(private state: DurableObjectState) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return errorJson("WebSocket 接続が必要です", 426);
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const message = await request.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // 切断済みソケットは無視
        }
      }
      return json({ ok: true });
    }

    if (url.pathname === "/ratelimit" && request.method === "POST") {
      const { key, limit, windowMs } = (await request.json()) as RateLimitBody;
      const now = Date.now();
      const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      const allowed = hits.length < limit;
      if (allowed) hits.push(now);
      this.buckets.set(key, hits);
      if (this.buckets.size > 5000) this.buckets.clear();
      return json({ allowed });
    }

    return errorJson("not found", 404);
  }

  webSocketMessage(): void {
    // クライアントからの受信は keepalive の ping(auto response 済み)のみを想定
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
