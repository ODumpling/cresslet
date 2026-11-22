import { createFileRoute } from "@tanstack/react-router";
import { CliLogin } from "../views/CliLogin.tsx";

export const Route = createFileRoute("/cli")({
  component: CliLogin,
});
