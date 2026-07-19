import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanupExpiredSessions } from "../src/cron";
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

describe("入室 (enter)", () => {
  it("存在しないコードは 404", async () => {
    const res = await SELF.fetch(`${BASE}/api/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "XXXXXX", turnstileToken: "ok" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it("Turnstile 検証に失敗すると 400", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const res = await SELF.fetch(`${BASE}/api/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: session.code, turnstileToken: "bad-token" }),
    });
    expect(res.status).toBe(400);
  });

  it("正しいコード + Turnstile で entryToken を得られる(小文字コードも許容)", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const res = await SELF.fetch(`${BASE}/api/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: session.code.toLowerCase(), turnstileToken: "ok" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { entryToken: string; session: { code: string } };
    expect(data.entryToken).toBeTruthy();
    expect(data.session.code).toBe(session.code);
  });

  it("入室トークンなしでは参加者 API を呼べない", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const res = await SELF.fetch(`${BASE}/api/s/${session.code}/questions`);
    expect(res.status).toBe(401);
  });
});

describe("質問", () => {
  it("投稿 → 一覧に isMine 付きで反映される", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx, "D1 の read replica はいつ使うべき?");

    const list = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, { headers: participantHeaders(ctx) })
    ).json()) as { questions: Array<{ id: string; body: string; isMine: boolean }> };
    const mine = list.questions.find((q) => q.id === question.id);
    expect(mine?.body).toBe("D1 の read replica はいつ使うべき?");
    expect(mine?.isMine).toBe(true);

    // 別の参加者からは isMine = false
    const other = await enter(session.code);
    const otherList = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, { headers: participantHeaders(other) })
    ).json()) as { questions: Array<{ id: string; isMine: boolean }> };
    expect(otherList.questions.find((q) => q.id === question.id)?.isMine).toBe(false);
  });

  it("本人のみ編集・削除できる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const owner = await enter(session.code);
    const other = await enter(session.code);
    const question = await postQuestion(owner);

    const editByOther = await SELF.fetch(`${BASE}/api/s/${session.code}/questions/${question.id}`, {
      method: "PATCH",
      headers: participantHeaders(other),
      body: JSON.stringify({ body: "改ざん" }),
    });
    expect(editByOther.status).toBe(403);

    const editByOwner = await SELF.fetch(`${BASE}/api/s/${session.code}/questions/${question.id}`, {
      method: "PATCH",
      headers: participantHeaders(owner),
      body: JSON.stringify({ body: "編集後の質問" }),
    });
    expect(editByOwner.status).toBe(200);

    const deleteByOther = await SELF.fetch(`${BASE}/api/s/${session.code}/questions/${question.id}`, {
      method: "DELETE",
      headers: participantHeaders(other),
    });
    expect(deleteByOther.status).toBe(403);

    const deleteByOwner = await SELF.fetch(`${BASE}/api/s/${session.code}/questions/${question.id}`, {
      method: "DELETE",
      headers: participantHeaders(owner),
    });
    expect(deleteByOwner.status).toBe(200);
  });

  it("連投は rate limit で 429 になる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie, "ratelimit 用");
    const ctx = await enter(session.code);
    for (let i = 0; i < 5; i++) {
      await postQuestion(ctx, `質問 ${i}`);
    }
    const res = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "6 件目" }),
    });
    expect(res.status).toBe(429);
  });
});

describe("いいね投票", () => {
  it("同一トークンの重複投票は 1 票のまま、取り消しも可能", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);
    const url = `${BASE}/api/s/${ctx.code}/questions/${question.id}/vote`;

    const first = (await (await SELF.fetch(url, { method: "PUT", headers: participantHeaders(ctx) })).json()) as {
      votes: number;
    };
    expect(first.votes).toBe(1);

    const second = (await (await SELF.fetch(url, { method: "PUT", headers: participantHeaders(ctx) })).json()) as {
      votes: number;
    };
    expect(second.votes).toBe(1);

    const removed = (await (
      await SELF.fetch(url, { method: "DELETE", headers: participantHeaders(ctx) })
    ).json()) as { votes: number };
    expect(removed.votes).toBe(0);
  });
});

describe("画像アップロード", () => {
  function upload(ctx: Awaited<ReturnType<typeof enter>>, file: File): Promise<Response> {
    const form = new FormData();
    form.append("file", file);
    return SELF.fetch(`${BASE}/api/s/${ctx.code}/images`, {
      method: "POST",
      headers: { "X-Entry-Token": ctx.entryToken, "X-Anon-Token": ctx.anonToken },
      body: form,
    });
  }

  it("image/* 以外は 400", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const res = await upload(ctx, new File(["hello"], "a.txt", { type: "text/plain" }));
    expect(res.status).toBe(400);
  });

  it("5MB 超は 413", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const res = await upload(ctx, new File([big], "big.png", { type: "image/png" }));
    expect(res.status).toBe(413);
  });

  it("正常な画像は保存され、Content-Type 付きで取得できる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const res = await upload(ctx, new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
    expect(res.status).toBe(200);
    const { imageKey } = (await res.json()) as { imageKey: string };

    const got = await SELF.fetch(`${BASE}/api/s/${ctx.code}/images/${imageKey}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("admin 認証", () => {
  it("未認証では admin API は全て 401", async () => {
    for (const [path, method] of [
      ["/api/admin/sessions", "GET"],
      ["/api/admin/sessions", "POST"],
      ["/api/admin/templates", "GET"],
      ["/api/admin/me", "GET"],
    ] as const) {
      const res = await SELF.fetch(`${BASE}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("パスワード誤りは 401、正しければ Cookie が発行される", async () => {
    const bad = await SELF.fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const cookie = await adminLogin();
    expect(cookie).toContain("admin_session=");
    const me = await SELF.fetch(`${BASE}/api/admin/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
  });
});

describe("講師回答・回答済み管理", () => {
  it("回答すると質問が回答済みになり、参加者にも見える", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    const res = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/questions/${question.id}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ body: "公式ドキュメントの通りです" }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { question: { isAnswered: boolean; answers: Array<{ body: string }> } };
    expect(data.question.isAnswered).toBe(true);
    expect(data.question.answers[0].body).toBe("公式ドキュメントの通りです");

    const list = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, { headers: participantHeaders(ctx) })
    ).json()) as { questions: Array<{ id: string; isAnswered: boolean; answers: unknown[] }> };
    const q = list.questions.find((x) => x.id === question.id);
    expect(q?.isAnswered).toBe(true);
    expect(q?.answers.length).toBe(1);
  });
});

