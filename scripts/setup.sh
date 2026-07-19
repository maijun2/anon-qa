#!/usr/bin/env bash
set -euo pipefail

# 初回のみ実行: Cloudflare リソース作成 + シークレット登録
# 前提:
#   * `npx wrangler login` 済み
#   * Turnstile widget を API で作る場合は CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN を環境変数に設定
#     (未設定の場合はダッシュボードでの手動作成手順を案内してスキップ)

cd "$(dirname "$0")/.."

DB_NAME="anon-qa-db"
BUCKET_NAME="anon-qa-images"

echo "== 1/4 D1 database =="
if npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  echo "既に存在します: $DB_NAME"
else
  npx wrangler d1 create "$DB_NAME"
  echo ""
  echo "↑ 出力された database_id を wrangler.jsonc の d1_databases[0].database_id に設定してください"
fi

echo ""
echo "== 2/4 R2 bucket =="
if npx wrangler r2 bucket create "$BUCKET_NAME" 2>/dev/null; then
  echo "作成しました: $BUCKET_NAME"
else
  echo "既に存在します(または作成済み): $BUCKET_NAME"
fi

echo ""
echo "== 3/4 Turnstile widget =="
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定のため API での作成をスキップします。"
  echo "ダッシュボード (Turnstile) で widget を作成し、"
  echo "  * site key   → wrangler.jsonc の vars.TURNSTILE_SITE_KEY"
  echo "  * secret key → echo '<secret>' | npx wrangler secret put TURNSTILE_SECRET_KEY"
  echo "を設定してください。"
else
  read -rp "Turnstile を有効にするドメイン (例: anon-qa.<account>.workers.dev): " TURNSTILE_DOMAIN
  RESPONSE=$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/challenges/widgets" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"anon-qa\",\"domains\":[\"${TURNSTILE_DOMAIN}\"],\"mode\":\"managed\"}")
  SITE_KEY=$(printf '%s' "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['sitekey'])")
  SECRET_KEY=$(printf '%s' "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['secret'])")
  echo "site key: $SITE_KEY"
  echo "→ wrangler.jsonc の vars.TURNSTILE_SITE_KEY に設定してください"
  printf '%s' "$SECRET_KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY
fi

echo ""
echo "== 4/4 Secrets =="
read -rsp "admin パスワードを入力: " ADMIN_PW
echo ""
printf '%s' "$ADMIN_PW" | npx wrangler secret put ADMIN_PASSWORD
openssl rand -hex 32 | npx wrangler secret put APP_SECRET

echo ""
echo "== 完了 =="
echo "残りの手作業:"
echo "  1. wrangler.jsonc の database_id / TURNSTILE_SITE_KEY を更新して commit"
echo "  2. GitHub Secrets に CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を登録"
echo "  3. main へ push → GitHub Actions が migrations apply + deploy を実行"
