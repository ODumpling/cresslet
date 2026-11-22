import { createFileRoute } from "@tanstack/react-router";
import { Workspace } from "../views/workspace/Workspace.tsx";

export const Route = createFileRoute("/p/$id")({
  component: Workspace,
});
