/**
 * Dev-only mock manga site under /__test_catalog (same Vite :1420).
 * Data: dev/test-catalog-titles.json + 10 downloadable titles (dl-*).
 * Images: .plan/caps/{1..8}/*.jpg
 *
 * Try: http://localhost:1420/__test_catalog/directorio?p=1
 * Delay: HTML ~50ms; each /caps/ image ~220ms (simulates page download).
 * Override any request: ?delay=80
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const PREFIX = "/__test_catalog";
const PER_PAGE = 18;
/** Catalog / series / chapter HTML. */
const DEFAULT_DELAY_MS = 50;
/** Per-image GET under /caps/ — simulates network download time. */
const IMAGE_DELAY_MS = 120;

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
  /** Downloadable demo titles with real page images. */
  downloadable: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPS_ROOT = path.resolve(__dirname, ".plan/caps");

const DL_TITLES: { title: string; summary: string }[] = [
  { title: "A", summary: "Título corto de un carácter." },
  { title: "Go", summary: "Título corto de dos caracteres." },
  { title: "XYZ", summary: "Título corto alfanumérico." },
  { title: "Noche corta", summary: "Título medio simple." },
  { title: "Camino del viento", summary: "Título medio descriptivo." },
  { title: "Crónicas del valle perdido", summary: "Título medio-largo." },
  {
    title:
      "[Historias Cortas De Otro Mundo] El retorno del viajero eterno y la memoria de las estrellas caídas en el mar del tiempo",
    summary: "Título muy largo con corchetes (estres UI / rename).",
  },
  { title: "DL Demo Mid: espadas & dragones ¿ñ!", summary: "UTF-8 y signos en el título." },
  { title: "B", summary: "Otro título de un carácter." },
  {
    title:
      "[Archivo] Saga interminable del caballero sin nombre que cruzó mil reinos buscando un final que nunca llegó (parte I)",
    summary: "Segundo título largo para ellipsis en cola y catálogo.",
  },
];

/** Mixed chapter labels within each downloadable manga (index 1..N). */
function chapterLabel(ch: number): string {
  switch (ch) {
    case 1:
      return "1";
    case 2:
      return "2";
    case 3:
      return "";
    case 4:
      return "Capítulo 4";
    case 5:
      return "Vol.1 Ch.05 - El bosque al amanecer";
    case 6:
      return "Extra: omake";
    case 7:
      return "";
    case 8:
      return "Capítulo 8 — Epílogo definitivo del arco (versión extendida)";
    case 9:
      return "Capítulo 9 — Arco nuevo (check al iniciar)";
    case 10:
      return "Capítulo 10 — Continuación";
    case 11:
      return "Capítulo 11 — Segundo lote de prueba";
    case 12:
      return "Capítulo 12 — Cierre del lote";
    default:
      return `Capítulo ${ch}`;
  }
}

/** Image folders on disk are only 1..8; map higher chapter indices onto them. */
function capImageFolder(ch: number): number {
  if (ch >= 1 && ch <= 8) return ch;
  return ((ch - 1) % 8) + 1;
}

function parseGenres(raw: string | undefined): string[] {
  if (!raw?.trim()) return ["Action", "Fantasy"];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function buildDownloadEntries(): Entry[] {
  return DL_TITLES.map((row, i) => {
    const n = i + 1;
    const num = String(n).padStart(2, "0");
    return {
      id: `dl-${String(n).padStart(4, "0")}`,
      index: n,
      title: `${num} · ${row.title}`,
      summary: row.summary,
      genres: ["Test", "Download"],
      // dl-0001 has extra chapters for favorites check smoke tests.
      chapters: n === 1 ? 12 : 8,
      na: false,
      downloadable: true,
    };
  });
}

function loadSeedEntries(startIndex: number): Entry[] {
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
    const n = startIndex + i;
    const id = `seed-${String(i + 1).padStart(4, "0")}`;
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
      downloadable: false,
    };
  });
}

/**
 * SortedList page 1 = last PER_PAGE of the array, then reversed.
 * Append dl-* at the end (newest); reverse order so after page reverse, dl-0001 is first.
 */
