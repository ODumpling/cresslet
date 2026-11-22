// Hand-written types for the TanStack Start build internals start-service.ts imports from a Start project's
// node_modules (@tanstack/router-generator, start-plugin-core, router-plugin; their dist files, by path): only what it
// uses, with TanStack's names. Values it only passes back to TanStack stay opaque (`unknown` / branded).
declare const opaque: unique symbol;

declare module "@tanstack/router-generator" {
  /** The generator's config (getConfig's result), passed back as is. */
  export interface Config { readonly [opaque]: "Config" }
  /** A crawl of the routes directory; `acc` is TanStack's own accumulator. */
  export interface CrawlingResult {
    acc: Record<string, unknown>;
  }
  export function getConfig(inline: Record<string, unknown>, root: string): Config;
  export class Generator {
    constructor(opts: { config: Config; root: string });
    run(): Promise<void>;
    getCrawlingResult(): Promise<CrawlingResult | null | undefined>;
    buildRouteTree(opts: CrawlingResult & { config: Record<string, unknown> }): { routeTreeContent: string };
    getRoutesByFileMap(): Map<string, unknown>;
  }
}

declare module "@tanstack/start-plugin-core/dist/esm/start-router-plugin/pruneServerOnlySubtrees.js" {
  import type { CrawlingResult } from "@tanstack/router-generator";
  export function pruneServerOnlySubtrees(crawl: CrawlingResult): Record<string, unknown>;
}

declare module "@tanstack/start-plugin-core/dist/esm/start-compiler/host.js" {
  /** A server function as the compiler reports it (start-build.ts ServerFn). */
  export interface ServerFnInfo {
    extractedFilename: string;
    functionName: string;
    isClientReferenced?: boolean;
  }
  export interface StartCompiler {
    ingestModule(m: { id: string; code: string }): void;
    compile(m: { id: string; code: string; detectedKinds: unknown }): Promise<{ code: string } | null | undefined>;
  }
  export function createStartCompiler(opts: {
    env: "client" | "server";
    envName: string;
    root: string;
    mode: "build";
    framework: "react";
    providerEnvName: string;
    compilerPlugins: unknown[];
    onServerFnsById: (fns: Record<string, ServerFnInfo>) => void;
    getKnownServerFns: () => Record<string, ServerFnInfo>;
    loadModule: (id: string) => Promise<void>;
    resolveId: (source: string, importer: string) => Promise<string | null>;
    warn: (message: string) => void;
  }): StartCompiler;
}

declare module "@tanstack/start-plugin-core/dist/esm/start-compiler/compiler.js" {
  export function detectKindsInCode(code: string, env: "client" | "server", opts: Record<string, unknown>): unknown;
}

declare module "@tanstack/start-plugin-core/dist/esm/start-compiler/config.js" {
  export function getTransformCodeFilterForEnv(env: "client" | "server", opts: Record<string, unknown>): RegExp[];
}

declare module "@tanstack/router-plugin/dist/esm/core/code-splitter/compilers.js" {
  export function compileCodeSplitReferenceRoute(opts: {
    code: string;
    codeSplitGroupings: unknown[];
    targetFramework: "react";
    filename: string;
    id: string;
    isProduction: boolean;
    deleteNodes: Set<string>;
    addHmr: boolean;
  }): { code: string } | null | undefined;
}
