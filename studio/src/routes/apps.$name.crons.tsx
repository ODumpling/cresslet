import { createFileRoute } from "@tanstack/react-router";
import { AppCrons } from "../views/app/Crons.tsx";

export const Route = createFileRoute("/apps/$name/crons")({
  component: AppCrons,
});
