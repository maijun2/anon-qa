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
  if (expired.results.length === 0) return;

  // R2 削除はセッション間で独立なため並列化。失敗したセッションは D1 行を残し、翌日の cron に再試行させる
  const settled = await Promise.allSettled(
    expired.results.map((row) => deleteSessionImages(env, row.id).then(() => row.id)),
  );
  const deletableIds: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      deletableIds.push(result.value);
    } else {
      console.error("session image cleanup failed:", result.reason);
    }
  }
  if (deletableIds.length === 0) return;

  await env.DB.batch(
    deletableIds.map((id) => env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id)),
  );
}
