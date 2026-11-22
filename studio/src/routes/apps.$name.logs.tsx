import { createFileRoute } from "@tanstack/react-router";
import { AppLogs } from "../views/app/Logs.tsx";

export const Route = createFileRoute("/apps/$name/logs")({
  component: AppLogs,
});
