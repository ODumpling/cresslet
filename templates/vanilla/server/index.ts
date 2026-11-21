// Server API. Runs in a sandbox on Cresslet; handles requests matching `routes` in cresslet.json.
import { app, db } from "cresslet";

let ready: Promise<void> | undefined;

export default {
  async fetch(req: Request): Promise<Response> {
    await (ready ??= db.exec(
      "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    ));
    const url = new URL(req.url);

    if (url.pathname === "/api/health") return Response.json({ ok: true, app: app.name });

    if (url.pathname === "/api/visits") {
      if (req.method === "POST") {
        // one transaction: the count read back is this request's
        const [, read] = await db.batch([
          "INSERT INTO counters (name, n) VALUES ('visits', 1) ON CONFLICT (name) DO UPDATE SET n = n + 1",
          db.sql`SELECT n FROM counters WHERE name = ${"visits"}`,
        ]);
        return Response.json({ visits: read.rows[0]?.n ?? 0 });
      }
      const row = await db.first<{ n: number }>(db.sql`SELECT n FROM counters WHERE name = ${"visits"}`);
      return Response.json({ visits: row?.n ?? 0 });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
