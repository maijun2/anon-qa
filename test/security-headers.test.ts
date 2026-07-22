// HTML ページの CSP 担保:
//   * 全 HTML ルート(静的配信 / worker 経由の両方)に enforce の CSP が付くこと
//   * Turnstile(script-src / frame-src)・WebSocket(connect-src 'self')・
//     画像表示(img-src 'self')が CSP で許可されていること
//   * HTML に src なしのインライン <script> が存在しないこと(script-src 'self' で
//     ブロックされ、ページが機能しなくなるため)
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HTML_CSP } from "../src/http";
import { BASE } from "./helpers";

// 静的配信(_headers)と worker 経由(withSecurityHeaders)の両系統を含める
const HTML_PATHS = [
  "/",
  "/s/TESTCODE",
  "/admin",
  "/admin/dashboard",
  "/admin/s/some-id",
  "/admin/s/some-id/present",
];

describe("セキュリティヘッダ(CSP)", () => {
  it("全 HTML ページに enforce の CSP が付与される", async () => {
    for (const path of HTML_PATHS) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toContain("text/html");
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp, path).toBe(HTML_CSP);
      // Report-Only のまま残っていないこと(enforce へ切り替え済み)
      expect(res.headers.get("Content-Security-Policy-Report-Only"), path).toBeNull();
    }
  });

  it("CSP が Turnstile・WebSocket・画像表示を許可している", () => {
    // Turnstile: https://developers.cloudflare.com/turnstile/reference/content-security-policy/
    expect(HTML_CSP).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(HTML_CSP).toContain("frame-src https://challenges.cloudflare.com");
    // WebSocket(同一オリジンの wss は 'self' に含まれる)と API fetch
    expect(HTML_CSP).toContain("connect-src 'self'");
    // 添付画像(/api/s/:code/images/:key)と投稿前プレビュー(blob:)
    expect(HTML_CSP).toContain("img-src 'self' data: blob:");
  });

  it("HTML に src なしのインライン <script> が存在しない", async () => {
    for (const path of HTML_PATHS) {
      const html = await (await SELF.fetch(`${BASE}${path}`)).text();
      const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
      expect(scripts.length, `${path} に <script> がない`).toBeGreaterThan(0);
      for (const tag of scripts) {
        expect(tag, `${path} のインライン script`).toMatch(/\bsrc=/);
      }
    }
  });

  it("API(JSON)レスポンスには HTML 用 CSP を付けない", async () => {
    const res = await SELF.fetch(`${BASE}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
