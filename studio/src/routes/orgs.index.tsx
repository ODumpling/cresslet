import { createFileRoute } from "@tanstack/react-router";
import { MyOrgs } from "../views/orgs/MyOrgs.tsx";

export const Route = createFileRoute("/orgs/")({
  component: MyOrgs,
});
