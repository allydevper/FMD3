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
  HiddenEntry,
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

/** Opciones de renombrado tal como las espera el backend (`RenameOpts`). */
export type RenameOpts = {
  mangaFolderOn: boolean;
  chapterFolderOn: boolean;
  patManga: string;
  patChapter: string;
  patPage: string;
  asciiOn: boolean;
  asciiChar: string;
  removeMangaFromChapter: boolean;
  /** 0 = sin padding. */
  volDigits: number;
  /** 0 = sin padding. */
  chapDigits: number;
};

/** Ruta de ejemplo generada por el mismo código que nombra las descargas reales. */
export function renamePreview(opts: RenameOpts, outputDir: string, packExt: string) {
  return invoke<string>("rename_preview", { opts, outputDir, packExt });
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

/** Hide catalog rows permanently (until unhide). Returns snapshots for Undo. */
export function catalogHide(entries: CatalogEntry[]) {
  return invoke<CatalogEntry[]>("catalog_hide", { entries });
}

/** Restore previously hidden catalog rows (Undo). */
export function catalogUnhide(snapshots: CatalogEntry[]) {
  return invoke("catalog_unhide", { snapshots });
}

/** Papelera: títulos quitados de la lista (todos, o los de un módulo). */
export function catalogHiddenList(moduleId?: string) {
  return invoke<HiddenEntry[]>("catalog_hidden_list", { moduleId: moduleId ?? null });
}

export function catalogHiddenCount(moduleId?: string) {
  return invoke<number>("catalog_hidden_count", { moduleId: moduleId ?? null });
}

/** Restaura títulos concretos de la papelera. Devuelve cuántos. */
export function catalogUnhideLinks(moduleId: string, links: string[]) {
  return invoke<number>("catalog_unhide_links", { moduleId, links });
}

/** Vacía la papelera (de un módulo o entera) restaurando todo. Devuelve cuántos. */
export function catalogUnhideAll(moduleId?: string) {
  return invoke<number>("catalog_unhide_all", { moduleId: moduleId ?? null });
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

export function queueRedownload(id: number) {
  return invoke("queue_redownload", { id });
}

export function queueRemove(id: number) {
  return invoke("queue_remove", { id });
}

/** Delete on-disk chapter folder for a queue item (under output_dir). */
export function queueDeleteChapterFiles(id: number, website?: string) {
  return invoke<string>("queue_delete_chapter_files", {
    id,
    website: website ?? null,
  });
}

export function queueClearFinished() {
  return invoke<number>("queue_clear_finished");
}

export function downloadedChaptersList(moduleId: string, mangaUrl: string) {
  return invoke<string[]>("downloaded_chapters_list", { moduleId, mangaUrl });
}

export function queueActiveChapterLinks(moduleId: string, mangaUrl: string) {
  return invoke<string[]>("queue_active_chapter_links", { moduleId, mangaUrl });
}

/**
 * Canonical mark keys for `links`, same order. The backend owns the key rules —
 * never recompute them here, that is how the two definitions drifted apart.
 */
export function chapterMarkKeys(links: string[]) {
  return invoke<string[]>("chapter_mark_keys", { links });
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

/** Open folder for a queue item. Default: manga folder. Pass preferChapter for chapter dir. */
export function queueOpenItemFolder(id: number, preferChapter = false) {
  return invoke<string>("queue_open_item_folder", {
    id,
    preferChapter,
  });
}

/** Open chapter content: packed file (pdf/cbz/…) if present, else chapter folder. */
export function queueOpenItemContent(id: number) {
  return invoke<string>("queue_open_item_content", { id });
}

/** Probe on-disk format for queue items: pdf | cbz | zip | epub | folder. */
export function queueItemsContentFormat(ids: number[]) {
  return invoke<{ id: number; format: string }[]>("queue_items_content_format", {
    ids,
  });
}

/** Open the manga work folder (base + rename pattern), not just the download root. */
export function queueOpenMangaFolder(req: {
  outputDir: string;
  mangaTitle: string;
  website: string;
  mangaUrl?: string;
  moduleId?: string;
}) {
  return invoke<string>("queue_open_manga_folder", {
    outputDir: req.outputDir,
    mangaTitle: req.mangaTitle,
    website: req.website,
    mangaUrl: req.mangaUrl ?? null,
    moduleId: req.moduleId ?? null,
  });
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

export function onAskExitConfirm(handler: () => void): Promise<UnlistenFn> {
  return listen("ask-exit-confirm", () => handler());
}

export function appConfirmExit() {
  return invoke("app_confirm_exit");
}

export function appCancelExit() {
  return invoke("app_cancel_exit");
}
