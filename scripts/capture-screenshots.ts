/**
 * README 用スクリーンショットの撮影スクリプト。
 *
 * 前提:
 *   - `npm run dev` を別ターミナルで起動しておくこと(既定 http://localhost:8787)
 *   - 初回のみ `npx playwright install chromium` でブラウザを取得しておくこと
 *     (CI の `npm ci` ではブラウザバイナリを自動ダウンロードしない設定にしているため、
 *      ローカルでの撮影時は手動インストールが必要)
 *
 * 実行: npm run capture-screenshots
 *
 * wrangler.jsonc の TURNSTILE_SITE_KEY は本番ドメイン(qa.maijun.net)専用の実キーで、
 * localhost では正しくウィジェットが描画されない。サーバ側検証(.dev.vars の
 * TURNSTILE_SECRET_KEY)は Cloudflare 公式のテスト用シークレットで送信トークンの
 * 中身を問わないため、ここではクライアント側の challenges.cloudflare.com スクリプトを
 * インターセプトして簡易スタブに差し替え、ネットワーク・ドメインに依存せず
 * 再現性のある撮影を行う。
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import sharp from "sharp";

const BASE_URL = process.env.CAPTURE_BASE_URL ?? "http://localhost:8787";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-admin-password";
const OUT_DIR = path.resolve(import.meta.dirname, "../docs/images");
const MAX_BYTES = 1024 * 1024;

// AWS/OCI 研修の質疑を想定したダミーデータ(実在の受講者情報は含まない)
const SAMPLE_QUESTIONS: { body: string; votes: number; answer: string | null }[] = [
  {
    body: "S3 のバケットポリシーと IAM ポリシーが競合した場合、評価の優先順位はどちらが高いのでしょうか?",
    votes: 5,
    answer:
      "明示的な Deny が最優先です。次に SCP・リソースポリシー・IAM ポリシーの許可をすべて掛け合わせて評価します。",
  },
  {
    body: "OCI の Compartment は AWS の Organization と同じ考え方で捉えて良いですか?",
    votes: 2,
    answer: null,
  },
  {
    body: "セキュリティグループとネットワーク ACL を両方設定する意味はありますか?片方で十分な気がしています。",
    votes: 3,
    answer:
      "セキュリティグループはステートフルでインスタンス単位、ネットワーク ACL はステートレスでサブネット単位です。多層防御として両方設定するのが推奨です。",
  },
];

/** Turnstile ウィジェットのスクリプトを常に成功する簡易スタブに差し替える */
async function stubTurnstile(context: BrowserContext): Promise<void> {
  await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        window.turnstile = {
          render(container) {
            const el = typeof container === "string" ? document.querySelector(container) : container;
            if (el) {
              el.innerHTML =
                '<div style="display:inline-flex;align-items:center;gap:8px;padding:10px 14px;' +
                'border:1px solid #d4d4d8;border-radius:4px;background:#fafafa;' +
                'font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#3f3f46;">' +
                '<span style="color:#16a34a;font-weight:700;">&#10003;</span> 確認済みです</div>';
            }
            return "stub-widget";
          },
          getResponse() { return "stub-token"; },
          reset() {},
        };
      `,
    }),
  );
}

async function adminLogin(context: BrowserContext): Promise<void> {
  const res = await context.request.post(`${BASE_URL}/api/admin/login`, {
    data: { password: ADMIN_PASSWORD },
  });
  if (!res.ok()) throw new Error(`admin login failed: ${res.status()} ${await res.text()}`);
}

async function createSampleSession(context: BrowserContext): Promise<{ id: string; code: string }> {
  const res = await context.request.post(`${BASE_URL}/api/admin/sessions`, {
    data: { courseName: "AWS/OCI 基礎研修", heldOn: new Date().toISOString().slice(0, 10) },
  });
  if (!res.ok()) throw new Error(`create session failed: ${res.status()} ${await res.text()}`);
  const { session } = (await res.json()) as { session: { id: string; code: string } };
  return session;
}

async function enterAsParticipant(context: BrowserContext, code: string): Promise<string> {
  const res = await context.request.post(`${BASE_URL}/api/enter`, {
    data: { code, turnstileToken: "stub-token" },
  });
  if (!res.ok()) throw new Error(`enter failed: ${res.status()} ${await res.text()}`);
  const { entryToken } = (await res.json()) as { entryToken: string };
  return entryToken;
}

async function postQuestion(
  context: BrowserContext,
  code: string,
  entryToken: string,
  body: string,
): Promise<string> {
  const res = await context.request.post(`${BASE_URL}/api/s/${code}/questions`, {
    headers: { "X-Entry-Token": entryToken, "X-Anon-Token": randomUUID() },
    data: { body },
  });
  if (!res.ok()) throw new Error(`post question failed: ${res.status()} ${await res.text()}`);
  const { question } = (await res.json()) as { question: { id: string } };
  return question.id;
}

/** 1 票ごとに別の匿名トークンを使い、複数参加者からの投票を模した状態にする */
async function voteQuestion(context: BrowserContext, code: string, entryToken: string, questionId: string): Promise<void> {
  const res = await context.request.put(`${BASE_URL}/api/s/${code}/questions/${questionId}/vote`, {
    headers: { "X-Entry-Token": entryToken, "X-Anon-Token": randomUUID() },
  });
  if (!res.ok()) throw new Error(`vote failed: ${res.status()} ${await res.text()}`);
}

async function postAnswer(context: BrowserContext, sessionId: string, questionId: string, body: string): Promise<void> {
  const res = await context.request.post(
    `${BASE_URL}/api/admin/sessions/${sessionId}/questions/${questionId}/answers`,
    { data: { body } },
  );
  if (!res.ok()) throw new Error(`post answer failed: ${res.status()} ${await res.text()}`);
}

/** PNG を最大圧縮で再エンコードし、1MB を超える場合はパレット化も試みてから保存する */
async function savePng(fileName: string, buffer: Buffer): Promise<void> {
  let out = await sharp(buffer).png({ compressionLevel: 9 }).toBuffer();
  if (out.byteLength > MAX_BYTES) {
    out = await sharp(buffer).png({ compressionLevel: 9, palette: true }).toBuffer();
  }
  const filePath = path.join(OUT_DIR, fileName);
  await writeFile(filePath, out);
  const { size } = await stat(filePath);
  const sizeLabel = `${(size / 1024).toFixed(0)}KB`;
  if (size > MAX_BYTES) {
    console.warn(`[capture-screenshots] ${fileName} は ${sizeLabel} で 1MB を超えています`);
  } else {
    console.log(`[capture-screenshots] saved ${fileName} (${sizeLabel})`);
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await stubTurnstile(context);
  const page = await context.newPage();

  await adminLogin(context);
  const session = await createSampleSession(context);

  const entryToken = await enterAsParticipant(context, session.code);
  for (const q of SAMPLE_QUESTIONS) {
    const questionId = await postQuestion(context, session.code, entryToken, q.body);
    for (let i = 0; i < q.votes; i++) {
      await voteQuestion(context, session.code, entryToken, questionId);
    }
    if (q.answer) await postAnswer(context, session.id, questionId, q.answer);
  }

  // 1. 参加者: 入室ページ(コード欄が事前入力された状態)
  await page.goto(`${BASE_URL}/?code=${session.code}`);
  await page.waitForSelector("#turnstile-widget div");
  await savePng("participant-enter.png", await page.screenshot());

  // 2. 参加者: 質問一覧(実際の UI 操作の代わりに localStorage へ entryToken を事前注入する)
  // session.js は読み込み直後に質問一覧を fetch し、トークンがないと 401 で `/` へ
  // リダイレクトしてしまう。goto 後に evaluate で書き込むと間に合わないため、
  // addInitScript でナビゲーション前(= session.js 実行前)に注入する。
  await context.addInitScript(
    ({ code, token, anon }) => {
      localStorage.setItem(`anonqa:entry:${code}`, token);
      localStorage.setItem("anonqa:anon", anon);
    },
    { code: session.code, token: entryToken, anon: randomUUID() },
  );
  await page.goto(`${BASE_URL}/s/${session.code}`);
  await page.waitForSelector(".question-card");
  await savePng("participant-questions.png", await page.screenshot());

  // 3. 講師: セッション管理画面
  await page.goto(`${BASE_URL}/admin/s/${session.id}`);
  await page.waitForSelector(".question-card");
  await savePng("admin-session.png", await page.screenshot());

  // 4. 講師: 投影モード(既定は未回答のみ表示のため、回答済みも含めて全件見せる)
  await page.goto(`${BASE_URL}/admin/s/${session.id}/present`);
  await page.waitForSelector(".question-card");
  await page.check("#show-answered");
  await page.waitForFunction(() => document.querySelectorAll(".question-card").length >= 3);
  await savePng("admin-present.png", await page.screenshot());

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
