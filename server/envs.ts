// Environments inside an app (docs/architecture.md#environments): production is the app itself (its pointer, config,
// data and secrets, as before); another environment (`staging`) has its own deploy pointer and config, sandbox, data
// and secret overrides, on `<app>--<env>.<domain>`, and promoting moves production's pointer to its deploy.
import { appUrl, type Config, paths } from "./config.ts";
import type { App, Environment, Store } from "./store.ts";
import type { AppSpec } from "./runtime.ts";

/** Environments an app can have besides production (more later: per-pull-request previews). */
export const ENV_NAMES = ["staging"] as const;
export type EnvName = (typeof ENV_NAMES)[number];
export const isEnvName = (v: unknown): v is EnvName => ENV_NAMES.includes(v as EnvName);

/** Joins an app's host label and an environment's: app names never hold `--` (validName), so this can't collide. */
export const ENV_SEP = "--";

/** A host label: `shop` → production of shop, `shop--staging` → its staging; null when it names no environment. */
export function splitLabel(label: string): { app: string; env: EnvName | null } | null {
  const i = label.indexOf(ENV_SEP);
  if (i < 0) return { app: label, env: null };
  const env = label.slice(i + ENV_SEP.length);
  return i > 0 && isEnvName(env) ? { app: label.slice(0, i), env } : null;
}

/** What serves one environment of an app: production (`env` null) or another one. */
export interface Target {
  /** Its runtime identity: the app's id, or the environment's. */
  key: string;
  app: App;
  env: Environment | null;
  deployId: string | null;
  /** JSON { routes, server, crons }. */
  config: string;
}

export const prodTarget = (app: App): Target => ({ key: app.id, app, env: null, deployId: app.current_deploy_id, config: app.config });
export const envTarget = (app: App, env: Environment): Target => ({ key: env.id, app, env, deployId: env.current_deploy_id, config: env.config });

/** The runtime keys of every environment of the app (production's first): stop them all on a change they share. */
export async function targetKeys(store: Store, appId: string): Promise<string[]> {
  return [appId, ...(await store.environments(appId)).map((e) => e.id)];
}

/** The app (live) and target a runtime key names: an app's id, or an environment's. */
export async function resolveKey(store: Store, key: string): Promise<Target | undefined> {
  if (!key.startsWith("env_")) {
    const app = await store.appById(key);
    return app && prodTarget(app);
  }
  const env = await store.environmentById(key);
  const app = env && await store.appById(env.app_id);
  return app && env && envTarget(app, env);
}

/** Where the target's database and files are. */
export const targetData = (cfg: Config, t: Pick<Target, "app" | "env">) =>
  t.env ? paths(cfg, t.app.id).env(t.env.name) : paths(cfg, t.app.id);

export function appSpec(cfg: Config, store: Store, t: Target): AppSpec {
  const { app, env } = t;
  return {
    key: t.key,
    appId: app.id,
    env: env?.name ?? null,
    dataDir: targetData(cfg, t).data,
    seq: () => env ? store.envUidSeq(env.id) : store.uidSeq(app.id),
    appName: app.name,
    appUrl: appUrl(cfg, app.name, env?.name),
    deployId: t.deployId!,
    // Another environment: production's secrets, its own overriding them.
    secrets: () => env ? store.envSecrets(env) : store.secrets(app.id),
    // Outbound network is only for claimed apps (enforced by the sandbox); the allowlist is the app's, for every environment.
    net: !!app.account_id,
    egress: app.egress ? JSON.parse(app.egress) : null,
  };
}
