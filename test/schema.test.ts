import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 スキーマ", () => {
  it("必要なテーブルがすべて存在する", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        "sessions",
        "questions",
        "answers",
        "votes",
        "materials",
        "surveys",
        "survey_options",
        "survey_responses",
        "templates",
        "template_materials",
        "template_surveys",
        "template_survey_options",
      ].sort(),
    );
  });

  it("セッション削除で子テーブルの行も FK CASCADE で削除される", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sessions (id, code, course_name, held_on, status, created_at) VALUES ('s1', 'CASCADE1', 'c', '2026-07-19', 'active', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      "INSERT INTO questions (id, session_id, body, token_hash, is_answered, created_at, updated_at) VALUES ('q1', 's1', 'b', 'h', 0, ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare("INSERT INTO votes (question_id, token_hash, created_at) VALUES ('q1', 'h2', ?)").bind(now).run();
    await env.DB.prepare("INSERT INTO answers (id, question_id, body, created_at) VALUES ('a1', 'q1', 'b', ?)").bind(now).run();

    await env.DB.prepare("DELETE FROM sessions WHERE id = 's1'").run();

    const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE session_id = 's1'").first<{ n: number }>();
    const v = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE question_id = 'q1'").first<{ n: number }>();
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM answers WHERE question_id = 'q1'").first<{ n: number }>();
    expect(q?.n).toBe(0);
    expect(v?.n).toBe(0);
    expect(a?.n).toBe(0);
  });

  it("アクセスコードは UNIQUE 制約を持つ", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO sessions (id, code, course_name, held_on, status, created_at) VALUES ('u1', 'DUP111', 'c', '2026-07-19', 'active', ?)",
    ).bind(now).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO sessions (id, code, course_name, held_on, status, created_at) VALUES ('u2', 'DUP111', 'c', '2026-07-19', 'active', ?)",
      ).bind(now).run(),
    ).rejects.toThrow();
  });
});
