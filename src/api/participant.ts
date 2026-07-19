import { anonTokenHash, issueEntryToken, verifyEntry } from "../auth";
import {
  getPublicQuestion,
  getPublicSurvey,
  getSessionByCode,
  listMaterials,
  listQuestions,
  listSurveys,
  publicSession,
} from "../db";
import { errorJson, json, readJson } from "../http";
import { deleteImage, getImage, uploadImage } from "../images";
import { broadcast, checkRateLimit } from "../realtime";
import { verifyTurnstile } from "../turnstile";
import type { Env, QuestionRow, SessionRow, SurveyRow } from "../types";

const MAX_QUESTION_LENGTH = 2000;

function rateLimited(): Response {
  return errorJson("操作の間隔が短すぎます。少し待ってから再試行してください", 429);
}

function sessionEnded(): Response {
  return errorJson("このセッションは終了しています", 403);
}

/** POST /api/enter — Turnstile 検証(入室時 1 回のみ)+ 入室トークン発行 */
export async function handleEnter(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code?: string; turnstileToken?: string }>(request);
  const code = body?.code?.trim().toUpperCase();
  if (!code) return errorJson("アクセスコードを入力してください", 400);
  const session = await getSessionByCode(env, code);
  if (!session) return errorJson("セッションが見つかりません。コードを確認してください", 404);
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, body?.turnstileToken))) {
    return errorJson("スパム検証に失敗しました。ページを再読み込みしてください", 400);
  }
  return json({ entryToken: await issueEntryToken(env, session), session: publicSession(session) });
}

/** /api/s/:code/... 参加者 API(入室トークン必須) */
export async function handleParticipantApi(
  request: Request,
  env: Env,
  code: string,
  rest: string[],
): Promise<Response> {
  const session = await getSessionByCode(env, code.toUpperCase());
  if (!session) return errorJson("セッションが見つかりません", 404);
  const method = request.method;

  // 画像の GET のみトークン不要(<img> からヘッダを付けられない。キーは推測不能な UUID)
  if (rest[0] === "images" && rest.length === 2 && method === "GET") {
    return getImage(env, session, rest[1]);
  }

  if (!(await verifyEntry(env, request, session.code))) {
    return errorJson("入室情報が無効です。再入室してください", 401);
  }

  if (rest.length === 0 && method === "GET") {
    return json({ session: publicSession(session) });
  }

  if (rest[0] === "questions") {
    return handleQuestions(request, env, session, rest.slice(1));
  }

  if (rest[0] === "images" && rest.length === 1 && method === "POST") {
    if (session.status === "ended") return sessionEnded();
    if (!(await checkRateLimit(env, session.code, request, "image"))) return rateLimited();
    return uploadImage(request, env, session);
  }

  if (rest[0] === "materials" && rest.length === 1 && method === "GET") {
    return json({ materials: await listMaterials(env, session.id) });
  }

  if (rest[0] === "surveys") {
    return handleSurveys(request, env, session, rest.slice(1));
  }

  return errorJson("not found", 404);
}

