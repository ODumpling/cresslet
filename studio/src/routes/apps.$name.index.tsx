import { createFileRoute } from "@tanstack/react-router";
import { AppOverview } from "../views/app/Overview.tsx";

export const Route = createFileRoute("/apps/$name/")({
  component: AppOverview,
});
