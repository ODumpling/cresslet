import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "../views/Settings.tsx";

export const Route = createFileRoute("/settings")({
  component: Settings,
});
