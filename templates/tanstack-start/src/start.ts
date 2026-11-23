// Start instance: request middleware for every request.
// - CSRF: state-changing requests (server functions are POSTs) must come from this site (Sec-Fetch-Site / Origin), so
//   another site can't make a signed-in browser call them.
// - Schema: the database is brought up to date on the first request (in the studio, the preview's first page load),
//   so its tables are there from the start, not only once some query needs them. Queries can rely on it.
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { migrate } from "./server/db.server";

const schema = createMiddleware().server(async ({ next }) => {
  await migrate();
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: ({ request }) => request.method !== "GET" && request.method !== "HEAD" }),
    schema,
  ],
}));
