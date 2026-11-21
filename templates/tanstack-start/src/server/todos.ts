// Todo server functions: every one runs as the signed-in user (`authed` middleware) and only touches their rows.
import { createServerFn } from "@tanstack/react-start";
import { db } from "cresslet";
import { authed } from "./auth";
import { migrate } from "./db.server";

export type Todo = { id: number; title: string; done: boolean; createdAt: number };

const id = (d: unknown) => {
  const n = Number((d as { id?: unknown })?.id);
  if (!Number.isSafeInteger(n)) throw new Error("bad id");
  return { id: n };
};

export const listTodos = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) => {
    await migrate();
    const rows = await db.query(db.sql<{ id: number; title: string; done: number; created_at: number }>`
      SELECT id, title, done, created_at FROM todos WHERE user_id = ${context.user.id} ORDER BY done, created_at DESC`);
    return rows.map((r): Todo => ({ id: r.id, title: r.title, done: !!r.done, createdAt: r.created_at }));
  });

export const addTodo = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator((d: unknown) => {
    const title = String((d as { title?: unknown })?.title ?? "").trim();
    if (!title || title.length > 500) throw new Error("title must be 1-500 characters");
    return { title };
  })
  .handler(async ({ data, context }) => {
    await migrate();
    await db.run(db.sql`INSERT INTO todos (user_id, title, created_at) VALUES (${context.user.id}, ${data.title}, ${Date.now()})`);
  });

export const toggleTodo = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(id)
  .handler(async ({ data, context }) => {
    await db.run(db.sql`UPDATE todos SET done = 1 - done WHERE id = ${data.id} AND user_id = ${context.user.id}`);
  });

export const deleteTodo = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(id)
  .handler(async ({ data, context }) => {
    await db.run(db.sql`DELETE FROM todos WHERE id = ${data.id} AND user_id = ${context.user.id}`);
  });
