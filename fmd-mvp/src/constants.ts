import type { AdvFilterState, CatalogAdvFilterPayload, GenreTri } from "./types";

/** Same as FMD2 `UserAgentDefault` (httpsendthread.pas). */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** Canonical EN keys (FMD2 defaultGenres) + ES labels for UI (A–Z by label). */
export const DEFAULT_GENRES: { id: string; label: string }[] = [
  { id: "Action", label: "Acción" },
  { id: "Adult", label: "Adulto" },
  { id: "Martial Arts", label: "Artes Marciales" },
  { id: "Adventure", label: "Aventura" },
  { id: "Gender Bender", label: "Cambio de sexo" },
  { id: "Comedy", label: "Comedia" },
  { id: "Sports", label: "Deportes" },
  { id: "Doujinshi", label: "Doujinshi" },
  { id: "Drama", label: "Drama" },
  { id: "Ecchi", label: "Ecchi" },
  { id: "Fantasy", label: "Fantasía" },
  { id: "Harem", label: "Harem" },
  { id: "Hentai", label: "Hentai" },
  { id: "Historical", label: "Historico" },
  { id: "Horror", label: "Horror" },
  { id: "Josei", label: "Josei" },
  { id: "Lolicon", label: "Lolicon" },
  { id: "Mature", label: "Maduro" },
  { id: "Mecha", label: "Mecha" },
  { id: "Mystery", label: "Misterio" },
  { id: "Musical", label: "Musical" },
  { id: "Psychological", label: "Psicológico" },
  { id: "Slice of Life", label: "Recuentos de la Vida" },
  { id: "Romance", label: "Romance" },
  { id: "Sci-fi", label: "Sci-Fi" },
  { id: "Seinen", label: "Seinen" },
  { id: "Shotacon", label: "Shotacon" },
  { id: "Shoujo", label: "Shoujo" },
  { id: "Shoujo Ai", label: "Shoujo Ai" },
  { id: "Shounen", label: "Shounen" },
  { id: "Shounen Ai", label: "Shounen Ai" },
  { id: "Supernatural", label: "Sobrenatural" },
  { id: "Tragedy", label: "Tragedia" },
  { id: "School Life", label: "Vida Escolar" },
  { id: "Webtoons", label: "Webtoons" },
  { id: "Yaoi", label: "Yaoi" },
  { id: "Yuri", label: "Yuri" },
];

export const FILTER_CUSTOM_HINT =
  "Géneros:\n" +
  "- Incluir: el manga debe tener este género.\n" +
  "- Excluir (X): el manga no debe tenerlo.\n" +
  "- Vacío: no importa.\n\n" +
  "Géneros extra:\n" +
  "- Separa varios con coma.\n" +
  "- Antepone ! o - para excluir.\n" +
  "- Ejemplo: Aventura, !Ecchi, Comedia.";

export function emptyAdvFilter(): AdvFilterState {
  const genres: Record<string, GenreTri> = {};
  for (const g of DEFAULT_GENRES) genres[g.id] = "ignore";
  return {
    genres,
    customGenres: "",
    title: "",
    authors: "",
    artists: "",
    summary: "",
    status: 4,
    matchMode: "all",
    onlyNew: false,
    allSites: false,
    useRegex: false,
  };
}

/** Snapshot for “Aplicar”: form edits must not change the list until Apply. */
export function cloneAdvFilter(f: AdvFilterState): AdvFilterState {
  return { ...f, genres: { ...f.genres } };
}

/** Build SQL-side filter payload for all-sites search (FMD2 GenerateSQLFilter). */
export function advFilterToPayload(f: AdvFilterState, newDays: number): CatalogAdvFilterPayload {
  const include_groups: string[][] = [];
  const exclude_aliases: string[] = [];

  for (const g of DEFAULT_GENRES) {
    const state = f.genres[g.id] ?? "ignore";
    const aliases = [g.id.toLowerCase(), g.label.toLowerCase()];
    if (state === "include") include_groups.push(aliases);
    if (state === "exclude") exclude_aliases.push(...aliases);
  }

  const custom = f.customGenres.trim();
  if (custom) {
    if (f.useRegex) {
      if (custom.startsWith("!") || custom.startsWith("-")) {
        const a = custom.slice(1).trim();
        if (a) exclude_aliases.push(a);
      } else {
        include_groups.push([custom]);
      }
    } else {
      for (const part of custom.split(",")) {
        const raw = part.trim();
        if (!raw) continue;
        if (raw.startsWith("!") || raw.startsWith("-")) {
          const a = raw.slice(1).trim().toLowerCase();
          if (a) exclude_aliases.push(a);
        } else {
          include_groups.push([raw.toLowerCase()]);
        }
      }
    }
  }

  return {
    title: f.title,
    authors: f.authors,
    artists: f.artists,
    summary: f.summary,
    status: f.status,
    match_mode: f.matchMode,
    only_new: f.onlyNew,
    use_regex: f.useRegex,
    new_days: newDays,
    include_groups,
    exclude_aliases,
  };
}

