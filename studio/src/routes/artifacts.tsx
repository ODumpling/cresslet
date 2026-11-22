import { createFileRoute } from "@tanstack/react-router";
import { Artifacts } from "../views/Artifacts.tsx";

export const Route = createFileRoute("/artifacts")({
  component: Artifacts,
});
