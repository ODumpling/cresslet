import { createFileRoute } from "@tanstack/react-router";
import { AdminSites } from "../views/admin/Sites.tsx";

export const Route = createFileRoute("/admin/")({
  component: AdminSites,
});
