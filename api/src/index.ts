import * as cheerio from "cheerio";

/**
 * BoxdWrapped – Cloudflare Worker API
 * Routes:
 * - GET / : mini doc
 * - GET /recap?user=...&year=2025 : fetch profile + diary (année) + mini stats
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function textOrNull(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length ? v : null;
}

function toIntOrNull(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Télécharge une page HTML (comme un navigateur)
 * On renvoie aussi `finalUrl` pour voir si on a eu une redirection.
 */
async function fetchHtml(url: string): Promise<{
  status: number;
  ok: boolean;
  html: string;
  finalUrl: string;
}> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
  });

  const html = await res.text();
  return { status: res.status, ok: res.ok, html, finalUrl: res.url };
}

/**
 * Parse une page de diary et extrait les entrées.
 * Structure attendue d'après ton HTML:
 * - chaque entrée est un <tr class="diary-entry-row ...">
 * - le lien du film est dans: h2.name a
 * - le href ressemble à: /<user>/film/<slug>/
 * - la date est souvent dans data-viewing-date ou dans un lien /diary/films/for/YYYY/MM/DD/
 */
function parseDiaryEntries(html: string): Array<{
  date: string | null;
  title: string | null;
  filmUrl: string | null;
}> {
  const $ = cheerio.load(html);
  const entries: Array<{ date: string | null; title: string | null; filmUrl: string | null }> = [];

  // On cible d'abord les vraies lignes du diary
  const rows = $("tr.diary-entry-row");
  const rowSet = rows.length ? rows : $("tr");

  rowSet.each((_, tr) => {
    const row = $(tr);

    // Date: attribut ou balise time
    let date =
      textOrNull(row.attr("data-viewing-date")) ||
      textOrNull(row.find("time[datetime]").attr("datetime"));

    // Sinon, on tente de la déduire depuis le lien "daydate" qui ressemble à /diary/films/for/2025/03/03/
    if (!date) {
      const dayHref = textOrNull(row.find('a.daydate').attr("href"));
      const m = dayHref ? dayHref.match(/\/diary\/films\/for\/(\d{4})\/(\d{2})\/(\d{2})\//) : null;
      if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
    }

    // Film: le lien dans h2.name a
    const filmAnchor = row.find("h2.name a").first();
    const href = textOrNull(filmAnchor.attr("href"));
    const title = textOrNull(filmAnchor.text());

    if (!href) return;

    // href peut être relatif, on construit une URL complète
    const filmUrl = href.startsWith("http") ? href : `https://letterboxd.com${href}`;

    entries.push({
      date: date ? date.slice(0, 10) : null,
      title,
      filmUrl,
    });
  });

  // Fallback si jamais rien trouvé, on essaye large avec tout lien contenant /film/
  if (entries.length === 0) {
    $('a[href*="/film/"]').each((_, a) => {
      const el = $(a);
      const href = textOrNull(el.attr("href"));
      if (!href) return;

      const title = textOrNull(el.text());
      const parent = el.closest("tr, li, div");
      const date =
        textOrNull(parent.attr("data-viewing-date")) ||
        textOrNull(parent.find("time[datetime]").attr("datetime"));

      const filmUrl = href.startsWith("http") ? href : `https://letterboxd.com${href}`;

      entries.push({
        date: date ? date.slice(0, 10) : null,
        title,
        filmUrl,
      });
    });
  }

  return entries;
}

/**
 * Récupère les entrées diary d'une année donnée.
 * On utilise la page filtrée par année: /{user}/diary/films/for/{year}/
 * Pagination: /{user}/diary/films/for/{year}/page/2/
 */
async function fetchDiaryForYear(user: string, year: number): Promise<{
  year: number;
  pagesFetched: number;
  entries: Array<{ date: string; title: string | null; filmUrl: string }>;
  stoppedBecause: string;
  debug: {
    diaryBaseUrl: string;
    lastPageUrl: string;
    lastFinalUrl: string;
    diaryTitle: string;
    filmLinksCount: number;
    filmSubstringCount: number;
    rssHref: string;
    htmlSnippet: string;
  };
}> {
  const entries: Array<{ date: string; title: string | null; filmUrl: string }> = [];

  const diaryBaseUrl = `https://letterboxd.com/${encodeURIComponent(user)}/diary/films/for/${year}/`;

  const MAX_PAGES = 30;
  let pagesFetched = 0;
  let stoppedBecause = "max_pages_reached";

  let lastPageUrl = diaryBaseUrl;
  let lastFinalUrl = diaryBaseUrl;
  let diaryTitle = "";
  let filmLinksCount = 0;
  let filmSubstringCount = 0;
  let rssHref = "";
  let htmlSnippet = "";

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1 ? diaryBaseUrl : `${diaryBaseUrl}page/${page}/`;
    lastPageUrl = pageUrl;

    const { status, ok, html, finalUrl } = await fetchHtml(pageUrl);
    pagesFetched++;
    lastFinalUrl = finalUrl;

    const $d = cheerio.load(html);
    diaryTitle = ($d("title").first().text() || "").trim();

    // On compte large, car les liens peuvent être /<user>/film/...
    filmLinksCount = $d('a[href*="/film/"]').length;

    // Recherche brute dans le HTML
    filmSubstringCount = (html.match(/\/film\//g) || []).length;

    // RSS parfois présent dans le head
    rssHref = ($d('link[rel="alternate"][type="application/rss+xml"]').attr("href") || "").trim();

    htmlSnippet = html.slice(0, 300);

    if (status === 404) {
      stoppedBecause = "diary_not_found_or_private";
      break;
    }
    if (!ok) {
      stoppedBecause = `diary_http_${status}`;
      break;
    }

    const pageEntries = parseDiaryEntries(html);

    // Sur une page filtrée par année, si elle est vide on stop direct
    if (pageEntries.length === 0) {
      stoppedBecause = "no_entries_on_page";
      break;
    }

    for (const e of pageEntries) {
      const date = e.date ? e.date.slice(0, 10) : null;
      if (!date || !e.filmUrl) continue;

      entries.push({
        date,
        title: e.title,
        filmUrl: e.filmUrl,
      });
    }
  }

  // Si on a récupéré au moins une page mais rien, on garde no_entries_on_page
  if (entries.length === 0 && stoppedBecause === "max_pages_reached") {
    stoppedBecause = "no_entries_collected";
  }

  return {
    year,
    pagesFetched,
    entries,
    stoppedBecause,
    debug: {
      diaryBaseUrl,
      lastPageUrl,
      lastFinalUrl,
      diaryTitle,
      filmLinksCount,
      filmSubstringCount,
      rssHref,
      htmlSnippet,
    },
  };
}

function computeLongestStreak(entries: Array<{ date: string }>) {
  // dates uniques (un jour = 1)
  const days = Array.from(new Set(entries.map((e) => e.date))).sort(); // "YYYY-MM-DD" se trie bien en string

  let bestLen = 0;
  let bestStart: string | null = null;
  let bestEnd: string | null = null;

  let curLen = 0;
  let curStart: string | null = null;
  let prevTime: number | null = null;

  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);

    if (prevTime === null) {
      curLen = 1;
      curStart = d;
    } else {
      const diffDays = (t - prevTime) / (1000 * 60 * 60 * 24);

      if (diffDays === 1) {
        curLen += 1;
      } else {
        // streak cassé
        curLen = 1;
        curStart = d;
      }
    }

    // update best
    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
      bestEnd = d;
    }

    prevTime = t;
  }

  return {
    length: bestLen,
    start: bestStart,
    end: bestEnd,
  };
}

