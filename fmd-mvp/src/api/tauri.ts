import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CatalogAdvFilterPayload,
  CatalogEntry,
  CatalogFetchProgressEvent,
  CatalogProgressEvent,
  CatalogStats,
  Favorite,
  FavoriteAddRequest,
  FavoriteCheckResult,
  MangaCacheRow,
  MangaInfoResult,
  ModuleMeta,
  QueueAddRequest,
  QueueItem,
  QueueProgressEvent,
  UpdateListStats,
} from "../types";

export function settingsGet(key: string) {
  return invoke<string | null>("settings_get", { key });
}

export function settingsSet(key: string, value: string) {
  return invoke("settings_set", { key, value });
}

/** Carpeta del ejecutable — default de "Guardar en". */
export function defaultSaveDir() {
  return invoke<string>("default_save_dir");
}

export function modulesList() {
  return invoke<ModuleMeta[]>("modules_list_cmd");
}

export function modulesRefresh() {
  return invoke<number>("modules_refresh_cmd");
}

export function modulesMatchUrl(url: string) {
  return invoke<ModuleMeta[]>("modules_match_url_cmd", { url });
}

export function catalogStats(moduleId: string) {
  return invoke<CatalogStats>("catalog_stats", { moduleId });
}

export function catalogSearch(
  moduleId: string,
  query: string,
  limit?: number,
  offset?: number,
) {
  return invoke<CatalogEntry[]>("catalog_search", {
    moduleId,
    query,
    limit,
    offset,
  });
}

export function catalogCount(moduleId: string, query: string) {
  return invoke<number>("catalog_count", { moduleId, query });
}

export function catalogSearchAll(
  moduleIds: string[],
  query: string,
  filter?: CatalogAdvFilterPayload,
  limit?: number,
  offset?: number,
) {
  return invoke<CatalogEntry[]>("catalog_search_all", {
    moduleIds,
    query,
    filter: filter ?? null,
    limit,
    offset,
  });
}

export function catalogCountAll(
  moduleIds: string[],
  query: string,
  filter?: CatalogAdvFilterPayload,
) {
  return invoke<number>("catalog_count_all", {
    moduleIds,
    query,
    filter: filter ?? null,
  });
}

export function catalogImport(moduleId: string, path: string) {
  return invoke<CatalogStats>("catalog_import", { moduleId, path });
}

export function catalogUpdate(moduleId: string) {
  return invoke<UpdateListStats>("catalog_update", { moduleId });
}

export function catalogFetchFromServer(moduleId: string) {
  return invoke<CatalogStats>("catalog_fetch_from_server", { moduleId });
}

export function catalogJobBegin() {
  return invoke("catalog_job_begin");
}

export function catalogJobCancel() {
  return invoke("catalog_job_cancel");
}

export function downloadFmd2Db(url: string) {
  return invoke<string>("catalog_download_fmd2db", { url });
}

export function mangaCacheUpsert(args: {
  moduleId: string;
  link: string;
  title: string;
  altTitles: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  numchapter: number;
  cover: string;
}) {
  return invoke("manga_cache_upsert", {
    moduleId: args.moduleId,
    link: args.link,
    title: args.title,
    altTitles: args.altTitles,
    authors: args.authors,
    artists: args.artists,
    genres: args.genres,
    status: args.status,
    summary: args.summary,
    numchapter: args.numchapter,
    cover: args.cover,
  });
}

export function mangaCacheGet(moduleId: string, link: string) {
  return invoke<MangaCacheRow | null>("manga_cache_get", { moduleId, link });
}

export function cacheClear() {
  return invoke<string>("cache_clear");
}

export function coverLocalPath(moduleId: string, link: string) {
  return invoke<string | null>("cover_local_path", { moduleId, link });
}

export function coverEnsure(
  moduleId: string,
  link: string,
  coverUrl: string,
  referer: string | null,
) {
  return invoke<string>("cover_ensure", { moduleId, link, coverUrl, referer });
}

export function getMangaInfo(url: string, moduleId: string | null) {
  return invoke<MangaInfoResult>("get_manga_info", { url, moduleId });
}

export function queueList() {
  return invoke<QueueItem[]>("queue_list");
}

export function queueAdd(req: QueueAddRequest) {
  return invoke<number>("queue_add", { req });
}

export function queueStart() {
  return invoke("queue_start");
}

export function queueCancel(id: number) {
  return invoke("queue_cancel", { id });
}

export function queueRetry(id: number) {
  return invoke("queue_retry", { id });
}

export function queueRemove(id: number) {
  return invoke("queue_remove", { id });
}

export function queueClearFinished() {
  return invoke<number>("queue_clear_finished");
}

export function queueReorder(ids: number[]) {
  return invoke("queue_reorder", { ids });
}

export function favoritesList() {
  return invoke<Favorite[]>("favorites_list");
}

export function favoritesAdd(req: FavoriteAddRequest) {
  return invoke<Favorite>("favorites_add", { req });
}

export function favoritesRemove(id: number) {
  return invoke("favorites_remove", { id });
}

export function favoritesSetEnabled(id: number, enabled: boolean) {
  return invoke("favorites_set_enabled", { id, enabled });
}

export function favoritesCheck(id: number, enqueue: boolean) {
  return invoke<FavoriteCheckResult>("favorites_check", { id, enqueue });
}

export function favoritesCheckAll(enqueue: boolean) {
  return invoke<FavoriteCheckResult[]>("favorites_check_all", { enqueue });
}

export function favoritesImportList(json: string) {
  return invoke<number>("favorites_import_list", { json });
}

export function openExternal(path: string, args?: string) {
  return invoke("shell_open_external", { path, args: args ?? null });
}

export function openLogFile() {
  return invoke("log_open");
}

export function clearLogFile() {
  return invoke("log_clear");
}

export function vacuumDb() {
  return invoke("db_vacuum");
}

export function checkAppUpdate() {
  return invoke<string>("app_check_update");
}

export function updateModulesFromGithub() {
  return invoke<number>("modules_update_github");
}

export function onQueueChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("queue-changed", handler);
}

export function onQueueProgress(
  handler: (payload: QueueProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<QueueProgressEvent>("queue-progress", (e) => handler(e.payload));
}

export function onCatalogProgress(
  handler: (payload: CatalogProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<CatalogProgressEvent>("catalog-progress", (e) =>
    handler(e.payload),
  );
}

export function onCatalogFetchProgress(
  handler: (payload: CatalogFetchProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<CatalogFetchProgressEvent>("catalog-fetch-progress", (e) =>
    handler(e.payload),
  );
}

export function onLuaLog(handler: (msg: string) => Promise<void> | void): Promise<UnlistenFn> {
  return listen<string>("lua-log", (e) => handler(e.payload));
}
