import { Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

type Field = { name: string; label: string; type: string; autoComplete: string; minLength?: number };

/** Sign-in / sign-up form: calls `submit` (a server function), then reloads the user and goes to `redirect`. */
export function AuthForm(props: {
  title: string;
  fields: Field[];
  submit: (opts: { data: Record<string, string> }) => Promise<{ ok: true } | { ok: false; error: string }>;
  action: string;
  redirect: string;
  alt: { text: string; to: "/login" | "/signup"; label: string };
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      const r = await props.submit({ data });
      if (!r.ok) return setError(r.error);
      await router.invalidate(); // the root route re-reads the user
      await router.navigate({ to: props.redirect.startsWith("/") ? props.redirect : "/dashboard" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <form className="card form" onSubmit={onSubmit}>
        <h1>{props.title}</h1>
        {props.fields.map((f) => (
          <label key={f.name}>
            {f.label}
            <input name={f.name} type={f.type} autoComplete={f.autoComplete} minLength={f.minLength} required />
          </label>
        ))}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "…" : props.action}</button>
        <p className="muted">
          {props.alt.text} <Link to={props.alt.to}>{props.alt.label}</Link>
        </p>
      </form>
    </main>
  );
}
