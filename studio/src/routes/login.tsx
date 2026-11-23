import { createFileRoute } from "@tanstack/react-router";
import { Login } from "../views/Login.tsx";

export const Route = createFileRoute("/login")({
  component: Login,
});
