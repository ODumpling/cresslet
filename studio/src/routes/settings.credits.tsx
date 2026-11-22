import { createFileRoute } from "@tanstack/react-router";
import { SettingsCredits } from "../views/settings/Credits.tsx";

export const Route = createFileRoute("/settings/credits")({
  component: SettingsCredits,
});
