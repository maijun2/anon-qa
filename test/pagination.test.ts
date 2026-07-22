// 質問一覧のカーソルページネーション:
//   * 300 件のセッションで初期ロードのペイロードが 50 件に制限されること(受け入れ条件)
//   * created_at + id の keyset で全件を重複・取りこぼしなく辿れること
//   * admin 側も同様にページングでき、tokenHash が漏れないこと
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { QUESTIONS_PAGE_SIZE } from "../src/db";
import {
  BASE,
  adminLogin,
  createSession,
  enter,
  mockTurnstile,
  participantHeaders,
} from "./helpers";

beforeAll(() => {
  mockTurnstile();
});

const TOTAL = 300;

interface PageResponse {
  questions: { id: string; createdAt: number }[];
  nextCursor: string | null;
}

/** rate limit を介さず D1 へ直接投入する(created_at の同値を 10 件ずつ混ぜ、id tiebreak を検証する) */
async function insertQuestions(sessionId: string, count: number): Promise<void> {
  const base = Date.now();
  const statements = [];
  for (let i = 0; i < count; i++) {
    const createdAt = base - Math.floor(i / 10) * 1000;
    statements.push(
      env.DB.prepare(
        `INSERT INTO questions (id, session_id, body, image_key, token_hash, is_answered, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 0, ?, ?)`,
      ).bind(crypto.randomUUID(), sessionId, `ページング検証 ${i}`, "dummy-token-hash", createdAt, createdAt),
    );
  }
  await env.DB.batch(statements);
}

/** (createdAt desc, id desc) の順序が全体で単調に保たれていることを検証する */
function expectSortedDesc(items: { id: string; createdAt: number }[]): void {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const ordered = cur.createdAt < prev.createdAt || (cur.createdAt === prev.createdAt && cur.id < prev.id);
    expect(ordered, `${i} 番目の並び順`).toBe(true);
  }
}

describe("質問一覧のカーソルページネーション", () => {
  it("300 件のセッションでも初期ロードは 50 件に制限され、全ページを重複なく辿れる(参加者)", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "ページング検証");
    await insertQuestions(session.id, TOTAL);
    const ctx = await enter(session.code);

    const all: { id: string; createdAt: number }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions${query}`, {
        headers: participantHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as PageResponse;
      if (pages === 0) {
        // 受け入れ条件: 初期ロードのペイロードは 50 件分
        expect(data.questions).toHaveLength(QUESTIONS_PAGE_SIZE);
        expect(data.nextCursor).not.toBeNull();
      }
      all.push(...data.questions);
      cursor = data.nextCursor;
      pages++;
    } while (cursor !== null && pages < 20);

    expect(pages).toBe(TOTAL / QUESTIONS_PAGE_SIZE);
    expect(all).toHaveLength(TOTAL);
    expect(new Set(all.map((q) => q.id)).size).toBe(TOTAL); // 重複・取りこぼしなし
    expectSortedDesc(all);
  });

  it("admin も初期 50 件 + 追加ページ取得でき、tokenHash は含まれない", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "ページング検証(admin)");
    await insertQuestions(session.id, TOTAL);

    const first = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}`, {
      headers: { Cookie: cookie },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).not.toContain("tokenHash");
    const firstData = JSON.parse(firstBody) as PageResponse;
    expect(firstData.questions).toHaveLength(QUESTIONS_PAGE_SIZE);
    expect(firstData.nextCursor).not.toBeNull();

    const second = await SELF.fetch(
      `${BASE}/api/admin/sessions/${session.id}/questions?cursor=${encodeURIComponent(firstData.nextCursor ?? "")}`,
      { headers: { Cookie: cookie } },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.text();
    expect(secondBody).not.toContain("tokenHash");
    const secondData = JSON.parse(secondBody) as PageResponse;
    expect(secondData.questions).toHaveLength(QUESTIONS_PAGE_SIZE);
    // 2 ページ目は 1 ページ目と重複しない
    const firstIds = new Set(firstData.questions.map((q) => q.id));
    for (const q of secondData.questions) {
      expect(firstIds.has(q.id)).toBe(false);
    }
  });

  it("不正なカーソルは先頭ページ扱いになる(500 にしない)", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "不正カーソル");
    const ctx = await enter(session.code);
    const res = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions?cursor=broken`, {
      headers: participantHeaders(ctx),
    });
    expect(res.status).toBe(200);
  });
});
