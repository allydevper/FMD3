/**
 * Dev-only mock manga site under /__test_catalog (same Vite :1420).
 * Data: ../dev/test-catalog-titles.json
 *
 * Try: http://localhost:1420/__test_catalog/directorio?p=1
 * Delay: ?delay=80 (ms) on any request.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const PREFIX = "/__test_catalog";
const PER_PAGE = 18;
const DEFAULT_DELAY_MS = 50;

type RawRow = {
  titles?: string;
  descriptions?: string;
  genres?: string;
  links?: string;
};

type Entry = {
  id: string;
  index: number;
  title: string;
  summary: string;
  genres: string[];
  chapters: number;
  na: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseGenres(raw: string | undefined): string[] {
  if (!raw?.trim()) return ["Action", "Fantasy"];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function loadEntries(): Entry[] {
  const jsonPath = path.resolve(__dirname, "dev/test-catalog-titles.json");
  let rows: RawRow[] = [];
  try {
    rows = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as RawRow[];
  } catch {
    rows = [
      { titles: "Test Fallback One", descriptions: "Missing JSON.", genres: "['Action']" },
      { titles: "Test Fallback Two ¿ñ!", descriptions: "UTF-8 check.", genres: "['Comedy']" },
    ];
  }
  return rows.map((row, i) => {
    const n = i + 1;
    const id = `seed-${String(n).padStart(4, "0")}`;
    const na = i === 0 || i === 5 || i === 10;
    const chapters = i === 1 || i === 7 ? 0 : 3 + ((i * 7) % 40);
    return {
      id,
      index: n,
      title: (row.titles || id).trim() || id,
      summary: (row.descriptions || "").trim(),
      genres: parseGenres(row.genres),
      chapters,
      na,
    };
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PER_PAGE));
}

/** Newest-first (high index first) for SortedList. */
function pageSlice(entries: Entry[], page1: number): Entry[] {
  const total = entries.length;
  const pages = pageCount(total);
  const p = Math.min(Math.max(page1, 1), pages);
  // page 1 = last PER_PAGE items
  const end = total - (p - 1) * PER_PAGE;
  const start = Math.max(0, end - PER_PAGE);
  return entries.slice(start, end).reverse();
}

function renderDirectory(entries: Entry[], page1: number): string {
  const pages = pageCount(entries.length);
  const slice = pageSlice(entries, page1);
  const items = slice
    .map(
      (e) =>
        `<div class="item"><a href="series/${e.id}/"><span>${escapeHtml(e.title)}</span></a></div>`,
    )
    .join("\n");
  const pag = Array.from({ length: pages }, (_, i) => {
    const n = i + 1;
    return `<li><a href="directorio?p=${n}">${n}</a></li>`;
  }).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TestCatalog</title></head><body>
<div id="article-div">
${items}
</div>
<ul class="pagination">${pag}<li><a href="directorio?p=${pages}">${pages}</a></li></ul>
</body></html>`;
}

function renderSeries(e: Entry): string {
  if (e.na) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<h1 class="post-title"><a>N/A</a></h1>
<div id="categ"></div>
<span class="estado">Unknown</span>
<div id="sinopsis"></div>
<div id="c_list"></div>
</body></html>`;
  }
  const genres = e.genres
    .map((g) => `<a href="#">${escapeHtml(g)}</a>`)
    .join(" ");
  const chs = Array.from({ length: e.chapters }, (_, i) => {
    const n = e.chapters - i;
    return `<a href="ch-${n}/"><div><h3>Capítulo ${n}</h3></div></a>`;
  }).join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<h1 class="post-title"><a>${escapeHtml(e.title)}</a></h1>
<div id="info-i"><strong>Autor:</strong> Author ${e.index}</div>
<div id="categ">${genres}</div>
<span class="estado">${e.index % 2 === 0 ? "En desarrollo" : "Finalizado"}</span>
<div id="sinopsis">${escapeHtml(e.summary.slice(0, 2000))}</div>
<div id="c_list">
${chs}
</div>
</body></html>`;
}

function sendHtml(res: Connect.ServerResponse, html: string, status = 200) {
  const buf = Buffer.from(html, "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
}

export function testCatalogMockPlugin(): Plugin {
  let entries: Entry[] | null = null;
  const getEntries = () => {
    if (!entries) entries = loadEntries();
    return entries;
  };

  return {
    name: "fmd-test-catalog-mock",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || "/";
        if (!rawUrl.startsWith(PREFIX)) {
          next();
          return;
        }

        let u: URL;
        try {
          u = new URL(rawUrl, "http://127.0.0.1");
        } catch {
          sendHtml(res, "bad url", 400);
          return;
        }

        const delay = Number(u.searchParams.get("delay") ?? DEFAULT_DELAY_MS);
        if (Number.isFinite(delay) && delay > 0) {
          await sleep(Math.min(delay, 5000));
        }

        // Strip prefix: /__test_catalog/directorio → /directorio
        const sub = u.pathname.slice(PREFIX.length) || "/";
        const list = getEntries();

        if (sub === "/" || sub === "") {
          sendHtml(
            res,
            `<!DOCTYPE html><html><body><p>TestCatalog mock OK · ${list.length} titles · <a href="${PREFIX}/directorio?p=1">directorio</a></p></body></html>`,
          );
          return;
        }

        if (sub.startsWith("/directorio")) {
          const p = Number(u.searchParams.get("p") || "1") || 1;
          sendHtml(res, renderDirectory(list, p));
          return;
        }

        const m = sub.match(/^\/series\/(seed-\d{4})\/?$/);
        if (m) {
          const e = list.find((x) => x.id === m[1]);
          if (!e) {
            sendHtml(res, "not found", 404);
            return;
          }
          sendHtml(res, renderSeries(e));
          return;
        }

        sendHtml(res, "not found", 404);
      });
    },
  };
}