async function handleQuestions(request: Request, env: Env, session: SessionRow, rest: string[]): Promise<Response> {
  const method = request.method;

  if (rest.length === 0 && method === "GET") {
    const myHash = await anonTokenHash(request);
    const myVotes = new Set<string>();
    if (myHash) {
      const rows = await env.DB.prepare(
        `SELECT v.question_id FROM votes v JOIN questions q ON q.id = v.question_id
         WHERE q.session_id = ? AND v.token_hash = ?`,
      )
        .bind(session.id, myHash)
        .all<{ question_id: string }>();
      for (const r of rows.results) myVotes.add(r.question_id);
    }
    const questions = (await listQuestions(env, session.id)).map(({ tokenHash, ...q }) => ({
      ...q,
      isMine: myHash !== null && tokenHash === myHash,
      voted: myVotes.has(q.id),
    }));
    return json({ questions });
  }

  if (rest.length === 0 && method === "POST") {
    if (session.status === "ended") return sessionEnded();
    const myHash = await anonTokenHash(request);
    if (!myHash) return errorJson("匿名トークンがありません。ページを再読み込みしてください", 400);
    if (!(await checkRateLimit(env, session.code, request, "question"))) return rateLimited();
    const body = await readJson<{ body?: string; imageKey?: string }>(request);
    const text = body?.body?.trim() ?? "";
    if (!text && !body?.imageKey) return errorJson("質問内容を入力してください", 400);
    if (text.length > MAX_QUESTION_LENGTH) {
      return errorJson(`質問は ${MAX_QUESTION_LENGTH} 文字以内で入力してください`, 400);
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO questions (id, session_id, body, image_key, token_hash, is_answered, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(id, session.id, text, body?.imageKey ?? null, myHash, now, now)
      .run();
    const question = await getPublicQuestion(env, id);
    await broadcast(env, session.code, "question:new", { question });
    return json({ question: { ...question, isMine: true, voted: false } }, 201);
  }

  const question = await env.DB.prepare("SELECT * FROM questions WHERE id = ? AND session_id = ?")
    .bind(rest[0], session.id)
    .first<QuestionRow>();
  if (!question) return errorJson("質問が見つかりません", 404);

  if (rest.length === 1 && (method === "PATCH" || method === "DELETE")) {
    if (session.status === "ended") return sessionEnded();
    const myHash = await anonTokenHash(request);
    if (!myHash || myHash !== question.token_hash) {
      return errorJson("自分の質問のみ編集・削除できます", 403);
    }
    if (method === "PATCH") {
      const body = await readJson<{ body?: string }>(request);
      const text = body?.body?.trim() ?? "";
      if (!text) return errorJson("質問内容を入力してください", 400);
      if (text.length > MAX_QUESTION_LENGTH) {
        return errorJson(`質問は ${MAX_QUESTION_LENGTH} 文字以内で入力してください`, 400);
      }
      await env.DB.prepare("UPDATE questions SET body = ?, updated_at = ? WHERE id = ?")
        .bind(text, Date.now(), question.id)
        .run();
      const updated = await getPublicQuestion(env, question.id);
      await broadcast(env, session.code, "question:updated", { question: updated });
      return json({ question: { ...updated, isMine: true } });
    }
    await env.DB.prepare("DELETE FROM questions WHERE id = ?").bind(question.id).run();
    await deleteImage(env, session.id, question.image_key);
    await broadcast(env, session.code, "question:deleted", { questionId: question.id });
    return json({ ok: true });
  }

  if (rest.length === 2 && rest[1] === "vote" && (method === "PUT" || method === "DELETE")) {
    if (session.status === "ended") return sessionEnded();
    const myHash = await anonTokenHash(request);
    if (!myHash) return errorJson("匿名トークンがありません。ページを再読み込みしてください", 400);
    if (!(await checkRateLimit(env, session.code, request, "vote"))) return rateLimited();
    if (method === "PUT") {
      await env.DB.prepare("INSERT OR IGNORE INTO votes (question_id, token_hash, created_at) VALUES (?, ?, ?)")
        .bind(question.id, myHash, Date.now())
        .run();
    } else {
      await env.DB.prepare("DELETE FROM votes WHERE question_id = ? AND token_hash = ?")
        .bind(question.id, myHash)
        .run();
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE question_id = ?")
      .bind(question.id)
      .first<{ n: number }>();
    const votes = count?.n ?? 0;
    await broadcast(env, session.code, "vote:changed", { questionId: question.id, votes });
    return json({ questionId: question.id, votes, voted: method === "PUT" });
  }

  return errorJson("not found", 404);
}

async function handleSurveys(request: Request, env: Env, session: SessionRow, rest: string[]): Promise<Response> {
  const method = request.method;

  if (rest.length === 0 && method === "GET") {
    const myHash = await anonTokenHash(request);
    const surveys = await listSurveys(env, session.id, false);
    const mineBySurvey = new Map<string, string[]>();
    if (myHash) {
      const rows = await env.DB.prepare(
        `SELECT r.survey_id, r.option_id FROM survey_responses r JOIN surveys s ON s.id = r.survey_id
         WHERE s.session_id = ? AND r.token_hash = ?`,
      )
        .bind(session.id, myHash)
        .all<{ survey_id: string; option_id: string }>();
      for (const r of rows.results) {
        const list = mineBySurvey.get(r.survey_id) ?? [];
        list.push(r.option_id);
        mineBySurvey.set(r.survey_id, list);
      }
    }
    return json({ surveys: surveys.map((s) => ({ ...s, myOptionIds: mineBySurvey.get(s.id) ?? [] })) });
  }

  if (rest.length === 2 && rest[1] === "responses" && method === "POST") {
    if (session.status === "ended") return sessionEnded();
    const myHash = await anonTokenHash(request);
    if (!myHash) return errorJson("匿名トークンがありません。ページを再読み込みしてください", 400);
    if (!(await checkRateLimit(env, session.code, request, "survey"))) return rateLimited();
    const survey = await env.DB.prepare("SELECT * FROM surveys WHERE id = ? AND session_id = ?")
      .bind(rest[0], session.id)
      .first<SurveyRow>();
    if (!survey) return errorJson("アンケートが見つかりません", 404);
    if (survey.status !== "published") return errorJson("このアンケートは回答を受け付けていません", 403);

    const body = await readJson<{ optionIds?: string[] }>(request);
    const optionIds = [...new Set(body?.optionIds ?? [])];
    if (optionIds.length === 0) return errorJson("選択肢を選んでください", 400);
    if (survey.is_multi !== 1 && optionIds.length > 1) {
      return errorJson("このアンケートは 1 つだけ選択できます", 400);
    }
    const valid = await env.DB.prepare("SELECT id FROM survey_options WHERE survey_id = ?")
      .bind(survey.id)
      .all<{ id: string }>();
    const validIds = new Set(valid.results.map((r) => r.id));
    if (!optionIds.every((o) => validIds.has(o))) return errorJson("不正な選択肢です", 400);

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM survey_responses WHERE survey_id = ? AND token_hash = ?").bind(survey.id, myHash),
      ...optionIds.map((o) =>
        env.DB.prepare(
          "INSERT INTO survey_responses (survey_id, option_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
        ).bind(survey.id, o, myHash, now),
      ),
    ]);
    const pub = await getPublicSurvey(env, survey.id);
    await broadcast(env, session.code, "survey:results", { survey: pub });
    return json({ survey: { ...pub, myOptionIds: optionIds } });
  }

  return errorJson("not found", 404);
}
