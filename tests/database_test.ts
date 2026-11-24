// The metadata database: migrations, SQLite ⇄ Postgres copies, and locking across servers sharing Postgres.
// The Postgres cases need CRESSLET_DATABASE_URL (npm run test:pg); they skip without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, numberParams, PostgresDb, SqliteDb } from "../server/db.ts";
import { migrate, type Migration, MIGRATIONS } from "../server/migrations.ts";
import { type DatabaseConfig, Store } from "../server/store.ts";
import { copyStore, postgresToSqlite, sqliteToPostgres } from "../server/db-migrate.ts";

const PG = process.env.CRESSLET_DATABASE_URL || null;
const needsPg = PG ? false : "needs Postgres (CRESSLET_DATABASE_URL; npm run test:pg)";

const tmp = () => mkdtemp(join(tmpdir(), "cresslet-db-"));
/** A fresh Postgres schema, dropped by `drop()`. */
async function pgSchema() {
  const schema = "t_" + randomBytes(6).toString("hex");
  const database: DatabaseConfig = { url: PG, schema };
  return {
    database,
    db: () => new PostgresDb(PG!, schema),
    async drop() {
      const admin = new PostgresDb(PG!);
      await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    },
  };
}

/** Each dialect available here: SQLite always, Postgres with CRESSLET_DATABASE_URL. */
const dialects: { name: string; skip: string | false; open(): Promise<{ db: Db; done(): Promise<void> }> }[] = [
  {
    name: "sqlite",
    skip: false,
    async open() {
      const dir = await tmp();
      const db = new SqliteDb(join(dir, "m.db"));
      return { db, done: async () => (await db.close(), await rm(dir, { recursive: true, force: true })) };
    },
  },
  {
    name: "postgres",
    skip: needsPg,
    async open() {
      const s = await pgSchema();
      const db = s.db();
      return { db, done: async () => (await db.close(), await s.drop()) };
    },
  },
];

