/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Route d'accueil
    if (url.pathname === "/") {
      return json({
        name: "BoxdWrapped API",
        endpoints: {
          recap: "/recap?user=YOUR_USERNAME",
        },
        example: "/recap?user=test",
      });
    }

    // Route /recap
    if (url.pathname === "/recap") {
      const user = url.searchParams.get("user");

      if (!user) {
        return json({ error: "Missing 'user' parameter" }, 400);
      }

      return json({
        user,
        message: "BoxdWrapped API is working 🚀",
      });
    }

    return json({ error: "Not found" }, 404);
  },
};

