export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
