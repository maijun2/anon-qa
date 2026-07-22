import { clearAdminCookie, issueAdminCookie, timingSafeEqualStr, verifyAdmin } from "../auth";
import {
  getPublicQuestion,
  getPublicSurvey,
  getSessionByCode,
  getSessionById,
  listMaterials,
  listQuestions,
  listSurveys,
  publicMaterial,
  publicSession,
} from "../db";
import { errorJson, json, readJson } from "../http";
import { deleteImage, deleteQuestionImages, deleteSessionImages, uploadImage } from "../images";
import { broadcast, checkLoginRateLimit } from "../realtime";
import type { Env, MaterialRow, QuestionRow, SessionRow, SurveyOptionRow, SurveyRow } from "../types";

// 紛らわしい文字(0/O, 1/I)を除いたコード用アルファベット
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** /api/admin/... 講師用 API(login 以外はセッション Cookie 必須) */
export async function handleAdminApi(request: Request, env: Env, rest: string[]): Promise<Response> {
  const method = request.method;

  if (rest[0] === "login" && method === "POST") {
    // 比較の前に制限を確認(記録はしない)。超過中はパスワードの正誤に関わらず
    // 比較自体を行わず 429 で弾く(でないと正解を引かれた瞬間に制限を回避できてしまう)
    if (!(await checkLoginRateLimit(env, request, "check"))) {
      return errorJson("試行回数が多すぎます。しばらく待ってから再試行してください", 429);
    }
    const body = await readJson<{ password?: string }>(request);
    if (!body?.password || !timingSafeEqualStr(body.password, env.ADMIN_PASSWORD)) {
      // 失敗時のみカウント(IP 別 + グローバルの両方)。正規ログインは制限対象外
      await checkLoginRateLimit(env, request, "record");
      return errorJson("パスワードが違います", 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await issueAdminCookie(env) });
  }

  if (!(await verifyAdmin(env, request))) return errorJson("認証が必要です", 401);

  if (rest[0] === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearAdminCookie() });
  }
  if (rest[0] === "me" && method === "GET") return json({ ok: true });
  if (rest[0] === "sessions") return handleSessions(request, env, rest.slice(1));
  if (rest[0] === "templates") return handleTemplates(request, env, rest.slice(1));
  return errorJson("not found", 404);
}