function loadEntries(): Entry[] {
  const dl = buildDownloadEntries();
  const seeds = loadSeedEntries(dl.length + 1);
  return [...seeds, ...[...dl].reverse()];
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
  const end = total - (p - 1) * PER_PAGE;
  const start = Math.max(0, end - PER_PAGE);
  return entries.slice(start, end).reverse();
}

function listCapImages(ch: number): string[] {
  const folder = capImageFolder(ch);
  const dir = path.join(CAPS_ROOT, String(folder));
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f));
  } catch {
    return [];
  }
  return files.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

function renderDirectory(entries: Entry[], page1: number): string {
  const pages = pageCount(entries.length);
  const slice = pageSlice(entries, page1);
  const items = slice
    .map(
      (e) =>
        /* Leading-/ path so catalog DB normalize → /series/id/; fill with RootURL keeps __test_catalog. */
        `<div class="item"><a href="/series/${e.id}/"><span>${escapeHtml(e.title)}</span></a></div>`,
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
    const label = e.downloadable ? chapterLabel(n) : `Capítulo ${n}`;
    const h3 = label ? `<h3>${escapeHtml(label)}</h3>` : `<h3></h3>`;
    /* Absolute under RootURL path segment (not site origin). */
    return `<a href="/series/${e.id}/ch-${n}/"><div>${h3}</div></a>`;
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

function renderChapter(e: Entry, ch: number): string {
  if (!e.downloadable) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<p>No pages for seed title.</p>
<div id="reader"></div>
</body></html>`;
  }
  const folder = capImageFolder(ch);
  const files = listCapImages(ch);
  const imgs = files
    .map((f) => {
      const src = `http://localhost:1420${PREFIX}/caps/${folder}/${encodeURIComponent(f)}`;
      return `<a class="page" href="${src}"></a><img src="${src}" alt="${escapeHtml(f)}" />`;
    })
    .join("\n");
  const label = chapterLabel(ch) || `Capítulo ${ch}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(label)}</title></head><body>
<h1>${escapeHtml(label)}</h1>
<div id="reader">
${imgs}
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

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function sendFile(res: Connect.ServerResponse, filePath: string) {
  try {
    const buf = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(filePath));
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
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

        const sub = u.pathname.slice(PREFIX.length) || "/";
        const isImage = /^\/caps\/[1-8]\//.test(sub);
        const delayParam = u.searchParams.get("delay");
        const delay = Number(
          delayParam ?? (isImage ? IMAGE_DELAY_MS : DEFAULT_DELAY_MS),
        );
        if (Number.isFinite(delay) && delay > 0) {
          await sleep(Math.min(delay, 5000));
        }

        const list = getEntries();

        if (sub === "/" || sub === "") {
          const dlN = list.filter((e) => e.downloadable).length;
          sendHtml(
            res,
            `<!DOCTYPE html><html><body><p>TestCatalog mock OK · ${list.length} titles (${dlN} downloadable) · <a href="${PREFIX}/directorio?p=1">directorio</a></p></body></html>`,
          );
          return;
        }

        if (sub.startsWith("/directorio")) {
          const p = Number(u.searchParams.get("p") || "1") || 1;
          sendHtml(res, renderDirectory(list, p));
          return;
        }

        const capImg = sub.match(/^\/caps\/([1-8])\/([^/]+)$/);
        if (capImg) {
          const ch = capImg[1]!;
          const name = decodeURIComponent(capImg[2]!);
          if (name.includes("..") || name.includes("/") || name.includes("\\")) {
            res.statusCode = 400;
            res.end("bad path");
            return;
          }
          sendFile(res, path.join(CAPS_ROOT, ch, name));
          return;
        }

        const seriesCh = sub.match(/^\/series\/((?:dl|seed)-\d{4})\/ch-(\d+)\/?$/);
        if (seriesCh) {
          const e = list.find((x) => x.id === seriesCh[1]);
          const ch = Number(seriesCh[2]);
          if (!e || !Number.isFinite(ch) || ch < 1) {
            sendHtml(res, "not found", 404);
            return;
          }
          sendHtml(res, renderChapter(e, ch));
          return;
        }

        const seriesOnly = sub.match(/^\/series\/((?:dl|seed)-\d{4})\/?$/);
        if (seriesOnly) {
          const e = list.find((x) => x.id === seriesOnly[1]);
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
