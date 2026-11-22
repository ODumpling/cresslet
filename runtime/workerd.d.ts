// What the sandbox entry uses of workerd beyond the web globals (tsconfig lib): its node:buffer, and the "app"
// module (the app's server bundle, server/runtime.ts workerdConfig). Minimal on purpose, instead of all of
// @cloudflare/workers-types: the entry touches only these.
declare module "node:buffer" {
  export const Buffer: {
    from(data: Uint8Array | ArrayBuffer): { toString(encoding: "base64"): string };
    from(data: string, encoding: "base64"): Uint8Array<ArrayBuffer>;
  };
}

declare module "app" {
  /** The app's default export (its handler or an object with fetch/scheduled); named exports are its own. */
  const exported: unknown;
  export default exported;
}
