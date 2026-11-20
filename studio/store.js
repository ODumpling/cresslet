// Browser-local project storage (IndexedDB). A project = { id, name, template, files, deploy, updatedAt }.
// `files` is a flat map path → string | Uint8Array, excluding node_modules / build output.
const DB = "cresslet-studio";
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

// Deploy keys live in localStorage, not IndexedDB: app code runs in workers on this origin and
// workers can read IndexedDB, but not localStorage.
const keyOf = (id) => `cresslet.deployKey.${id}`;
const deployKeys = {
  get(id) {
    try {
      return localStorage.getItem(keyOf(id));
    } catch {
      return null;
    }
  },
  /** True if stored (verified by reading back). */
  set(id, v) {
    try {
      v ? localStorage.setItem(keyOf(id), v) : localStorage.removeItem(keyOf(id));
      return localStorage.getItem(keyOf(id)) === (v || null);
    } catch {
      return false;
    }
  },
};
const withKey = (p) => p && p.deploy ? { ...p, deploy: { ...p.deploy, deployKey: deployKeys.get(p.id) ?? p.deploy.deployKey } } : p;
const stripKey = (p) => {
  // Keep the key in the record if localStorage can't hold it: losing it would lock the user out of an
  // anonymous app.
  if (!p.deploy?.deployKey || !deployKeys.set(p.id, p.deploy.deployKey)) return p;
  const { deployKey: _, ...deploy } = p.deploy;
  return { ...p, deploy };
};

/**
 * Moves every record's deploy key out of IndexedDB in one read-write transaction (so a concurrent save
 * or delete in another tab can't be undone). Resolves to the number of keys that couldn't be moved.
 */
export async function migrateDeployKeys() {
  const d = await db();
  return new Promise((resolve, reject) => {
    let left = 0;
    const t = d.transaction("projects", "readwrite");
    const req = t.objectStore("projects").openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (cur.value.deploy?.deployKey) {
        const next = stripKey(cur.value);
        if (next.deploy?.deployKey) left++;
        else cur.update(next);
      }
      cur.continue();
    };
    t.oncomplete = () => resolve(left);
    t.onerror = () => reject(t.error);
  });
}

export const projects = {
  list: () => tx("readonly", (s) => s.getAll()).then((all) => all.sort((a, b) => b.updatedAt - a.updatedAt)),
  get: (id) => tx("readonly", (s) => s.get(id)).then(withKey),
  /**
   * Never writes a deploy key to IndexedDB (app workers run while the studio saves). Resolves to false
   * if the key couldn't be kept in localStorage, so the caller can show it to the user.
   */
  async put(p) {
    let kept = true;
    let rec = p;
    if (p.deploy?.deployKey) {
      kept = deployKeys.set(p.id, p.deploy.deployKey);
      const { deployKey: _, ...deploy } = p.deploy;
      rec = { ...p, deploy };
    }
    await tx("readwrite", (s) => s.put({ ...rec, updatedAt: Date.now() }));
    return kept;
  },
  /** Changes only the name (in one transaction): never touches deploy keys or files. */
  rename: (id, name) => tx("readwrite", (s) => {
    const r = s.get(id);
    r.onsuccess = () => r.result && s.put({ ...r.result, name, updatedAt: Date.now() });
  }),
  delete: (id) => (deployKeys.set(id, null), tx("readwrite", (s) => s.delete(id))),
};

export const IGNORE = [/^node_modules(\/|$)/, /^dist(\/|$)/, /^\.cresslet(\/|$)/];
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
      return localStorage.getItem("cresslet.token");
    } catch {
      return null;
    }
  },
  set token(v) {
    try {
      v ? localStorage.setItem("cresslet.token", v) : localStorage.removeItem("cresslet.token");
    } catch { /* storage blocked */ }
  },
  get email() {
    try {
      return localStorage.getItem("cresslet.email");
    } catch {
      return null;
    }
  },
  set email(v) {
    try {
      v ? localStorage.setItem("cresslet.email", v) : localStorage.removeItem("cresslet.email");
    } catch { /* storage blocked */ }
  },
};
