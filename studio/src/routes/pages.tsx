import { createFileRoute, redirect } from "@tanstack/react-router";

// Artifacts were called pages.
export const Route = createFileRoute("/pages")({ beforeLoad: () => { throw redirect({ to: "/artifacts", replace: true }); } });
