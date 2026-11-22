import { test } from "node:test";
import assert from "node:assert/strict";
import { type Config, isolationWarnings, loadConfig } from "../server/config.ts";

const gh = { clientId: "id", clientSecret: "s", webUrl: "", apiUrl: "" };
const warnings = (o: Partial<Config>, sandbox: Partial<Config["sandbox"]> = {}) => {
  const base = loadConfig();
  return isolationWarnings(loadConfig({ ...o, sandbox: { ...base.sandbox, runsc: null, outerGvisor: false, uidBase: null, ...sandbox } }))
    .map((w) => w.includes("share one uid") ? "uid" : w.includes("CRESSLET_OUTER_GVISOR isn't true") ? "gvisor" : w);
};

test("isolation warnings: only when strangers can deploy, until gVisor (and per-app uids) cover them", () => {
  // Closed instance: nothing to warn about. Signup without GitHub can't happen.
  assert.deepEqual(warnings({ openSignup: false, github: gh }), []);
  assert.deepEqual(warnings({ openSignup: true, github: null }), []);
  // Multi-tenant (open signup with GitHub), no hardening: both.
  const open = { openSignup: true, github: gh };
  assert.deepEqual(warnings(open), ["gvisor", "uid"]);
  // Per-app uids alone aren't enough.
  assert.deepEqual(warnings(open, { uidBase: 100000 }), ["gvisor"]);
  // gVisor around the whole server (deploy/coolify) + per-app uids: fine; without uids, apps share one.
  assert.deepEqual(warnings(open, { outerGvisor: true, uidBase: 100000 }), []);
  assert.deepEqual(warnings(open, { outerGvisor: true }), ["uid"]);
  // gVisor per sandbox: each has its own kernel and filesystem view.
  assert.deepEqual(warnings(open, { runsc: "/usr/local/bin/runsc" }), []);
});

test("CRESSLET_OUTER_GVISOR: only the literal true turns it on", () => {
  const prev = process.env.CRESSLET_OUTER_GVISOR;
  try {
    for (const [v, want] of [[undefined, false], ["true", true], ["1", false], ["false", false]] as const) {
      if (v === undefined) delete process.env.CRESSLET_OUTER_GVISOR;
      else process.env.CRESSLET_OUTER_GVISOR = v;
      assert.equal(loadConfig().sandbox.outerGvisor, want, String(v));
    }
  } finally {
    if (prev === undefined) delete process.env.CRESSLET_OUTER_GVISOR;
    else process.env.CRESSLET_OUTER_GVISOR = prev;
  }
});

test("CRESSLET_CUSTOM_DOMAINS: on unless set to something other than true", () => {
  const prev = process.env.CRESSLET_CUSTOM_DOMAINS;
  try {
    for (const [v, want] of [[undefined, true], ["true", true], ["false", false], ["0", false]] as const) {
      if (v === undefined) delete process.env.CRESSLET_CUSTOM_DOMAINS;
      else process.env.CRESSLET_CUSTOM_DOMAINS = v;
      assert.equal(loadConfig().customDomains, want, String(v));
    }
  } finally {
    if (prev === undefined) delete process.env.CRESSLET_CUSTOM_DOMAINS;
    else process.env.CRESSLET_CUSTOM_DOMAINS = prev;
  }
});
