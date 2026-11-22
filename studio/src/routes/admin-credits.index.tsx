import { createFileRoute } from "@tanstack/react-router";
import { AdminCredits } from "../views/admin/Credits.tsx";

export const Route = createFileRoute("/admin-credits/")({
  component: AdminCredits,
});
