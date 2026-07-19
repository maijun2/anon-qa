import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.resolve("migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // SQLite-backed DO と isolated storage の非互換を回避。
          // 各テストは毎回新規セッション(ランダムコード)を作るため共有ストレージで問題ない
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_PASSWORD: "test-admin-password",
              TURNSTILE_SECRET_KEY: "test-turnstile-secret",
              APP_SECRET: "test-app-secret"
            }
          }
        }
      }
    }
  };
});
