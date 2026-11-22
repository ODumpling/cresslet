import { createFileRoute } from "@tanstack/react-router";
import { SettingsArtifacts } from "../views/settings/Artifacts.tsx";

export const Route = createFileRoute("/settings/artifacts")({
  component: SettingsArtifacts,
});
