// #/artifacts (was #/pages): deploy and manage artifacts, static HTML with a visibility and a retention. Logged out:
// what they are, and a login.
import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../api-types.ts";
import { api, errorMessage } from "../lib/api.ts";
import { refocus } from "../lib/focus.ts";
import { bareUrl, keepOptions, keepParse, keepText, keepValue, pageName, untilText, VIS_LABEL } from "../lib/format.ts";
import { useAlive, useLoad, useView } from "../lib/hooks.ts";
import { logIn, session, useSession } from "../lib/session.ts";
import { toast } from "../lib/toast.tsx";
import { SlugField, useSlug } from "../ui/SlugField.tsx";
import { ExtLink, Icon, SrOnly } from "../ui/icons.tsx";

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast(`Copy failed: ${url}`);
  }
}

/** A picked folder's files, its top directory stripped; hidden files and folders (.git, .DS_Store) stay behind. */
interface PickedFile {
  f: File;
  path: string;
}
function folderFiles(list: FileList) {
  const files = [...list]
    .map((f) => ({ f, path: f.webkitRelativePath.split("/").slice(1).join("/") }))
    .filter(({ path }) => path && !path.split("/").some((seg) => seg.startsWith(".")));
  return { dir: list[0]?.webkitRelativePath.split("/")[0] ?? null, files };
}
const b64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const folderBody = async (files: PickedFile[]) =>
  ({ files: await Promise.all(files.map(async ({ f, path }) => ({ path, data: await b64(f), encoding: "base64" }))) });

/** A file input that picks a folder (React has no prop for it). */
const asFolderPicker = (el: HTMLInputElement | null) => el?.setAttribute("webkitdirectory", "");

/**
 * The deploy in flight, outlasting the view: left the page mid-deploy and came back, that deploy still owns the
 * dialog's work (a new dialog doesn't open until it's done). `gen`: the latest deploy.
 */
const upload = { active: false, gen: 0 };

export function Artifacts() {
  useView("pages", "Artifacts");
  const { token } = useSession();
  const dialog = useRef<DialogHandle>(null);
  const list = useLoad(() => (token ? api<{ pages: API.Page[] }>("/v1/pages").then((r) => r.pages) : Promise.resolve(null)), [token]);
  const openDialog = () => dialog.current?.open();
  const pages = list.data;
  return (
    <main id="pages" className="page" aria-labelledby="pages-title">
      <header className="page-head">
        <div>
          <h1 id="pages-title" tabIndex={-1}>Artifacts</h1>
          <p className="muted">Static HTML you share: one file, or a folder with an index.html. You choose who can open it and how long it's kept. Need a server, a database or rollback? Make a <Link to="/">project</Link> and deploy it as an app.</p>
        </div>
        {token ? <button className="btn primary" id="page-new" type="button" aria-haspopup="dialog" onClick={openDialog}><Icon name="plus" />New artifact</button> : null}
      </header>
      {token ? (
        <section className="block first" id="pages-main">
          <div id="page-list" className="pages-list">
            {list.error ? <p className="error">Could not load artifacts: {list.error.message}</p>
              : !pages ? null
              : pages.length ? (
                <ul className="list art-list" aria-label="Your artifacts">
                  {pages.map((p) => <PageRow key={p.id} p={p} reload={list.reload} />)}
                </ul>
              ) : (
                <div className="empty-state">
                  <strong>No artifacts yet</strong>
                  <span>Deploy an HTML file or a folder, or run <code>npx cresslet@latest deploy report.html</code>.</span>
                  <button className="btn primary sm" type="button" aria-haspopup="dialog" onClick={openDialog}><Icon name="plus" />New artifact</button>
                </div>
              )}
          </div>
        </section>
      ) : (
        <section className="block first" id="pages-login">
          <div className="panel split">
            <p className="muted small">Log in to deploy artifacts: private to the people you share them with, link-only, or public, and kept for as long as you choose.</p>
            <button className="btn primary" id="pages-login-btn" type="button" onClick={() => void logIn("#/artifacts")}><Icon name="github" />Log in with GitHub</button>
          </div>
        </section>
      )}
      {token ? <NewArtifactDialog key={token} ref={dialog} reload={list.reload} /> : null}
    </main>
  );
}

