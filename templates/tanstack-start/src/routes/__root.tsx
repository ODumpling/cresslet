/// <reference types="vite/client" />
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { getUser, signOut, type User } from "../server/auth";
import css from "../styles.css?url";

export const Route = createRootRouteWithContext<{ user: User | null }>()({
  // runs on the server for the first page, then before each client navigation
  beforeLoad: async () => ({ user: await getUser() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Cresslet app" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  shellComponent: Shell,
  component: Layout,
  notFoundComponent: () => (
    <main className="page narrow">
      <h1>Not found</h1>
      <p>
        That page doesn't exist. <Link to="/">Go home</Link>
      </p>
    </main>
  ),
  errorComponent: ErrorPage,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Layout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">Cresslet app</Link>
        <nav>
          {user ? (
            <>
              <Link to="/dashboard" activeProps={{ className: "active" }}>Dashboard</Link>
              <span className="muted">{user.name}</span>
              <button
                className="link"
                onClick={async () => {
                  await signOut();
                  await router.invalidate();
                  await router.navigate({ to: "/" });
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" activeProps={{ className: "active" }}>Sign in</Link>
              <Link to="/signup" className="button small">Sign up</Link>
            </>
          )}
        </nav>
      </header>
      <Outlet />
    </>
  );
}

function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="page narrow">
      <h1>Something went wrong</h1>
      <p className="error">{error instanceof Error ? error.message : String(error)}</p>
      <button
        onClick={() => {
          reset();
          router.invalidate();
        }}
      >
        Try again
      </button>
    </main>
  );
}
