// Worker thread serving one app's bindings socket (see serveBindings in bindings.ts): the app's
// synchronous SQLite and file index run here, so a slow query stalls only this app's bindings, never
// the control plane's main thread or other apps.
import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";
import { getRequestListener } from "@hono/node-server";
import { type BindingsOptions, createBindings } from "./bindings.ts";

const { dataDir, sockPath, opts } = workerData as { dataDir: string; sockPath: string; opts: BindingsOptions };
const port = parentPort!;

try {
  const bindings = createBindings(dataDir, opts);
  const server = createServer(getRequestListener(bindings.fetch));
  server.once("error", (e) => void bindings.close().finally(() => (port.postMessage({ error: e.message }), port.close())));
  server.listen(sockPath, () => port.postMessage({ ready: true }));
  port.once("message", async () => {
    // "close": no new connections, cut open ones (the sandbox is gone), then let accepted file writes land.
    server.close();
    server.closeAllConnections();
    await bindings.close();
    port.close();
  });
} catch (e) {
  port.postMessage({ error: (e as Error).message });
}
