// The messages between the studio page (cresslet-plugin.ts, `cresslet dev`) and the app's server worker
// (server-worker.ts). Types only: nothing imports this file at runtime.

/** Headers as [name, value] pairs (Set-Cookie may repeat). */
export type HeaderList = [string, string][];

export interface AppInfo {
  id: string;
  name: string;
  url: string;
  deployId: string;
}

export interface FileItem {
  key: string;
  size: number;
  contentType: string;
  updatedAt: number;
}

/** A files call the worker makes (the page keeps the files in the VFS). */
export type FileOp =
  | { op: "put"; key: string; bytes: Uint8Array; contentType: string }
  | { op: "get"; key: string }
  | { op: "delete"; key: string }
  | { op: "list"; prefix: string };

/** Its answer, by op. */
export interface FileResults {
  put: {};
  get: { found: false } | { found: true; bytes: Uint8Array<ArrayBuffer>; contentType: string };
  delete: {};
  list: { items: FileItem[] };
}
/** The fields of any op's answer. */
export interface FileResult {
  found?: boolean;
  bytes?: Uint8Array<ArrayBuffer>;
  contentType?: string;
  items?: FileItem[];
}

export type ToWorker =
  | {
    type: "init";
    code: string;
    app: AppInfo;
    secrets: Record<string, string>;
    db: Uint8Array | null;
    /** One request at a time (TanStack Start: AsyncLocalStorage is a one-store shim in the preview). */
    serial?: boolean;
  }
  | { type: "request"; id: number; url: string; method: string; headers: HeaderList; body: ArrayBuffer | null }
  /** With a MessagePort to the preview's socket after a 101, or none (the preview gave up). */
  | { type: "socket"; id: number }
  /** The studio's Database view: a script of one or more statements, run on the app's database. */
  | { type: "sql"; id: number; sql: string }
  | ({ type: "files-result"; id: number; error?: string } & FileResult);

/** A response to a request: `body` null for a 101 (WebSocket), which has the accepted `protocol`. */
export interface ResponseMessage {
  type: "response";
  id: number;
  status: number;
  headers: HeaderList;
  body: ArrayBuffer | null;
  protocol?: string;
}

/** A cell as the Database view shows it: a blob as its size, an integer past ±2^53 as its digits. */
export type SqlCell = number | string | null | { blob: number };

/** What a script did: the last statement that returns columns (a query, or `… RETURNING`), and every change. */
export interface SqlResult {
  columns: string[];
  rows: SqlCell[][];
  /** More rows than `rows` (the worker keeps the first 1,000). */
  truncated: boolean;
  /** Rows inserted, updated or deleted by the script (total_changes(), triggers and cascades too). */
  changes: number;
  statements: number;
  /** The script left a transaction open: nothing is saved until a COMMIT or ROLLBACK. */
  transaction: boolean;
}

export type FromWorker =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "log"; level: "log" | "info" | "warn" | "error" | "debug"; msg: string }
  | { type: "db"; bytes: Uint8Array }
  | ResponseMessage
  /** `snapshot`: the script's writes were posted as a `db` snapshot (just before this). */
  | ({ type: "sql-result"; id: number; snapshot: boolean } & ({ result: SqlResult } | { error: string }))
  | ({ type: "files"; id: number } & FileOp);
