// Every app belongs to an account: tests that only need *some* owner to deploy get one here.
import type { Store } from "../server/store.ts";

/** A full-access token for `email`'s account (created if missing). */
export async function ownerToken(store: Store, email = "owner@test.local"): Promise<string> {
  const acct = await store.accountByEmail(email) ?? await store.createAccount(email);
  return (await store.issueToken(acct.id, { name: "test" })).token;
}

/** `authorization` header for `ownerToken`. */
export const ownerAuth = async (store: Store, email?: string) => ({ authorization: `Bearer ${await ownerToken(store, email)}` });

/**
 * Turns an app into one from before anonymous deploys were removed: no owner, expiring. Such apps
 * still exist on old instances until they expire, so the guards for them stay tested.
 */
export async function makeLegacyAnonymous(store: Store, appId: string, expiresAt = Date.now() + 72 * 3600_000) {
  await store.db.run("UPDATE apps SET account_id = NULL, expires_at = ? WHERE id = ?", expiresAt, appId);
}