/** Civil Julian Day Number — same formula as FMD2 `DateToJDN`. */
export function dateToJdn(d: Date = new Date()): number {
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return Math.round(
    day +
      Math.floor((153 * m + 2) / 5) +
      365 * y +
      Math.floor(y / 4) -
      Math.floor(y / 100) +
      Math.floor(y / 400) -
      32045 -
      0.5,
  );
}

/** FMD2 highlight/filter: `jdn > todayJdn - newDays`. `jdn <= 0` is never new. */
export function isCatalogEntryNew(jdn: number, newDays: number): boolean {
  if (!jdn || jdn <= 0 || newDays <= 0) return false;
  return jdn > dateToJdn() - newDays;
}

export const CATALOG_PAGE = 250;
export const LOLI_VAULT_ID = "218b722b1eb34f2aa3863f84538c5b08";
export const THEME_KEY = "fmd-theme-dark";
export const CH_ROW_H = 52;
export const CH_ROW_GAP = 8;
export const CH_ROW_STRIDE = CH_ROW_H + CH_ROW_GAP;
export const CH_OVERSCAN = 8;
/** Coalesce `queue-changed` bursts before re-reading chapter marks. */
export const MARK_REFRESH_DEBOUNCE_MS = 150;
export const CAT_ROW_H = 44;
/** Title (2 lines) + source line when all-sites filter is on. */
export const CAT_ROW_H_ALL_SITES = 62;
export const CAT_OVERSCAN = 12;

export const DL_HIST = [
  { id: "hoy", label: "Hoy", maxH: 24 },
  { id: "ayer", label: "Ayer", maxH: 48 },
  { id: "d7", label: "Últimos 7 días", maxH: 24 * 7 },
  { id: "mes", label: "Este mes", maxH: 24 * 31 },
  { id: "m6", label: "Últimos 6 meses", maxH: 24 * 183 },
  { id: "old", label: "Más de 6 meses", maxH: Number.POSITIVE_INFINITY },
] as const;

export const DL_ST: Record<
  string,
  { id: string; label: string; color: string; bg: string; bar: string }
> = {
  running: {
    id: "active",
    label: "En progreso",
    color: "var(--text)",
    bg: "transparent",
    bar: "var(--accent)",
  },
  pending: {
    id: "queued",
    label: "En cola",
    color: "var(--muted)",
    bg: "transparent",
    bar: "var(--muted)",
  },
  cancelled: {
    id: "paused",
    label: "Detenido",
    color: "var(--warn)",
    bg: "var(--warn-bg)",
    bar: "var(--warn)",
  },
  failed: {
    id: "failed",
    label: "Falló",
    color: "var(--bad)",
    bg: "var(--bad-bg)",
    bar: "var(--bad)",
  },
  done: {
    id: "done",
    label: "Completado",
    color: "var(--ok)",
    bg: "var(--ok-bg)",
    bar: "var(--ok)",
  },
};

export const PACK_EXT: Record<string, string> = {
  none: "",
  zip: ".zip",
  cbz: ".cbz",
  pdf: ".pdf",
  epub: ".epub",
};

export const GENRE_TRI_CYCLE: GenreTri[] = ["ignore", "include", "exclude"];

