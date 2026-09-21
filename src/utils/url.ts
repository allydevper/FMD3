export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const INVISIBLE_CHARS = /[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g;
const PROSE_TOKEN =
  /[áéíóúñüÁÉÍÓÚÑÜ]|^(?:el|la|los|las|de|del|en|un|una|capítulo|capitulo|nuevo|mira|este|esta|esto|link|enlace|anticlick|lee|aquí|aqui)$/i;
const URLISH_TOKEN = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
const HTTP_TOKEN_RE = /https?:\/\/[^\s<>"']+/gi;
const COLLAPSED_HTTP_RE = /https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s<>"']*/i;
const COLLAPSED_WWW_RE = /www\.[a-z0-9.-]+\.[a-z]{2,}[^\s<>"']*/i;
const COLLAPSED_BARE_RE = /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/[^\s<>"']*/i;

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_CHARS, "");
}

function trimUrlJunk(s: string): string {
  return s.replace(/[)\]}>.,;:!?]+$/g, "");
}

function unwrapWrappers(s: string): string {
  let t = s.trim();
  const md = t.match(/\]\((https?:\/\/[^)\s]+)\)/i);
  if (md) return md[1];
  t = t.replace(/^<([^<>]+)>$/, "$1").trim();
  t = t.replace(/^[`'"]+|[`'"]+$/g, "").trim();
  return t;
}

/** Undo common anticlick / defanging used in Telegram, Discord and forums. */
function refangAnticlick(s: string): string {
  return s
    .replace(/hxxps/gi, "https")
    .replace(/hxxp/gi, "http")
    .replace(/\[:\]/g, ":")
    .replace(/\[\/\]/g, "/")
    .replace(/\\\./g, ".")
    .replace(/\[\s*(?:\.|dot|punto)\s*\]/gi, ".")
    .replace(/\(\s*(?:\.|dot|punto)\s*\)/gi, ".")
    .replace(/\{\s*(?:\.|dot|punto)\s*\}/gi, ".")
    .replace(/\s+(?:dot|punto)\s+/gi, ".")
    .replace(/https?\s*:\s*\/\s*\//gi, (m) =>
      m.toLowerCase().startsWith("https") ? "https://" : "http://",
    )
    .replace(/www\s*\./gi, "www.");
}

function isUrlContinuation(token: string, urlSoFar: string): boolean {
  if (!token || PROSE_TOKEN.test(token)) return false;
  if (/^[/?#.&%=_~:@,;*+-]/.test(token)) return true;
  if (!URLISH_TOKEN.test(token)) return false;
  const last = urlSoFar.slice(-1);
  if ("./?#&=-_".includes(last)) return true;
  /* Space + letters after a host/path char is almost always caption text. */
  if (/[A-Za-z0-9]$/.test(urlSoFar) && /^[A-Za-z]{2,}$/.test(token)) return false;
  return true;
}

/**
 * Collapse anticlick spaces from the first URL-like token to the end of
 * that URL, stopping at surrounding caption text.
 */
function collapseAnticlickLine(line: string): string | null {
  const start = line.search(
    /(?:https?:\/\/|www\.|[a-z0-9-]+\s*\.\s*[a-z]{2,})/i,
  );
  if (start < 0) return null;
  const parts = line.slice(start).split(/(\s+)/);
  let url = "";
  for (const part of parts) {
    if (/^\s+$/.test(part)) continue;
    if (!url) {
      url = part;
      continue;
    }
    if (!isUrlContinuation(part, url)) break;
    url += part;
  }
  return url || null;
}

function pushCandidate(out: string[], raw: string | null | undefined) {
  if (!raw) return;
  const cleaned = unwrapWrappers(trimUrlJunk(raw.trim()));
  if (cleaned && !out.includes(cleaned)) out.push(cleaned);
}

function anticlickCandidates(raw: string): string[] {
  const text = refangAnticlick(stripInvisible(raw));
  const out: string[] = [];

  HTTP_TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(HTTP_TOKEN_RE)) pushCandidate(out, m[0]);
  pushCandidate(out, text);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    pushCandidate(out, trimmed);
    pushCandidate(out, collapseAnticlickLine(trimmed));
    pushCandidate(out, trimmed.replace(/\s+/g, ""));
  }

  const collapsed = text.replace(/\s+/g, "");
  const http = collapsed.match(COLLAPSED_HTTP_RE);
  if (http) pushCandidate(out, http[0]);
  const www = collapsed.match(COLLAPSED_WWW_RE);
  if (www) pushCandidate(out, www[0]);
  const bare = collapsed.match(COLLAPSED_BARE_RE);
  if (bare) pushCandidate(out, bare[0]);
  if (/^(?:https?:\/\/|www\.)/i.test(collapsed)) pushCandidate(out, collapsed);

  return out;
}

/**
 * Parse an already-cleaned absolute http(s) URL (or a bare domain path).
 * Rejects plain text (`Listo.`), relative paths without a selected root, etc.
 * Accepts bare domains (`18kami.com/...`) by prefixing `https://`.
 */
function parseAbsoluteHttpUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;

  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) {
    if (candidate.startsWith("//")) {
      candidate = `https:${candidate}`;
    } else if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/:?#]|$)/i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }

  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = (u.hostname || "").toLowerCase();
    /* Allow localhost / IPv6 loopback for TestCatalog and local mocks. */
    const local =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1";
    if (!host || (!local && !host.includes("."))) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Normalize pasted manga URL for GetInfo, including anticlick / defanged
 * links (`https:// sitio [.] com /manga/…`, `hxxps://…`).
 */
export function normalizeMangaUrl(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  for (const candidate of anticlickCandidates(raw)) {
    const parsed = parseAbsoluteHttpUrl(candidate);
    if (parsed) return parsed;
  }
  return parseAbsoluteHttpUrl(raw);
}

export function maybeFillHost(root: string, link: string): string {
  if (!link) return link;
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith("//")) return `https:${link}`;
  /* Match Rust lua_host::maybe_fill_host: concat onto RootURL (keeps path prefix). */
  const host = root.replace(/\/+$/, "");
  if (link.startsWith("/")) return `${host}${link}`;
  return `${host}/${link.replace(/^\/+/, "")}`;
}

