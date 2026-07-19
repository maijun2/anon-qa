# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際のガイドです。

## プロジェクト概要

トレーニング(研修)用の**完全匿名 Q&A アプリ**。Cloudflare 上で動作。
匿名質問(画像添付可)・いいね投票・講師回答・リアルタイムアンケート・参考情報共有・テンプレートを提供する。

詳細仕様は `requirements.md` を参照。**仕様判断に迷ったら必ず requirements.md を正とする。**

## 技術スタック

- **Runtime**: Cloudflare Workers(Worker 単体構成、Workers Static Assets で静的配信 + API を統合)
- **リアルタイム**: Durable Objects + WebSocket(Hibernation API を使用)
- **DB**: D1(マイグレーションは `migrations/` の連番 SQL で管理)
- **ストレージ**: R2(添付画像、最大 5MB/枚)
- **スパム対策**: Turnstile(入室時に 1 回検証)
- **言語**: TypeScript
- **フロントエンド**: Vanilla JS + HTML(`public/`、ビルドツールなしのシンプル構成)
- **IaC**: wrangler.jsonc に全 binding を宣言。初回リソース作成は `scripts/setup.sh`
- **CI/CD**: GitHub Actions(`main` push で migrations apply → deploy)

## ディレクトリ構成

```
├── wrangler.jsonc          # IaC 本体(bindings, DO, cron, assets)
├── src/
│   ├── index.ts            # Worker エントリ(ルーティング + API)
│   ├── session-do.ts       # Durable Object(セッション単位の WebSocket hub)
│   └── ...
├── public/                 # 静的アセット(参加者ページ / admin ページ)
├── migrations/             # D1 スキーマ(0001_init.sql, ...)
├── scripts/setup.sh        # 初回のみ: D1/R2/Turnstile 作成 + secret 登録
└── .github/workflows/deploy.yml
```

## コマンド

```bash
npm run dev          # wrangler dev(ローカル開発、D1/R2 はローカルエミュレーション)
npm test             # テスト実行(vitest + @cloudflare/vitest-pool-workers)
npm run deploy       # wrangler deploy(通常は CI 経由。手動デプロイは緊急時のみ)
npx wrangler d1 migrations apply anon-qa-db --local   # ローカル DB にマイグレーション適用
```

## 絶対に守るルール(匿名性・セキュリティ)

1. **IP アドレス・User-Agent を DB に保存しない。** ログにも残さない。rate limit 用の IP はメモリ/DO 内カウンタのみで永続化禁止
2. **ブラウザトークンは個人と紐付けない。** `crypto.randomUUID()` を localStorage に保持し、D1 にはハッシュ値のみ保存(本人の投稿編集/削除判定と投票重複防止のみに使用)
3. **シークレットをコードや wrangler.jsonc に書かない。** `wrangler secret put` を使用(ADMIN_PASSWORD, TURNSTILE_SECRET_KEY)
4. **画像アップロードはサーバ側でも検証する。** Content-Type(image/* のみ)と 5MB 制限をフロント・Worker の両方で実施
5. **admin API は全エンドポイントで認証チェック。** セッション Cookie(HttpOnly, Secure, SameSite=Strict)

## 実装規約

- API は REST(`/api/...`)。WebSocket は `/api/ws/:code` で Durable Object へ転送
- D1 スキーマ変更は必ず新規マイグレーションファイルを追加(既存ファイルは変更しない)
- WebSocket のブロードキャストメッセージは `{ type: string, payload: object }` 形式で統一
- エラーレスポンスは `{ error: string }` + 適切な HTTP ステータス
- 日時は UTC で保存、表示時に JST 変換
- 外部 npm 依存は最小限(Cloudflare 公式ライブラリ以外は導入前に要相談)
- UI 文言は日本語

## デザイン規約(詳細は requirements.md §8)

- レスポンシブ(モバイルファースト、ブレークポイント 768px)。参加者ページはスマホ優先、admin は PC 前提
- 白基調 + アクセントカラー 1 色。色は CSS カスタムプロパティで一元管理
- システムフォントのみ(Web フォント不使用)。モダンブラウザのみ対応(Polyfill 不要)
- 投影モード(`/admin/s/:id/present`)は大文字・高コントラストの専用ビュー
- 回答済み等の状態は色 + ラベルで表現(色のみに依存しない)
- WebSocket 切断時は自動再接続、操作は楽観的 UI 更新 + 失敗時ロールバック

## テスト方針

- Worker API は vitest(`@cloudflare/vitest-pool-workers`)でユニットテスト
- 特に匿名性ルール(IP 非保存、トークンハッシュ化)はテストで担保する
- マイグレーション適用後のスキーマ整合性を CI で検証

## デプロイフロー

1. PR 作成 → CI で lint + test
2. `main` にマージ → GitHub Actions が migrations apply → wrangler deploy
3. 手動デプロイは原則禁止(緊急時のみ `npm run deploy`)
