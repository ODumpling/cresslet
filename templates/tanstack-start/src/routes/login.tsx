import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import { signIn } from "../server/auth";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } =>
    typeof s.redirect === "string" ? { redirect: s.redirect } : {},
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: "/dashboard" });
  },
  head: () => ({ meta: [{ title: "Sign in" }] }),
  component: Login,
});

function Login() {
  const { redirect: to } = Route.useSearch();
  return (
    <AuthForm
      title="Sign in"
      action="Sign in"
      submit={signIn}
      redirect={to ?? "/dashboard"}
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]}
      alt={{ text: "No account yet?", to: "/signup", label: "Sign up" }}
    />
  );
}
