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
    if (!u.hostname || !u.hostname.includes(".")) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function maybeFillHost(root: string, link: string): string {
  if (!link) return link;
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith("//")) return `https:${link}`;
  try {
    return new URL(link, root.endsWith("/") ? root : `${root}/`).href;
  } catch {
    return link;
  }
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