const cols = async (db: Db, table: string) =>
  db.dialect === "sqlite"
    ? (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name)
    : (await db.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", table)).map((c) => c.name);

test("placeholders: ? becomes $n outside quoted strings", () => {
  assert.equal(numberParams("SELECT ? , '?', \"a?\" FROM t WHERE x = ? AND y = '?''?'"), "SELECT $1 , '?', \"a?\" FROM t WHERE x = $2 AND y = '?''?'");
});

for (const d of dialects) {
  test(`migrations (${d.name}): applied once, in order, all or nothing; a newer database is reported`, { skip: d.skip }, async () => {
    const { db, done } = await d.open();
    try {
      const all = MIGRATIONS.map((m) => m.version), n = all.length;
      assert.deepEqual(await migrate(db), { applied: all, unknown: [] });
      assert.deepEqual(await migrate(db), { applied: [], unknown: [] }, "nothing left to apply");

      const v2: Migration = { version: n + 1, name: "apps.note", up: (db) => db.exec("ALTER TABLE apps ADD COLUMN note TEXT") };
      assert.deepEqual((await migrate(db, [...MIGRATIONS, v2])).applied, [n + 1]);
      assert.ok((await cols(db, "apps")).includes("note"));

      // A migration that fails halfway: its earlier statements are rolled back, nothing is recorded.
      const v3: Migration = {
        version: n + 2,
        name: "broken",
        async up(db) {
          await db.exec("ALTER TABLE apps ADD COLUMN half TEXT");
          await db.exec("ALTER TABLE no_such_table ADD COLUMN x TEXT");
        },
      };
      await assert.rejects(migrate(db, [...MIGRATIONS, v2, v3]));
      assert.ok(!(await cols(db, "apps")).includes("half"), "rolled back");
      const recorded = (await db.all<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version"));
      assert.deepEqual(recorded.map((r) => [r.version, r.name]), [...MIGRATIONS.map((m) => [m.version, m.name]), [n + 1, "apps.note"]]);

      // Rolled back to a release without v2: it runs, and says the database is ahead.
      assert.deepEqual(await migrate(db), { applied: [], unknown: [{ version: n + 1, name: "apps.note" }] });
      await assert.rejects(migrate(db, [v2, MIGRATIONS[0]]), /increasing order/);
    } finally {
      await done();
    }
  });
}

test("migrations (postgres): servers starting together apply each migration once", { skip: needsPg }, async () => {
  const s = await pgSchema();
  const dbs = Array.from({ length: 4 }, () => s.db());
  try {
    const results = await Promise.all(dbs.map((db) => migrate(db)));
    assert.deepEqual(results.map((r) => r.applied).flat(), MIGRATIONS.map((m) => m.version));
    assert.equal((await dbs[0].all("SELECT * FROM schema_migrations")).length, MIGRATIONS.length);
  } finally {
    for (const db of dbs) await db.close();
    await s.drop();
  }
});

test("a SQLite database from before migrations upgrades in place, data kept", async () => {
  const dir = await tmp();
  try {
    // A release before this one: the same tables, no schema_migrations.
    let store = await Store.open(dir);
    const acct = await store.createAccount("old@b.co");
    const { app } = await store.createApp("old", acct.id);
    await store.setSecret(app.id, "K", "v");
    await store.db.exec("DROP TABLE schema_migrations");
    await store.close();

    store = await Store.open(dir);
    try {
      assert.deepEqual((await store.db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).map((r) => r.version), MIGRATIONS.map((m) => m.version));
      assert.equal((await store.appByName("old"))?.account_id, acct.id);
      assert.deepEqual(await store.secrets(app.id), { K: "v" });
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** One of everything, through the Store, as a server would write it. */
async function fill(store: Store) {
  const owner = await store.createAccount("owner@b.co", { id: 7, login: "own" });
  const guest = await store.createAccount("guest@b.co");
  const { token, info: cli } = await store.issueToken(owner.id, { name: "cli" });
  await store.issueToken(owner.id, { name: "ci", role: "deploy", apps: [] });
  const { app } = await store.createApp("shop", owner.id);
  await store.setCurrentDeploy(app.id, "dep_1", { routes: ["/api/*"], crons: ["* * * * *"] });
  for (const [i, d] of ["dep_1", "dep_2", "dep_3"].entries()) {
    await store.addDeploy({ id: d, app_id: app.id, created_at: 1000 + i, bytes: 10, file_count: 1, has_server: 1, source: "cli", git_sha: i ? null : "a".repeat(40), git_branch: i ? null : "main", git_repo: i ? null : "own/shop" });
  }
  await store.upsertGitConnection({
    account_id: owner.id, provider: "github", provider_uid: "7", login: "own", email: "owner@b.co", scopes: null,
    access_token: "ghu_abc", refresh_token: "ghr_def", expires_at: 5000,
  });
  await store.setAppRepo({
    app_id: app.id, provider: "github", repo_id: "9", owner: "own", name: "shop", default_branch: "main", subdir: "",
    delete_branch: 1, connected_by: owner.id, last_synced_sha: "a".repeat(40),
  });
  await store.addStackChange({
    id: "chg_1", app_id: app.id, stack_id: "stk_1", stack_name: "dark-mode", position: 1, branch: "feat/dark-mode/1-dark-mode",
    sha: "b".repeat(40), base_sha: "a".repeat(40), title: "Dark mode", prompt: "Dark mode ✓", author: "own", created_by: owner.id,
  });
  await store.setSecret(app.id, "API_KEY", "s3cret");
  await store.setSecret(app.id, "OTHER", "ünïcode ✓");
  await store.addDomain(app.id, "shop.example.com");
  await store.invite(app.id, "later@b.co", "viewer", owner.id);
  const { invite } = await store.invite(app.id, "guest@b.co", "admin", owner.id);
  await store.acceptInvite(invite, guest.id);
  const page = await store.createPage("pg-1", owner.id, { title: "P", visibility: "private", retentionDays: 30 });
  await store.pageTicket(page.id, owner.id, 60_000);
  await store.takeRateHit("deploys", app.id, 0, 10, Date.now(), Date.now() + 3_600_000);
  await store.uidSeq(app.id);
  await store.grantAi(owner.id, 5000, { by: "test" });
  await store.chargeAi(owner.id, "2026-11", 1000, 1500, { model: "claude-opus-5-5", input: 3, output: 4, usd: 0.25 });
  const org = await store.createOrg("acme", "Acme", owner.id);
  await store.setOrgMember(org.id, owner.id, "admin");
  await store.setOrgMember(org.id, guest.id, "member");
  const { app: orgApp } = await store.createApp("tool", owner.id);
  await store.setAppOrg(orgApp.id, org.id, owner.id);
  await store.proveInstall(owner.id, "ins_1", "install-secret");
  const agent = await store.createAgentCredential({
    accountId: owner.id, cliTokenId: cli.id, installId: "ins_1", secretHash: "c".repeat(64), label: "Claude Code",
    handle: `ins_1:${app.id}`, projectName: "shop",
  });
  await store.setAgentPause(owner.id, `ins_1:${app.id}`, true);
  const staging = await store.ensureEnvironment(app.id, "staging");
  await store.setEnvSecret(staging.id, "API_KEY", "staging-ünï");
  await store.envUidSeq(staging.id);
  return { owner, guest, token, app, agent, staging, orgApp: (await store.appById(orgApp.id))! };
}

test("SQLite → Postgres → SQLite: every row and secret copied and checked; the source untouched", { skip: needsPg }, async () => {
  const dir = await tmp();
  const s = await pgSchema();
  try {
    const src = await Store.open(dir);
    const seed = await fill(src);
    await src.close();
    const before = createHash("sha256").update(await readFile(join(dir, "cresslet.db"))).digest("hex");

    // A dry run checks everything and writes nothing.
    const dry = await sqliteToPostgres(dir, s.database, { dryRun: true });
    assert.equal(dry.committed, false);
    assert.ok(dry.tables.find((t) => t.table === "secrets")!.rows === 2 && dry.secrets === 3);
    const pg = await Store.open(dir, s.database);
    assert.equal((await pg.db.get<{ n: number }>("SELECT count(*) AS n FROM accounts"))!.n, 0, "dry run wrote nothing");
    const seq = (await pg.db.get<{ s: string }>("SELECT pg_get_serial_sequence('ai_ledger', 'id') AS s"))!.s;
    assert.equal((await pg.db.get<{ last_value: number }>(`SELECT last_value FROM ${seq}`))!.last_value, 1, "nor moved a sequence");
    await pg.close();

    const report = await sqliteToPostgres(dir, s.database);
    assert.equal(report.committed, true);
    assert.equal(createHash("sha256").update(await readFile(join(dir, "cresslet.db"))).digest("hex"), before, "source file unchanged");
    const rows = Object.fromEntries(report.tables.map((t) => [t.table, t.rows]));
    assert.deepEqual(rows, {
      accounts: 2, apps: 3, tokens: 2, deploys: 3, secrets: 2, domains: 1, meta: 1, collaborators: 1, invites: 1,
      page_sessions: 1, rate_hits: 1, ai_wallets: 1, ai_ledger: 2, orgs: 1, org_members: 2, git_connections: 1, app_repos: 1,
      stack_changes: 1, browser_installs: 1, agent_credentials: 1, agent_grants: 1, agent_pauses: 1,
      environments: 1, env_secrets: 1,
    });

    // The copy works as the database of a server.
    const store = await Store.open(dir, s.database);
    try {
      assert.equal((await store.useToken(seed.token))?.account.email, "owner@b.co");
      const agents = await store.agentCredentials(seed.owner.id);
      assert.deepEqual(agents.map((a) => [a.id, a.grants.map((g) => g.project_name)]), [[seed.agent.id, ["shop"]]]);
      assert.ok(await store.agentPaused(seed.owner.id, `ins_1:${seed.app.id}`));
      assert.deepEqual(await store.secrets(seed.app.id), { API_KEY: "s3cret", OTHER: "ünïcode ✓" });
      // A staging environment's overrides (sealed to it) on top of production's; its own uid.
      assert.deepEqual(await store.envSecrets(seed.staging), { API_KEY: "staging-ünï", OTHER: "ünïcode ✓" });
      assert.equal(await store.envUidSeq(seed.staging.id), 2);
      assert.deepEqual((await store.deploys(seed.app.id)).map((d) => d.id), ["dep_3", "dep_2", "dep_1"]);
      assert.equal((await store.deploys(seed.app.id))[2].git_repo, "own/shop");
      const conn = await store.getGitConnection(seed.owner.id, "github");
      assert.deepEqual([conn?.access_token, conn?.refresh_token], ["ghu_abc", "ghr_def"]);
      assert.equal((await store.getAppRepo(seed.app.id))?.name, "shop");
      assert.deepEqual((await store.openStackChanges(seed.app.id)).map((c) => [c.branch, c.prompt]), [["feat/dark-mode/1-dark-mode", "Dark mode ✓"]]);
      assert.deepEqual((await store.appsWithCrons()).map((a) => a.name), ["shop"]);
      assert.equal(await store.access(seed.app, seed.guest.id), "admin");
      assert.equal(await store.access(seed.orgApp, seed.guest.id), "admin", "an org member");
      assert.equal(await store.access(seed.orgApp, seed.owner.id), "owner", "an org admin");
      assert.equal(await store.uidSeq(seed.app.id), 1);
      assert.deepEqual(await store.aiWallet(seed.owner.id, "2026-11"), { balance: 4500, periodUsed: 1000 });
      // Generated ids carry on after the copied ones.
      await store.chargeAi(seed.owner.id, "2026-11", 1000, 1, { model: "m" });
      assert.deepEqual((await store.aiLedger(seed.owner.id)).map((r) => r.kind), ["usage", "usage", "grant"]);
      await store.addDeploy({ id: "dep_4", app_id: seed.app.id, created_at: 1000, bytes: 1, file_count: 1, has_server: 0, source: "cli" });
      assert.deepEqual((await store.pageVersions(seed.app.id)).map((d) => d.id), ["dep_4", "dep_3", "dep_2", "dep_1"]);
      // A second copy into the same database is refused: it isn't empty.
      await assert.rejects(sqliteToPostgres(dir, s.database), /isn't empty/);
    } finally {
      await store.close();
    }

    // And back (the way to roll back the switch), checked the same way.
    const out = join(dir, "back");
    const back = await postgresToSqlite(dir, s.database, out);
    assert.equal(back.committed, true);
    assert.equal(back.tables.find((t) => t.table === "deploys")!.rows, 4);
    const sq = await Store.open(out);
    try {
      assert.deepEqual(await sq.secrets(seed.app.id), { API_KEY: "s3cret", OTHER: "ünïcode ✓" });
      assert.deepEqual((await sq.pageVersions(seed.app.id)).map((d) => d.id), ["dep_4", "dep_3", "dep_2", "dep_1"]);
    } finally {
      await sq.close();
    }
    await assert.rejects(postgresToSqlite(dir, s.database, out), /exists/);
  } finally {
    await s.drop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a copy that doesn't match is rolled back", { skip: needsPg }, async () => {
  const dir = await tmp();
  const s = await pgSchema();
  try {
    const from = await Store.open(dir);
    await fill(from);
    const to = await Store.open(dir, s.database);
    try {
      // A target that silently drops a value: the comparison catches it, and nothing stays.
      await to.db.exec("CREATE FUNCTION blank() RETURNS trigger AS $$ BEGIN NEW.github_login := NULL; RETURN NEW; END $$ LANGUAGE plpgsql");
      await to.db.exec("CREATE TRIGGER blank BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION blank()");
      await assert.rejects(copyStore(from, to), /accounts: copy differs/);
      assert.equal((await to.db.get<{ n: number }>("SELECT count(*) AS n FROM apps"))!.n, 0);
    } finally {
      await to.close();
      await from.close();
    }
  } finally {
    await s.drop();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Two servers' stores on one database (Postgres), or one store's concurrent callers (SQLite). */
const shared: { name: string; skip: string | false; open(): Promise<{ stores: Store[]; done(): Promise<void> }> }[] = [
  {
    name: "sqlite",
    skip: false,
    async open() {
      const dir = await tmp();
      const store = await Store.open(dir);
      return { stores: [store, store], done: async () => (await store.close(), await rm(dir, { recursive: true, force: true })) };
    },
  },
  {
    name: "postgres, two servers",
    skip: needsPg,
    async open() {
      const dir = await tmp();
      const s = await pgSchema();
      const stores = [await Store.open(dir, s.database), await Store.open(dir, s.database)];
      return {
        stores,
        async done() {
          for (const st of stores) await st.close();
          await s.drop();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

for (const sh of shared) {
  test(`concurrent writers (${sh.name}): limits, quotas, wallets and uid numbers don't race`, { skip: sh.skip }, async () => {
    const { stores, done } = await sh.open();
    const on = (i: number) => stores[i % stores.length];
    try {
      const acct = await stores[0].createAccount("a@b.co");
      // Rate limit: 5 an hour, 40 tries at once.
      const took = await Promise.all(Array.from({ length: 40 }, (_, i) => on(i).takeRateHit("creates", acct.id, 0, 5, Date.now(), Date.now() + 1000)));
      assert.equal(took.filter(Boolean).length, 5);
      // Quota checked inside createApp: at most 3 apps, 12 creations at once.
      const made = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
        on(i).createApp(`app-${i}`, acct.id, async () => {
          if ((await on(i).appsByAccount(acct.id)).length >= 3) throw new Error("quota");
        })));
      assert.equal(made.filter((r) => r.status === "fulfilled").length, 3);
      assert.equal((await stores[0].appsByAccount(acct.id)).length, 3);
      // Wallet: grants and charges interleaved, none lost.
      await Promise.all(Array.from({ length: 30 }, (_, i) =>
        i % 3 ? on(i).chargeAi(acct.id, "2026-11", 0, 7, { model: "m" }) : on(i).grantAi(acct.id, 100, { by: "t" })));
      assert.equal((await stores[0].aiWallet(acct.id, "2026-11")).balance, 10 * 100 - 20 * 7);
      assert.equal((await stores[0].aiLedger(acct.id, 100)).length, 30);
      // Sandbox uid numbers: one per app, never shared.
      const apps = await stores[0].appsByAccount(acct.id);
      const seqs = await Promise.all([...apps, ...apps].map((a, i) => on(i).uidSeq(a.id)));
      assert.equal(new Set(seqs.slice(0, 3)).size, 3);
      assert.deepEqual(seqs.slice(3), seqs.slice(0, 3));
    } finally {
      await done();
    }
  });
}

test("an invite resent while it's being cancelled is saved as a new one", async () => {
  const dir = await tmp();
  const store = await Store.open(dir);
  try {
    const owner = await store.createAccount("o@b.co");
    const { app } = await store.createApp("inv", owner.id);
    const { invite: first } = await store.invite(app.id, "x@b.co", "viewer", owner.id);
    // The cancel lands between the resend reading the pending invite and updating it.
    const get = store.db.get.bind(store.db);
    store.db.get = (async (sql: string, ...p: never[]) => {
      const r = await get(sql, ...p);
      if (/FROM invites WHERE app_id = \? AND email = \?/.test(sql)) await store.cancelInvite(app.id, first.id);
      return r;
    }) as typeof store.db.get;
    const resent = await store.invite(app.id, "x@b.co", "admin", owner.id);
    store.db.get = get as typeof store.db.get;
    assert.equal(resent.created, true);
    assert.deepEqual((await store.invites(app.id)).map((i) => [i.id, i.role]), [[resent.invite.id, "admin"]]);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
