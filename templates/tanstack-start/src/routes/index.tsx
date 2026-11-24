import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user } = Route.useRouteContext();
  return (
    <main className="page">
      <section className="hero">
        <h1>TanStack Start on Cresslet</h1>
        <p className="lead">
          Server-rendered React with file routes and server functions, running in a Cresslet sandbox with its own SQLite
          database (<code>db</code>) and key-value store (<code>kv</code>).
        </p>
        {user ? (
          <Link to="/dashboard" className="button">Open your dashboard</Link>
        ) : (
          <div className="row">
            <Link to="/signup" className="button">Create an account</Link>
            <Link to="/login" className="button secondary">Sign in</Link>
          </div>
        )}
      </section>
      <section className="features">
        <div className="card">
          <h3>SSR + server functions</h3>
          <p>Pages render on the server; <code>createServerFn</code> handlers run there too and are called like functions.</p>
        </div>
        <div className="card">
          <h3>Auth</h3>
          <p>Email + password (PBKDF2), sessions in <code>kv</code> with a TTL, kv rate limits, CSRF checks.</p>
        </div>
        <div className="card">
          <h3>Data</h3>
          <p>Users and todos in <code>db</code>: a Drizzle schema, migrations from drizzle-kit. <code>GET /api/health</code> is a server route.</p>
        </div>
      </section>
    </main>
  );
}
