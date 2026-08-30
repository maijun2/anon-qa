import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve("migrations"));
  return {
    plugins: [
      cloudflareTest({
        // v0.18: singleWorker / isolatedStorage オプションは廃止
        // (ストレージ分離はテストファイル単位に固定)
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_PASSWORD: "test-admin-password",
            TURNSTILE_SECRET_KEY: "test-turnstile-secret",
            APP_SECRET: "test-app-secret"
          }
        }
      })
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        // v8 プロバイダは workerd に node:inspector が無く非対応(pool 側が実行時にエラーで指示する)
        provider: "istanbul",
        reporter: ["text", "html"],
        reportsDirectory: "./coverage"
      }
    }
  };
});
