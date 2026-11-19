// Secrets at rest: AES-256-GCM, bound to (appId, key) so ciphertexts can't be swapped between rows.
// Key: CRESSLET_SECRETS_KEY (any string; hashed to 32 bytes), else a random key generated once in
// <dataDir>/secrets.key. Both are kept in the keyring so an operator can switch to the env key
// later: rows still under the file key are re-encrypted on startup (Store constructor).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "v1:";

export class SecretBox {
  #keys: Buffer[];

  constructor(keys: Buffer[]) {
    if (!keys.length) throw new Error("SecretBox needs a key");
    this.#keys = keys;
  }

  static load(dataDir: string, envKey = process.env.CRESSLET_SECRETS_KEY): SecretBox {
    const keys: Buffer[] = [];
    if (envKey) keys.push(createHash("sha256").update(envKey).digest());
    const file = join(dataDir, "secrets.key");
    if (existsSync(file)) {
      const k = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
      if (k.length !== 32) throw new Error(`${file} is corrupt (expected a base64 32-byte key)`);
      keys.push(k);
    } else if (!envKey) {
      // Durable before any row is sealed with it: losing this key loses every secret.
      const k = randomBytes(32);
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, k.toString("base64") + "\n");
      fsyncSync(fd);
      closeSync(fd);
      const dir = openSync(dataDir, "r");
      fsyncSync(dir);
      closeSync(dir);
      keys.push(k);
    }
    return new SecretBox(keys);
  }

  seal(appId: string, key: string, value: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#keys[0], iv);
    c.setAAD(Buffer.from(`${appId}\0${key}`));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final(), c.getAuthTag()]);
    return PREFIX + iv.toString("base64") + ":" + ct.toString("base64");
  }

  /** Plaintext, and whether the row should be re-sealed under the primary key. */
  open(appId: string, key: string, sealed: string): { value: string; stale: boolean } {
    const [iv, ct] = sealed.slice(PREFIX.length).split(":").map((s) => Buffer.from(s, "base64"));
    for (const [i, k] of this.#keys.entries()) {
      try {
        const d = createDecipheriv("aes-256-gcm", k, iv);
        d.setAAD(Buffer.from(`${appId}\0${key}`));
        d.setAuthTag(ct.subarray(ct.length - 16));
        const value = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
        return { value, stale: i > 0 };
      } catch { /* try next key */ }
    }
    throw new Error(`cannot decrypt secret ${key} of ${appId}: wrong CRESSLET_SECRETS_KEY?`);
  }
}
