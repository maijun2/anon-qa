import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    // cloudflare:test の env は Cloudflare.Env 型(workers-types v5)。
    // declaration merging でアプリの Env とテスト用 binding を注入する
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