async function handleSessions(request: Request, env: Env, rest: string[]): Promise<Response> {
  const method = request.method;

  if (rest.length === 0 && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id) AS question_count
       FROM sessions s ORDER BY s.created_at DESC`,
    ).all<SessionRow & { question_count: number }>();
    return json({
      sessions: rows.results.map((s) => ({ ...publicSession(s), questionCount: s.question_count })),
    });
  }

  if (rest.length === 0 && method === "POST") {
    const body = await readJson<{ courseName?: string; heldOn?: string; templateId?: string }>(request);
    const courseName = body?.courseName?.trim();
    if (!courseName) return errorJson("コース名を入力してください", 400);
    const heldOn = body?.heldOn?.trim() || new Date().toISOString().slice(0, 10);

    let code = "";
    for (let i = 0; i < 10 && !code; i++) {
      const candidate = generateCode();
      if (!(await getSessionByCode(env, candidate))) code = candidate;
    }
    if (!code) return errorJson("アクセスコードの生成に失敗しました。再試行してください", 500);

    const session: SessionRow = {
      id: crypto.randomUUID(),
      code,
      course_name: courseName,
      held_on: heldOn,
      status: "active",
      created_at: Date.now(),
    };
    await env.DB.prepare(
      "INSERT INTO sessions (id, code, course_name, held_on, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(session.id, session.code, session.course_name, session.held_on, session.status, session.created_at)
      .run();

    if (body?.templateId) {
      const applied = await applyTemplate(env, body.templateId, session.id);
      if (!applied) return errorJson("テンプレートが見つかりません", 404);
    }
    return json({ session: { ...publicSession(session), questionCount: 0 } }, 201);
  }

  const session = await getSessionById(env, rest[0]);
  if (!session) return errorJson("セッションが見つかりません", 404);

  if (rest.length === 1 && method === "GET") {
    const questions = (await listQuestions(env, session.id)).map(({ tokenHash: _tokenHash, ...q }) => q);
    return json({
      session: publicSession(session),
      questions,
      materials: await listMaterials(env, session.id),
      surveys: await listSurveys(env, session.id, true),
    });
  }

  if (rest.length === 1 && method === "DELETE") {
    await deleteSessionImages(env, session.id);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id).run();
    await broadcast(env, session.code, "session:deleted", { sessionId: session.id });
    return json({ ok: true });
  }

  // 講師回答の添付画像アップロード(admin は Cookie 認証済み)。既存の uploadImage を再利用
  if (rest.length === 2 && rest[1] === "images" && method === "POST") {
    return uploadImage(request, env, session);
  }

  if (rest.length === 2 && rest[1] === "end" && method === "POST") {
    await env.DB.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").bind(session.id).run();
    const updated = { ...session, status: "ended" as const };
    await broadcast(env, session.code, "session:ended", { session: publicSession(updated) });
    return json({ session: publicSession(updated) });
  }

  if (rest[1] === "questions" && rest.length >= 3) {
    return handleAdminQuestion(request, env, session, rest.slice(2));
  }
  if (rest[1] === "materials") {
    return handleAdminMaterials(request, env, session, rest.slice(2));
  }
  if (rest[1] === "surveys") {
    return handleAdminSurveys(request, env, session, rest.slice(2));
  }
  return errorJson("not found", 404);
}

async function handleAdminQuestion(
  request: Request,
  env: Env,
  session: SessionRow,
  rest: string[],
): Promise<Response> {
  const method = request.method;
  const question = await env.DB.prepare("SELECT * FROM questions WHERE id = ? AND session_id = ?")
    .bind(rest[0], session.id)
    .first<QuestionRow>();
  if (!question) return errorJson("質問が見つかりません", 404);

  if (rest.length === 1 && method === "DELETE") {
    await deleteQuestionImages(env, session.id, question.id, question.image_key);
    await env.DB.prepare("DELETE FROM questions WHERE id = ?").bind(question.id).run();
    await broadcast(env, session.code, "question:deleted", { questionId: question.id });
    return json({ ok: true });
  }

  if (rest.length === 2 && rest[1] === "answers" && method === "POST") {
    const body = await readJson<{ body?: string; imageKey?: string }>(request);
    const text = body?.body?.trim() ?? "";
    if (!text && !body?.imageKey) return errorJson("回答内容を入力してください", 400);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO answers (id, question_id, body, author_role, token_hash, image_key, created_at, updated_at)
         VALUES (?, ?, ?, 'instructor', NULL, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), question.id, text, body?.imageKey ?? null, now, now),
      env.DB.prepare("UPDATE questions SET is_answered = 1 WHERE id = ?").bind(question.id),
    ]);
    const updated = await getPublicQuestion(env, question.id);
    await broadcast(env, session.code, "question:updated", { question: updated });
    return json({ question: updated }, 201);
  }

  // 返信のモデレーション削除(参加者返信・講師回答とも削除可)。is_answered は自動で変えない
  if (rest.length === 3 && rest[1] === "answers" && method === "DELETE") {
    const answer = await env.DB.prepare("SELECT image_key FROM answers WHERE id = ? AND question_id = ?")
      .bind(rest[2], question.id)
      .first<{ image_key: string | null }>();
    if (!answer) return errorJson("返信が見つかりません", 404);
    await env.DB.prepare("DELETE FROM answers WHERE id = ?").bind(rest[2]).run();
    await deleteImage(env, session.id, answer.image_key);
    const updated = await getPublicQuestion(env, question.id);
    await broadcast(env, session.code, "question:updated", { question: updated });
    return json({ question: updated });
  }

  if (rest.length === 2 && rest[1] === "answered" && method === "PATCH") {
    const body = await readJson<{ isAnswered?: boolean }>(request);
    await env.DB.prepare("UPDATE questions SET is_answered = ? WHERE id = ?")
      .bind(body?.isAnswered ? 1 : 0, question.id)
      .run();
    const updated = await getPublicQuestion(env, question.id);
    await broadcast(env, session.code, "question:updated", { question: updated });
    return json({ question: updated });
  }

  return errorJson("not found", 404);
}

interface MaterialInput {
  module?: string;
  title?: string;
  url?: string;
  body?: string;
}

async function broadcastMaterials(env: Env, session: SessionRow): Promise<void> {
  await broadcast(env, session.code, "material:changed", { materials: await listMaterials(env, session.id) });
}

async function handleAdminMaterials(
  request: Request,
  env: Env,
  session: SessionRow,
  rest: string[],
): Promise<Response> {
  const method = request.method;

  if (rest.length === 0 && method === "GET") {
    return json({ materials: await listMaterials(env, session.id) });
  }

  if (rest.length === 0 && method === "POST") {
    const body = await readJson<MaterialInput>(request);
    const title = body?.title?.trim();
    if (!title) return errorJson("タイトルを入力してください", 400);
    const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM materials WHERE session_id = ?")
      .bind(session.id)
      .first<{ n: number }>();
    const material: MaterialRow = {
      id: crypto.randomUUID(),
      session_id: session.id,
      module: body?.module?.trim() ?? "",
      title,
      url: body?.url?.trim() || null,
      body: body?.body?.trim() || null,
      sort_order: (max?.n ?? 0) + 1,
    };
    await env.DB.prepare(
      "INSERT INTO materials (id, session_id, module, title, url, body, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(material.id, material.session_id, material.module, material.title, material.url, material.body, material.sort_order)
      .run();
    await broadcastMaterials(env, session);
    return json({ material: publicMaterial(material) }, 201);
  }

  if (rest.length === 1 && rest[0] === "order" && method === "PUT") {
    const body = await readJson<{ ids?: string[] }>(request);
    if (!body?.ids?.length) return errorJson("並び順を指定してください", 400);
    await env.DB.batch(
      body.ids.map((id, index) =>
        env.DB.prepare("UPDATE materials SET sort_order = ? WHERE id = ? AND session_id = ?").bind(
          index + 1,
          id,
          session.id,
        ),
      ),
    );
    await broadcastMaterials(env, session);
    return json({ materials: await listMaterials(env, session.id) });
  }

  const material = await env.DB.prepare("SELECT * FROM materials WHERE id = ? AND session_id = ?")
    .bind(rest[0], session.id)
    .first<MaterialRow>();
  if (!material) return errorJson("参考情報が見つかりません", 404);

  if (rest.length === 1 && method === "PATCH") {
    const body = await readJson<MaterialInput>(request);
    const title = body?.title?.trim() ?? material.title;
    if (!title) return errorJson("タイトルを入力してください", 400);
    await env.DB.prepare("UPDATE materials SET module = ?, title = ?, url = ?, body = ? WHERE id = ?")
      .bind(body?.module?.trim() ?? material.module, title, body?.url?.trim() || null, body?.body?.trim() || null, material.id)
      .run();
    await broadcastMaterials(env, session);
    return json({ ok: true });
  }

  if (rest.length === 1 && method === "DELETE") {
    await env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(material.id).run();
    await broadcastMaterials(env, session);
    return json({ ok: true });
  }

  return errorJson("not found", 404);
}

interface SurveyInput {
  title?: string;
  isMulti?: boolean;
  options?: string[];
}

async function handleAdminSurveys(
  request: Request,
  env: Env,
  session: SessionRow,
  rest: string[],
): Promise<Response> {
  const method = request.method;

  if (rest.length === 0 && method === "GET") {
    return json({ surveys: await listSurveys(env, session.id, true) });
  }

  if (rest.length === 0 && method === "POST") {
    const body = await readJson<SurveyInput>(request);
    const created = await insertSurvey(env, session.id, body);
    if (created instanceof Response) return created;
    return json({ survey: await getPublicSurvey(env, created) }, 201);
  }

  const survey = await env.DB.prepare("SELECT * FROM surveys WHERE id = ? AND session_id = ?")
    .bind(rest[0], session.id)
    .first<SurveyRow>();
  if (!survey) return errorJson("アンケートが見つかりません", 404);

  if (rest.length === 1 && method === "PATCH") {
    if (survey.status !== "draft") return errorJson("配信済みのアンケートは編集できません", 400);
    const body = await readJson<SurveyInput>(request);
    const title = body?.title?.trim();
    const options = (body?.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (!title || options.length < 2) return errorJson("質問文と 2 つ以上の選択肢を入力してください", 400);
    await env.DB.batch([
      env.DB.prepare("UPDATE surveys SET title = ?, is_multi = ? WHERE id = ?").bind(
        title,
        body?.isMulti ? 1 : 0,
        survey.id,
      ),
      env.DB.prepare("DELETE FROM survey_options WHERE survey_id = ?").bind(survey.id),
      ...options.map((label, index) =>
        env.DB.prepare("INSERT INTO survey_options (id, survey_id, label, sort_order) VALUES (?, ?, ?, ?)").bind(
          crypto.randomUUID(),
          survey.id,
          label,
          index + 1,
        ),
      ),
    ]);
    return json({ survey: await getPublicSurvey(env, survey.id) });
  }

  if (rest.length === 1 && method === "DELETE") {
    await env.DB.prepare("DELETE FROM surveys WHERE id = ?").bind(survey.id).run();
    await broadcast(env, session.code, "survey:deleted", { surveyId: survey.id });
    return json({ ok: true });
  }

  if (rest.length === 2 && rest[1] === "publish" && method === "POST") {
    if (survey.status === "closed") return errorJson("終了したアンケートは再配信できません", 400);
    await env.DB.prepare("UPDATE surveys SET status = 'published' WHERE id = ?").bind(survey.id).run();
    const pub = await getPublicSurvey(env, survey.id);
    await broadcast(env, session.code, "survey:published", { survey: pub });
    return json({ survey: pub });
  }

  if (rest.length === 2 && rest[1] === "close" && method === "POST") {
    await env.DB.prepare("UPDATE surveys SET status = 'closed' WHERE id = ?").bind(survey.id).run();
    const pub = await getPublicSurvey(env, survey.id);
    await broadcast(env, session.code, "survey:closed", { survey: pub });
    return json({ survey: pub });
  }

  return errorJson("not found", 404);
}

/** アンケートを draft として作成。入力不正時はエラー Response を返す */
async function insertSurvey(env: Env, sessionId: string, body: SurveyInput | null): Promise<string | Response> {
  const title = body?.title?.trim();
  const options = (body?.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (!title || options.length < 2) return errorJson("質問文と 2 つ以上の選択肢を入力してください", 400);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO surveys (id, session_id, title, is_multi, status, sort_order, created_at) VALUES (?, ?, ?, ?, 'draft', 0, ?)",
    ).bind(id, sessionId, title, body?.isMulti ? 1 : 0, Date.now()),
    ...options.map((label, index) =>
      env.DB.prepare("INSERT INTO survey_options (id, survey_id, label, sort_order) VALUES (?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        id,
        label,
        index + 1,
      ),
    ),
  ]);
  return id;
}

interface TemplateSurveyInput {
  title?: string;
  isMulti?: boolean;
  options?: string[];
}

interface TemplateInput {
  name?: string;
  materials?: MaterialInput[];
  surveys?: TemplateSurveyInput[];
}

async function handleTemplates(request: Request, env: Env, rest: string[]): Promise<Response> {
  const method = request.method;

  if (rest.length === 0 && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM template_materials m WHERE m.template_id = t.id) AS material_count,
        (SELECT COUNT(*) FROM template_surveys s WHERE s.template_id = t.id) AS survey_count
       FROM templates t ORDER BY t.created_at DESC`,
    ).all<{ id: string; name: string; created_at: number; material_count: number; survey_count: number }>();
    return json({
      templates: rows.results.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.created_at,
        materialCount: t.material_count,
        surveyCount: t.survey_count,
      })),
    });
  }

  if (rest.length === 0 && method === "POST") {
    const body = await readJson<TemplateInput>(request);
    const name = body?.name?.trim();
    if (!name) return errorJson("テンプレート名を入力してください", 400);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO templates (id, name, created_at) VALUES (?, ?, ?)")
      .bind(id, name, Date.now())
      .run();
    const error = await replaceTemplateChildren(env, id, body);
    if (error) return error;
    return json({ template: await getTemplateDetail(env, id) }, 201);
  }

  const template = await env.DB.prepare("SELECT * FROM templates WHERE id = ?")
    .bind(rest[0])
    .first<{ id: string; name: string; created_at: number }>();
  if (!template) return errorJson("テンプレートが見つかりません", 404);

  if (rest.length === 1 && method === "GET") {
    return json({ template: await getTemplateDetail(env, template.id) });
  }

  if (rest.length === 1 && method === "PUT") {
    const body = await readJson<TemplateInput>(request);
    const name = body?.name?.trim();
    if (!name) return errorJson("テンプレート名を入力してください", 400);
    await env.DB.batch([
      env.DB.prepare("UPDATE templates SET name = ? WHERE id = ?").bind(name, template.id),
      env.DB.prepare("DELETE FROM template_materials WHERE template_id = ?").bind(template.id),
      env.DB.prepare("DELETE FROM template_surveys WHERE template_id = ?").bind(template.id),
    ]);
    const error = await replaceTemplateChildren(env, template.id, body);
    if (error) return error;
    return json({ template: await getTemplateDetail(env, template.id) });
  }

  if (rest.length === 1 && method === "DELETE") {
    await env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(template.id).run();
    return json({ ok: true });
  }

  return errorJson("not found", 404);
}

