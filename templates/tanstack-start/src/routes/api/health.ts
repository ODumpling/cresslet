// A server route: plain Request → Response handlers, no page. GET /api/health
import { createFileRoute } from "@tanstack/react-router";
import { app, db } from "cresslet";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const row = await db.first(db.sql<{ v: string }>`SELECT sqlite_version() AS v`);
        return Response.json({ ok: true, app: app.name, deploy: app.deployId, sqlite: row?.v });
      },
    },
  },
});
