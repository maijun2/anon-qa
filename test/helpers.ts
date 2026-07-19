import { SELF, fetchMock } from "cloudflare:test";

export const BASE = "https://example.com";
export const ADMIN_PASSWORD = "test-admin-password";

/**
 * Turnstile siteverify をモックする。トークンに "bad" を含む場合のみ失敗を返す。
 * 各テストファイルの beforeAll で呼ぶこと。
 */
export function mockTurnstile(): void {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://challenges.cloudflare.com")
    .intercept({ method: "POST", path: "/turnstile/v0/siteverify" })
    .reply(200, (opts) => {
      const body = typeof opts.body === "string" ? opts.body : "";
      return JSON.stringify({ success: !body.includes("bad") });
    }, { headers: { "Content-Type": "application/json" } })
    .persist();
}

export async function adminLogin(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0];
}

export async function createSession(
  cookie: string,
  courseName = "テスト研修",
  templateId?: string,
): Promise<{ id: string; code: string }> {
  const res = await SELF.fetch(`${BASE}/api/admin/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ courseName, heldOn: "2026-07-19", templateId }),
  });
  if (res.status !== 201) throw new Error(`create session failed: ${res.status}`);
  const data = (await res.json()) as { session: { id: string; code: string } };
  return data.session;
}

export interface ParticipantContext {
  code: string;
  entryToken: string;
  anonToken: string;
}

export async function enter(code: string): Promise<ParticipantContext> {
  const res = await SELF.fetch(`${BASE}/api/enter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, turnstileToken: "ok-token" }),
  });
  if (res.status !== 200) throw new Error(`enter failed: ${res.status}`);
  const data = (await res.json()) as { entryToken: string };
  return { code, entryToken: data.entryToken, anonToken: crypto.randomUUID() };
}

export function participantHeaders(ctx: ParticipantContext): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Entry-Token": ctx.entryToken,
    "X-Anon-Token": ctx.anonToken,
  };
}

export async function postQuestion(
  ctx: ParticipantContext,
  body = "テスト質問です",
): Promise<{ id: string }> {
  const res = await SELF.fetch(`${BASE}/api/s/${ctx.code}/questions`, {
    method: "POST",
    headers: participantHeaders(ctx),
    body: JSON.stringify({ body }),
  });
  if (res.status !== 201) throw new Error(`post question failed: ${res.status}`);
  const data = (await res.json()) as { question: { id: string } };
  return data.question;
}
