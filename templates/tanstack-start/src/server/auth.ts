// Auth server functions: called from components like normal async functions; their bodies run only on the server
// (TanStack Start replaces them with RPC calls in the client bundle, so the *.server.ts imports never ship).
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { db } from "cresslet";
import { currentUser, endSession, hashPassword, rateLimit, startSession, UserError, verifyPassword } from "./auth.server";

export type { User } from "./auth.server";

const str = (v: unknown, name: string, max = 200) => {
  if (typeof v !== "string" || !v.trim()) throw new UserError(`${name} is required`);
  if (v.length > max) throw new UserError(`${name} is too long`);
  return v.trim();
};
const record = (d: unknown) => (d && typeof d === "object" ? (d as Record<string, unknown>) : {});

/** The signed-in user or null (the root route loads it for every page). */
export const getUser = createServerFn({ method: "GET" }).handler(() => currentUser());

/** For server functions that need a signed-in user: `.middleware([authed])`, then `context.user`. */
export const authed = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await currentUser();
  if (!user) throw new UserError("Sign in first");
  return next({ context: { user } });
});

type Result = { ok: true } | { ok: false; error: string };
/** Expected failures come back as `{ ok: false, error }` for the form to show; anything else is a real error. */
const userErrors = async (fn: () => Promise<void>): Promise<Result> => {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof UserError) return { ok: false, error: e.message };
    throw e;
  }
};

export const signUp = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const r = record(d);
    return { name: r.name, email: r.email, password: r.password };
  })
  .handler(({ data }) =>
    userErrors(async () => {
      const name = str(data.name, "Name", 80);
      const email = str(data.email, "Email", 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError("Enter a valid email");
      const password = typeof data.password === "string" ? data.password : "";
      if (password.length < 8) throw new UserError("Password must be at least 8 characters");
      if (password.length > 200) throw new UserError("Password is too long");
      await rateLimit("signup", 10, 3600);
      const hash = await hashPassword(password);
      const row = await db.first(db.sql<{ id: number }>`
        INSERT INTO users (email, name, password_hash, created_at) VALUES (${email}, ${name}, ${hash}, ${Date.now()})
        ON CONFLICT (email) DO NOTHING RETURNING id`);
      if (!row) throw new UserError("An account with that email already exists");
      await startSession(row.id);
    })
  );

export const signIn = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const r = record(d);
    return { email: r.email, password: r.password };
  })
  .handler(({ data }) =>
    userErrors(async () => {
      const email = str(data.email, "Email", 254).toLowerCase();
      const password = typeof data.password === "string" ? data.password : "";
      await rateLimit("signin", 10, 600);
      const user = await db.first(
        db.sql<{ id: number; password_hash: string }>`SELECT id, password_hash FROM users WHERE email = ${email}`,
      );
      if (!user || !(await verifyPassword(password, user.password_hash))) throw new UserError("Wrong email or password");
      await startSession(user.id);
    })
  );

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  await endSession();
});
