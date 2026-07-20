import { errorJson, json } from "./http";

interface RateLimitBody {
  key: string;
  limit: number;
  windowMs: number;
  /** 省略時は「確認と同時にカウント」。"check" は参照のみ、"record" は無条件にカウント */
  mode?: "check" | "record";
}

/**
 * セッション(アクセスコード)単位の WebSocket hub。
 * Hibernation API を使用し、接続維持中の duration 課金を抑える。
 * rate limit カウンタは IP 由来のキーを含むためメモリ内のみで保持し、
 * storage への永続化・ログ出力は行わない(hibernation でリセットされるのは許容)。
 */
export class SessionDO implements DurableObject {
  private buckets = new Map<string, number[]>();
  // このサイズを超えたら GC を試みる(全消去はしない。理由は gcStaleBuckets 参照)
  private static readonly GC_THRESHOLD = 5000;
  // GC で「期限切れ」とみなす基準。個々のバケットの windowMs は /ratelimit の
  // 呼び出しごとにしか渡らず DO 側に保持していないため、現状すべてのバケットが
  // 60 秒窓であることを踏まえて固定値を安全側の基準として使う。
  private static readonly GC_STALE_MS = 60_000;

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
      const { key, limit, windowMs, mode } = (await request.json()) as RateLimitBody;
      const now = Date.now();
      const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      const allowed = hits.length < limit;
      if (mode === "record") {
        // 失敗確定時のみ呼ばれる想定。呼び出し元は超過時に "check" で先に弾くため、
        // この分岐だけで無制限に増え続けることはない
        hits.push(now);
      } else if (mode !== "check" && allowed) {
        hits.push(now);
      }
      this.buckets.set(key, hits);
      if (this.buckets.size > SessionDO.GC_THRESHOLD) this.gcStaleBuckets(now);
      return json({ allowed });
    }

    return errorJson("not found", 404);
  }

  /**
   * サイズ閾値超過時のみ呼ばれる GC。全消去(旧実装)だと攻撃者が大量のキーを
   * 生成するだけで admin login 等の有効なカウンタも巻き添えでリセットでき、
   * rate limit の回避に使われてしまうため、期限切れのエントリのみを削除する。
   * GC 後もなお閾値を超える場合は「有効なキーがそれだけ多い」ということなので、
   * 次回のリクエスト時に再度 GC を試みる(自然に頭打ちになる想定)。
   * 恒常的に超過し続けるようなら GC_THRESHOLD 自体の見直しを検討する。
   */
  private gcStaleBuckets(now: number): void {
    for (const [key, hits] of this.buckets) {
      const fresh = hits.filter((t) => now - t < SessionDO.GC_STALE_MS);
      if (fresh.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, fresh);
    }
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
