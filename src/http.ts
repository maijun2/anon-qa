/**
 * HTML ページ向け CSP。静的配信側の public/_headers にも同じ値を記載しているため、
 * 変更時は両方を同期させること。
 * (エントリファイル src/index.ts から named export すると workerd がハンドラと
 *  誤認して起動に失敗するため、ここで定義する)
 * - script-src / frame-src: Turnstile(challenges.cloudflare.com)を許可
 *   https://developers.cloudflare.com/turnstile/reference/content-security-policy/
 * - style-src 'unsafe-inline': レイアウト調整・アンケート結果バーの動的な幅指定に
 *   style 属性を多用しているため許可(インライン <style> / <script> は不使用。
 *   escapeHtml 済みテキストのみ描画するため style 属性経由の注入経路はない)
 * - img-src blob:: 添付画像の投稿前プレビュー(URL.createObjectURL)用
 * - connect-src 'self': 同一オリジンの API / WebSocket(wss は 'self' に含まれる)
 */
export const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorJson(error: string, status: number): Response {
  return json({ error }, status);
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
