import { createFileRoute } from "@tanstack/react-router";
import { AppSecrets } from "../views/app/Secrets.tsx";

export const Route = createFileRoute("/apps/$name/secrets")({
  component: AppSecrets,
});
