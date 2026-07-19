#!/usr/bin/env bash
set -euo pipefail

# Cloudflare リソース作成 + シークレット登録
# 冪等: 何度実行しても安全。作成済みリソース・登録済みシークレットはスキップする
# 前提:
#   * CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN を環境変数に設定(未設定なら即エラー終了)

cd "$(dirname "$0")/.."

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "ERROR: CLOUDFLARE_ACCOUNT_ID が未設定です。" >&2
  echo "  export CLOUDFLARE_ACCOUNT_ID=<アカウント ID> を実行してから再実行してください。" >&2
  echo "  (アカウント ID はダッシュボード右側の Account ID、または \`npx wrangler whoami\` で確認)" >&2
  exit 1
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN が未設定です。" >&2
  echo "  export CLOUDFLARE_API_TOKEN=<API トークン> を実行してから再実行してください。" >&2
  exit 1
fi

DB_NAME="anon-qa-db"
BUCKET_NAME="anon-qa-images"
TURNSTILE_WIDGET_NAME="anon-qa"

# デプロイ済み worker のシークレット一覧(worker 未作成の初回実行時は空扱い)
EXISTING_SECRETS=$(npx wrangler secret list 2>/dev/null || echo '[]')
secret_exists() {
  printf '%s' "$EXISTING_SECRETS" | python3 -c "
import json, sys
sys.exit(0 if any(s['name'] == '$1' for s in json.load(sys.stdin)) else 1)
"
}

echo "== 1/4 D1 database =="
if npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  echo "スキップ(作成済み): $DB_NAME"
else
  npx wrangler d1 create "$DB_NAME"
  echo ""
  echo "↑ 出力された database_id を wrangler.jsonc の d1_databases[0].database_id に設定してください"
fi

echo ""
echo "== 2/4 R2 bucket =="
if npx wrangler r2 bucket info "$BUCKET_NAME" >/dev/null 2>&1; then
  echo "スキップ(作成済み): $BUCKET_NAME"
else
  npx wrangler r2 bucket create "$BUCKET_NAME"
  echo "作成しました: $BUCKET_NAME"
fi

echo ""
echo "== 3/4 Turnstile widget =="
WIDGETS=$(curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/challenges/widgets" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
EXISTING_SITE_KEY=$(printf '%s' "$WIDGETS" | python3 -c "
import json, sys
hits = [w['sitekey'] for w in (json.load(sys.stdin).get('result') or []) if w['name'] == '${TURNSTILE_WIDGET_NAME}']
print(hits[0] if hits else '')
")
if [[ -n "$EXISTING_SITE_KEY" ]]; then
  echo "スキップ(作成済み): widget '${TURNSTILE_WIDGET_NAME}' (site key: ${EXISTING_SITE_KEY})"
else
  read -rp "Turnstile を有効にするドメイン (例: qa.maijun.net): " TURNSTILE_DOMAIN
  RESPONSE=$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/challenges/widgets" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"${TURNSTILE_WIDGET_NAME}\",\"domains\":[\"${TURNSTILE_DOMAIN}\"],\"mode\":\"managed\"}")
  SITE_KEY=$(printf '%s' "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['sitekey'])")
  SECRET_KEY=$(printf '%s' "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['secret'])")
  echo "site key: $SITE_KEY"
  echo "→ wrangler.jsonc の vars.TURNSTILE_SITE_KEY に設定してください"
  # widget を新規作成した場合は既存シークレットの有無に関わらず新しい secret で上書きする
  printf '%s' "$SECRET_KEY" | npx wrangler secret put TURNSTILE_SECRET_KEY
fi

echo ""
echo "== 4/4 Secrets =="
if secret_exists ADMIN_PASSWORD; then
  echo "スキップ(登録済み): ADMIN_PASSWORD"
else
  read -rsp "admin パスワードを入力: " ADMIN_PW
  echo ""
  printf '%s' "$ADMIN_PW" | npx wrangler secret put ADMIN_PASSWORD
fi
if secret_exists APP_SECRET; then
  # 再生成するとトークンハッシュ・セッション Cookie が全て無効になるため必ずスキップ
  echo "スキップ(登録済み): APP_SECRET"
else
  openssl rand -hex 32 | npx wrangler secret put APP_SECRET
fi

echo ""
echo "== 完了 =="
echo "残りの手作業(未実施のもののみ):"
echo "  1. wrangler.jsonc の database_id / TURNSTILE_SITE_KEY を更新して commit"
echo "  2. GitHub Secrets に CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を登録"
echo "  3. main へ push → GitHub Actions が migrations apply + deploy を実行"
