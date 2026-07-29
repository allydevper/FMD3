import type { Favorite } from "../types";
import * as api from "../api/tauri";
import { urlsReferToSameManga } from "./url";

let cache: Favorite[] | null = null;
let inflight: Promise<Favorite[]> | null = null;

export function invalidateFavoritesCache(): void {
  cache = null;
}

export function peekFavoritesCache(): Favorite[] | null {
  return cache;
}

export function favoritesCacheUpsert(fav: Favorite): void {
  if (!cache) {
    cache = [fav];
    return;
  }
  const i = cache.findIndex((f) => f.id === fav.id);
  if (i >= 0) cache = cache.map((f, idx) => (idx === i ? fav : f));
  else cache = [...cache, fav];
}

export function favoritesCacheRemove(id: number): void {
  if (!cache) return;
  cache = cache.filter((f) => f.id !== id);
}

/** Load favorites (shared cache). `force` bypasses memory cache. */
export async function loadFavoritesCached(force = false): Promise<Favorite[]> {
  if (!force && cache) return cache;
  if (!force && inflight) return inflight;
  const req = api
    .favoritesList()
    .then((list) => {
      cache = list;
      return list;
    })
    .finally(() => {
      if (inflight === req) inflight = null;
    });
  inflight = req;
  return req;
}

export function matchFavorite(
  favs: Favorite[],
  url: string,
  moduleId?: string | null,
  rowLink?: string,
): Favorite | undefined {
  const mid = (moduleId || "").trim();
  const link = (rowLink || "").trim();
  return favs.find((f) => {
    if (url && urlsReferToSameManga(f.manga_url, url)) return true;
    if (link && urlsReferToSameManga(f.manga_url, link)) return true;
    if (mid && f.module_id === mid) {
      if (url && urlsReferToSameManga(f.manga_url, url)) return true;
      if (link && urlsReferToSameManga(f.manga_url, link)) return true;
    }
    return false;
  });
}

/** Sync lookup against warm cache only (no I/O). */
export function matchFavoriteCached(
  url: string,
  moduleId?: string | null,
  rowLink?: string,
): Favorite | undefined | null {
  if (!cache) return null;
  return matchFavorite(cache, url, moduleId, rowLink);
}
