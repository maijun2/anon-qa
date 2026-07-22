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
  imageKey: string | null;
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
    imageKey: a.image_key,
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

/** 質問一覧の 1 ページあたりの件数(初期ロード・追加ロード共通) */
export const QUESTIONS_PAGE_SIZE = 50;

export interface QuestionsCursor {
  createdAt: number;
  id: string;
}

/** カーソルは "createdAt_id" 形式。不正な値は先頭ページ扱い(null)にする */
export function parseQuestionsCursor(raw: string | null): QuestionsCursor | null {
  if (!raw) return null;
  const sep = raw.indexOf("_");
  if (sep <= 0) return null;
  const createdAt = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

export interface QuestionsPage {
  questions: Array<PublicQuestion & { tokenHash: string }>;
  /** 次ページ取得用カーソル。null なら最終ページ */
  nextCursor: string | null;
}

/**
 * セッションの質問一覧(created_at + id の keyset カーソルページネーション)。
 * created_at 同値の取りこぼし・重複を避けるため id を tiebreak に使う。
 * tokenHash は本人判定(isMine)用で、レスポンスに含めてはならない
 * (admin にも返さない — ハッシュでも投稿者の紐付けが可能になるため)。
 */
export async function listQuestions(
  env: Env,
  sessionId: string,
  myHash: string | null = null,
  cursor: QuestionsCursor | null = null,
): Promise<QuestionsPage> {
  let sql = `SELECT q.*, (SELECT COUNT(*) FROM votes v WHERE v.question_id = q.id) AS vote_count
     FROM questions q WHERE q.session_id = ?`;
  const binds: (string | number)[] = [sessionId];
  if (cursor) {
    sql += " AND (q.created_at < ? OR (q.created_at = ? AND q.id < ?))";
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  // 次ページの有無を判定するため 1 件多く取得する
  sql += " ORDER BY q.created_at DESC, q.id DESC LIMIT ?";
  binds.push(QUESTIONS_PAGE_SIZE + 1);
  const questions = await env.DB.prepare(sql)
    .bind(...binds)
    .all<QuestionRow & { vote_count: number }>();

  const hasMore = questions.results.length > QUESTIONS_PAGE_SIZE;
  const page = questions.results.slice(0, QUESTIONS_PAGE_SIZE);

  // answers はページ内の質問のぶんだけロードする(全件ロードしない)
  const answersByQuestion = new Map<string, PublicAnswer[]>();
  if (page.length > 0) {
    const placeholders = page.map(() => "?").join(",");
    const answers = await env.DB.prepare(
      `SELECT * FROM answers WHERE question_id IN (${placeholders}) ORDER BY created_at ASC`,
    )
      .bind(...page.map((q) => q.id))
      .all<AnswerRow>();
    for (const a of answers.results) {
      const list = answersByQuestion.get(a.question_id) ?? [];
      list.push(toPublicAnswer(a, myHash));
      answersByQuestion.set(a.question_id, list);
    }
  }

  const last = page[page.length - 1];
  return {
    questions: page.map((q) => ({
      ...toPublicQuestion(q, answersByQuestion.get(q.id) ?? []),
      tokenHash: q.token_hash,
    })),
    nextCursor: hasMore ? `${last.created_at}_${last.id}` : null,
  };
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
