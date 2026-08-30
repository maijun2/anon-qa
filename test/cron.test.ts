// cron による期限切れセッション削除(バッチ化後)の検証:
//   * 複数の期限切れセッションが D1(FK CASCADE)・R2 双方からまとめて削除されること
//   * 期限内のセッションは影響を受けないこと
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanupExpiredSessions } from "../src/cron";
import { SESSION_TTL_MS } from "../src/types";
import { adminLogin, createSession, mockTurnstile } from "./helpers";

beforeAll(() => {
  mockTurnstile();
});

async function setCreatedAt(sessionId: string, createdAt: number): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").bind(createdAt, sessionId).run();
}

async function countSessions(ids: string[]): Promise<number> {
  const placeholders = ids.map(() => "?").join(",");
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE id IN (${placeholders})`)
    .bind(...ids)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

describe("cleanupExpiredSessions(バッチ化)", () => {
  it("期限切れセッションを D1・R2 双方からまとめて削除し、期限内セッションは残す", async () => {
    const cookie = await adminLogin();
    const expiredCount = 5;
    const expiredIds: string[] = [];
    const expiredAt = Date.now() - SESSION_TTL_MS - 1000;

    for (let i = 0; i < expiredCount; i++) {
      const session = await createSession(cookie, `期限切れ研修${i}`);
      await setCreatedAt(session.id, expiredAt);
      // 各セッションに画像を配置し、削除対象になることを検証する
      await env.IMAGES.put(`${session.id}/dummy.png`, new Uint8Array([1, 2, 3]));
      expiredIds.push(session.id);
    }

    const freshSession = await createSession(cookie, "期限内研修");

    await cleanupExpiredSessions(env);

    expect(await countSessions(expiredIds)).toBe(0);
    expect(await countSessions([freshSession.id])).toBe(1);

    for (const id of expiredIds) {
      const listed = await env.IMAGES.list({ prefix: `${id}/` });
      expect(listed.objects.length, `${id} の画像`).toBe(0);
    }
  });

  it("期限切れセッションが0件の場合は何もしない", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "通常研修");

    await cleanupExpiredSessions(env);

    expect(await countSessions([session.id])).toBe(1);
  });
});
