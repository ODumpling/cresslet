import { createFileRoute, redirect } from "@tanstack/react-router";

// Any other address: the home page, as before.
export const Route = createFileRoute("/$")({ beforeLoad: () => { throw redirect({ to: "/", replace: true }); } });
