import { createFileRoute } from "@tanstack/react-router";
import { AppSettings } from "../views/app/Settings.tsx";

export const Route = createFileRoute("/apps/$name/settings")({
  component: AppSettings,
});