function computeStats(entries: Array<{ date: string; title: string | null; filmUrl: string }>) {
  // 1) Films par mois: "2025-11" -> count
  const byMonth: Record<string, number> = {};
  for (const e of entries) {
    const month = e.date.slice(0, 7); // YYYY-MM
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }

  const monthsSorted = Object.entries(byMonth)
    .sort((a, b) => b[1] - a[1]); // desc par count

  const topMonths = monthsSorted.slice(0, 5).map(([month, count]) => ({ month, count }));

  // 2) Nombre de jours actifs (au moins 1 film)
  const uniqueDays = new Set(entries.map((e) => e.date));
  const activeDays = uniqueDays.size;

  // 3) Top days (jours avec le plus de films)
  const byDay: Record<string, number> = {};
  for (const e of entries) byDay[e.date] = (byDay[e.date] ?? 0) + 1;

  const topDays = Object.entries(byDay)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([date, count]) => ({ date, count }));

  // 4) Longest streak
  const longestStreak = computeLongestStreak(entries);


  return {
    activeDays,
    topMonths,
    topDays,
    longestStreak,
  };
}



export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        name: "BoxdWrapped API",
        endpoints: {
          recap: "/recap?user=rayane347&year=2025",
        },
      });
    }

    if (url.pathname === "/recap") {
      const user = url.searchParams.get("user");
      const yearParam = url.searchParams.get("year");

      if (!user) return json({ error: "Missing 'user' parameter" }, 400);

      const year = toIntOrNull(yearParam) ?? 2025;

      // Profil: vérifie que le pseudo est bon
      const profileUrl = `https://letterboxd.com/${encodeURIComponent(user)}/`;
      const profileFetch = await fetchHtml(profileUrl);

      if (profileFetch.status === 404) {
        return json({ user, profileUrl, exists: false, error: "Profile not found (404)" }, 404);
      }
      if (!profileFetch.ok) {
        return json(
          { user, profileUrl, exists: null, error: `Letterboxd returned status ${profileFetch.status}` },
          502
        );
      }

      const $p = cheerio.load(profileFetch.html);
      const profile = { pageTitle: textOrNull($p("title").first().text()) };

      const diary = await fetchDiaryForYear(user, year);
	  const stats = computeStats(diary.entries);


      return json({
        user,
        profileUrl,
        profile,
        recap: {
          year,
          totalLogged: diary.entries.length,
          pagesFetched: diary.pagesFetched,
          stoppedBecause: diary.stoppedBecause,
          sampleEntries: diary.entries.slice(0, 65),
          debug: diary.debug,
		  stats,
        },
        message: "Diary fetched + year recap generated ✅",
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
