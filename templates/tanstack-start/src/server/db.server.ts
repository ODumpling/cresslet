// The app's database through Drizzle: `orm` for queries (tables in ./schema.ts), `migrate()` to bring the schema up to
// date. src/start.ts runs migrate() before every request (once per sandbox; after that it returns at once), so the
// tables exist from the app's first request and queries don't call it themselves. Migrations come from drizzle-kit
// (`npm run db:generate` after editing schema.ts); never write or edit them by hand.
import { db } from "cresslet";
import { drizzle, migrate as migrateDb } from "cresslet/drizzle";
import migrations from "../../drizzle/migrations";
import * as schema from "./schema";

/** Drizzle on the app's `db`. Several writes that must land together: `orm.batch([...])` (one transaction). */
export const orm = drizzle(db, { schema });

/** Applies the migrations in drizzle/ the database hasn't had (each in one transaction). */
export const migrate = () => migrateDb(db, migrations);
