import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { cresslet } from "cresslet/vite";

export default defineConfig({
  server: { port: 3000 },
  // cresslet(): db, kv, files, secrets for server code under `vite dev` (local data in .cresslet/dev/)
  plugins: [cresslet(), tanstackStart(), viteReact()],
});
