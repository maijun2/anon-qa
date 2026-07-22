import { anonTokenHash } from "./auth";
import type { Env } from "./types";

function sessionStub(env: Env, code: string): DurableObjectStub {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(code));
}

/** WebSocket ブロードキャスト。メッセージは { type, payload } 形式で統一 */
export async function broadcast(env: Env, code: string, type: string, payload: object): Promise<void> {
  await sessionStub(env, code).fetch("https://session-do/broadcast", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

export function forwardWebSocket(env: Env, code: string, request: Request): Promise<Response> {
  return sessionStub(env, code).fetch(new Request("https://session-do/ws", request));
}

export const RATE_LIMITS = {
  question: { limit: 5, windowMs: 60_000 },
  // 返信は question と別バケット(会場 NAT の同一 IP で質問と枠を食い合わせない)
  answer: { limit: 5, windowMs: 60_000 },
  vote: { limit: 30, windowMs: 60_000 },
  image: { limit: 10, windowMs: 60_000 },
  survey: { limit: 30, windowMs: 60_000 },
  // admin ログインのブルートフォース抑止。失敗した試行のみをカウントする
  login: { limit: 5, windowMs: 60_000 },
} as const;

// admin ログインは特定セッションに紐付かないため、専用の固定 DO 名に集約する
export const ADMIN_RATE_LIMIT_KEY = "__admin__";

// admin login のグローバル(全 IP 合算)失敗バケット。IP 別サブバケットで先に
// 止まるため、ここに到達するのは複数 IP からの分散攻撃時のみ。
const LOGIN_GLOBAL_KEY = "login:__global__";
const LOGIN_GLOBAL_LIMIT = 20;
// グローバル超過時は完全遮断でなく指数バックオフ: 30s → 60s → 120s → … → 上限 10 分
const LOGIN_GLOBAL_BACKOFF = { initialMs: 30_000, maxMs: 600_000 };

/**
 * admin login の rate limit(失敗のみカウントする 2 段構え)。
 * 1. IP 別サブバケット(login:IP、5 失敗/60s): 単一 IP からの連打はここで先に
 *    止まり、グローバル枠を消費しない(他 IP の正規ログインを巻き込まない)
 * 2. グローバルバケット(全 IP 合算 20 失敗/60s): 分散攻撃時のみ発動。
 *    超過時は指数バックオフで、バックオフ明けには再試行できる
 * IP・カウンタとも DO のメモリ内のみで扱い、永続化・ログ出力しない。
 */
export async function checkLoginRateLimit(
  env: Env,
  request: Request,
  mode: "check" | "record",
): Promise<boolean> {
  const ipAllowed = await checkRateLimit(env, ADMIN_RATE_LIMIT_KEY, request, "login", mode);
  // check で IP 別に弾かれた場合はグローバルを参照しない(枠を消費させない)
  if (mode === "check" && !ipAllowed) return false;
  const res = await sessionStub(env, ADMIN_RATE_LIMIT_KEY).fetch("https://session-do/ratelimit", {
    method: "POST",
    body: JSON.stringify({
      key: LOGIN_GLOBAL_KEY,
      limit: LOGIN_GLOBAL_LIMIT,
      windowMs: RATE_LIMITS.login.windowMs,
      mode,
      backoff: LOGIN_GLOBAL_BACKOFF,
    }),
  });
  const globalAllowed = ((await res.json()) as { allowed: boolean }).allowed;
  return ipAllowed && globalAllowed;
}

// 匿名トークンなしのリクエストに適用する IP 単独キーの緩和倍率。
// 教室 NAT では 1 つの IP を数十人が共有するため、IP 単独の厳しい制限は
// 正当な参加者への誤爆になる。トークンなしの異常リクエスト対策としてのみ残す。
const IP_ONLY_LIMIT_MULTIPLIER = 10;

/**
 * rate limit。IP・トークンハッシュは DO のメモリ内カウンタにのみ渡し、
 * DB・ログには一切残さない(匿名性原則)。
 *
 * キー設計(教室 NAT 対応):
 * - 主体は「IP + 端末単位の匿名トークンハッシュ」の複合キー。同一 NAT 配下の
 *   別端末が互いの制限を食い合わない。
 *   ※ 入室トークンは同一セッションの全参加者で同一値(端末ごとの乱数を含まない
 *     HMAC 署名)のため端末の区別には使えず、匿名トークンハッシュを用いる。
 * - トークンなしのリクエストは IP 単独キーに現行値の 10 倍の緩い上限を適用
 *   (通常の導線では必ずトークンが付くため、実質は異常リクエスト対策)。
 * - トークンを付け替えて複合キーを回避する攻撃は残るが、入室時の Turnstile 検証
 *   + 入室トークン必須で参加者以外は到達できず、許容する(バケット肥大は DO の
 *   GC で頭打ちになる)。
 * - login バケットは性質上トークンがなく、緩和すると総当たり耐性が下がるため
 *   従来どおり IP 単独の厳格な上限を維持する。
 *
 * mode 省略時は従来どおり「確認と同時にカウント」する(question/vote 等はこれを使う)。
 * admin login のように「失敗した試行だけをカウントしたい」場合は、
 * "check" で参照のみ行ってから比較し、失敗が確定した時だけ "record" でカウントする。
 */
export async function checkRateLimit(
  env: Env,
  code: string,
  request: Request,
  bucket: keyof typeof RATE_LIMITS,
  mode?: "check" | "record",
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const deviceHash = bucket === "login" ? null : await anonTokenHash(request);
  const key = deviceHash ? `${bucket}:${ip}:${deviceHash}` : `${bucket}:${ip}`;
  const effectiveLimit = deviceHash || bucket === "login" ? limit : limit * IP_ONLY_LIMIT_MULTIPLIER;
  const res = await sessionStub(env, code).fetch("https://session-do/ratelimit", {
    method: "POST",
    body: JSON.stringify({ key, limit: effectiveLimit, windowMs, mode }),
  });
  const data = (await res.json()) as { allowed: boolean };
  return data.allowed;
}
