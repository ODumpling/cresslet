// How the studio writes sizes, times and counts.
import type * as API from "../../api-types.ts";

export const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
};
const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
export const ago = (iso: string | number | null | undefined) => {
  if (!iso) return "—";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, sec] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(s) >= sec) return rtf!.format(Math.round(s / sec), unit);
  }
  return rtf!.format(Math.round(s), "second");
};
export const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : "never";
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const bareUrl = (url: string) => url.replace(/^https?:\/\//, "");

export const STATUS: Record<string, string> = { running: "Running", idle: "Idle", empty: "Not deployed", deleted: "Deleted" };
export const ACCESS_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", viewer: "Viewer" };
export const ORG_ROLE_LABEL: Record<API.OrgRole, string> = { admin: "Admin", member: "Member" };
export const ownerText = (o: API.Owner | null | undefined) => (o ? o.github ?? o.email : "Anonymous");
export const personText = (p: API.Owner) => (p.github ? `${p.github} (${p.email})` : p.email);
export const canManage = (access: string | undefined) => access === "owner" || access === "admin";

/** Artifacts: who can open them and how long they're kept. */
export const VIS_LABEL: Record<API.Visibility, string> = { private: "Private", link: "Anyone with the link", public: "Public" };
export const keepText = (d: number | null) => (d === null ? "Forever" : d === 365 ? "1 year" : `${d} day${d === 1 ? "" : "s"}`);
export const keepValue = (d: number | null) => (d === null ? "forever" : String(d));
export const keepParse = (v: string) => (v === "forever" ? null : Number(v));
export const KEEP_OPTIONS = ["1", "7", "30", "90", "365", "forever"];
/** The retention choices, plus `days` if it was set elsewhere (CLI or API) and isn't one of them, in order. */
export function keepOptions(days: number | null) {
  const v = keepValue(days);
  if (KEEP_OPTIONS.includes(v)) return KEEP_OPTIONS;
  const i = KEEP_OPTIONS.findIndex((o) => o === "forever" || Number(o) > days!); // not null: "forever" is an option
  return [...KEEP_OPTIONS.slice(0, i), v, ...KEEP_OPTIONS.slice(i)];
}
export const pageName = (p: API.Page) => p.title ?? p.name;
export const untilText = (p: API.Page) => (p.expiresAt ? `until ${new Date(p.expiresAt).toLocaleDateString()}` : "no expiry");
