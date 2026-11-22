import { createFileRoute } from "@tanstack/react-router";
import { AdminUsers } from "../views/admin/Users.tsx";

export const Route = createFileRoute("/admin-users")({
  component: AdminUsers,
});
