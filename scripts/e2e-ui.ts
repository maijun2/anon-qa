/**
 * 講師 2 ペイン UI の E2E 検証(UI 改善の検収項目):
 *   1. 右ペイン sticky — 長い一覧を最下部までスクロールしても詳細カードが画面内に固定される。
 *      左右見出し・白枠の上端が同一ベースラインに揃っていることも併せて検証する
 *   2. 回答送信 — 2 ペイン UI の「回答する」ボタン経由で回答が投稿・反映される
 *
 * 前提:
 *   - `npm run dev` を別ターミナルで起動しておくこと(既定 http://localhost:8787)
 *   - 初回のみ `npx playwright install chromium` でブラウザを取得しておくこと
 *
 * 実行: npm run e2e:ui (すべて PASS なら exit 0)
 */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8787";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-admin-password";
const QUESTION_COUNT = 30;

let failed = false;
function check(name: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!cond) failed = true;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // 準備: admin ログイン → セッション作成 → 参加者として質問を大量投稿(一覧を画面より長くする)
  const login = await context.request.post(`${BASE_URL}/api/admin/login`, {
    data: { password: ADMIN_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()}`);
  const { session } = (await (
    await context.request.post(`${BASE_URL}/api/admin/sessions`, {
      data: { courseName: "E2E 2ペイン検証", heldOn: new Date().toISOString().slice(0, 10) },
    })
  ).json()) as { session: { id: string; code: string } };
  const { entryToken } = (await (
    await context.request.post(`${BASE_URL}/api/enter`, {
      data: { code: session.code, turnstileToken: "e2e-token" },
    })
  ).json()) as { entryToken: string };
  for (let i = 0; i < QUESTION_COUNT; i++) {
    // rate limit(IP + 匿名トークンハッシュの複合キー)を避けるためトークンを分ける
    const res = await context.request.post(`${BASE_URL}/api/s/${session.code}/questions`, {
      headers: { "X-Entry-Token": entryToken, "X-Anon-Token": randomUUID() },
      data: { body: `E2E 検証用の質問 ${i} - 本文はある程度の長さを持たせて 2 行クランプの確認にも使う。` },
    });
    if (!res.ok()) throw new Error(`post question ${i} failed: ${res.status()}`);
  }

  const page = await context.newPage();
  await page.goto(`${BASE_URL}/admin/s/${session.id}`);
  await page.waitForSelector(".qitem");

  // ---------- 1. 左右の上端揃え + 右ペイン sticky ----------
  const [headL, headR] = await page
    .locator(".pane-heading")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  check("左右見出しの上端が同一ベースライン", Math.abs(headL - headR) < 1, `diff=${Math.abs(headL - headR).toFixed(2)}px`);

  await page.click(".qitem");
  await page.waitForSelector("#question-detail .question-body");
  const listTop = await page.locator("#question-list").evaluate((e) => e.getBoundingClientRect().top);
  const detailTop = await page.locator("#question-detail").evaluate((e) => e.getBoundingClientRect().top);
  check("左右白枠の上端が同一ベースライン", Math.abs(listTop - detailTop) < 1, `diff=${Math.abs(listTop - detailTop).toFixed(2)}px`);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  // ビューポート交差を厳密に判定する(isVisible は画面外でも true を返すため使わない)
  const sticky = await page.locator("#question-detail").evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { top: r.top, inView: r.top >= 0 && r.top < window.innerHeight && r.bottom > 0 };
  });
  check("最下部スクロール後も右ペインが画面内に固定", sticky.inView, `top=${sticky.top.toFixed(0)}px`);
  await page.evaluate(() => window.scrollTo(0, 0));

  // ---------- 2. 2 ペイン UI からの回答送信 ----------
  const openBefore = Number(await page.textContent("#count-open"));
  const itemsBefore = await page.locator(".qitem").count();
  await page.fill("#question-detail .answer-input", "E2E からの講師回答です");
  await page.click('#question-detail [data-action="submit-answer"]');

  await page.waitForSelector("#question-detail .answers .answer", { timeout: 5000 });
  const answerText = await page.textContent("#question-detail .answers");
  check("回答が右ペインのスレッドに表示", answerText?.includes("E2E からの講師回答です") === true);
  check("回答者ラベルが「講師」", answerText?.includes("講師") === true);
  // 回答送信後に入力欄がクリアされる(renderDetail の下書き退避で送信済みテキストが残らない)
  check("回答送信後に入力欄が空になる", (await page.inputValue("#question-detail .answer-input")) === "");
  check(
    "質問が回答済みバッジに変わる",
    (await page.locator("#question-detail .badge-answered").count()) === 1,
  );
  await page.waitForFunction(
    (expected) => document.getElementById("count-open")?.textContent === String(expected),
    openBefore - 1,
    { timeout: 5000 },
  );
  check("未回答カウントが 1 減る", true, `${openBefore} → ${openBefore - 1}`);
  check("回答済みカウントが 1 になる", (await page.textContent("#count-done"))?.trim() === "1");
  check(
    "未回答フィルタの一覧から対象が消える",
    (await page.locator(".qitem").count()) === itemsBefore - 1,
  );

  await browser.close();
  console.log(failed ? "\n=== FAILED ===" : "\n=== ALL PASS ===");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
