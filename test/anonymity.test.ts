// 匿名性ルールの担保:
//   * 全テーブルに IP / User-Agent 系のカラムが存在しないこと
//   * ブラウザトークンは生値ではなく SHA-256 ハッシュのみ保存されること
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { BASE, adminLogin, createSession, enter, mockTurnstile, participantHeaders, postQuestion } from "./helpers";

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
    await postQuestion(ctx);

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
});
