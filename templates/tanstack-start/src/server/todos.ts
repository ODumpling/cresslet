// Todo server functions: every one runs as the signed-in user (`authed` middleware) and only touches their rows.
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, not } from "drizzle-orm";
import { authed } from "./auth";
import { orm } from "./db.server";
import { todos } from "./schema";

export type Todo = { id: number; title: string; done: boolean; createdAt: number };

const id = (d: unknown) => {
  const n = Number((d as { id?: unknown })?.id);
  if (!Number.isSafeInteger(n)) throw new Error("bad id");
  return { id: n };
};
const mine = (todoId: number, userId: number) => and(eq(todos.id, todoId), eq(todos.userId, userId));

export const listTodos = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }): Promise<Todo[]> =>
    orm.select({ id: todos.id, title: todos.title, done: todos.done, createdAt: todos.createdAt }).from(todos)
      .where(eq(todos.userId, context.user.id)).orderBy(asc(todos.done), desc(todos.createdAt))
  );

export const addTodo = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator((d: unknown) => {
    const title = String((d as { title?: unknown })?.title ?? "").trim();
    if (!title || title.length > 500) throw new Error("title must be 1-500 characters");
    return { title };
  })
  .handler(async ({ data, context }) => {
    await orm.insert(todos).values({ userId: context.user.id, title: data.title, createdAt: Date.now() });
  });

export const toggleTodo = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(id)
  .handler(async ({ data, context }) => {
    await orm.update(todos).set({ done: not(todos.done) }).where(mine(data.id, context.user.id));
  });

export const deleteTodo = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(id)
  .handler(async ({ data, context }) => {
    await orm.delete(todos).where(mine(data.id, context.user.id));
  });
