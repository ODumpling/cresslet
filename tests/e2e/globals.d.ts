// What the e2e scripts' page.evaluate callbacks keep on a preview page's window between calls.
export {};
declare global {
  interface Window {
    __marker?: number;
    __old?: number;
    __TSR_ROUTER__: { navigate(opts: { to: string }): Promise<void> };
    __ws?: WebSocket;
    __closed?: { code: number; reason: string; wasClean: boolean } | null;
    __welcome?: string;
    __spin?: Promise<string>;
  }
}
