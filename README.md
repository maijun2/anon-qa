# anon-qa

トレーニング(研修)用の完全匿名 Q&A アプリ。Cloudflare Workers 単体構成(Workers Static Assets + D1 + R2 + Durable Objects + Turnstile + Cron Triggers)。

- 匿名質問(画像添付可)・いいね投票・自分の質問の編集/削除
- 講師回答・回答済み管理・リアルタイムアンケート・参考情報共有・テンプレート
- セッションは作成から 30 日で自動削除(D1 + R2)
- 仕様の詳細は [requirements.md](requirements.md) を参照

## 開発

```bash
npm install
npx wrangler d1 migrations apply anon-qa-db --local   # ローカル DB にスキーマ適用
npm run dev                                           # http://localhost:8787
```

- ローカルでは Turnstile はテストキー(常に成功)で動作します
- ローカルの admin パスワード等は `.dev.vars` で設定します(`.dev.vars.example` 参照)

```bash
npm run lint   # 型チェック (tsc --noEmit)
npm test       # vitest (@cloudflare/vitest-pool-workers)
```

## 初回セットアップ(本番)

1. Cloudflare アカウントで `npx wrangler login`
2. `bash scripts/setup.sh`
   - D1 database / R2 bucket / Turnstile widget を作成
   - `ADMIN_PASSWORD` / `TURNSTILE_SECRET_KEY` / `APP_SECRET` を secret 登録
3. 出力された `database_id` と Turnstile site key を `wrangler.jsonc` に反映して commit
4. GitHub リポジトリの Secrets に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を登録
5. `main` へ push → GitHub Actions が D1 migrations apply → `wrangler deploy` を実行

以降の変更はすべて git push のみで反映されます。手動デプロイは緊急時のみ `npm run deploy`。

## 画面

| パス | 内容 |
|---|---|
| `/` | 入室(アクセスコード + Turnstile) |
| `/s/:code` | 参加者ページ(質問 / 参考情報 / アンケート) |
| `/admin` | 講師ログイン |
| `/admin/dashboard` | セッション / テンプレート管理 |
| `/admin/s/:id` | セッション管理(質問 / 参考情報 / アンケート配信) |
| `/admin/s/:id/present` | 投影モード(大画面表示) |

## 匿名性について

- IP アドレス・User-Agent は DB にもログにも保存しない(rate limit は DO メモリ内カウンタのみ)
- ブラウザトークン(`crypto.randomUUID()`)は SHA-256 ハッシュのみ D1 に保存し、本人の投稿編集/削除判定と投票重複防止のみに使用
- 講師を含め誰も質問者を特定できない(トークンハッシュは API レスポンスに含めない)
- これらはテスト(`test/anonymity.test.ts`)で担保している
