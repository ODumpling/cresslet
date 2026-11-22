// Minimal static file serving: content types, ETag/304, HEAD, single byte ranges.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { stripTypes } from "./strip.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

export const contentType = (path: string) =>
  TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const body = (path: string, start?: number, end?: number) =>
  Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;

export async function serveFile(req: Request, path: string): Promise<Response> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (!info.isFile()) return new Response("Not Found", { status: 404 });
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  const headers = new Headers({
    "content-type": contentType(path),
    etag,
    "last-modified": info.mtime.toUTCString(),
    "accept-ranges": "bytes",
  });
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const head = req.method === "HEAD";

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = info.size;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(head ? null : body(path, start, end), { status: 206, headers });
  }
  headers.set("content-length", String(info.size));
  return new Response(head ? null : body(path), { status: 200, headers });
}

const stripped = new Map<string, { key: string; code: Promise<string> }>();

/**
 * `path` (a .ts file) as the JavaScript a `.js` URL names: types stripped (server/strip.ts), once per version of
 * the file (size + mtime, as the ETag). No ranges: browsers only ask for whole scripts.
 */
async function serveStripped(req: Request, path: string): Promise<Response> {
  const info = await stat(path);
  const key = `${info.size.toString(16)}-${info.mtimeMs.toString(16)}`;
  let hit = stripped.get(path);
  if (hit?.key !== key) {
    const fresh = hit = { key, code: readFile(path, "utf8").then(stripTypes) };
    fresh.code.catch(() => stripped.get(path) === fresh && stripped.delete(path)); // (the request reports it)
    stripped.set(path, fresh);
  }
  const code = await hit.code;
  const headers = new Headers({
    "content-type": TYPES[".js"],
    etag: `W/"${key}"`,
    "last-modified": info.mtime.toUTCString(),
  });
  if (req.headers.get("if-none-match") === `W/"${key}"`) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(Buffer.byteLength(code)));
  return new Response(req.method === "HEAD" ? null : code, { status: 200, headers });
}

/**
 * Serve `fsRoot` by URL path; directories serve their index.html. `stripTs`: a `.js` path with no such file but a
 * `.ts` beside it serves that, as JavaScript (the studio's sources are TypeScript; their URLs and imports say .js).
 */
export async function serveDir(req: Request, fsRoot: string, opts: { stripTs?: boolean } = {}): Promise<Response> {
  const root = resolve(fsRoot);
  let rel: string;
  try {
    rel = posix.normalize(decodeURIComponent(new URL(req.url).pathname));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  let path = resolve(join(root, rel));
  if (path !== root && !path.startsWith(root + sep)) return new Response("Not Found", { status: 404 });
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
  } catch {
    if (opts.stripTs && path.endsWith(".js")) {
      const ts = path.slice(0, -3) + ".ts";
      if (await stat(ts).then((i) => i.isFile(), () => false)) return serveStripped(req, ts);
    }
    /* otherwise serveFile 404s */
  }
  return serveFile(req, path);
}
