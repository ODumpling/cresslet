// Evaluated before the app's module (worker.ts imports it first): where the `cresslet` SDK
// (`import { db } from "cresslet"`, cresslet-cli sdk/index.js) finds the app's env. `env` stays null
// while the app's module evaluates and until the first request or cron run has loaded the bindings.
// contract 1: env published here, env.db.batch, "?" placeholders. 2: env.db.raw, `raw` batch statements (rows as
// arrays). Bump it with each addition the SDK
// relies on (docs/app-format.md); never remove what an earlier contract had.
export const runtime: { contract: number; runtime: string; paramStyle: string; env: unknown } = { contract: 2, runtime: "cresslet platform", paramStyle: "?", env: null };
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("cresslet.runtime")] = runtime;
