import { ClientOnly, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Layout } from "../ui/Layout.tsx";
import "../../vendor/xterm.css";
import "../../styles.css";

export const Route = createRootRoute({
  // Nothing renders server-side: the prerendered shell is just the document (the app needs the browser: hash routes,
  // localStorage, IndexedDB, the container).
  ssr: false,
  head: () => ({
    meta: [
      { charSet: "UTF-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { name: "color-scheme", content: "dark light" },
      { title: "Cresslet Studio" },
    ],
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  }),
  shellComponent: Shell,
  component: () => <ClientOnly><Layout /></ClientOnly>,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* here, not in head(): it keeps one meta per name */}
        <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)" />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
