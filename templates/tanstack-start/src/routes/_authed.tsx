// Pathless layout: every route under routes/_authed/ needs a signed-in user (else → /login?redirect=…).
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { user: context.user };
  },
  component: Outlet,
});
