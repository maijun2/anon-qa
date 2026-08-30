// GET /api/admin/pending-questions(外部連携専用、Bearer 認証):
//   * 認証あり/なしの挙動
//   * 未回答(is_answered=0)かつ active セッションの質問のみを返すこと
//   * レスポンスに token_hash 等の匿名性に関わる値が含まれないこと
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, mockTurnstile } from "./helpers";

const PENDING_API_TOKEN = "test-pending-api-token";

beforeAll(() => {
  mockTurnstile();
});

interface Seed {
  sessionId: string;
  questionId: string;
}

/** admin API を介さず D1 へ直接投入する(pending API は admin Cookie を使わないため) */
async function seedSession(opts: {
  status: "active" | "ended";
  isAnswered: boolean;
  courseName: string;
}): Promise<Seed> {
  const sessionId = crypto.randomUUID();
  const code = sessionId.slice(0, 8).toUpperCase();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id, code, course_name, held_on, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(sessionId, code, opts.courseName, "2026-08-30", opts.status, now)
    .run();

  const questionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO questions (id, session_id, body, image_key, token_hash, is_answered, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(questionId, sessionId, `pending 検証質問(${opts.courseName})`, "dummy-token-hash", opts.isAnswered ? 1 : 0, now, now)
    .run();

  return { sessionId, questionId };
}

describe("GET /api/admin/pending-questions", () => {
  it("Authorization ヘッダなしは 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/pending-questions`);
    expect(res.status).toBe(401);
  });

  it("誤ったトークンは 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/pending-questions`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("未回答かつ active セッションの質問のみを新着順で返す(回答済み・ended は除外)", async () => {
    const target = await seedSession({ status: "active", isAnswered: false, courseName: "対象セッション" });
    await seedSession({ status: "active", isAnswered: true, courseName: "回答済み(除外)" });
    await seedSession({ status: "ended", isAnswered: false, courseName: "終了済み(除外)" });

    const res = await SELF.fetch(`${BASE}/api/admin/pending-questions`, {
      headers: { Authorization: `Bearer ${PENDING_API_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("token_hash");
    expect(bodyText).not.toContain("dummy-token-hash");

    const data = JSON.parse(bodyText) as {
      questions: {
        id: string;
        text: string;
        hasImage: boolean;
        createdAt: string;
        sessionName: string;
        sessionCode: string;
      }[];
      total: number;
    };
    const mine = data.questions.find((q) => q.id === target.questionId);
    expect(mine).toBeDefined();
    expect(mine?.sessionName).toBe("対象セッション");
    expect(mine?.hasImage).toBe(false);
    expect(typeof mine?.createdAt).toBe("string");
    expect(new Date(mine!.createdAt).toISOString()).toBe(mine!.createdAt);
    expect(data.questions.some((q) => q.sessionName === "回答済み(除外)")).toBe(false);
    expect(data.questions.some((q) => q.sessionName === "終了済み(除外)")).toBe(false);
  });
});
