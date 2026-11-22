import { createFileRoute } from "@tanstack/react-router";
import { Org } from "../views/orgs/Org.tsx";

export const Route = createFileRoute("/orgs/$name")({
  component: Org,
});
