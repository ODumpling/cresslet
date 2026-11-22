import { createFileRoute } from "@tanstack/react-router";
import { PrivateView } from "../views/PrivateView.tsx";

export const Route = createFileRoute("/view/$name")({
  // ?path=… is the page path the visitor asked for (server/host.ts).
  validateSearch: (s: Record<string, unknown>) => ({ path: typeof s.path === "string" ? s.path : "/" }),
  component: PrivateView,
});
