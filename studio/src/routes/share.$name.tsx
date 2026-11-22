import { createFileRoute } from "@tanstack/react-router";
import { Share } from "../views/Share.tsx";

export const Route = createFileRoute("/share/$name")({
  component: Share,
});