/** A popover menu under its button (native popover: Escape and a click outside close it, focus returns to the button). */
function RowMenu({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const menu = menuRef.current!, btn = btnRef.current!; // mounted
    const unlisten = () => {
      removeEventListener("scroll", hide, true);
      removeEventListener("resize", hide);
    };
    function hide() {
      if (menu.isConnected && menu.matches(":popover-open")) menu.hidePopover();
      else unlisten();
    }
    // Placed before it shows (under the button, right edges lined up), flipped above if there's no room below.
    const before = (e: Event) => {
      if ((e as ToggleEvent).newState !== "open") return;
      const r = btn.getBoundingClientRect();
      menu.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
      menu.style.top = `${r.bottom + 4}px`;
    };
    const toggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== "open") return unlisten();
      const r = btn.getBoundingClientRect();
      if (r.bottom + 4 + menu.offsetHeight > innerHeight) menu.style.top = `${Math.max(8, r.top - 4 - menu.offsetHeight)}px`;
      addEventListener("scroll", hide, true); // placed once: it closes rather than drift away from its row
      addEventListener("resize", hide);
      menu.querySelector<HTMLElement>("button, a")?.focus();
    };
    // Closed before the item acts, so a confirm() or a file picker isn't drawn over an open menu.
    const click = (e: Event) => void ((e.target as Element).closest("button, a") && hide()); // a click lands on an element
    // Tabbing out of it closes it too, so it doesn't sit over the rows focus moved on to.
    const menuOut = (e: FocusEvent) => void (e.relatedTarget && !menu.contains(e.relatedTarget as Node) && e.relatedTarget !== btn && hide());
    const btnOut = (e: FocusEvent) => void (e.relatedTarget && !menu.contains(e.relatedTarget as Node) && hide());
    menu.addEventListener("beforetoggle", before);
    menu.addEventListener("toggle", toggle);
    menu.addEventListener("click", click, true);
    menu.addEventListener("focusout", menuOut);
    btn.addEventListener("focusout", btnOut);
    return () => {
      unlisten(); // a row that goes (deleted) takes its listeners with it
      menu.removeEventListener("beforetoggle", before);
      menu.removeEventListener("toggle", toggle);
      menu.removeEventListener("click", click, true);
      menu.removeEventListener("focusout", menuOut);
      btn.removeEventListener("focusout", btnOut);
    };
  }, []);
  return (
    <>
      <button className="icon-btn row-more" type="button" title="More actions" aria-label={`More actions for ${label}`} popoverTarget={id} ref={btnRef}><Icon name="more" /></button>
      <div id={id} className="menu" popover="" ref={menuRef}>{children}</div>
    </>
  );
}