describe("回答スレッド(参加者返信)", () => {
  interface ThreadAnswer {
    id: string;
    body: string;
    authorRole: string;
    isMine: boolean;
  }

  async function getQuestion(ctx: Awaited<ReturnType<typeof enter>>, questionId: string) {
    const list = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, { headers: participantHeaders(ctx) })
    ).json()) as { questions: Array<{ id: string; isAnswered: boolean; answers: ThreadAnswer[] }> };
    return list.questions.find((x) => x.id === questionId);
  }

  it("参加者が返信でき、isAnswered は変わらない。isMine は本人のみ true", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const other = await enter(session.code);
    const question = await postQuestion(ctx);

    const { answerId } = await postReply(other, question.id, "便乗質問です");

    const mine = await getQuestion(other, question.id);
    expect(mine?.isAnswered).toBe(false);
    expect(mine?.answers.length).toBe(1);
    expect(mine?.answers[0]).toMatchObject({ id: answerId, authorRole: "participant", isMine: true });

    // 質問者から見ると他人の返信(isMine=false)
    const theirs = await getQuestion(ctx, question.id);
    expect(theirs?.answers[0].isMine).toBe(false);
  });

  it("講師回答は authorRole=instructor で届き、参加者は編集・削除できない", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/questions/${question.id}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ body: "講師回答" }),
    });
    const q = await getQuestion(ctx, question.id);
    expect(q?.answers[0].authorRole).toBe("instructor");
    expect(q?.answers[0].isMine).toBe(false);

    const patched = await SELF.fetch(
      `${BASE}/api/s/${ctx.code}/questions/${question.id}/answers/${q?.answers[0].id}`,
      { method: "PATCH", headers: participantHeaders(ctx), body: JSON.stringify({ body: "改ざん" }) },
    );
    expect(patched.status).toBe(403);
  });

  it("本人は返信を編集・削除でき、他人は 403", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const other = await enter(session.code);
    const question = await postQuestion(ctx);
    const { answerId } = await postReply(ctx, question.id);

    const byOther = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/answers/${answerId}`, {
      method: "DELETE",
      headers: participantHeaders(other),
    });
    expect(byOther.status).toBe(403);

    const patched = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/answers/${answerId}`, {
      method: "PATCH",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "編集後の返信" }),
    });
    expect(patched.status).toBe(200);
    expect((await getQuestion(ctx, question.id))?.answers[0].body).toBe("編集後の返信");

    const deleted = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/answers/${answerId}`, {
      method: "DELETE",
      headers: participantHeaders(ctx),
    });
    expect(deleted.status).toBe(200);
    expect((await getQuestion(ctx, question.id))?.answers.length).toBe(0);
  });

  it("admin は参加者返信をモデレーション削除できる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);
    const { answerId } = await postReply(ctx, question.id, "不適切な返信");

    const res = await SELF.fetch(
      `${BASE}/api/admin/sessions/${session.id}/questions/${question.id}/answers/${answerId}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    expect((await getQuestion(ctx, question.id))?.answers.length).toBe(0);
  });

  it("終了セッションへの返信は 403、2000 文字超は 400", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    const tooLong = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/answers`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "あ".repeat(2001) }),
    });
    expect(tooLong.status).toBe(400);

    await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/end`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const ended = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/answers`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "終了後の返信" }),
    });
    expect(ended.status).toBe(403);
  });

  it("返信の rate limit(5 件/分)を超えると 429", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    for (let i = 0; i < 5; i++) {
      await postReply(ctx, question.id, `返信 ${i + 1}`);
    }
    const res = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/answers`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "6 件目" }),
    });
    expect(res.status).toBe(429);
  });
});

