// The app's tables (Drizzle). To change them: edit this file, run `npm run db:generate` (drizzle-kit writes the next
// migration into drizzle/), commit drizzle/. Never edit or delete a migration that has been deployed.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer().primaryKey(),
  /** Stored lowercased (signUp/signIn lowercase what's typed). */
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const todos = sqliteTable(
  "todos",
  {
    id: integer().primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    done: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("todos_user").on(t.userId, t.createdAt)],
);
