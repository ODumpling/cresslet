// Server API. Runs in a sandbox on Cresslet; handles requests matching `routes` in cresslet.json.
// Web-standard APIs only (fetch, Request, Response, URL, crypto). No Node/Deno filesystem.
import { app, db } from "cresslet";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`;

let ready: Promise<void> | undefined;

export default {
  async fetch(req: Request): Promise<Response> {
    await (ready ??= db.exec(SCHEMA));
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/api\/todos(?:\/(\d+))?$/);

    if (url.pathname === "/api/health") return Response.json({ ok: true, app: app.name });

    if (m && !m[1]) {
      if (req.method === "GET") {
        return Response.json(await db.sql`SELECT * FROM todos ORDER BY id DESC`);
      }
      if (req.method === "POST") {
        const { text } = await req.json<{ text?: string }>();
        if (!text?.trim()) return Response.json({ error: "text required" }, { status: 400 });
        const row = await db.first<{ id: number }>(
          db.sql`INSERT INTO todos (text, created_at) VALUES (${text.trim().slice(0, 500)}, ${Date.now()}) RETURNING id`,
        );
        return Response.json({ id: row!.id }, { status: 201 });
      }
    }

    if (m && m[1]) {
      const id = Number(m[1]);
      if (req.method === "PATCH") {
        const { done } = await req.json<{ done?: boolean }>();
        await db.run(db.sql`UPDATE todos SET done = ${done ? 1 : 0} WHERE id = ${id}`);
        return Response.json({ ok: true });
      }
      if (req.method === "DELETE") {
        await db.run(db.sql`DELETE FROM todos WHERE id = ${id}`);
        return Response.json({ ok: true });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
