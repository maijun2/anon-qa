import type { AnswerRow, Env, QuestionRow, MaterialRow, SessionRow, SurveyOptionRow, SurveyRow } from "./types";
import { SESSION_TTL_MS } from "./types";

export function getSessionByCode(env: Env, code: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT * FROM sessions WHERE code = ?").bind(code).first<SessionRow>();
}

export function getSessionById(env: Env, id: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
}

export function publicSession(s: SessionRow) {
  return {
    id: s.id,
    code: s.code,
    courseName: s.course_name,
    heldOn: s.held_on,
    status: s.status,
    createdAt: s.created_at,
    expiresAt: s.created_at + SESSION_TTL_MS,
  };
}

export interface PublicAnswer {
  id: string;
  body: string;
  authorRole: "instructor" | "participant";
  /** 閲覧者自身の返信か。ブロードキャスト時は常に false(フロントが復元する) */
  isMine: boolean;
  createdAt: number;
  updatedAt: number;
}

/** answers の token_hash はこの関数の外に出さない(isMine の計算までで消費する) */
function toPublicAnswer(a: AnswerRow, myHash: string | null): PublicAnswer {
  return {
    id: a.id,
    body: a.body,
    authorRole: a.author_role,
    isMine: a.token_hash !== null && a.token_hash === myHash,
    createdAt: a.created_at,
    updatedAt: a.updated_at ?? a.created_at,
  };
}

export interface PublicQuestion {
  id: string;
  body: string;
  imageKey: string | null;
  isAnswered: boolean;
  createdAt: number;
  updatedAt: number;
  votes: number;
  answers: PublicAnswer[];
}

function toPublicQuestion(q: QuestionRow & { vote_count: number }, answers: PublicAnswer[]): PublicQuestion {
  return {
    id: q.id,
    body: q.body,
    imageKey: q.image_key,
    isAnswered: q.is_answered === 1,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
    votes: q.vote_count,
    answers,
  };
}

/**
 * セッションの全質問。tokenHash は本人判定(isMine)用で、レスポンスに含めては
 * ならない(admin にも返さない — ハッシュでも投稿者の紐付けが可能になるため)。
 */
export async function listQuestions(
  env: Env,
  sessionId: string,
  myHash: string | null = null,
): Promise<Array<PublicQuestion & { tokenHash: string }>> {
  const questions = await env.DB.prepare(
    `SELECT q.*, (SELECT COUNT(*) FROM votes v WHERE v.question_id = q.id) AS vote_count
     FROM questions q WHERE q.session_id = ? ORDER BY q.created_at DESC`,
  )
    .bind(sessionId)
    .all<QuestionRow & { vote_count: number }>();

  const answers = await env.DB.prepare(
    `SELECT a.* FROM answers a JOIN questions q ON q.id = a.question_id
     WHERE q.session_id = ? ORDER BY a.created_at ASC`,
  )
    .bind(sessionId)
    .all<AnswerRow>();

  const answersByQuestion = new Map<string, PublicAnswer[]>();
  for (const a of answers.results) {
    const list = answersByQuestion.get(a.question_id) ?? [];
    list.push(toPublicAnswer(a, myHash));
    answersByQuestion.set(a.question_id, list);
  }

  return questions.results.map((q) => ({
    ...toPublicQuestion(q, answersByQuestion.get(q.id) ?? []),
    tokenHash: q.token_hash,
  }));
}

export async function getPublicQuestion(
  env: Env,
  questionId: string,
  myHash: string | null = null,
): Promise<PublicQuestion | null> {
  const q = await env.DB.prepare(
    `SELECT q.*, (SELECT COUNT(*) FROM votes v WHERE v.question_id = q.id) AS vote_count
     FROM questions q WHERE q.id = ?`,
  )
    .bind(questionId)
    .first<QuestionRow & { vote_count: number }>();
  if (!q) return null;
  const answers = await env.DB.prepare("SELECT * FROM answers WHERE question_id = ? ORDER BY created_at ASC")
    .bind(questionId)
    .all<AnswerRow>();
  return toPublicQuestion(
    q,
    answers.results.map((a) => toPublicAnswer(a, myHash)),
  );
}

export function publicMaterial(m: MaterialRow) {
  return { id: m.id, module: m.module, title: m.title, url: m.url, body: m.body, sortOrder: m.sort_order };
}

export async function listMaterials(env: Env, sessionId: string) {
  const materials = await env.DB.prepare(
    "SELECT * FROM materials WHERE session_id = ? ORDER BY module ASC, sort_order ASC",
  )
    .bind(sessionId)
    .all<MaterialRow>();
  return materials.results.map(publicMaterial);
}

export interface PublicSurveyOption {
  id: string;
  label: string;
  count: number;
}

export interface PublicSurvey {
  id: string;
  title: string;
  isMulti: boolean;
  status: "draft" | "published" | "closed";
  createdAt: number;
  options: PublicSurveyOption[];
  totalRespondents: number;
}

export async function listSurveys(env: Env, sessionId: string, includeDraft: boolean): Promise<PublicSurvey[]> {
  const statusFilter = includeDraft ? "" : " AND status IN ('published', 'closed')";
  const surveys = await env.DB.prepare(
    `SELECT * FROM surveys WHERE session_id = ?${statusFilter} ORDER BY created_at ASC`,
  )
    .bind(sessionId)
    .all<SurveyRow>();

  const options = await env.DB.prepare(
    `SELECT o.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.option_id = o.id) AS response_count
     FROM survey_options o JOIN surveys s ON s.id = o.survey_id
     WHERE s.session_id = ? ORDER BY o.sort_order ASC`,
  )
    .bind(sessionId)
    .all<SurveyOptionRow & { response_count: number }>();

  const totals = await env.DB.prepare(
    `SELECT r.survey_id, COUNT(DISTINCT r.token_hash) AS respondents
     FROM survey_responses r JOIN surveys s ON s.id = r.survey_id
     WHERE s.session_id = ? GROUP BY r.survey_id`,
  )
    .bind(sessionId)
    .all<{ survey_id: string; respondents: number }>();

  const totalBySurvey = new Map(totals.results.map((t) => [t.survey_id, t.respondents]));
  const optionsBySurvey = new Map<string, PublicSurveyOption[]>();
  for (const o of options.results) {
    const list = optionsBySurvey.get(o.survey_id) ?? [];
    list.push({ id: o.id, label: o.label, count: o.response_count });
    optionsBySurvey.set(o.survey_id, list);
  }

  return surveys.results.map((s) => ({
    id: s.id,
    title: s.title,
    isMulti: s.is_multi === 1,
    status: s.status,
    createdAt: s.created_at,
    options: optionsBySurvey.get(s.id) ?? [],
    totalRespondents: totalBySurvey.get(s.id) ?? 0,
  }));
}

export async function getPublicSurvey(env: Env, surveyId: string): Promise<PublicSurvey | null> {
  const s = await env.DB.prepare("SELECT * FROM surveys WHERE id = ?").bind(surveyId).first<SurveyRow>();
  if (!s) return null;
  const surveys = await listSurveys(env, s.session_id, true);
  return surveys.find((x) => x.id === surveyId) ?? null;
}
