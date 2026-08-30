export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  SESSION_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** wrangler secret put で登録 */
  ADMIN_PASSWORD: string;
  TURNSTILE_SECRET_KEY: string;
  APP_SECRET: string;
  /** wrangler secret put で登録(オプション)。pending-questions API の Bearer 認証用。未設定なら全リクエスト拒否 */
  PENDING_API_TOKEN?: string;
  /** wrangler secret put で登録(オプション)。未設定なら Discord 通知は無効化される */
  DISCORD_WEBHOOK_URL?: string;
  DISCORD_THREAD_ID?: string;
  /** 公開情報(wrangler.jsonc の vars) */
  TURNSTILE_SITE_KEY: string;
}

/** セッションの保持期間。作成から 30 日で Cron が自動削除する */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  code: string;
  course_name: string;
  held_on: string;
  status: "active" | "ended";
  created_at: number;
}

export interface QuestionRow {
  id: string;
  session_id: string;
  body: string;
  image_key: string | null;
  token_hash: string;
  is_answered: number;
  created_at: number;
  updated_at: number;
}

export interface AnswerRow {
  id: string;
  question_id: string;
  body: string;
  author_role: "instructor" | "participant";
  /** 参加者返信の本人判定用ハッシュ。講師回答は null */
  token_hash: string | null;
  /** 添付画像の R2 キー(UUID)。画像なしは null。0003 以前の既存行も null */
  image_key: string | null;
  created_at: number;
  /** 0002 以前の既存行は null(created_at 扱い) */
  updated_at: number | null;
}

export interface MaterialRow {
  id: string;
  session_id: string;
  module: string;
  title: string;
  url: string | null;
  body: string | null;
  sort_order: number;
}

export interface SurveyRow {
  id: string;
  session_id: string;
  title: string;
  is_multi: number;
  status: "draft" | "published" | "closed";
  sort_order: number;
  created_at: number;
}

export interface SurveyOptionRow {
  id: string;
  survey_id: string;
  label: string;
  sort_order: number;
}
