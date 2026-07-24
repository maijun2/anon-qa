// 講師画面のトリアージ・検索・並べ替え(UI 改善で追加した admin API):
//   * q: 本文の部分一致検索(session_id スコープを跨がない)
//   * status: open/done/all が is_answered と一致し、counts の 3 値が実データと一致する
//   * sort: votes が多い順、new/old が時系列
//   * ページネーション方式: sort=votes / 検索時はカーソルなしの一括取得(nextCursor=null)、
//     sort=new は既存の keyset カーソル(50 件ずつ)を維持する(listQuestions のコメント参照)
//   * 匿名性回帰: いずれのレスポンスにも tokenHash が含まれない
//   * 一括削除(クライアント側ループ想定): 連続 DELETE で行 + R2 画像が消え、
//     question:deleted が各件 broadcast される
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
  postQuestion,
} from "./helpers";

beforeAll(() => {
  mockTurnstile();
});

interface SeedQuestion {
  body: string;
  isAnswered?: boolean;
  votes?: number;
  createdAt?: number;
}

interface ListedQuestion {
  id: string;
  body: string;
  isAnswered: boolean;
  votes: number;
  createdAt: number;
}

interface ListResponse {
  questions: ListedQuestion[];
  nextCursor: string | null;
  counts: { open: number; done: number; total: number };
}

