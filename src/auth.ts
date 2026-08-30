import type { Env, SessionRow } from "./types";
import { SESSION_TTL_MS } from "./types";

const encoder = new TextEncoder();
const ADMIN_COOKIE = "admin_session";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

function b64urlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): string {
  const bin = atob(input.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return toHex(new Uint8Array(sig));
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

export async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyToken<T extends { exp?: number }>(token: string, secret: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!timingSafeEqualStr(sig, await hmacHex(secret, body))) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as T;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Turnstile 検証済みの参加者に発行する入室トークン。セッションの保持期限まで有効 */
export function issueEntryToken(env: Env, session: SessionRow): Promise<string> {
  return signToken({ c: session.code, exp: session.created_at + SESSION_TTL_MS }, env.APP_SECRET);
}

export async function verifyEntry(env: Env, request: Request, code: string): Promise<boolean> {
  const token = request.headers.get("X-Entry-Token") ?? new URL(request.url).searchParams.get("token");
  if (!token) return false;
  const payload = await verifyToken<{ c: string; exp: number }>(token, env.APP_SECRET);
  return payload !== null && payload.c === code;
}

/** 匿名トークン(生値)はここでハッシュ化し、生値は保存・ログ出力しない */
export async function anonTokenHash(request: Request): Promise<string | null> {
  const raw = request.headers.get("X-Anon-Token");
  if (!raw || raw.length < 16 || raw.length > 128) return null;
  return sha256Hex(raw);
}

export async function issueAdminCookie(env: Env): Promise<string> {
  const token = await signToken({ a: 1, exp: Date.now() + ADMIN_SESSION_TTL_MS }, env.APP_SECRET);
  return `${ADMIN_COOKIE}=${token}; Path=/; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function verifyAdmin(env: Env, request: Request): Promise<boolean> {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (!match) return false;
  return (await verifyToken<{ a: number; exp: number }>(match[1], env.APP_SECRET)) !== null;
}

/** pending-questions API 用。外部サービス(KiroCrew 等)から Authorization: Bearer で呼ばれる想定 */
export function verifyPendingApiToken(env: Env, request: Request): boolean {
  if (!env.PENDING_API_TOKEN) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return timingSafeEqualStr(header.slice("Bearer ".length), env.PENDING_API_TOKEN);
}