async function replaceTemplateChildren(env: Env, templateId: string, body: TemplateInput | null): Promise<Response | null> {
  const statements: D1PreparedStatement[] = [];
  (body?.materials ?? []).forEach((m, index) => {
    const title = m.title?.trim();
    if (!title) return;
    statements.push(
      env.DB.prepare(
        "INSERT INTO template_materials (id, template_id, module, title, url, body, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), templateId, m.module?.trim() ?? "", title, m.url?.trim() || null, m.body?.trim() || null, index + 1),
    );
  });
  for (const [index, s] of (body?.surveys ?? []).entries()) {
    const title = s.title?.trim();
    const options = (s.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (!title) continue;
    if (options.length < 2) return errorJson("アンケートには 2 つ以上の選択肢が必要です", 400);
    const surveyId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        "INSERT INTO template_surveys (id, template_id, title, is_multi, sort_order) VALUES (?, ?, ?, ?, ?)",
      ).bind(surveyId, templateId, title, s.isMulti ? 1 : 0, index + 1),
    );
    options.forEach((label, optIndex) => {
      statements.push(
        env.DB.prepare(
          "INSERT INTO template_survey_options (id, template_survey_id, label, sort_order) VALUES (?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), surveyId, label, optIndex + 1),
      );
    });
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return null;
}

async function getTemplateDetail(env: Env, templateId: string) {
  const template = await env.DB.prepare("SELECT * FROM templates WHERE id = ?")
    .bind(templateId)
    .first<{ id: string; name: string; created_at: number }>();
  const materials = await env.DB.prepare(
    "SELECT * FROM template_materials WHERE template_id = ? ORDER BY sort_order ASC",
  )
    .bind(templateId)
    .all<{ id: string; module: string; title: string; url: string | null; body: string | null; sort_order: number }>();
  const surveys = await env.DB.prepare("SELECT * FROM template_surveys WHERE template_id = ? ORDER BY sort_order ASC")
    .bind(templateId)
    .all<{ id: string; title: string; is_multi: number }>();
  const options = await env.DB.prepare(
    `SELECT o.* FROM template_survey_options o JOIN template_surveys s ON s.id = o.template_survey_id
     WHERE s.template_id = ? ORDER BY o.sort_order ASC`,
  )
    .bind(templateId)
    .all<{ id: string; template_survey_id: string; label: string }>();

  const optionsBySurvey = new Map<string, string[]>();
  for (const o of options.results) {
    const list = optionsBySurvey.get(o.template_survey_id) ?? [];
    list.push(o.label);
    optionsBySurvey.set(o.template_survey_id, list);
  }
  return {
    id: template?.id,
    name: template?.name,
    createdAt: template?.created_at,
    materials: materials.results.map((m) => ({
      module: m.module,
      title: m.title,
      url: m.url,
      body: m.body,
    })),
    surveys: surveys.results.map((s) => ({
      title: s.title,
      isMulti: s.is_multi === 1,
      options: optionsBySurvey.get(s.id) ?? [],
    })),
  };
}

/** テンプレートの内容をセッションへコピーする(参考情報 + アンケート draft) */
async function applyTemplate(env: Env, templateId: string, sessionId: string): Promise<boolean> {
  const template = await env.DB.prepare("SELECT id FROM templates WHERE id = ?")
    .bind(templateId)
    .first<{ id: string }>();
  if (!template) return false;

  const materials = await env.DB.prepare(
    "SELECT * FROM template_materials WHERE template_id = ? ORDER BY sort_order ASC",
  )
    .bind(templateId)
    .all<{ module: string; title: string; url: string | null; body: string | null; sort_order: number }>();
  const surveys = await env.DB.prepare("SELECT * FROM template_surveys WHERE template_id = ? ORDER BY sort_order ASC")
    .bind(templateId)
    .all<{ id: string; title: string; is_multi: number; sort_order: number }>();
  const options = await env.DB.prepare(
    `SELECT o.* FROM template_survey_options o JOIN template_surveys s ON s.id = o.template_survey_id
     WHERE s.template_id = ? ORDER BY o.sort_order ASC`,
  )
    .bind(templateId)
    .all<{ template_survey_id: string; label: string; sort_order: number }>();

  const statements: D1PreparedStatement[] = [];
  for (const m of materials.results) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO materials (id, session_id, module, title, url, body, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), sessionId, m.module, m.title, m.url, m.body, m.sort_order),
    );
  }
  for (const s of surveys.results) {
    const newSurveyId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        "INSERT INTO surveys (id, session_id, title, is_multi, status, sort_order, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
      ).bind(newSurveyId, sessionId, s.title, s.is_multi, s.sort_order, Date.now()),
    );
    options.results
      .filter((o) => o.template_survey_id === s.id)
      .forEach((o) => {
        statements.push(
          env.DB.prepare("INSERT INTO survey_options (id, survey_id, label, sort_order) VALUES (?, ?, ?, ?)").bind(
            crypto.randomUUID(),
            newSurveyId,
            o.label,
            o.sort_order,
          ),
        );
      });
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return true;
}
