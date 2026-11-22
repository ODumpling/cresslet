// TypeScript → JavaScript for code that runs where Node's type stripping doesn't: the studio (served to
// browsers, server/static.ts) and the sandbox entry (run by workerd, server/runtime.ts). Erasable syntax only
// (the tsconfigs enforce it); "strip" mode blanks the types in place, so lines and columns stay those of the
// .ts source and no source map is needed.
import { stripTypeScriptTypes } from "node:module";

const WARNING = "stripTypeScriptTypes is an experimental feature";

export function stripTypes(source: string): string {
  // Node 24 warns once per process that the API is experimental: drop that one warning, nothing else.
  const emit = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    if (typeof warning === "string" && warning.startsWith(WARNING)) return;
    Reflect.apply(emit, process, [warning, ...rest]);
  };
  try {
    return stripTypeScriptTypes(source, { mode: "strip" });
  } finally {
    process.emitWarning = emit;
  }
}
