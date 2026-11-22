import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { projects } from "../../store.ts";
import { mustLogIn } from "../lib/api.ts";
import { useSession } from "../lib/session.ts";
import { Home } from "../views/Home.tsx";
import { Landing } from "../views/Landing.tsx";

export const Route = createFileRoute("/")({ component: Index });

/** The landing page when logged out (and, on servers without login, for new visitors with no local projects), else
 *  the projects dashboard. */
function Index() {
  const { token } = useSession();
  const [landing, setLanding] = useState<boolean | null>(token ? false : null);
  useEffect(() => {
    if (token) return setLanding(false);
    let live = true;
    void (async () => {
      const local = await mustLogIn() ? [] : await projects.list().catch(() => []);
      if (live) setLanding(!local.length);
    })();
    return () => void (live = false);
  }, [token]);
  if (landing === null) return null;
  return landing ? <Landing /> : <Home />;
}
