// 匿名性ルールの担保:
//   * 全テーブルに IP / User-Agent 系のカラムが存在しないこと
//   * ブラウザトークンは生値ではなく SHA-256 ハッシュのみ保存されること
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { SessionDO } from "../src/session-do";
import {
  BASE,
  adminLogin,
  createSession,
  enter,
  mockTurnstile,
  participantHeaders,
  postQuestion,
  postReply,
} from "./helpers";

beforeAll(() => {
  mockTurnstile();
});

describe("匿名性", () => {
  it("どのテーブルにも IP / User-Agent 系カラムが存在しない", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();
    expect(tables.results.length).toBeGreaterThan(0);
    const forbidden = /(^|_)(ip|ips|user_agent|useragent|ua|remote_addr|address|host)($|_)/i;
    for (const table of tables.results) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table.name})`).all<{ name: string }>();
      for (const column of columns.results) {
        expect(column.name, `${table.name}.${column.name}`).not.toMatch(forbidden);
      }
    }
  });

  it("質問のトークンはハッシュのみ保存され、生値は DB に存在しない", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    const row = await env.DB.prepare("SELECT token_hash FROM questions WHERE id = ?")
      .bind(question.id)
      .first<{ token_hash: string }>();
    expect(row).not.toBeNull();
    expect(row?.token_hash).toBe(await sha256Hex(ctx.anonToken));
    expect(row?.token_hash).not.toBe(ctx.anonToken);

    // 生トークンがどの行にも保存されていないこと
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE token_hash = ?")
      .bind(ctx.anonToken)
      .first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });

  it("参加者返信もハッシュのみ保存され、講師回答の token_hash は NULL", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);
    const { answerId } = await postReply(ctx, question.id);

    const row = await env.DB.prepare("SELECT token_hash, author_role FROM answers WHERE id = ?")
      .bind(answerId)
      .first<{ token_hash: string; author_role: string }>();
    expect(row?.author_role).toBe("participant");
    expect(row?.token_hash).toBe(await sha256Hex(ctx.anonToken));
    expect(row?.token_hash).not.toBe(ctx.anonToken);

    await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/questions/${question.id}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ body: "講師回答" }),
    });
    const instructor = await env.DB.prepare(
      "SELECT token_hash FROM answers WHERE question_id = ? AND author_role = 'instructor'",
    )
      .bind(question.id)
      .first<{ token_hash: string | null }>();
    expect(instructor?.token_hash).toBeNull();
  });

  it("投票もハッシュのみ保存される", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    const res = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/vote`, {
      method: "PUT",
      headers: participantHeaders(ctx),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT token_hash FROM votes WHERE question_id = ?")
      .bind(question.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(ctx.anonToken));
  });

  it("参加者向け質問一覧に token_hash が含まれない(admin 向けにも含まれない)", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);
    await postReply(ctx, question.id); // 返信(answers)を含む状態で検証する

    const participantRes = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, {
      headers: participantHeaders(ctx),
    });
    const participantBody = await participantRes.text();
    expect(participantBody).not.toContain("token");

    const adminRes = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}`, {
      headers: { Cookie: cookie },
    });
    const adminBody = await adminRes.text();
    expect(adminBody).not.toContain("tokenHash");
  });

  it("rate limit の複合キーはハッシュのみを含み、DO メモリ外へ永続化されない", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    // 質問投稿で rate limit(IP + 匿名トークンハッシュの複合キー)が記録される
    await postQuestion(ctx);

    const myHash = await sha256Hex(ctx.anonToken);
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(session.code));
    await runInDurableObject(stub, async (instance: SessionDO, state) => {
      // DO storage へ一切永続化していない(メモリ内カウンタのみ)
      expect((await state.storage.list()).size).toBe(0);

      const keys = [
        ...(instance as unknown as { buckets: Map<string, number[]> }).buckets.keys(),
      ];
      // 複合キーとして端末のトークンハッシュが記録されている
      expect(keys.some((k) => k.includes(myHash))).toBe(true);
      // 生トークンはどのキーにも現れない
      for (const k of keys) {
        expect(k).not.toContain(ctx.anonToken);
      }
    });
  });
});
