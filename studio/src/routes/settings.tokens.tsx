import { createFileRoute } from "@tanstack/react-router";
import { SettingsTokens } from "../views/settings/Tokens.tsx";

export const Route = createFileRoute("/settings/tokens")({
  component: SettingsTokens,
});