/** rate limit を介さず D1 へ直接投入する(votes は行数で表現) */
async function seedQuestions(sessionId: string, seeds: SeedQuestion[]): Promise<void> {
  const base = Date.now();
  const statements = [];
  for (const [i, seed] of seeds.entries()) {
    const id = crypto.randomUUID();
    const createdAt = seed.createdAt ?? base - i * 1000;
    statements.push(
      env.DB.prepare(
        `INSERT INTO questions (id, session_id, body, image_key, token_hash, is_answered, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).bind(id, sessionId, seed.body, "dummy-token-hash", seed.isAnswered ? 1 : 0, createdAt, createdAt),
    );
    for (let v = 0; v < (seed.votes ?? 0); v++) {
      statements.push(
        env.DB.prepare("INSERT INTO votes (question_id, token_hash, created_at) VALUES (?, ?, ?)").bind(
          id,
          `dummy-voter-${v}`,
          createdAt,
        ),
      );
    }
  }
  await env.DB.batch(statements);
}

async function fetchList(sessionId: string, cookie: string, query: string): Promise<{ data: ListResponse; raw: string }> {
  const res = await SELF.fetch(`${BASE}/api/admin/sessions/${sessionId}/questions${query}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  // 匿名性回帰: 検索/フィルタ/ソートのいずれのレスポンスにも tokenHash を含めない
  expect(raw).not.toContain("tokenHash");
  return { data: JSON.parse(raw) as ListResponse, raw };
}

describe("講師の検索・フィルタ・ソート", () => {
  it("q は本文の部分一致で、session_id スコープを跨がない", async () => {
    const cookie = await adminLogin();
    const target = await createSession(cookie, "検索対象セッション");
    const other = await createSession(cookie, "別セッション");
    await seedQuestions(target.id, [
      { body: "CloudTrail のログ集約について" },
      { body: "IAM ポリシーの評価順序" },
    ]);
    await seedQuestions(other.id, [{ body: "CloudTrail 別セッションの質問" }]);

    const { data } = await fetchList(target.id, cookie, "?q=CloudTrail");
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].body).toBe("CloudTrail のログ集約について");
    // 検索時はカーソルなしの一括取得
    expect(data.nextCursor).toBeNull();
  });

  it("q の % _ はワイルドカードではなくリテラルとして扱う", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "LIKE エスケープ");
    await seedQuestions(session.id, [{ body: "進捗は100%です" }, { body: "全く別の質問" }]);

    const { data } = await fetchList(session.id, cookie, `?q=${encodeURIComponent("100%")}`);
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].body).toBe("進捗は100%です");
  });

  it("status=open|done|all が is_answered と一致し、counts の 3 値が実データと一致する", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "トリアージ");
    await seedQuestions(session.id, [
      { body: "未回答1" },
      { body: "未回答2" },
      { body: "未回答3" },
      { body: "回答済み1", isAnswered: true },
      { body: "回答済み2", isAnswered: true },
    ]);

    const open = await fetchList(session.id, cookie, "?status=open");
    expect(open.data.questions).toHaveLength(3);
    expect(open.data.questions.every((q) => !q.isAnswered)).toBe(true);

    const done = await fetchList(session.id, cookie, "?status=done");
    expect(done.data.questions).toHaveLength(2);
    expect(done.data.questions.every((q) => q.isAnswered)).toBe(true);

    const all = await fetchList(session.id, cookie, "?status=all");
    expect(all.data.questions).toHaveLength(5);

    for (const { data } of [open, done, all]) {
      expect(data.counts).toEqual({ open: 3, done: 2, total: 5 });
    }

    // 初期ロード(GET /sessions/:id)にも counts が同梱される
    const initial = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}?status=open`, {
      headers: { Cookie: cookie },
    });
    expect(initial.status).toBe(200);
    const initialBody = await initial.text();
    expect(initialBody).not.toContain("tokenHash");
    const initialData = JSON.parse(initialBody) as ListResponse;
    expect(initialData.counts).toEqual({ open: 3, done: 2, total: 5 });
    expect(initialData.questions).toHaveLength(3);
  });

  it("sort=votes は多い順、new/old は時系列に並ぶ", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "ソート検証");
    const base = Date.now();
    await seedQuestions(session.id, [
      { body: "古い・2票", votes: 2, createdAt: base - 3000 },
      { body: "中間・5票", votes: 5, createdAt: base - 2000 },
      { body: "新しい・0票", votes: 0, createdAt: base - 1000 },
    ]);

    const votes = await fetchList(session.id, cookie, "?sort=votes");
    expect(votes.data.questions.map((q) => q.votes)).toEqual([5, 2, 0]);
    expect(votes.data.nextCursor).toBeNull();

    const newest = await fetchList(session.id, cookie, "?sort=new");
    expect(newest.data.questions.map((q) => q.body)).toEqual(["新しい・0票", "中間・5票", "古い・2票"]);

    const oldest = await fetchList(session.id, cookie, "?sort=old");
    expect(oldest.data.questions.map((q) => q.body)).toEqual(["古い・2票", "中間・5票", "新しい・0票"]);
  });

  it("sort=votes はページサイズを超えても一括で返し、sort=new は keyset を維持する", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "一括取得検証");
    const seeds: SeedQuestion[] = [];
    for (let i = 0; i < QUESTIONS_PAGE_SIZE + 10; i++) {
      seeds.push({ body: `一括検証 ${i}`, votes: i % 3 });
    }
    await seedQuestions(session.id, seeds);

    const votes = await fetchList(session.id, cookie, "?sort=votes");
    expect(votes.data.questions).toHaveLength(QUESTIONS_PAGE_SIZE + 10);
    expect(votes.data.nextCursor).toBeNull();
    for (let i = 1; i < votes.data.questions.length; i++) {
      expect(votes.data.questions[i - 1].votes).toBeGreaterThanOrEqual(votes.data.questions[i].votes);
    }

    const newest = await fetchList(session.id, cookie, "?sort=new");
    expect(newest.data.questions).toHaveLength(QUESTIONS_PAGE_SIZE);
    expect(newest.data.nextCursor).not.toBeNull();
  });

  it("sort=old も keyset カーソルで重複なく全件を辿れる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "old カーソル検証");
    const seeds: SeedQuestion[] = [];
    for (let i = 0; i < QUESTIONS_PAGE_SIZE + 10; i++) {
      seeds.push({ body: `old 検証 ${i}` });
    }
    await seedQuestions(session.id, seeds);

    const first = await fetchList(session.id, cookie, "?sort=old");
    expect(first.data.questions).toHaveLength(QUESTIONS_PAGE_SIZE);
    expect(first.data.nextCursor).not.toBeNull();
    const second = await fetchList(
      session.id,
      cookie,
      `?sort=old&cursor=${encodeURIComponent(first.data.nextCursor ?? "")}`,
    );
    expect(second.data.questions).toHaveLength(10);
    expect(second.data.nextCursor).toBeNull();

    const all = [...first.data.questions, ...second.data.questions];
    expect(new Set(all.map((q) => q.id)).size).toBe(QUESTIONS_PAGE_SIZE + 10);
    for (let i = 1; i < all.length; i++) {
      const ordered =
        all[i].createdAt > all[i - 1].createdAt ||
        (all[i].createdAt === all[i - 1].createdAt && all[i].id > all[i - 1].id);
      expect(ordered, `${i} 番目の並び順`).toBe(true);
    }
  });
});

describe("一括削除(既存 DELETE の連続呼び出し)", () => {
  it("複数 ID の連続 DELETE で行と R2 画像が消え、question:deleted が各件 broadcast される", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "一括削除検証");
    const ctx = await enter(session.code);

    // 画像付き 1 件 + テキストのみ 2 件を投稿
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
    const { imageKey } = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/images`, {
        method: "POST",
        headers: { "X-Entry-Token": ctx.entryToken, "X-Anon-Token": ctx.anonToken },
        body: form,
      })
    ).json()) as { imageKey: string };
    const withImage = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "画像付きの質問", imageKey }),
    });
    expect(withImage.status).toBe(201);
    const q1 = ((await withImage.json()) as { question: { id: string } }).question;
    const q2 = await postQuestion(ctx, "削除対象2");
    const q3 = await postQuestion(ctx, "削除対象3");
    expect(await env.IMAGES.get(`${session.id}/${imageKey}`)).not.toBeNull();

    // broadcast を検証するため参加者として WebSocket 接続しておく
    const wsRes = await SELF.fetch(`${BASE}/api/ws/${ctx.code}?token=${encodeURIComponent(ctx.entryToken)}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket;
    if (!ws) throw new Error("webSocket がありません");
    ws.accept();
    const deletedIds: string[] = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; payload: { questionId?: string } };
      if (msg.type === "question:deleted" && msg.payload.questionId) deletedIds.push(msg.payload.questionId);
    });

    // クライアント側ループと同じく、既存の単一 DELETE を 1 件ずつ呼ぶ
    const targets = [q1.id, q2.id, q3.id];
    for (const id of targets) {
      const res = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/questions/${id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    }

    // broadcast は非同期に届くため揃うまで待つ
    for (let i = 0; i < 50 && deletedIds.length < targets.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect([...deletedIds].sort()).toEqual([...targets].sort());

    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE session_id = ?")
      .bind(session.id)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
    expect(await env.IMAGES.get(`${session.id}/${imageKey}`)).toBeNull();
    ws.close();
  });
});
