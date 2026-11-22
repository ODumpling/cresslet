import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "../views/app/AppLayout.tsx";

export const Route = createFileRoute("/apps/$name")({
  component: AppLayout,
});
