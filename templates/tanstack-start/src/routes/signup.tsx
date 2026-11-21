import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "../components/AuthForm";
import { signUp } from "../server/auth";

export const Route = createFileRoute("/signup")({
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: "/dashboard" });
  },
  head: () => ({ meta: [{ title: "Sign up" }] }),
  component: () => (
    <AuthForm
      title="Create an account"
      action="Sign up"
      submit={signUp}
      redirect="/dashboard"
      fields={[
        { name: "name", label: "Name", type: "text", autoComplete: "name" },
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password (8+ characters)", type: "password", autoComplete: "new-password", minLength: 8 },
      ]}
      alt={{ text: "Already have an account?", to: "/login", label: "Sign in" }}
    />
  ),
});
