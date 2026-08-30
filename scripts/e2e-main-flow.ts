/**
 * 主要導線の E2E(Low-6):
 *   入室 → 質問投稿 → 投票 → 講師回答 → 投影モードへの反映
 *
 * 前提:
 *   - `npm run dev` を別ターミナルで起動しておくこと(既定 http://localhost:8787)
 *   - 初回のみ `npx playwright install chromium` でブラウザを取得しておくこと
 *
 * 実行: npm run e2e:main (すべて PASS なら exit 0)
 */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8787";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-admin-password";

let failed = false;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!cond) failed = true;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // ---------- 準備: 講師ログイン → セッション作成 → 参加者入室(API) ----------
  const login = await context.request.post(`${BASE_URL}/api/admin/login`, {
    data: { password: ADMIN_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()}`);

  const { session } = (await (
    await context.request.post(`${BASE_URL}/api/admin/sessions`, {
      data: { courseName: "E2E 主要導線検証", heldOn: new Date().toISOString().slice(0, 10) },
    })
  ).json()) as { session: { id: string; code: string } };

  const { entryToken } = (await (
    await context.request.post(`${BASE_URL}/api/enter`, {
      data: { code: session.code, turnstileToken: "e2e-token" },
    })
  ).json()) as { entryToken: string };
  const anonToken = randomUUID();

  // 参加者ページは entryToken/anonToken を localStorage(common.js のキー)から読むため、
  // 同一オリジンのページを一度開いてから注入する
  const page = await context.newPage();
  await page.goto(BASE_URL);
  await page.evaluate(
    ({ code, entryToken, anonToken }) => {
      localStorage.setItem("anonqa:anon", anonToken);
      localStorage.setItem(`anonqa:entry:${code}`, entryToken);
    },
    { code: session.code, entryToken, anonToken },
  );

  // ---------- 1. 参加者: 質問投稿 ----------
  await page.goto(`${BASE_URL}/s/${session.code}`);
  await page.waitForSelector("#question-form");
  await page.fill("#question-input", "E2E からの質問です");
  await page.click("#question-submit");
  await page.waitForSelector(".question-card");
  check(
    "質問が一覧に表示される",
    (await page.locator(".question-card .question-body").first().textContent())?.includes(
      "E2E からの質問です",
    ) === true,
  );

  // ---------- 2. 参加者: 投票 ----------
  await page.click('.question-card [data-action="vote"]');
  await page.waitForFunction(
    () => document.querySelector(".question-card .vote-count")?.textContent?.trim() === "1",
  );
  check(
    "投票後にカウントが1になる",
    (await page.locator(".question-card .vote-count").first().textContent())?.trim() === "1",
  );

  // ---------- 3. 講師: 2ペイン UI から回答 ----------
  await page.goto(`${BASE_URL}/admin/s/${session.id}`);
  await page.waitForSelector(".qitem");
  await page.click(".qitem");
  await page.waitForSelector("#question-detail .answer-input");
  await page.fill("#question-detail .answer-input", "E2E からの講師回答です");
  await page.click('#question-detail [data-action="submit-answer"]');
  await page.waitForSelector("#question-detail .badge-answered", { timeout: 5000 });
  check("講師回答後に回答済みバッジが付く", true);

  // ---------- 4. 投影モード: 回答済み・投票数の反映 ----------
  await page.goto(`${BASE_URL}/admin/s/${session.id}/present`);
  await page.waitForSelector("#show-answered");
  await page.check("#show-answered");
  await page.waitForSelector(".question-card.answered");
  const presentCard = page.locator(".question-card.answered").first();
  check("投影モードで回答済みバッジが表示される", (await presentCard.locator(".badge-answered").count()) === 1);
  check(
    "投影モードで投票数が反映される",
    (await presentCard.locator(".vote-display").textContent())?.includes("1") === true,
  );

  await browser.close();
  console.log(failed ? "\n=== FAILED ===" : "\n=== ALL PASS ===");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
