import { createFileRoute } from "@tanstack/react-router";
import { SettingsAccount } from "../views/settings/Account.tsx";

export const Route = createFileRoute("/settings/")({
  component: SettingsAccount,
});