describe("アンケート", () => {
  async function createSurvey(cookie: string, sessionId: string, isMulti = false): Promise<string> {
    const res = await SELF.fetch(`${BASE}/api/admin/sessions/${sessionId}/surveys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ title: "理解度は?", isMulti, options: ["ばっちり", "だいたい", "難しい"] }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { survey: { id: string } }).survey.id;
  }

  it("draft は参加者に見えず、配信後に見える", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const surveyId = await createSurvey(cookie, session.id);

    const before = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys`, { headers: participantHeaders(ctx) })
    ).json()) as { surveys: unknown[] };
    expect(before.surveys.length).toBe(0);

    const publish = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/surveys/${surveyId}/publish`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(publish.status).toBe(200);

    const after = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys`, { headers: participantHeaders(ctx) })
    ).json()) as { surveys: Array<{ id: string; status: string }> };
    expect(after.surveys.find((s) => s.id === surveyId)?.status).toBe("published");
  });

  it("単一選択は複数送信で 400、再回答で票が置き換わる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const surveyId = await createSurvey(cookie, session.id);
    await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/surveys/${surveyId}/publish`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const surveys = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys`, { headers: participantHeaders(ctx) })
    ).json()) as { surveys: Array<{ id: string; options: Array<{ id: string }> }> };
    const options = surveys.surveys.find((s) => s.id === surveyId)!.options;

    const multi = await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys/${surveyId}/responses`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ optionIds: [options[0].id, options[1].id] }),
    });
    expect(multi.status).toBe(400);

    const first = await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys/${surveyId}/responses`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ optionIds: [options[0].id] }),
    });
    expect(first.status).toBe(200);

    const second = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys/${surveyId}/responses`, {
        method: "POST",
        headers: participantHeaders(ctx),
        body: JSON.stringify({ optionIds: [options[1].id] }),
      })
    ).json()) as { survey: { options: Array<{ id: string; count: number }>; totalRespondents: number } };
    expect(second.survey.options.find((o) => o.id === options[0].id)?.count).toBe(0);
    expect(second.survey.options.find((o) => o.id === options[1].id)?.count).toBe(1);
    expect(second.survey.totalRespondents).toBe(1);
  });

  it("複数選択許可なら複数送信できる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const surveyId = await createSurvey(cookie, session.id, true);
    await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/surveys/${surveyId}/publish`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const surveys = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys`, { headers: participantHeaders(ctx) })
    ).json()) as { surveys: Array<{ id: string; options: Array<{ id: string }> }> };
    const options = surveys.surveys.find((s) => s.id === surveyId)!.options;

    const res = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/surveys/${surveyId}/responses`, {
        method: "POST",
        headers: participantHeaders(ctx),
        body: JSON.stringify({ optionIds: [options[0].id, options[2].id] }),
      })
    ).json()) as { survey: { totalRespondents: number } };
    expect(res.survey.totalRespondents).toBe(1);
  });
});

