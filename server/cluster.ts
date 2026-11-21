// Placement: which node owns an app. One node (the default) owns them all; see docs/architecture.md#scaling-out.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The seam for running more than one server process. The node that owns an app holds its files
 * (`data/apps/<id>/`), runs its sandbox, keeps its logs, fires its crons and reaps it; any other
 * node forwards the app's requests to it unchanged (app hosts, and app-scoped /v1 calls), and the
 * owner answers them as a single node does.
 */
export interface Cluster {
  /** This node owns the app. */
  local(appId: string): boolean;
  /** Sends a request for an app this node doesn't own to its owner, and returns the owner's answer. */
  forward(appId: string, req: Request): Promise<Response>;
  /** Same for a WebSocket upgrade on an app host; the caller destroys the socket if it rejects. */
  forwardUpgrade(appId: string, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

const unowned = (appId: string) => new Error(`single node: no other node owns ${appId}`);

/** Today's server: this node owns every app, so nothing is ever forwarded. */
export const singleNode: Cluster = {
  local: () => true,
  forward: (appId) => Promise.reject(unowned(appId)),
  forwardUpgrade: (appId) => Promise.reject(unowned(appId)),
};