export function resolveCover(cover: string, root: string): string {
  const c = (cover || "").trim();
  if (!c) return "";
  return maybeFillHost(root, c);
}

export function catalogLinkKey(link: string): string {
  try {
    const u = new URL(link);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "") || link;
  } catch {
    return link.replace(/\/+$/, "");
  }
}

/**
 * Path-only key so relative catalog links match absolute manga URLs.
 *
 * Used for favorites matching and for display — NOT for downloaded/queued chapter
 * marks. Those keys come from the backend (`api.chapterMarkKeys`), which owns the
 * single canonical definition.
 */
export function mangaPathKey(link: string): string {
  const s = (link || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    const path = s.split("?")[0].split("#")[0].trim();
    const withSlash = path.startsWith("/") ? path : `/${path}`;
    return withSlash.replace(/\/+$/, "").toLowerCase();
  }
}

/** Hostname without `www.`, or empty if `url` has no host (relative path). */
export function urlHostKey(url: string): string {
  const s = (url || "").trim();
  if (!s) return "";
  try {
    const href = s.startsWith("//") ? `https:${s}` : s;
    const u = new URL(href);
    return (u.hostname || "").replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** True when an absolute URL belongs to this module's RootURL host. */
export function urlMatchesModuleHost(url: string, rootUrl: string): boolean {
  const a = urlHostKey(url);
  const b = urlHostKey(rootUrl);
  return !!a && !!b && a === b;
}

/** True if two manga URLs/links likely point to the same title. */
export function urlsReferToSameManga(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (catalogLinkKey(a) === catalogLinkKey(b)) return true;
  const pa = mangaPathKey(a);
  const pb = mangaPathKey(b);
  if (!pa || !pb) return false;
  if (pa === pb) return true;
  // Relative vs absolute / host variants: share a meaningful path suffix.
  const shorter = pa.length <= pb.length ? pa : pb;
  const longer = pa.length <= pb.length ? pb : pa;
  return shorter.length > 4 && longer.endsWith(shorter);
}
