// Start instance: request middleware for every request. CSRF: state-changing requests (server functions are POSTs)
// must come from this site (Sec-Fetch-Site / Origin), so another site can't make a signed-in browser call them.
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: ({ request }) => request.method !== "GET" && request.method !== "HEAD" }),
  ],
}));
