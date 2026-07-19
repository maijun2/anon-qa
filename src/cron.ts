import { deleteSessionImages } from "./images";
import type { Env } from "./types";
import { SESSION_TTL_MS } from "./types";

/**
 * 作成から 30 日を超えたセッションを全データ(D1 は FK CASCADE、R2 は prefix 一括)ごと削除する。
 * Cron Triggers(日次)から呼ばれる。
 */
export async function cleanupExpiredSessions(env: Env): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const expired = await env.DB.prepare("SELECT id FROM sessions WHERE created_at < ?")
    .bind(cutoff)
    .all<{ id: string }>();
  for (const row of expired.results) {
    await deleteSessionImages(env, row.id);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.id).run();
  }
}