/** SQLite settings keys (mirror Rust settings_keys). */
export const SK = {
  UA: "http.user_agent",
  PROXY: "http.proxy",
  TIMEOUT: "http.timeout_secs",
  HTTP_RETRIES: "http.retries",
  MAX_THREADS: "download.max_threads",
  UPDATE_LIST_THREADS: "connections.max_update_list_threads",
  FAV_THREADS: "connections.max_favorite_threads",
  PACK: "download.pack_format",
  PACK_DELETE: "download.pack_delete_folder",
  CONVERT: "download.convert_to",
  PAT_MANGA: "download.manga_folder_pattern",
  PAT_CHAPTER: "download.chapter_folder_pattern",
  PAT_PAGE: "download.page_name_pattern",
  MANGA_FOLDER_ON: "download.manga_folder_on",
  CHAPTER_FOLDER_ON: "download.chapter_folder_on",
  ASCII_ON: "download.ascii_on",
  ASCII_CHAR: "download.ascii_char",
  VOL_PAD: "download.vol_pad",
  CHAP_PAD: "download.chap_pad",
  VOL_DIGITS: "download.vol_digits",
  CHAP_DIGITS: "download.chap_digits",
  TASK_RETRIES: "download.task_retries",
  PARALLEL_TASKS: "download.parallel_tasks",
  ONE_CHAPTER_PER_MANGA: "download.one_chapter_per_manga",
  OUTPUT_DIR: "default_output_dir",
  MODULES_ENABLED: "modules.enabled",
  MODULES_UPDATER_SHOW_WARNING: "modulesupdater.show_update_warning",
  MODULES_UPDATER_AUTO_RESTART: "modulesupdater.auto_restart",
  MODULES_SOURCE: "modules.source",
  MODULES_SOURCE_URL: "modules.source_url",
  MODULES_BULK_THRESHOLD: "modules.updater.bulk_threshold",
  MODULES_THREADS: "modules.updater.threads",
  MODULES_FETCH_METADATA: "modules.updater.fetch_metadata",
  MODULES_METADATA_MAX_FILES: "modules.updater.metadata_max_files",
  MODULES_BACKUP_GENERATIONS: "modules.updater.backup_generations",
  MODULES_BACKUP_MAX_MB: "modules.updater.backup_max_mb",
  CATALOG_DB_URL: "catalog.db_url",
  FAV_INTERVAL_ON: "favorites.check_interval_on",
  FAV_INTERVAL_MIN: "favorites.check_interval_min",
  FAV_CHECK_ON_START: "favorites.check_on_start",
  FAV_DOWNLOAD_AFTER: "favorites.download_after_check",
  UI_LOAD_COVERS: "ui.load_covers",
  UI_LIVE_SEARCH: "ui.live_search",
  UI_GOTO_DL: "ui.goto_downloads_on_add",
  UI_GOTO_FAV: "ui.goto_favorites_on_add",
  UI_NEW_DAYS: "ui.new_days",
  UI_DL_LEFT_BAR: "ui.dl_show_left_bar",
  /** Last selected website/source in the Info «Fuente» combo. */
  UI_SELECTED_MODULE: "ui.selected_module",
  APP_THEME: "app.theme",
  AFTER_FINISH: "app.after_finish",
  LOG_ON: "log.enabled",
  LOG_FILE: "log.file",
  CONFIRM_EXIT: "dialogs.confirm_exit",
  CONFIRM_DELETE: "dialogs.confirm_delete",
  CONFIRM_EMPTY_LIST: "dialogs.confirm_empty_list",
  TRAY_MINIMIZE: "shell.tray_minimize",
  TRAY_START: "shell.tray_start_minimized",
  NOTIFY: "shell.notify_on_done",
  VACUUM: "db.vacuum_on_exit",
  CLEAR_DONE_EXIT: "queue.clear_done_on_exit",
  LONG_PATHS: "paths.long_paths",
  SORT_ON_ADD: "queue.sort_on_add",
  PNG_AS_JPEG: "download.png_as_jpeg",
  WEBP_AS: "download.webp_as",
  PNG_LEVEL: "download.png_level",
  JPEG_QUALITY: "download.jpeg_quality",
  PDF_QUALITY: "download.pdf_quality",
  REMOVE_MANGA_FROM_CHAPTER: "download.remove_manga_from_chapter",
  LANG: "app.language",
  CHECK_UPDATE_START: "updater.check_on_start",
  UPDATE_LIST_NO_INFO: "catalog.update_no_info",
  UPDATE_LIST_FULL_SCAN: "catalog.update_full_scan",
} as const;
