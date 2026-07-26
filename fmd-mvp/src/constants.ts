import type { AdvFilterState, GenreTri } from "./types";

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

export const CATALOG_PAGE = 250;
export const LOLI_VAULT_ID = "218b722b1eb34f2aa3863f84538c5b08";
export const THEME_KEY = "fmd-theme-dark";
export const CH_ROW_H = 52;
export const CH_ROW_GAP = 8;
export const CH_ROW_STRIDE = CH_ROW_H + CH_ROW_GAP;
export const CH_OVERSCAN = 8;
export const CAT_ROW_H = 44;
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

export const RENAME_SAMPLE: Record<string, string> = {
  "%MANGA%": "One Piece",
  "%WEBSITE%": "MangaDex",
  "%AUTHOR%": "Eiichiro Oda",
  "%ARTIST%": "Eiichiro Oda",
  "%NUMBERING%": "003",
  "%CHAPTER%": "Chapter 3",
  "%FILENAME%": "003",
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
  OUTPUT_DIR: "default_output_dir",
  MODULES_ENABLED: "modules.enabled",
  CATALOG_DB_URL: "catalog.db_url",
  FAV_INTERVAL_ON: "favorites.check_interval_on",
  FAV_INTERVAL_MIN: "favorites.check_interval_min",
  FAV_CHECK_ON_START: "favorites.check_on_start",
  FAV_OPEN_ON_START: "favorites.open_on_start",
  FAV_DOWNLOAD_AFTER: "favorites.download_after_check",
  FAV_REMOVE_COMPLETED: "favorites.remove_completed",
  UI_LOAD_COVERS: "ui.load_covers",
  UI_LIVE_SEARCH: "ui.live_search",
  UI_GOTO_DL: "ui.goto_downloads_on_add",
  UI_GOTO_FAV: "ui.goto_favorites_on_add",
  UI_NEW_DAYS: "ui.new_days",
  UI_DL_TOOLBAR: "ui.dl_show_toolbar",
  UI_DL_CLEAR_BTN: "ui.dl_show_clear_btn",
  UI_DL_LEFT_BAR: "ui.dl_show_left_bar",
  APP_THEME: "app.theme",
  AFTER_FINISH: "app.after_finish",
  LOG_ON: "log.enabled",
  LOG_FILE: "log.file",
  EXT_ON: "external.viewer_on",
  EXT_PATH: "external.viewer_path",
  EXT_ARGS: "external.viewer_args",
  CONFIRM_EXIT: "dialogs.confirm_exit",
  CONFIRM_DELETE: "dialogs.confirm_delete",
  CONFIRM_EMPTY_LIST: "dialogs.confirm_empty_list",
  TRAY_MINIMIZE: "shell.tray_minimize",
  TRAY_START: "shell.tray_start_minimized",
  SINGLE_INSTANCE: "shell.single_instance",
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
  DROPBOX_ON: "dropbox.enabled",
  DROPBOX_MODE: "dropbox.mode",
  DROPBOX_OPACITY: "dropbox.opacity",
  LANG: "app.language",
  CHECK_UPDATE_START: "updater.check_on_start",
  UPDATE_LIST_NO_INFO: "catalog.update_no_info",
} as const;
