import { createFileRoute } from "@tanstack/react-router";
import { AdminCreditsAccount } from "../views/admin/CreditsAccount.tsx";

export const Route = createFileRoute("/admin-credits/$id")({
  component: AdminCreditsAccount,
});
