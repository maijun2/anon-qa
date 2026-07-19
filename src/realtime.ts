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
  vote: { limit: 30, windowMs: 60_000 },
  image: { limit: 10, windowMs: 60_000 },
  survey: { limit: 30, windowMs: 60_000 },
} as const;

/**
 * IP 単位の rate limit。IP は DO のメモリ内カウンタにのみ渡し、DB・ログには一切残さない。
 */
export async function checkRateLimit(
  env: Env,
  code: string,
  request: Request,
  bucket: keyof typeof RATE_LIMITS,
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const res = await sessionStub(env, code).fetch("https://session-do/ratelimit", {
    method: "POST",
    body: JSON.stringify({ key: `${bucket}:${ip}`, limit, windowMs }),
  });
  const data = (await res.json()) as { allowed: boolean };
  return data.allowed;
}
