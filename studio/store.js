// Browser-local project storage (IndexedDB). A project = { id, name, template, files, deploy, updatedAt }.
// `files` is a flat map path → string | Uint8Array, excluding node_modules / build output.
const DB = "clover-studio";
let dbp;

function db() {
  return dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("projects", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("projects", mode);
    const r = fn(t.objectStore("projects"));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const projects = {
  list: () => tx("readonly", (s) => s.getAll()).then((all) => all.sort((a, b) => b.updatedAt - a.updatedAt)),
  get: (id) => tx("readonly", (s) => s.get(id)),
  put: (p) => tx("readwrite", (s) => s.put({ ...p, updatedAt: Date.now() })),
  delete: (id) => tx("readwrite", (s) => s.delete(id)),
};

export const IGNORE = [/^node_modules(\/|$)/, /^dist(\/|$)/, /^\.clover(\/|$)/];
export const ignored = (path) => IGNORE.some((re) => re.test(path));

/** Flat map → WebContainer-style tree. */
export function toTree(files) {
  const root = {};
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) node = (node[dir] ??= { directory: {} }).directory;
    node[parts.at(-1)] = { file: { contents } };
  }
  return root;
}

/** WebContainer-style tree → flat map. */
export function fromTree(tree, prefix = "", out = {}) {
  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (node.directory) fromTree(node.directory, path, out);
    else if (node.file && "contents" in node.file) out[path] = node.file.contents;
  }
  return out;
}

export const auth = {
  get token() {
    try {
      return localStorage.getItem("clover.token");
    } catch {
      return null;
    }
  },
  set token(v) {
    try {
      v ? localStorage.setItem("clover.token", v) : localStorage.removeItem("clover.token");
    } catch { /* storage blocked */ }
  },
  get email() {
    try {
      return localStorage.getItem("clover.email");
    } catch {
      return null;
    }
  },
  set email(v) {
    try {
      v ? localStorage.setItem("clover.email", v) : localStorage.removeItem("clover.email");
    } catch { /* storage blocked */ }
  },
};
