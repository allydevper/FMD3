export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalize pasted manga URL for GetInfo.
 * Rejects plain text (`Listo.`), relative paths without a selected root, etc.
 * Accepts bare domains (`18kami.com/...`) by prefixing `https://`.
 */
export function normalizeMangaUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

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