function PageRow({ p, reload }: { p: API.Page; reload: () => Promise<boolean> }) {
  const alive = useAlive();
  // This row's page: changed in place by its selects, and replaced by a list reload.
  const [row, setRow] = useState({ src: p, page: p });
  if (row.src !== p) setRow({ src: p, page: p });
  const page = row.src === p ? row.page : p;
  // A select's choice while it's being saved (it goes back to the page's value if that fails).
  const [visPending, setVisPending] = useState<API.Visibility | null>(null);
  const [keepPending, setKeepPending] = useState<string | null>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceDirRef = useRef<HTMLInputElement>(null);
  const manage = page.access === "owner" || page.access === "admin";
  const label = pageName(page);

  async function change(c: { visibility?: API.Visibility; retentionDays?: number | null }, select: HTMLSelectElement) {
    const done = () => (c.visibility ? setVisPending(null) : setKeepPending(null));
    try {
      const { page: next } = await api<{ page: API.Page }>(`/v1/pages/${encodeURIComponent(page.name)}`, { method: "PATCH", body: JSON.stringify(c) });
      if (alive.current) {
        flushSync(() => {
          setRow((r) => ({ ...r, page: next }));
          done();
        });
      }
      toast(c.visibility
        ? `${pageName(next)}: ${VIS_LABEL[next.visibility].toLowerCase()}`
        : `${pageName(next)} is kept ${next.retentionDays === null ? "forever" : untilText(next)}`);
    } catch (e) {
      toast(`Could not change ${pageName(page)}: ${errorMessage(e)}`);
      if (alive.current) flushSync(done);
    }
    if (alive.current) refocus(select); // disabling it meanwhile may have dropped focus
  }

  /** New files at the same link: one HTML file, or a folder (all of the page's files are replaced). */
  async function replace(input: HTMLInputElement, folder: boolean) {
    if (!input.files?.length) return;
    const account = session().token;
    try {
      let content;
      if (folder) {
        const { files } = folderFiles(input.files);
        if (!files.some((x) => x.path === "index.html")) throw new Error("that folder has no index.html at its top level");
        content = await folderBody(files);
      } else content = { html: await input.files[0]!.text() }; // at least one (above)
      if (session().token !== account) throw new Error("another account logged in meanwhile");
      await api(`/v1/pages/${encodeURIComponent(page.name)}`, { method: "PUT", body: JSON.stringify({ ...content, source: "studio" }) });
      toast(`Replaced ${pageName(page)} (same link)`);
    } catch (e) {
      toast(`Could not replace ${pageName(page)}: ${errorMessage(e)}`);
    }
    input.value = "";
    if (await reload()) refocus(document.getElementById("pages-title"));
  }

  async function remove() {
    if (!confirm(`Delete ${pageName(page)}? Its link stops working.`)) return;
    try {
      await api(`/v1/pages/${encodeURIComponent(page.name)}`, { method: "DELETE" });
    } catch (e) {
      toast(`Could not delete ${pageName(page)}: ${errorMessage(e)}`);
      return;
    }
    toast(`Deleted ${pageName(page)}`);
    if (await reload()) refocus(document.getElementById("pages-title"));
  }

  const canReplace = page.access !== "viewer";
  const hasMenu = canReplace || manage || page.access === "owner";
  const keepShown = keepPending ?? keepValue(page.retentionDays);
  return (
    <li className="art-row">
      <div className="art-main">
        <span className="file-ico" title={VIS_LABEL[page.visibility]}><Icon name={page.visibility === "private" ? "shield" : "globe"} /></span>
        <div className="art-text">
          <ExtLink href={page.url} className="ext art-title"><span className="truncate">{label}</span></ExtLink>
          <span className="sub"><span className="truncate">{bareUrl(page.url)}</span><span aria-hidden="true">·</span><span>{untilText(page)}</span></span>
        </div>
      </div>
      <div className="art-controls">
        {manage ? (
          <select className="input role-select" id={`vis-${page.id}`} title="Who can open it" aria-label={`Who can open ${label}`}
            value={visPending ?? page.visibility} disabled={visPending !== null}
            onChange={(e) => {
              const v = e.currentTarget.value as API.Visibility, select = e.currentTarget;
              flushSync(() => setVisPending(v));
              void change({ visibility: v }, select);
            }}>
            {Object.entries(VIS_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        ) : <span className="muted small">{VIS_LABEL[page.visibility]}</span>}
        {manage ? (
          <select className="input role-select" id={`keep-${page.id}`} title="Keep for" aria-label={`Keep ${label} for`}
            value={keepShown} disabled={keepPending !== null}
            onChange={(e) => {
              const v = e.currentTarget.value, select = e.currentTarget;
              flushSync(() => setKeepPending(v));
              void change({ retentionDays: keepParse(v) }, select);
            }}>
            {keepOptions(page.retentionDays).map((v) => <option key={v} value={v}>{keepText(keepParse(v))}</option>)}
          </select>
        ) : <span className="muted small">{keepText(page.retentionDays)}</span>}
      </div>
      <div className="art-actions">
        <button className="btn sm" type="button" title="Copy link" aria-label={`Copy link to ${label}`} onClick={() => void copyLink(page.url)}><Icon name="copy" /><span className="lbl">Copy link</span></button>
        {hasMenu ? (
          <RowMenu id={`more-${page.id}`} label={label}>
            {canReplace ? <button className="menu-item" type="button" onClick={() => replaceRef.current?.click()}><Icon name="refresh" />Replace with an HTML file<SrOnly>{` (${label}, same link)`}</SrOnly></button> : null}
            {canReplace ? <button className="menu-item" type="button" onClick={() => replaceDirRef.current?.click()}><Icon name="folder" />Replace with a folder<SrOnly>{` (${label}, same link)`}</SrOnly></button> : null}
            {manage ? <Link className="menu-item" to="/share/$name" params={{ name: page.name }}><Icon name="users" />Share<SrOnly>{` ${label}`}</SrOnly></Link> : null}
            {page.access === "owner" ? <hr className="menu-sep" /> : null}
            {page.access === "owner" ? <button className="menu-item danger" type="button" id={`delete-page-${page.id}`} onClick={() => void remove()}><Icon name="trash" />Delete<SrOnly>{` ${label}`}</SrOnly></button> : null}
          </RowMenu>
        ) : null}
        <input type="file" hidden accept=".html,.htm,text/html" ref={replaceRef} onChange={(e) => void replace(e.currentTarget, false)} />
        <input type="file" hidden multiple ref={(el) => { replaceDirRef.current = el; asFolderPicker(el); }} onChange={(e) => void replace(e.currentTarget, true)} />
      </div>
    </li>
  );
}

const VIS_HINT: Record<API.Visibility, string> = {
  private: "Only you and the people you share it with, logged in.",
  link: "Anyone who has the link. Search engines don't list it.",
  public: "Anyone. Search engines can list it.",
};
const NO_PICK = ["Nothing chosen", "Drop an HTML file here, or choose one."] as const;
/** What the dialog will send: one HTML file, or a folder's files (its top directory stripped). */
type Pick = { title: string | null; html: File; files?: undefined } | { title: string | null; files: PickedFile[]; html?: undefined };

interface DialogHandle {
  open(): void;
}

/** The new-artifact dialog: its files, address, who can open it and how long it's kept. */
function NewArtifactDialog({ ref, reload }: { ref: Ref<DialogHandle>; reload: () => Promise<boolean> }) {
  const alive = useAlive();
  // Navigation away has started (the next view may still be loading, with this dialog still open): a deploy not yet
  // sent isn't sent.
  const leaving = useRef(false);
  const router = useRouter();
  useEffect(() => router.subscribe("onBeforeNavigate", (e) => {
    if (e.toLocation.pathname !== "/artifacts") leaving.current = true; // (another view: this one unmounts)
  }), [router]);
  const dlgRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const opening = useRef(false);
  const slug = useSlug("page");
  const [pick, setPick] = useState<Pick | null>(null);
  const [shown, setShown] = useState<readonly [string, string]>(NO_PICK);
  const [error, setError] = useState("");
  const [visibility, setVisibility] = useState<API.Visibility>("private");
  const [retention, setRetention] = useState("30");
  const [keepDays, setKeepDays] = useState<number | null>(30); // the account's default: listed even if set elsewhere
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false); // a deploy in flight: Escape, Cancel and × do nothing, the pickers are off

  /** Opens at the account's defaults (asked for each time, so a change in Settings or elsewhere counts, and it never
   * starts at the first option), with a new generated address. */
  useImperativeHandle(ref, () => ({
    async open() {
      const dlg = dlgRef.current;
      if (!dlg || dlg.open || opening.current) return;
      // Left the page mid-deploy and came back: that deploy still owns the dialog (it closes it and clears its pick).
      if (upload.active) return toast("Still deploying your last artifact…");
      opening.current = true;
      let defaults;
      try {
        defaults = (await api<API.Settings>("/v1/me/settings")).pages;
      } catch (e) {
        return toast(`Could not load your artifact defaults: ${errorMessage(e)}`);
      } finally {
        opening.current = false;
      }
      if (!alive.current || dlg.open) return; // left the page meanwhile
      if (fileRef.current) fileRef.current.value = "";
      if (dirRef.current) dirRef.current.value = "";
      flushSync(() => {
        setPick(null);
        setShown(NO_PICK);
        setError("");
        setOver(false);
        setBusy(false);
        setVisibility(defaults.visibility);
        setKeepDays(defaults.retentionDays);
        setRetention(keepValue(defaults.retentionDays));
        slug.field.setValue("");
      });
      dlg.showModal();
      void slug.suggest();
    },
  }));

  function pickHtml(f: File | undefined) {
    if (dirRef.current) dirRef.current.value = "";
    setPick(f ? { title: f.name.replace(/\.html?$/i, ""), html: f } : null);
    setShown(f ? [f.name, f.size < 1024 ? `${f.size} bytes` : `${(f.size / 1024).toFixed(f.size < 10240 ? 1 : 0)} KB`] : NO_PICK);
    setError("");
  }
  function pickDir(list: FileList) {
    if (fileRef.current) fileRef.current.value = "";
    const { dir, files } = folderFiles(list);
    const noIndex = files.length > 0 && !files.some((x) => x.path === "index.html");
    const next = files.length && !noIndex ? { title: dir, files } : null;
    setPick(next);
    setShown(next ? [`${dir}/`, `${files.length} file${files.length === 1 ? "" : "s"}`] : NO_PICK);
    setError(noIndex ? "That folder has no index.html at its top level." : "");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pick) {
      if (!error) setError("Choose an HTML file or a folder first."); // else: why the pick was refused
      fileRef.current?.focus();
      return;
    }
    setError("");
    const dlg = dlgRef.current!; // mounted
    const mine = ++upload.gen;
    const chosen = pick; // what was chosen when Deploy was pressed (the file inputs are disabled meanwhile)
    const account = session().token;
    upload.active = true;
    flushSync(() => setBusy(true));
    try {
      const name = await slug.value();
      if (!name) {
        slug.field.input.current?.focus();
        return;
      }
      const content = chosen.html ? { html: await chosen.html.text() } : await folderBody(chosen.files);
      // Left the page (or another account logged in) before it was sent: don't act on it. (Once sent, it finishes.)
      if (session().token !== account) throw new Error("another account logged in meanwhile, so it wasn't deployed");
      if (!alive.current || !dlg.open || leaving.current) throw new Error("you left the page before it was sent, so it wasn't deployed");
      const { page } = await api<{ page: API.Page }>("/v1/pages", {
        method: "POST",
        body: JSON.stringify({ ...content, name, title: chosen.title, visibility, retentionDays: keepParse(retention), source: "studio" }),
      });
      upload.active = false;
      if (alive.current) setPick(null);
      dlg.close();
      toast(<span>{`Deployed ${pageName(page)}: `}<ExtLink href={page.url}>{bareUrl(page.url)}</ExtLink>{" "}
        <button className="btn sm" type="button" onClick={() => void copyLink(page.url)}><Icon name="copy" />Copy link</button></span>);
      if (await reload()) refocus(document.getElementById("page-new")); // from the empty state's button, which the list replaced
    } catch (err) {
      if (alive.current && dlg.open) setError(`Could not deploy: ${errorMessage(err)}`);
      else toast(`Could not deploy: ${errorMessage(err)}`); // closed by leaving the page meanwhile
    } finally {
      if (mine === upload.gen) {
        upload.active = false;
        if (alive.current) {
          flushSync(() => setBusy(false));
          if (dlg.open && !dlg.contains(document.activeElement)) uploadRef.current?.focus(); // disabling Deploy dropped focus
        }
      }
    }
  }

  const close = () => !upload.active && dlgRef.current?.close();
  // A file dropped anywhere in the dialog but the drop zone would make the browser open it, leaving the studio.
  const guard = (e: React.DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
  return (
    <dialog className="modal modal-lg" id="page-dialog" aria-labelledby="page-form-title" aria-describedby="page-form-desc" ref={dlgRef}
      onCancel={(e) => upload.active && e.preventDefault()} onDragOver={guard} onDrop={guard}>
      <form id="page-form" className="form page-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <div>
            <h2 id="page-form-title">New artifact</h2>
            <p className="muted small" id="page-form-desc">One HTML file, or a folder with an index.html at its top.</p>
          </div>
          <button className="icon-btn" type="button" id="page-close" aria-label="Close" disabled={busy} onClick={close}><Icon name="x" /></button>
        </div>
        <fieldset className="field">
          <legend>Files</legend>
          <div className="dropzone" id="page-drop" data-picked={String(!!pick)} data-over={over ? "true" : undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
            onDrop={(e) => {
              // An HTML file is picked; a folder needs the Folder button (a dropped folder can't be read as one here).
              e.preventDefault();
              setOver(false);
              if (upload.active) return;
              const item = e.dataTransfer.items?.[0];
              const f = e.dataTransfer.files[0];
              if (item?.webkitGetAsEntry?.()?.isDirectory) return setError("To deploy a folder, choose it with the Folder button.");
              if (!f || !/\.html?$/i.test(f.name)) return setError("Drop an .html file.");
              if (fileRef.current) fileRef.current.value = "";
              pickHtml(f);
            }}>
            <span className="dropzone-ico" aria-hidden="true"><Icon name="file" /></span>
            <div className="dropzone-text">
              <strong id="page-picked" aria-live="polite">{shown[0]}</strong>
              <span className="muted small" id="page-picked-sub">{shown[1]}</span>
            </div>
            <div className="dropzone-btns">
              <label className="btn sm file-btn">
                <input type="file" id="page-file" className="sr-only" accept=".html,.htm,text/html" disabled={busy}
                  ref={(el) => { fileRef.current = el; el?.setAttribute("autofocus", ""); }}
                  onChange={(e) => pickHtml(e.currentTarget.files?.[0])} />
                <Icon name="file" />HTML file
              </label>
              <label className="btn sm file-btn">
                <input type="file" id="page-dir" className="sr-only" multiple disabled={busy}
                  ref={(el) => { dirRef.current = el; asFolderPicker(el); }}
                  onChange={(e) => e.currentTarget.files && pickDir(e.currentTarget.files)} />
                <Icon name="folder" />Folder
              </label>
            </div>
          </div>
        </fieldset>
        <SlugField slug={slug} id="page-name"
          hint="A generated address can't be guessed, so a link-only artifact stays with the people you send it to. A name of your own is easier to share, and to guess." />
        <div className="page-fields">
          <div className="field">
            <label htmlFor="page-visibility">Who can open it</label>
            <select className="input" id="page-visibility" aria-describedby="vis-hint" value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as API.Visibility)}>
              {Object.entries(VIS_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <p className="muted small" id="vis-hint">{VIS_HINT[visibility]}</p>
          </div>
          <div className="field">
            <label htmlFor="page-retention">Keep for</label>
            <select className="input" id="page-retention" aria-describedby="page-retention-hint" value={retention} onChange={(e) => setRetention(e.currentTarget.value)}>
              {keepOptions(keepDays).map((v) => <option key={v} value={v}>{keepText(keepParse(v))}</option>)}
            </select>
            <p className="muted small" id="page-retention-hint">Counted from each deploy or change. Defaults are in <Link to="/settings">Settings</Link>.</p>
          </div>
        </div>
        <p className="error small" id="page-error" role="alert" hidden={!error}>{error}</p>
        <div className="row modal-foot">
          <button className="btn" type="button" id="page-cancel" disabled={busy} onClick={close}>Cancel</button>
          <button className="btn primary" id="page-upload" type="submit" disabled={busy} ref={uploadRef}><Icon name="rocket" />Deploy</button>
        </div>
      </form>
    </dialog>
  );
}