describe("テンプレート", () => {
  it("テンプレートからセッションへ参考情報・アンケート(draft)がコピーされる", async () => {
    const cookie = await adminLogin();
    const created = await SELF.fetch(`${BASE}/api/admin/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "AWS 研修セット",
        materials: [{ module: "Module 1", title: "IAM ドキュメント", url: "https://docs.aws.amazon.com/iam/" }],
        surveys: [{ title: "難易度は?", isMulti: false, options: ["簡単", "ちょうどよい", "難しい"] }],
      }),
    });
    expect(created.status).toBe(201);
    const template = ((await created.json()) as { template: { id: string } }).template;

    const session = await createSession(cookie, "テンプレ利用研修", template.id);
    const detail = (await (
      await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}`, { headers: { Cookie: cookie } })
    ).json()) as {
      materials: Array<{ title: string }>;
      surveys: Array<{ title: string; status: string }>;
    };
    expect(detail.materials.length).toBe(1);
    expect(detail.materials[0].title).toBe("IAM ドキュメント");
    expect(detail.surveys.length).toBe(1);
    expect(detail.surveys[0].status).toBe("draft");
  });
});

describe("セッション終了・削除", () => {
  it("終了後は投稿・投票できないが閲覧はできる", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const question = await postQuestion(ctx);

    const end = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}/end`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(end.status).toBe(200);

    const post = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, {
      method: "POST",
      headers: participantHeaders(ctx),
      body: JSON.stringify({ body: "終了後の質問" }),
    });
    expect(post.status).toBe(403);

    const vote = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions/${question.id}/vote`, {
      method: "PUT",
      headers: participantHeaders(ctx),
    });
    expect(vote.status).toBe(403);

    const list = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, { headers: participantHeaders(ctx) });
    expect(list.status).toBe(200);
  });

  it("削除するとセッションと画像が消える", async () => {
    const cookie = await adminLogin();
    const session = await createSession(cookie);
    const ctx = await enter(session.code);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    const uploaded = (await (
      await SELF.fetch(`${BASE}/api/s/${ctx.code}/images`, {
        method: "POST",
        headers: { "X-Entry-Token": ctx.entryToken, "X-Anon-Token": ctx.anonToken },
        body: form,
      })
    ).json()) as { imageKey: string };

    const del = await SELF.fetch(`${BASE}/api/admin/sessions/${session.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);

    const meta = await SELF.fetch(`${BASE}/api/s/${ctx.code}`, { headers: participantHeaders(ctx) });
    expect(meta.status).toBe(404);

    const obj = await env.IMAGES.get(`${session.id}/${uploaded.imageKey}`);
    expect(obj).toBeNull();
  });
});

describe("Cron: 期限切れセッションの自動削除", () => {
  it("作成から 30 日を超えたセッションが D1 + R2 ごと削除される", async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(
      "INSERT INTO sessions (id, code, course_name, held_on, status, created_at) VALUES ('old-s', 'OLDOLD', '旧研修', '2026-06-01', 'active', ?)",
    ).bind(old).run();
    await env.DB.prepare(
      "INSERT INTO questions (id, session_id, body, token_hash, is_answered, created_at, updated_at) VALUES ('old-q', 'old-s', 'b', 'h', 0, ?, ?)",
    ).bind(old, old).run();
    await env.IMAGES.put("old-s/img1", new Uint8Array([1]));

    await cleanupExpiredSessions(env);

    const s = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'old-s'").first<{ n: number }>();
    const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE id = 'old-q'").first<{ n: number }>();
    expect(s?.n).toBe(0);
    expect(q?.n).toBe(0);
    expect(await env.IMAGES.get("old-s/img1")).toBeNull();
  });
});
