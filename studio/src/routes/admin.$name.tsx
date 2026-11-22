import { createFileRoute } from "@tanstack/react-router";
import { AdminSite } from "../views/admin/Site.tsx";

export const Route = createFileRoute("/admin/$name")({
  component: AdminSite,
});
