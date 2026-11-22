import { createFileRoute } from "@tanstack/react-router";
import { AdminOrgs } from "../views/admin/Orgs.tsx";

export const Route = createFileRoute("/admin-orgs")({
  component: AdminOrgs,
});
