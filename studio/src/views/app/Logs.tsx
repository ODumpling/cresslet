// An app's Logs tab: the last 200 lines, then live. The stream stops when the tab (or the page) is left.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { errorMessage } from "../../lib/api.ts";
import { useSession } from "../../lib/session.ts";
import { Seg } from "../../ui/bits.tsx";
import { appPath, useApp, useTabReload } from "./AppLayout.tsx";

type Kind = "all" | "request" | "app" | "system";
const KINDS: [Kind, string][] = [["all", "All"], ["request", "Requests"], ["app", "App output"], ["system", "System"]];
const MAX_LINES = 1000;
let lineId = 0; // React keys for the lines

export function AppLogs() {
  const { name } = useApp();
  const { token } = useSession();
  const [filter, setFilter] = useState<Kind>("all");
  const [lines, setLines] = useState<(API.LogLine & { n: number })[]>([]);
  const [state, setState] = useState("Connecting…");
  // Refresh: a new stream (and a new list).
  const [gen, setGen] = useState(0);
  const restart = useCallback(() => {
    flushSync(() => setGen((g) => g + 1));
    return Promise.resolve(true);
  }, []);
  useTabReload(restart);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLines([]);
    setState("Connecting…");
    const add = (batch: API.LogLine[]) => {
      const l = list.current;
      stick.current = !!l && l.scrollHeight - l.scrollTop - l.clientHeight < 40;
      const items = batch.map((x) => ({ ...x, n: lineId++ }));
      setLines((old) => [...old, ...items].slice(-MAX_LINES));
    };
    void (async () => {
      try {
        const res = await fetch(appPath(name, "/logs?n=200&follow=1"), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `${res.status}`);
        setState("Live");
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader(); // an ok GET's body
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const batch: API.LogLine[] = [];
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line) batch.push(JSON.parse(line));
          }
          if (batch.length) add(batch);
        }
        if (!ctrl.signal.aborted) setState("Disconnected");
      } catch (e) {
        if (!ctrl.signal.aborted) setState(`Disconnected: ${errorMessage(e)}`);
      }
    })();
    return () => ctrl.abort();
  }, [name, token, gen]);

  // Following the end: new lines keep it in view (not when scrolled up to read).
  useLayoutEffect(() => {
    const l = list.current;
    if (l && stick.current) l.scrollTop = l.scrollHeight;
    stick.current = false;
  }, [lines]);

  return (
    <>
      <div className="toolbar flush">
        <Seg options={KINDS} value={filter} onChange={setFilter} />
        <button className="btn sm" type="button" onClick={() => setLines([])}>Clear</button>
        <span className="muted small" role="status">{state}</span>
      </div>
      <div className="panel log-panel">
        <ol className="log-lines mono" aria-label="Log lines" tabIndex={0} data-filter={filter} ref={list}>
          {lines.map((l) => {
            const kind = l.kind === "stdout" || l.kind === "stderr" ? "app" : l.kind;
            return (
              <li key={l.n} data-kind={kind} data-k={l.kind}>
                <time dateTime={new Date(l.t).toISOString()}>{new Date(l.t).toLocaleTimeString()}</time>
                <span className="kind">{l.kind}</span>
                <span className="msg">{l.msg}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
