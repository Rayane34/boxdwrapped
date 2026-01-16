/**
 * BoxdWrapped – Cloudflare Worker API
 *
 * Cette API :
 * - expose une route `/`
 * - expose une route `/recap?user=...`
 * - va chercher la page publique Letterboxd d’un utilisateur
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

    /**
     * Route d’accueil
     * http://localhost:8787/
     */
    if (url.pathname === "/") {
      return json({
        name: "BoxdWrapped API",
        description: "Better Letterboxd recap using public data",
        endpoints: {
          recap: "/recap?user=YOUR_USERNAME",
        },
        example: "/recap?user=test",
      });
    }

    /**
     * Route /recap
     * http://localhost:8787/recap?user=test
     */
    if (url.pathname === "/recap") {
      const user = url.searchParams.get("user");

      // Vérification du paramètre
      if (!user) {
        return json({ error: "Missing 'user' parameter" }, 400);
      }

      // URL du profil Letterboxd public
      const profileUrl = `https://letterboxd.com/${encodeURIComponent(user)}/`;

      let response: Response;

      try {
        // On télécharge la page Letterboxd
        response = await fetch(profileUrl, {
          headers: {
            // User-Agent propre (important)
            "User-Agent": "BoxdWrapped/0.1 (learning project)",
            "Accept": "text/html",
          },
        });
      } catch (error) {
        // Erreur réseau (Letterboxd down, pas de connexion, etc.)
        return json(
          {
            user,
            profileUrl,
            error: "Failed to fetch Letterboxd profile",
          },
          502
        );
      }

      // Profil introuvable
      if (response.status === 404) {
        return json(
          {
            user,
            profileUrl,
            exists: false,
            error: "Profile not found (404)",
          },
          404
        );
      }

      // Autre erreur (403, 429, 500…)
      if (!response.ok) {
        return json(
          {
            user,
            profileUrl,
            exists: null,
            error: `Letterboxd returned status ${response.status}`,
          },
          502
        );
      }

      // Pour l’instant, on ne parse pas encore le HTML
      return json({
        user,
        profileUrl,
        exists: true,
        status: response.status,
        message: "Profile page fetched successfully ✅",
      });
    }

    // Route inconnue
    return json({ error: "Not found" }, 404);
  },
};
