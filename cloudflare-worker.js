// TeamPro static cache policy for Cloudflare Workers.
// HTML stays revalidated; fingerprinted/static assets can be cached for a year.
// If you move /app behind Cloudflare Workers, route the site through this worker.

const STATIC_RE = /\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await fetch(request);
    const headers = new Headers(response.headers);

    if (request.method === "GET") {
      if (STATIC_RE.test(url.pathname)) {
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (url.pathname.endsWith(".html") || request.headers.get("accept")?.includes("text/html")) {
        headers.set("Cache-Control", "no-cache");
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
