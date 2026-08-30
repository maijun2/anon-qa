import type { Env } from "./types";

const MAX_MESSAGE_BODY_LENGTH = 200;

interface NewQuestionNotification {
  sessionName: string;
  questionId: string;
  text: string;
  hasImage: boolean;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * 質問投稿の「気づき」用 Discord 通知。DISCORD_WEBHOOK_URL 未設定なら無効(no-op)。
 * fire-and-forget: 失敗しても呼び出し元(質問投稿)には一切影響させない(例外を投げない)。
 * IP・User-Agent・匿名トークン類は引数にも本文にも含めない(匿名性維持)。
 */
export async function notifyNewQuestion(env: Env, n: NewQuestionNotification): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const lines = [
    `📨 新規質問 (セッション: ${n.sessionName}, ID: ${n.questionId})`,
    "",
    truncate(n.text, MAX_MESSAGE_BODY_LENGTH),
  ];
  if (n.hasImage) lines.push("", "📎画像あり");

  const url = new URL(env.DISCORD_WEBHOOK_URL);
  if (env.DISCORD_THREAD_ID) url.searchParams.set("thread_id", env.DISCORD_THREAD_ID);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n") }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error("discord webhook failed:", res.status);
  } catch (err) {
    console.error("discord webhook error:", err instanceof Error ? err.message : String(err));
  }
}
