// drizzle-kit (`npm run db:generate`): reads the schema, writes migrations into drizzle/. `driver: "durable-sqlite"`
// makes it write drizzle/migrations.js too, which src/server/db.server.ts imports (cresslet/drizzle's migrate).
import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "sqlite", driver: "durable-sqlite", schema: "./src/server/schema.ts", out: "./drizzle" });
