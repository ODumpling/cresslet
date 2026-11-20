// Worker thread serving one app's bindings socket (see serveBindings in bindings.ts): the app's
// synchronous SQLite and file index run here, so a slow query stalls only this app's bindings, never
// the control plane's main thread or other apps. Booted ahead of need: it waits for its app.
import { createServer } from "node:http";
import { parentPort } from "node:worker_threads";
import { getRequestListener } from "@hono/node-server";
import { type BindingsOptions, createBindings } from "./bindings.ts";

const port = parentPort!;

interface Start { dataDir: string; sockPath: string; opts: BindingsOptions; gated: boolean }

port.once("message", ({ dataDir, sockPath, opts, gated }: Start) => {
  // Gated: the app's previous thread is still landing file writes; "go" comes once it's gone.
  let go = () => {};
  const after = gated ? new Promise<void>((r) => (go = r)) : undefined;
  try {
    const bindings = createBindings(dataDir, opts, after);
    const server = createServer(getRequestListener(bindings.fetch));
    server.once("error", (e) => {
      go(); // nothing of ours waits behind the gate: don't wait for it to close
      void bindings.close().finally(() => (port.postMessage({ error: e.message }), port.close()));
    });
    server.listen(sockPath, () => port.postMessage({ ready: true }));
    port.on("message", async (m) => {
      if (m === "go") return go();
      if (m !== "close") return;
      // No new connections, cut open ones (the sandbox is gone), then let accepted file writes land
      // (after the predecessor's: its "go" still comes).
      server.close();
      server.closeAllConnections();
      await bindings.close();
      port.close();
    });
  } catch (e) {
    port.postMessage({ error: (e as Error).message });
    port.close();
  }
});
