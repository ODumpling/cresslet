import { createFileRoute } from "@tanstack/react-router";
import { SettingsAgents } from "../views/settings/Agents.tsx";

export const Route = createFileRoute("/settings/agents")({
  component: SettingsAgents,
});
