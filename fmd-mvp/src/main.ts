import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import coverDefaultUrl from "./assets/cover-default.svg";
import chaptersEmptyUrl from "./assets/chapters-empty.png";
import "./styles.css";

type ChapterInfo = {
  index: number;
  name: string;
  link: string;
};

type MangaInfoResult = {
  title: string;
  cover: string;
  authors: string;
  artists: string;
  genres: string;
  alt_titles: string;
  status: string;
  summary: string;
  chapters: ChapterInfo[];
  module_id: string;
  module_name: string;
  root_url: string;
};

type QueueItem = {
  id: number;
  manga_title: string;
  root_url: string;
  module_id: string;
  chapter_index: number;
  chapter_name: string;
  chapter_link: string;
  output_dir: string;
  status: string;
  error: string;
  created_at: string;
  updated_at: string;
};

type ModuleMeta = {
  id: string;
  name: string;
  root_url: string;
  category: string;
  file_path?: string;
  mtime?: number | null;
};

type Favorite = {
  id: number;
  module_id: string;
  module_name: string;
  root_url: string;
  manga_url: string;
  title: string;
  last_chapter_link: string;
  last_chapter_name: string;
  chapter_count: number;
  updated_at: string;
};

type FavoriteCheckResult = {
  favorite: Favorite;
  new_chapters: ChapterInfo[];
  enqueued: number;
};

type QueueProgressEvent = {
  item_id: number;
  manga_title: string;
  chapter_name: string;
  message: string;
  pending_left: number;
  page_current: number;
  page_total: number;
};

type CatalogEntry = {
  link: string;
  title: string;
  alttitles: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  numchapter: number;
  jdn: number;
  cover: string;
};

type MangaCacheRow = {
  link: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  numchapter: number;
  cover: string;
  updated_at: string;
};

type CatalogStats = {
  module_id: string;
  path: string;
  count: number;
};

type GenreTri = "ignore" | "include" | "exclude";
type InfoMode = "search" | "filter";
type AdvFilterState = {
  genres: Record<string, GenreTri>;
  customGenres: string;
  title: string;
  authors: string;
  artists: string;
  summary: string;
  status: 0 | 1 | 2 | 3 | 4;
  matchMode: "all" | "one";
  onlyNew: boolean;
  allSites: boolean;
  useRegex: boolean;
};

/** Same as FMD2 `UserAgentDefault` (httpsendthread.pas). */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** Canonical EN keys (FMD2 defaultGenres) + ES labels for UI. */
const DEFAULT_GENRES: { id: string; label: string }[] = [
  { id: "Action", label: "Acción" },
  { id: "Adult", label: "Adulto" },
  { id: "Adventure", label: "Aventura" },
  { id: "Comedy", label: "Comedia" },
  { id: "Doujinshi", label: "Doujinshi" },
  { id: "Drama", label: "Drama" },
  { id: "Ecchi", label: "Ecchi" },
  { id: "Fantasy", label: "Fantasía" },
  { id: "Gender Bender", label: "Cambio de sexo" },
  { id: "Harem", label: "Harem" },
  { id: "Hentai", label: "Hentai" },
  { id: "Historical", label: "Historico" },
  { id: "Horror", label: "Horror" },
  { id: "Josei", label: "Josei" },
  { id: "Lolicon", label: "Lolicon" },
  { id: "Martial Arts", label: "Artes Marciales" },
  { id: "Mature", label: "Maduro" },
  { id: "Mecha", label: "Mecha" },
  { id: "Musical", label: "Musical" },
  { id: "Mystery", label: "Misterio" },
  { id: "Psychological", label: "Psicológico" },
  { id: "Romance", label: "Romance" },
  { id: "School Life", label: "Vida Escolar" },
  { id: "Sci-fi", label: "Sci-Fi (Ciencia Ficción)" },
  { id: "Seinen", label: "Seinen" },
  { id: "Shotacon", label: "Shotacon" },
  { id: "Shoujo", label: "Shoujo" },
  { id: "Shoujo Ai", label: "Shoujo Ai" },
  { id: "Shounen", label: "Shounen" },
  { id: "Shounen Ai", label: "Shounen Ai" },
  { id: "Slice of Life", label: "Recuentos de la Vida" },
  { id: "Smut", label: "Smut (Atrevido)" },
  { id: "Sports", label: "Deportes" },
  { id: "Supernatural", label: "Sobrenatural" },
  { id: "Tragedy", label: "Tragedia" },
  { id: "Yaoi", label: "Yaoi" },
  { id: "Yuri", label: "Yuri" },
  { id: "Webtoons", label: "Webtoons" },
];

const FILTER_CUSTOM_HINT =
  "Géneros:\n" +
  "- Incluir: el manga debe tener este género.\n" +
  "- Excluir (X): el manga no debe tenerlo.\n" +
  "- Vacío: no importa.\n\n" +
  "Géneros extra:\n" +
  "- Separa varios con coma.\n" +
  "- Antepone ! o - para excluir.\n" +
  "- Ejemplo: Aventura, !Ecchi, Comedia.";

function emptyAdvFilter(): AdvFilterState {
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

type UpdateListStats = {
  module_id: string;
  inserted: number;
  total_in_db: number;
  pages_fetched: number;
};

type NavId = "downloads" | "info" | "favorites" | "about" | "options";

const CATALOG_BATCH = 500;
const LOLI_VAULT_ID = "218b722b1eb34f2aa3863f84538c5b08";
const THEME_KEY = "fmd-theme-dark";
const CH_ROW_H = 52;
const CH_ROW_GAP = 8;
const CH_ROW_STRIDE = CH_ROW_H + CH_ROW_GAP;
const CH_OVERSCAN = 8;
const CAT_ROW_H = 44;
const CAT_OVERSCAN = 12;

function svgIco(d: string): string {
  return `url('data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`,
  )}')`;
}

const ICO = {
  download: svgIco(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  ),
  info: svgIco(
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  ),
  heart: svgIco(
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  ),
  heartSolid: `url('data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  )}')`,
  about: svgIco(
    '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  ),
  settings: svgIco(
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  ),
  moon: svgIco(
    '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  ),
  sun: svgIco(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  ),
  search: svgIco('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  refresh: svgIco(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  ),
  chevron: svgIco('<path d="m6 9 6 6 6-6"/>'),
  arrowRight: svgIco('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  broom: svgIco(
    '<path d="m13 11 9-9"/><path d="M14.6 12.6c.8.8.9 2.1.2 3L10 22l-8-8 6.4-4.8c.9-.7 2.2-.6 3 .2Z"/>',
  ),
  x: svgIco('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: svgIco('<path d="M20 6 9 17l-5-5"/>'),
  plus: svgIco('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  minus: svgIco('<path d="M5 12h14"/>'),
  dash: svgIco('<path d="M5 12h14"/>'),
  external: svgIco(
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  ),
  split: svgIco(
    '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  ),
  folder: svgIco(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ),
  user: svgIco(
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  ),
  brush: svgIco(
    '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>',
  ),
  book: svgIco(
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
  ),
  status: svgIco(
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  ),
  import: svgIco(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  ),
  filterOff: svgIco(
    '<path d="M13.013 3H2l8 9.06V21l4-2v-3.5"/><path d="m22 3-5 5"/><path d="m17 3 5 5"/>',
  ),
  terminal: svgIco(
    '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  ),
  layout: svgIco(
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  ),
  link: svgIco(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  globe: svgIco(
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  ),
  message: svgIco('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  sliders: svgIco(
    '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  ),
  file: svgIco(
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>',
  ),
  image: svgIco(
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  ),
  filter: svgIco('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  tag: svgIco(
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="black"/>',
  ),
  text: svgIco('<path d="M17 6.1H3"/><path d="M21 12.1H3"/><path d="M15.1 18H3"/>'),
  arrowLeft: svgIco('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
};

let manga: MangaInfoResult | null = null;
let mangaUrl = "";
let outputDir = "";
let selected = new Set<number>();
let activeNav: NavId = "info";
let expandedGroups = new Set<string>();
let liveProgress = new Map<
  number,
  { page_current: number; page_total: number; message: string; chapter_name: string }
>();
let lastQueueItems: QueueItem[] = [];
let catalogEntries: CatalogEntry[] = [];
let catalogQuery = "";
let catalogLoadedKey = "";
let modulesCache: ModuleMeta[] = [];
let sourceOpen = false;
let sourceFilter = "";
let activeCatalogTitle = "";
let isFavorite = false;
let darkTheme = localStorage.getItem(THEME_KEY) === "1";
let logOpen = false;
let infoMode: InfoMode = "search";
let advFilter = emptyAdvFilter();
/** Stub: UI says filter is “applied” (no catalog SQL yet). */
let advFilterApplied = false;
/** Monotonic id so solo la última GetInfo aplica resultado. */
let mangaLoadSeq = 0;
/** URL en vuelo (evita reabrir el mismo título). */
let mangaLoadingUrl = "";
/** Cover local de respaldo para onerror. */
let coverLocalFallback = "";
let coverEnsureSeq = 0;
/** Evita reasignar el mismo src (parpadeo). */
let coverDisplayKey = "";
/** Sidebar visible aunque GetInfo aún no haya terminado. */
let infoPanelOpen = false;
const app = document.querySelector("#app")!;
app.className = `app${darkTheme ? " dark" : ""}`;

app.innerHTML = `
  <svg class="svg-filters" aria-hidden="true" focusable="false" width="0" height="0">
    <filter id="cover-sharpen" color-interpolation-filters="sRGB">
      <feConvolveMatrix order="3" kernelMatrix="0 -0.35 0 -0.35 2.4 -0.35 0 -0.35 0" preserveAlpha="true"/>
    </filter>
  </svg>
  <div class="shell-body">
    <nav class="nav-rail" aria-label="Principal">
      <button type="button" class="nav-item" data-nav="downloads" title="Descargas">
        <span class="ico ico-lg" style="--ico:${ICO.download}"></span>
        <span>Descargas</span>
      </button>
      <button type="button" class="nav-item active" data-nav="info" title="Información">
        <span class="ico ico-lg" style="--ico:${ICO.info}"></span>
        <span>Información</span>
      </button>
      <button type="button" class="nav-item" data-nav="favorites" title="Favoritos">
        <span class="ico ico-lg" style="--ico:${ICO.heart}"></span>
        <span>Favoritos</span>
      </button>
      <button type="button" class="nav-item" data-nav="about" title="Sobre">
        <span class="ico ico-lg" style="--ico:${ICO.about}"></span>
        <span>Sobre</span>
      </button>
      <div class="nav-spacer"></div>
      <button type="button" class="nav-item icon-only" data-nav="options" title="Opciones">
        <span class="ico ico-lg" style="--ico:${ICO.settings}"></span>
      </button>
      <button type="button" class="nav-item icon-only" id="theme-toggle" title="Tema">
        <span class="ico ico-lg" id="theme-ico" style="--ico:${darkTheme ? ICO.sun : ICO.moon}"></span>
      </button>
      <button type="button" class="nav-item icon-only" id="log-toggle" title="Log">
        <span class="ico ico-lg" style="--ico:${ICO.terminal}"></span>
      </button>
    </nav>

    <div class="main-region">
      <p id="busy" class="busy-bar" hidden></p>

      <section id="view-info" class="view view-info">
        <aside class="search-panel">
          <div class="search-panel-head">
            <div class="seg">
              <button type="button" class="seg-btn active" id="seg-search">Info</button>
              <button type="button" class="seg-btn" id="seg-filter">Filtro</button>
            </div>
            <div class="field-label">Fuente</div>
            <div class="source-row">
              <div class="source-dd">
                <button type="button" class="source-trigger" id="source-trigger">
                  <span id="source-label">—</span>
                  <span class="ico ico-sm" style="--ico:${ICO.chevron}; color:var(--on-accent); opacity:.55"></span>
                </button>
                <div class="source-backdrop" id="source-backdrop" hidden></div>
                <div class="source-menu" id="source-menu" hidden>
                  <div class="source-search-wrap">
                    <span class="ico ico-sm" style="--ico:${ICO.search}"></span>
                    <input id="source-q" type="text" placeholder="Buscar fuente..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
                  </div>
                  <div class="source-list" id="source-list"></div>
                </div>
              </div>
              <button type="button" class="ghost" id="catalog-update" title="Actualizar lista">
                <span class="ico" id="catalog-refresh-ico" style="--ico:${ICO.refresh}"></span>
              </button>
            </div>
            <div class="search-input-row">
              <div class="search-field">
                <span class="ico ico-sm" style="--ico:${ICO.search}"></span>
                <input id="catalog-q" type="text" placeholder="Buscar título..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-size:12px;font-weight:400;line-height:36px;" />
                <button type="button" class="search-clear" id="catalog-clear" hidden title="Limpiar">
                  <span class="ico ico-sm" style="--ico:${ICO.x}"></span>
                </button>
              </div>
              <button type="button" class="ghost" id="catalog-broom" title="Limpiar filtro">
                <span class="ico" style="--ico:${ICO.broom}"></span>
              </button>
            </div>
          </div>
          <div class="search-mode-bar">
            <span>Modo: <strong id="catalog-mode-label">búsqueda individual</strong></span>
            <div class="search-mode-right">
              <button type="button" class="ghost ghost-sm" id="catalog-clear-adv" title="Quitar filtro">
                <span class="ico ico-sm" style="--ico:${ICO.filterOff}"></span>
              </button>
              <span class="result-badge" id="catalog-stats">0</span>
            </div>
          </div>
            <div class="catalog-results" id="catalog-list"></div>
        </aside>

        <div class="info-main">
          <div class="info-top">
            <div class="info-center">
              <div class="url-bar-wrap">
                <div class="url-bar">
                  <input id="url" type="text" placeholder="https://..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
                  <button type="button" class="url-clear" id="url-clear" hidden title="Limpiar">
                    <span class="ico ico-sm" style="--ico:${ICO.x}"></span>
                  </button>
                  <button type="button" class="url-go" id="load" title="Cargar">
                    <span class="ico" style="--ico:${ICO.arrowRight}"></span>
                  </button>
                </div>
              </div>

              <div class="chapters-panel">
                <div class="chapters-tex" aria-hidden="true"></div>
                <div class="chapters-head" id="chapters-head" hidden>
                  <div class="chapters-head-left">
                    <span class="chapters-label">Capítulos</span>
                    <span class="chapters-meta" id="chapters-available" hidden></span>
                  </div>
                  <div class="chapters-head-right">
                    <span class="sel-count" id="count" hidden></span>
                    <button type="button" class="btn-select-all" id="sel-all" hidden>Seleccionar todo</button>
                  </div>
                </div>
                <div class="chapters-list" id="chapters"></div>
              </div>
            </div>

            <aside class="info-sidebar" id="info-sidebar">
              <div class="info-sidebar-blur" id="cover-blur" hidden>
                <img id="cover-blur-img" alt="" />
              </div>
              <div class="info-sidebar-fade" aria-hidden="true"></div>
              <div class="info-sidebar-scroll">
                <div class="info-sidebar-inner">
                  <div class="cover-frame">
                    <img id="cover-img" alt="portada" hidden />
                    <div class="cover-placeholder" id="cover-ph">Sin portada</div>
                  </div>
                  <div>
                    <h1 class="info-title" id="title">—</h1>
                    <div class="info-alt" id="alt-titles"></div>
                  </div>
                  <div class="info-actions">
                    <button type="button" class="info-action-btn" id="btn-online" disabled>
                      <span class="ico ico-sm" style="--ico:${ICO.external}"></span> Leer en línea
                    </button>
                    <button type="button" class="info-action-btn" id="fav-add" disabled>
                      <span class="ico ico-sm" id="fav-ico" style="--ico:${ICO.heart}"></span>
                      <span id="fav-label">Añadir a favoritos</span>
                    </button>
                  </div>
                  <div class="info-rows" id="info-rows"></div>
                </div>
              </div>
            </aside>

                        <div class="filter-panel" id="filter-panel" hidden>
              <header class="filter-head">
                <div>
                  <div class="filter-eyebrow">Búsqueda avanzada</div>
                  <h1 class="filter-title">Filtro</h1>
                </div>
                <div class="filter-head-meta">
                  <span class="ico ico-sm" style="--ico:${ICO.filter}"></span>
                  <span><span class="filter-active-n" id="filter-active-count">0</span> filtros activos</span>
                </div>
              </header>

              <div class="filter-scroll">
                <div class="filter-grid">
                  <section class="filter-card filter-card-genres">
                    <div class="filter-card-head">
                      <div class="filter-card-title">
                        <span class="ico ico-sm" style="--ico:${ICO.tag}"></span>
                        <h2>Géneros</h2>
                        <span
                          class="filter-hint ico ico-sm"
                          id="filter-hint"
                          style="--ico:${ICO.about}"
                          role="img"
                          aria-label="Ayuda de géneros"
                        ></span>
                      </div>
                      <div class="filter-legend" aria-hidden="true">
                        <span class="filter-legend-item"><span class="filter-legend-dot inc"></span>Incluir</span>
                        <span class="filter-legend-item"><span class="filter-legend-dot exc"></span>Excluir</span>
                      </div>
                    </div>
                    <div class="filter-genres" id="filter-genres" role="group" aria-label="Géneros"></div>
                    <div class="filter-extra">
                      <label class="filter-extra-label" id="filter-custom-label" for="filter-custom">Géneros extra</label>
                      <input
                        id="filter-custom"
                        class="st-field"
                        type="text"
                        placeholder="Ej.: Aventura, !Ecchi, Comedia"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <div class="filter-extra-hint">Antepón <code>!</code> para excluir un género</div>
                    </div>
                  </section>

                  <section class="filter-card filter-card-details">
                    <div class="filter-card-head">
                      <div class="filter-card-title">
                        <span class="ico ico-sm" style="--ico:${ICO.text}"></span>
                        <h2>Detalles</h2>
                      </div>
                    </div>
                    <div class="filter-details">
                      <label for="filter-title">Título</label>
                      <div class="fl-row">
                        <input id="filter-title" class="st-field" type="text" placeholder="Parte del título" autocomplete="off" spellcheck="false" />
                      </div>
                      <label for="filter-authors">Autor</label>
                      <div class="fl-row">
                        <input id="filter-authors" class="st-field" type="text" placeholder="Nombre del autor" autocomplete="off" spellcheck="false" />
                      </div>
                      <label for="filter-artists">Artista</label>
                      <div class="fl-row">
                        <input id="filter-artists" class="st-field" type="text" placeholder="Nombre del artista" autocomplete="off" spellcheck="false" />
                      </div>
                      <label for="filter-status">Estado</label>
                      <div class="fl-row">
                        <div class="filter-select-wrap">
                          <select id="filter-status" class="st-field">
                            <option value="0">Completado</option>
                            <option value="1">En curso</option>
                            <option value="2">En pausa</option>
                            <option value="3">Cancelado</option>
                            <option value="4" selected>Sin filtrar</option>
                          </select>
                        </div>
                      </div>
                      <label for="filter-summary">Sinopsis</label>
                      <div class="fl-row">
                        <input id="filter-summary" class="st-field" type="text" placeholder="Texto en la sinopsis" autocomplete="off" spellcheck="false" />
                      </div>
                    </div>
                  </section>

                  <div class="filter-col filter-col-side">
                    <section class="filter-card">
                      <h2 class="filter-card-label">Coincidencia de géneros</h2>
                      <label class="opt-row">
                        <input type="radio" name="filter-match" id="filter-match-one" value="one" />
                        <span class="radio" aria-hidden="true"></span>
                        <div>
                          <div class="opt-row-title">Cualquiera de los marcados</div>
                          <div class="opt-row-desc">Coincide con al menos uno</div>
                        </div>
                      </label>
                      <label class="opt-row">
                        <input type="radio" name="filter-match" id="filter-match-all" value="all" checked />
                        <span class="radio" aria-hidden="true"></span>
                        <div>
                          <div class="opt-row-title">Todos los marcados</div>
                          <div class="opt-row-desc">Debe cumplir todos</div>
                        </div>
                      </label>
                    </section>

                    <section class="filter-card">
                      <h2 class="filter-card-label">Opciones</h2>
                      <label class="opt-row opt-row-switch">
                        <div>
                          <div class="opt-row-title">Solo mangas nuevos</div>
                          <div class="opt-row-desc">Recién añadidos o actualizados</div>
                        </div>
                        <span class="st-switch"><input type="checkbox" id="filter-only-new" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span>
                      </label>
                      <label class="opt-row opt-row-switch">
                        <div>
                          <div class="opt-row-title">Buscar en todas las fuentes</div>
                          <div class="opt-row-desc">Ignora la fuente seleccionada</div>
                        </div>
                        <span class="st-switch"><input type="checkbox" id="filter-all-sites" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span>
                      </label>
                      <label class="opt-row opt-row-switch">
                        <div>
                          <div class="opt-row-title">Usar expresión regular</div>
                          <div class="opt-row-desc">Patrones avanzados en los campos de texto</div>
                        </div>
                        <span class="st-switch"><input type="checkbox" id="filter-regex" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span>
                      </label>
                    </section>
                  </div>
                </div>
              </div>

              <div class="filter-actions">
                <button type="button" class="btn" id="filter-apply">
                  <span class="ico ico-sm" style="--ico:${ICO.filter}"></span> Aplicar filtro
                </button>
                <button type="button" class="secondary" id="filter-remove">Quitar filtro</button>
                <button type="button" class="secondary" id="filter-reset">Reiniciar</button>
                <div class="filter-actions-spacer"></div>
                <button type="button" class="secondary" id="filter-back">
                  <span class="ico ico-sm" style="--ico:${ICO.arrowLeft}"></span> Regresar
                </button>
              </div>
            </div>
          </div>

          <div class="action-bar">
            <div class="action-path">
              <span class="action-path-label">Guardar en</span>
              <div class="path-field">
                <input id="path-input" type="text" readonly placeholder="Sin carpeta de salida" autocomplete="off" />
                <button type="button" class="path-browse" id="pick" title="Examinar…">
                  <span class="ico ico-sm" style="--ico:${ICO.folder}"></span>
                </button>
              </div>
            </div>
            <label class="action-check" title="Próximamente">
              <input type="checkbox" id="task-stopped" disabled />
              Tarea detenida
            </label>
            <div class="action-btns">
              <button type="button" class="btn-split" id="btn-split" disabled title="Próximamente">
                <span class="ico ico-sm" style="--ico:${ICO.split}"></span> Dividir descarga
              </button>
              <button type="button" class="btn-download" id="enqueue" disabled>
                <span class="ico ico-sm" style="--ico:${ICO.download}"></span> Descargar
              </button>
            </div>
          </div>
        </div>
      </section>

      <section id="view-downloads" class="view" hidden>
        <div class="view-pad">
          <div class="toolbar">
            <button id="queue-refresh" class="secondary" type="button">Actualizar</button>
            <button id="queue-clear" class="secondary" type="button">Limpiar terminados</button>
            <button id="queue-start" class="secondary" type="button">Reanudar cola</button>
            <span id="queue-status" class="path"></span>
          </div>
          <div class="dl-table-wrap">
            <table class="dl-table" id="queue-table">
              <thead>
                <tr>
                  <th class="col-exp"></th>
                  <th class="col-manga">Manga</th>
                  <th class="col-status">Status</th>
                  <th class="col-progress">Progress</th>
                  <th class="col-save">Save to</th>
                  <th class="col-actions"></th>
                </tr>
              </thead>
              <tbody id="queue-list"></tbody>
            </table>
            <div id="queue-empty" class="empty" hidden>Cola vacía</div>
          </div>
        </div>
      </section>

      <section id="view-favorites" class="view" hidden>
        <div class="view-pad">
          <div class="toolbar">
            <button id="fav-refresh" class="secondary" type="button">Actualizar</button>
            <button id="fav-check-all" class="secondary" type="button">Check todos</button>
            <button id="fav-check-enqueue-all" class="btn" type="button">Check + encolar</button>
          </div>
          <div id="fav-list" class="list"></div>
        </div>
      </section>

            <section id="view-options" class="view" hidden>
        <div class="options-shell">
          <header class="options-header">
            <div class="options-eyebrow">Preferencias</div>
            <h1 class="options-title">Configuración</h1>
          </header>
          <div class="options-main">
            <nav class="options-cats" role="tablist" aria-label="Categorías">
              <button type="button" class="options-cat active" data-opt-tab="general" role="tab" aria-selected="true">
                <span class="ico ico-sm" style="--ico:${ICO.settings}"></span><span>General</span>
              </button>
              <button type="button" class="options-cat" data-opt-tab="view" role="tab" aria-selected="false">
                <span class="ico ico-sm" style="--ico:${ICO.layout}"></span><span>Vista</span>
              </button>
              <button type="button" class="options-cat" data-opt-tab="connections" role="tab" aria-selected="false">
                <span class="ico ico-sm" style="--ico:${ICO.link}"></span><span>Conexiones</span>
              </button>
              <button type="button" class="options-cat" data-opt-tab="saveto" role="tab" aria-selected="false">
                <span class="ico ico-sm" style="--ico:${ICO.folder}"></span><span>Guardar en</span>
              </button>
              <button type="button" class="options-cat" data-opt-tab="updates" role="tab" aria-selected="false">
                <span class="ico ico-sm" style="--ico:${ICO.refresh}"></span><span>Actualizaciones</span>
              </button>
              <button type="button" class="options-cat" data-opt-tab="dialogs" role="tab" aria-selected="false">
                <span class="ico ico-sm" style="--ico:${ICO.message}"></span><span>Diálogos</span>
              </button>
              <button type="button" class="options-cat" data-opt-tab="websites" role="tab" aria-selected="false">
                <span class="ico ico-sm" style="--ico:${ICO.globe}"></span><span>Sitios Web</span>
              </button>
            </nav>
            <div class="options-body">
              <div class="options-panel active" id="opt-general" data-opt-panel="general" role="tabpanel">
                <div class="opt-scroll">
                  <div class="st-wrap">
                    <section class="st-section">
                      <div class="st-section-head">
                        <span class="ico ico-sm" style="--ico:${ICO.settings}"></span>
                        <h2>Aplicación</h2>
                      </div>
                      <div class="st-card">
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Idioma</div>
                            <div class="st-desc">Idioma de la interfaz</div>
                          </div>
                          <div class="st-select filter-select-wrap">
                            <select class="opt-stub">
                              <option value="de">Deutsch</option>
                              <option value="en" selected>English</option>
                              <option value="es">Español</option>
                              <option value="fr">Français</option>
                              <option value="id_ID">Bahasa Indonesia</option>
                              <option value="pl_PL">Polski</option>
                              <option value="pt_BR">Português (Brasil)</option>
                              <option value="ru_RU">Русский</option>
                              <option value="tr_TR">Türkçe</option>
                              <option value="zh">中文</option>
                              <option value="el_GR">Ελληνικά</option>
                            </select>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Tema</div>
                            <div class="st-desc">Apariencia clara, oscura o según el sistema</div>
                          </div>
                          <div class="st-select filter-select-wrap">
                            <select class="opt-stub"><option>Sistema</option><option>Claro</option><option>Oscuro</option></select>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Tras terminar</div>
                            <div class="st-desc">Acción al completar todas las descargas</div>
                          </div>
                          <div class="st-select filter-select-wrap">
                            <select class="opt-stub">
                              <option>No hacer nada</option>
                              <option>Salir del programa</option>
                              <option>Apagar equipo</option>
                              <option>Suspender</option>
                            </select>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Marcar manga como nuevo</div>
                            <div class="st-desc">Días desde la última actualización</div>
                          </div>
                          <div class="st-num-wrap">
                            <div class="st-stepper" data-min="1">
                              <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                              <input id="opt-new-days" class="st-stepper-input opt-stub" type="number" value="1" min="1" max="365" />
                              <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                            </div>
                            <span class="st-unit">días</span>
                          </div>
                        </div>
                      </div>
                    </section>

                    <section class="st-section">
                      <div class="st-section-head">
                        <span class="ico ico-sm" style="--ico:${ICO.sliders}"></span>
                        <h2>Comportamiento</h2>
                      </div>
                      <div class="st-card">
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Minimizar al iniciar</div><div class="st-desc">Arranca en la bandeja del sistema</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Minimizar a la bandeja</div><div class="st-desc">Al cerrar, oculta en la bandeja en vez de salir</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Permitir solo una instancia</div><div class="st-desc">Evita abrir la app dos veces</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Búsqueda en vivo</div><div class="st-desc">Filtra mientras escribes (lento en listas largas)</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Borrar tareas completadas al cerrar</div><div class="st-desc">Limpia la cola de descargas al salir</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Ordenar descargas al añadir tareas</div><div class="st-desc">Reordena la cola automáticamente</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Vacuum de bases al salir</div><div class="st-desc">Compacta las bases de datos al cerrar</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Rutas de nombre largo <span class="st-warn">Cuidado</span></div><div class="st-desc">Permite rutas de más de 260 caracteres</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                      </div>
                    </section>

                    <section class="st-section">
                      <div class="st-section-head">
                        <span class="ico ico-sm" style="--ico:${ICO.external}"></span>
                        <h2>Programa externo</h2>
                      </div>
                      <div class="st-card">
                        <label class="st-row click">
                          <div class="st-meta"><div class="st-label">Abrir manga con programa externo</div><div class="st-desc">Usa otra aplicación para abrir los capítulos</div></div>
                          <span class="st-switch"><input class="opt-stub" type="checkbox" id="opt-external" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span>
                        </label>
                        <div class="st-row st-row-stack" id="opt-external-fields" hidden>
                          <div class="st-form-grid">
                            <label>Ruta</label>
                            <input class="st-field st-mono opt-stub" type="text" placeholder="C:\Program Files\...\visor.exe" />
                            <label>Parámetros</label>
                            <input class="st-field st-mono opt-stub" type="text" value="%PATH%%CHAPTER%" placeholder="%PATH%%CHAPTER%" />
                          </div>
                        </div>
                      </div>
                    </section>

                    <section class="st-section">
                      <div class="st-section-head">
                        <span class="ico ico-sm" style="--ico:${ICO.file}"></span>
                        <h2>Registro (log)</h2>
                      </div>
                      <div class="st-card">
                        <label class="st-row click">
                          <div class="st-meta"><div class="st-label">Activar registro</div><div class="st-desc">Guarda la actividad en un archivo de log</div></div>
                          <span class="st-switch"><input class="opt-stub" type="checkbox" id="opt-log" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span>
                        </label>
                        <div id="opt-log-extra" hidden>
                          <div class="st-row">
                            <div class="st-form-inline">
                              <span class="st-form-key">Archivo</span>
                              <input class="st-field st-mono opt-stub" type="text" value="fmd.log" />
                            </div>
                          </div>
                          <div class="st-row st-row-actions">
                            <button type="button" class="secondary opt-stub">Borrar archivo de log</button>
                            <button type="button" class="secondary opt-stub">Abrir log</button>
                          </div>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <div class="options-panel" id="opt-view" data-opt-panel="view" role="tabpanel" hidden>
                <div class="opt-scroll">
                  <div class="st-wrap">
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.layout}"></span><h2>Drop Box</h2></div>
                      <div class="st-card">
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Mostrar Drop Box</div><div class="st-desc">Ventana flotante para soltar enlaces</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <div class="st-row"><div class="st-meta"><div class="st-label">Modo</div><div class="st-desc">Qué hacer con los enlaces soltados</div></div><div class="st-select filter-select-wrap"><select class="opt-stub"><option>Descargar todo</option><option>Añadir a favoritos</option></select></div></div>
                        <div class="st-row"><div class="st-meta"><div class="st-label">Opacidad</div><div class="st-desc">Transparencia de la ventana Drop Box</div></div><input class="st-range opt-stub" type="range" min="5" max="255" value="255" /></div>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.sliders}"></span><h2>Interfaz</h2></div>
                      <div class="st-card">
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Mostrar barra de descargas</div><div class="st-desc">Toolbar superior en la cola</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Botón borrar completadas</div><div class="st-desc">Mostrar «Borrar todas las tareas completadas»</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Barra izquierda de descargas</div><div class="st-desc">Controles adicionales a la izquierda</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Cargar portada del manga</div><div class="st-desc">Descarga y muestra la imagen de portada</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Globo de notificación</div><div class="st-desc">Avisos del sistema al completar tareas</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Ir a Descargas al añadir</div><div class="st-desc">Cambia a la vista Descargas al crear tareas</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Ir a Favoritos al añadir manga</div><div class="st-desc">Cambia a Favoritos al guardar un título</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <div class="options-panel" id="opt-connections" data-opt-panel="connections" role="tabpanel" hidden>
                <div class="opt-scroll">
                  <div class="st-wrap">
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.download}"></span><h2>Descargas</h2></div>
                      <div class="st-card">
                        <div class="st-row"><div class="st-meta"><div class="st-label">Tareas en paralelo</div><div class="st-desc">Mangas descargando a la vez</div></div><div class="st-num-wrap"><div class="st-stepper"><button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button><input class="st-stepper-input opt-stub" type="number" min="1" max="8" value="1" /><button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button></div></div></div>
                        <div class="st-row"><div class="st-meta"><div class="st-label">Archivos por tarea</div><div class="st-desc">Hilos de descarga dentro de un capítulo</div></div><div class="st-num-wrap"><div class="st-stepper"><button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button><input id="set-threads" class="st-stepper-input" type="number" min="1" max="32" value="1" autocomplete="off" /><button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button></div></div></div>
                        <div class="st-row"><div class="st-meta"><div class="st-label">Reintentos de tarea</div><div class="st-desc">Si la tarea falla, cuántas veces reintentar</div></div><div class="st-num-wrap"><div class="st-stepper"><button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button><input class="st-stepper-input opt-stub" type="number" min="0" max="10" value="1" /><button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button></div></div></div>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Reiniciar desde capítulos fallidos</div><div class="st-desc">Continúa siempre desde el último fallo</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.sliders}"></span><h2>Misceláneo</h2></div>
                      <div class="st-card">
                        <div class="st-row"><div class="st-meta"><div class="st-label">Hilos de favoritos</div><div class="st-desc">Comprobaciones de favoritos a la vez</div></div><div class="st-num-wrap"><div class="st-stepper"><button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button><input class="st-stepper-input opt-stub" type="number" min="1" max="32" value="1" /><button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button></div></div></div>
                        <div class="st-row"><div class="st-meta"><div class="st-label">Hilos de actualizar lista</div><div class="st-desc">Paralelismo al actualizar el catálogo</div></div><div class="st-num-wrap"><div class="st-stepper"><button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button><input class="st-stepper-input opt-stub" type="number" min="1" max="32" value="1" /><button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button></div></div></div>
                        <div class="st-row"><div class="st-meta"><div class="st-label">Hilos en segundo plano</div><div class="st-desc">Cargas en background</div></div><div class="st-num-wrap"><div class="st-stepper"><button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button><input class="st-stepper-input opt-stub" type="number" min="1" max="32" value="1" /><button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button></div></div></div>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.link}"></span><h2>Red</h2></div>
                      <div class="st-card">
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Timeout</div>
                            <div class="st-desc">Segundos de espera de conexión</div>
                          </div>
                          <div class="st-num-wrap">
                            <div class="st-stepper">
                              <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                              <input class="st-stepper-input opt-stub" type="number" min="1" max="300" value="30" />
                              <span class="st-stepper-suffix">s</span>
                              <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                            </div>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Reintentos de conexión</div>
                            <div class="st-desc">−1 = reintentar siempre</div>
                          </div>
                          <div class="st-num-wrap">
                            <div class="st-stepper">
                              <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                              <input class="st-stepper-input opt-stub" type="number" min="-1" max="5" value="5" />
                              <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                            </div>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">User-Agent</div>
                            <div class="st-desc">Cabecera HTTP enviada por defecto</div>
                          </div>
                          <input
                            id="set-ua"
                            class="st-field st-mono st-field-ua"
                            type="text"
                            value="${DEFAULT_USER_AGENT}"
                            placeholder="(por defecto)"
                            autocomplete="off"
                            spellcheck="false"
                          />
                        </div>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Usar proxy</div>
                            <div class="st-desc">Enruta el tráfico HTTP por un proxy</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-use-proxy" />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-nest" id="opt-proxy-fields" hidden>
                          <div class="st-nest-inner">
                            <div class="st-nest-row">
                              <label for="set-proxy-type">Tipo</label>
                              <div class="st-select st-select-full filter-select-wrap">
                                <select id="set-proxy-type" class="opt-stub">
                                  <option value="http">HTTP</option>
                                  <option value="socks4">SOCKS4</option>
                                  <option value="socks5">SOCKS5</option>
                                </select>
                              </div>
                            </div>
                            <div class="st-nest-row">
                              <label for="set-proxy-host">Host</label>
                              <input
                                id="set-proxy-host"
                                class="st-field st-mono"
                                type="text"
                                placeholder="host o IP"
                                autocomplete="off"
                                spellcheck="false"
                              />
                            </div>
                            <div class="st-nest-row">
                              <label for="set-proxy-port">Puerto</label>
                              <div>
                                <div class="st-stepper">
                                  <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                                  <input
                                    id="set-proxy-port"
                                    class="st-stepper-input st-stepper-wide"
                                    type="number"
                                    min="1"
                                    max="65535"
                                    value="8080"
                                  />
                                  <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                                </div>
                              </div>
                            </div>
                            <div class="st-nest-row">
                              <label for="set-proxy-user">Usuario</label>
                              <input
                                id="set-proxy-user"
                                class="st-field st-mono opt-stub"
                                type="text"
                                placeholder="opcional"
                                autocomplete="off"
                                spellcheck="false"
                              />
                            </div>
                            <div class="st-nest-row">
                              <label for="set-proxy-pass">Contraseña</label>
                              <input
                                id="set-proxy-pass"
                                class="st-field st-mono opt-stub"
                                type="password"
                                placeholder="opcional"
                                autocomplete="off"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <div class="options-panel" id="opt-saveto" data-opt-panel="saveto" role="tabpanel" hidden>
                <div class="opt-scroll">
                  <div class="st-wrap">
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.folder}"></span><h2>Destino</h2></div>
                      <div class="st-card">
                        <div class="st-row st-row-stack">
                          <div class="st-meta">
                            <div class="st-label">Ruta de descarga por defecto</div>
                            <div class="st-desc">Carpeta raíz donde se guardan los capítulos</div>
                          </div>
                          <div class="path-field path-field-exam">
                            <input id="set-output-dir" type="text" readonly placeholder="Sin carpeta de salida" autocomplete="off" />
                            <button type="button" class="path-browse path-browse-label" id="set-output-browse" title="Examinar…">
                              <span class="ico ico-sm" style="--ico:${ICO.folder}"></span>
                              Examinar
                            </button>
                          </div>
                        </div>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.file}"></span><h2>Formato de salida</h2></div>
                      <div class="st-card">
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Guardar capítulos como</div>
                            <div class="st-desc">Contenedor del capítulo descargado</div>
                          </div>
                          <div class="st-seg" id="set-pack" role="radiogroup" aria-label="Guardar capítulos como">
                            <button type="button" class="st-seg-opt on" data-pack="none" aria-pressed="true">Ninguno</button>
                            <button type="button" class="st-seg-opt" data-pack="zip" aria-pressed="false">ZIP</button>
                            <button type="button" class="st-seg-opt" data-pack="cbz" aria-pressed="false">CBZ</button>
                            <button type="button" class="st-seg-opt" data-pack="pdf" aria-pressed="false">PDF</button>
                            <button type="button" class="st-seg-opt" data-pack="epub" aria-pressed="false">EPUB</button>
                          </div>
                        </div>
                        <div class="st-row" id="set-pdf-quality-row" hidden>
                          <div class="st-meta">
                            <div class="st-label">Calidad del PDF</div>
                            <div class="st-desc">Menor calidad, archivos más ligeros</div>
                          </div>
                          <div class="st-num-wrap">
                            <div class="st-stepper">
                              <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                              <input id="set-pdf-quality" class="st-stepper-input opt-stub" type="number" value="100" min="5" max="100" />
                              <span class="st-stepper-suffix">%</span>
                              <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.image}"></span><h2>Conversión de imagen</h2></div>
                      <div class="st-card">
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Guardar PNG como JPEG</div>
                            <div class="st-desc">Reduce mucho el peso; pierde la transparencia</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-png-as-jpeg" />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Guardar WebP como</div>
                            <div class="st-desc">Formato al convertir imágenes WebP</div>
                          </div>
                          <div class="st-select filter-select-wrap">
                            <select id="set-webp-as" class="opt-stub">
                              <option value="0">WebP</option>
                              <option value="1" selected>PNG</option>
                              <option value="2">JPEG</option>
                            </select>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Compresión PNG</div>
                            <div class="st-desc">Más compresión, guardado más lento</div>
                          </div>
                          <div class="st-select filter-select-wrap">
                            <select id="set-png-level" class="opt-stub">
                              <option value="0">Ninguno</option>
                              <option value="1" selected>El más rápido</option>
                              <option value="2">Predeterminado</option>
                              <option value="3">Máximo</option>
                            </select>
                          </div>
                        </div>
                        <div class="st-row">
                          <div class="st-meta">
                            <div class="st-label">Calidad JPEG</div>
                            <div class="st-desc">Aplica a las imágenes convertidas a JPEG</div>
                          </div>
                          <div class="st-num-wrap">
                            <div class="st-stepper">
                              <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                              <input id="set-jpeg-quality" class="st-stepper-input opt-stub" type="number" value="80" min="1" max="100" />
                              <span class="st-stepper-suffix">%</span>
                              <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.file}"></span><h2>Renombrado</h2></div>
                      <div class="st-card">
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Carpeta por manga</div>
                            <div class="st-desc">Crea una carpeta con el nombre del manga</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-manga-folder" checked />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-row st-row-stack" id="set-pat-manga-row">
                          <div class="st-meta">
                            <div class="st-label">Patrón de la carpeta</div>
                            <div class="st-desc">Plantilla del nombre de carpeta del manga</div>
                          </div>
                          <input id="set-pat-manga" class="st-field st-mono" type="text" value="%MANGA%" autocomplete="off" spellcheck="false" />
                          <div class="st-token-insert" data-target="set-pat-manga">
                            <span class="st-token-insert-label">Insertar:</span>
                            <button type="button" class="st-token-chip" data-token="%WEBSITE%">%WEBSITE%</button>
                            <button type="button" class="st-token-chip" data-token="%MANGA%">%MANGA%</button>
                            <button type="button" class="st-token-chip" data-token="%AUTHOR%">%AUTHOR%</button>
                            <button type="button" class="st-token-chip" data-token="%ARTIST%">%ARTIST%</button>
                          </div>
                        </div>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Carpeta por capítulo</div>
                            <div class="st-desc">Cada capítulo en su propia subcarpeta</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-chapter-folder" checked />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-row st-row-stack" id="set-pat-chapter-row">
                          <div class="st-meta">
                            <div class="st-label">Patrón del capítulo</div>
                            <div class="st-desc">Plantilla del nombre de carpeta del capítulo</div>
                          </div>
                          <input id="set-pat-chapter" class="st-field st-mono" type="text" value="%CHAPTER%" autocomplete="off" spellcheck="false" />
                          <div class="st-token-insert" data-target="set-pat-chapter">
                            <span class="st-token-insert-label">Insertar:</span>
                            <button type="button" class="st-token-chip" data-token="%WEBSITE%">%WEBSITE%</button>
                            <button type="button" class="st-token-chip" data-token="%MANGA%">%MANGA%</button>
                            <button type="button" class="st-token-chip" data-token="%CHAPTER%">%CHAPTER%</button>
                            <button type="button" class="st-token-chip" data-token="%AUTHOR%">%AUTHOR%</button>
                            <button type="button" class="st-token-chip" data-token="%ARTIST%">%ARTIST%</button>
                            <button type="button" class="st-token-chip" data-token="%NUMBERING%">%NUMBERING%</button>
                          </div>
                        </div>
                        <div class="st-row st-row-stack">
                          <div class="st-meta">
                            <div class="st-label">Nombre del archivo</div>
                            <div class="st-desc">Plantilla del archivo final</div>
                          </div>
                          <input id="set-pat-page" class="st-field st-mono" type="text" value="%FILENAME%" autocomplete="off" spellcheck="false" />
                          <div class="st-token-insert" data-target="set-pat-page">
                            <span class="st-token-insert-label">Insertar:</span>
                            <button type="button" class="st-token-chip" data-token="%WEBSITE%">%WEBSITE%</button>
                            <button type="button" class="st-token-chip" data-token="%MANGA%">%MANGA%</button>
                            <button type="button" class="st-token-chip" data-token="%CHAPTER%">%CHAPTER%</button>
                            <button type="button" class="st-token-chip" data-token="%FILENAME%">%FILENAME%</button>
                          </div>
                        </div>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Quitar el nombre del manga del capítulo</div>
                            <div class="st-desc">Evita repetir el título en cada capítulo</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-remove-manga-name" />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Rellenar el volumen con ceros</div>
                            <div class="st-desc">v2 se convierte en v02</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-vol-pad" checked />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-nest" id="opt-vol-pad-fields">
                          <div class="st-nest-inner">
                            <div class="st-nest-row">
                              <label for="set-vol-digits">Dígitos</label>
                              <div class="st-stepper">
                                <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                                <input id="set-vol-digits" class="st-stepper-input opt-stub" type="number" value="2" min="1" max="4" />
                                <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                              </div>
                            </div>
                          </div>
                        </div>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Rellenar el capítulo con ceros</div>
                            <div class="st-desc">3 se convierte en 003</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-chap-pad" checked />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-nest" id="opt-chap-pad-fields">
                          <div class="st-nest-inner">
                            <div class="st-nest-row">
                              <label for="set-chap-digits">Dígitos</label>
                              <div class="st-stepper">
                                <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                                <input id="set-chap-digits" class="st-stepper-input opt-stub" type="number" value="3" min="1" max="5" />
                                <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                              </div>
                            </div>
                          </div>
                        </div>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Reemplazar caracteres no ASCII</div>
                            <div class="st-desc">Evita nombres inválidos en algunos sistemas</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-replace-ascii" />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-nest" id="opt-replace-ascii-fields" hidden>
                          <div class="st-nest-inner">
                            <div class="st-nest-row st-nest-row-compact">
                              <label for="set-replace-ascii-char">Reemplazar por</label>
                              <input
                                id="set-replace-ascii-char"
                                class="st-field st-char opt-stub"
                                type="text"
                                maxlength="4"
                                value="_"
                                placeholder="_"
                                autocomplete="off"
                                spellcheck="false"
                              />
                            </div>
                          </div>
                        </div>
                        <div class="st-row st-row-stack">
                          <div class="st-meta">
                            <div class="st-label">Resultado</div>
                            <div class="st-desc">Ejemplo con el capítulo 3 de un manga de tu lista</div>
                          </div>
                          <div class="st-preview" id="set-rename-preview" aria-live="polite"></div>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <div class="options-panel" id="opt-updates" data-opt-panel="updates" role="tabpanel" hidden>
                <div class="opt-scroll">
                  <div class="st-wrap">
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.refresh}"></span><h2>Actualizaciones</h2></div>
                      <div class="st-card">
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Comprobar versión al iniciar</div><div class="st-desc">Busca actualizaciones de la app</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">No cargar info al actualizar lista</div><div class="st-desc">Más rápido; el filtro avanzado no funcionará</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                      </div>
                    </section>
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.heart}"></span><h2>Favoritos</h2></div>
                      <div class="st-card">
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Comprobar al iniciar</div><div class="st-desc">Busca capítulos nuevos al arrancar</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Abrir Favoritos al iniciar</div><div class="st-desc">Muestra esa vista al abrir la app</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click">
                          <div class="st-meta">
                            <div class="st-label">Comprobar en intervalo</div>
                            <div class="st-desc">Revisa favoritos periódicamente</div>
                          </div>
                          <span class="st-switch">
                            <input class="opt-stub" type="checkbox" id="set-fav-interval" checked />
                            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
                          </span>
                        </label>
                        <div class="st-nest" id="opt-fav-interval-fields">
                          <div class="st-nest-inner">
                            <div class="st-nest-row">
                              <label for="set-fav-interval-min">Intervalo</label>
                              <div class="st-inline-end">
                                <div class="st-stepper">
                                  <button type="button" class="st-stepper-btn" data-step="-1" aria-label="Menos">−</button>
                                  <input
                                    id="set-fav-interval-min"
                                    class="st-stepper-input st-stepper-wide opt-stub"
                                    type="number"
                                    min="1"
                                    max="1440"
                                    value="60"
                                  />
                                  <button type="button" class="st-stepper-btn" data-step="1" aria-label="Más">+</button>
                                </div>
                                <span class="st-unit">min</span>
                              </div>
                            </div>
                          </div>
                        </div>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Descargar tras comprobar</div><div class="st-desc">Encola capítulos nuevos automáticamente</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Quitar mangas completados</div><div class="st-desc">Los elimina de Favoritos al terminar</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <div class="options-panel" id="opt-dialogs" data-opt-panel="dialogs" role="tabpanel" hidden>
                <div class="opt-scroll">
                  <div class="st-wrap">
                    <section class="st-section">
                      <div class="st-section-head"><span class="ico ico-sm" style="--ico:${ICO.message}"></span><h2>Confirmaciones</h2></div>
                      <div class="st-card">
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Salir</div><div class="st-desc">Pedir confirmación antes de cerrar</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Borrar descarga / manga / favorito</div><div class="st-desc">Confirmar eliminaciones</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                        <label class="st-row click"><div class="st-meta"><div class="st-label">Descargar lista si está vacía</div><div class="st-desc">Preguntar antes de Update List</div></div><span class="st-switch"><input class="opt-stub" type="checkbox" checked /><span class="sw" aria-hidden="true"><span class="knob"></span></span></span></label>
                      </div>
                    </section>
                  </div>
                </div>
              </div>

              <div class="options-panel" id="opt-websites" data-opt-panel="websites" role="tabpanel" hidden>
                <div class="sites-tabs" role="tablist" aria-label="Sitios Web">
                  <button type="button" class="sites-tab on" data-sites-tab="list" role="tab" aria-selected="true">Sitios Web</button>
                  <button type="button" class="sites-tab" data-sites-tab="mods" role="tab" aria-selected="false">Módulos</button>
                </div>
                <div class="sites-pane" id="sites-pane-list" data-sites-pane="list">
                  <div class="sites-toolbar">
                    <div class="sites-search-wrap">
                      <span class="ico ico-sm sites-search-ico" style="--ico:${ICO.search}"></span>
                      <input
                        id="sites-q"
                        class="st-field"
                        type="text"
                        placeholder="Buscar sitio web..."
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <button type="button" class="sites-clear" id="sites-clear" hidden title="Limpiar">
                        <span class="ico ico-sm" style="--ico:${ICO.x}"></span>
                      </button>
                    </div>
                    <div class="sites-toolbar-spacer"></div>
                    <div class="sites-toolbar-actions">
                      <button type="button" class="sites-tbtn" id="sites-all">
                        <span class="ico ico-sm" style="--ico:${ICO.check}"></span>Seleccionar todo
                      </button>
                      <button type="button" class="sites-tbtn" id="sites-none">
                        <span class="ico ico-sm" style="--ico:${ICO.x}"></span>Deseleccionar todo
                      </button>
                      <button type="button" class="sites-tbtn" id="sites-expand">
                        <span class="ico ico-sm" style="--ico:${ICO.plus}"></span>Expandir todo
                      </button>
                      <button type="button" class="sites-tbtn" id="sites-collapse">
                        <span class="ico ico-sm" style="--ico:${ICO.minus}"></span>Contraer todo
                      </button>
                    </div>
                  </div>
                  <div class="sites-tree" id="sites-tree" role="tree"></div>
                  <div class="sites-footer">
                    <span class="ico ico-sm" style="--ico:${ICO.globe}"></span>
                    <span id="sites-active-label">0 de 0 sitios activos</span>
                    <div class="sites-footer-spacer"></div>
                    <button type="button" class="lnk" id="sites-only-active">Mostrar solo activos</button>
                  </div>
                </div>
                <div class="sites-pane" id="sites-pane-mods" data-sites-pane="mods" hidden>
                  <div class="mods-toolbar">
                    <button type="button" class="mods-btn-p" id="mods-check">
                      <span class="ico ico-sm" id="mods-check-ico" style="--ico:${ICO.refresh}"></span>
                      <span id="mods-check-label">Revisar actualización</span>
                    </button>
                    <div class="mods-checks">
                      <button type="button" class="mods-chk" id="mods-warn" aria-pressed="true">
                        <span class="sites-cb on" style="--ico:${ICO.check}"><span class="sites-cb-mk"></span></span>
                        Mostrar advertencia de actualización
                      </button>
                      <button type="button" class="mods-chk" id="mods-autorestart" aria-pressed="false">
                        <span class="sites-cb" style="--ico:${ICO.check}"><span class="sites-cb-mk"></span></span>
                        Auto reinicio
                      </button>
                    </div>
                    <div class="sites-toolbar-spacer"></div>
                    <div class="sites-search-wrap mods-search-wrap">
                      <span class="ico ico-sm sites-search-ico" style="--ico:${ICO.search}"></span>
                      <input
                        id="mods-q"
                        class="st-field"
                        type="text"
                        placeholder="Buscar módulo..."
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <button type="button" class="sites-clear" id="mods-clear" hidden title="Limpiar">
                        <span class="ico ico-sm" style="--ico:${ICO.x}"></span>
                      </button>
                    </div>
                  </div>
                  <div class="mods-list-wrap">
                    <div class="mods-head">
                      <span>Nombre del archivo (modules/)</span>
                      <span>Última modificación</span>
                      <span>Último mensaje</span>
                    </div>
                    <div class="mods-list" id="mods-list"></div>
                  </div>
                  <div class="sites-footer">
                    <span class="ico ico-sm" style="--ico:${ICO.terminal}"></span>
                    <span id="mods-summary">0 módulos</span>
                    <div class="sites-footer-spacer"></div>
                    <button type="button" class="lnk" id="mods-only-updated">Mostrar solo actualizados</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <footer class="options-footer">
            <span class="options-dirty" id="opt-dirty" hidden>Cambios sin guardar</span>
            <div class="options-footer-spacer"></div>
            <button type="button" class="secondary" id="set-cancel">Cancelar</button>
            <button type="button" class="btn" id="set-save">Aplicar</button>
          </footer>
        </div>
      </section>


      <section id="view-about" class="view" hidden>
        <div class="view-pad">
          <div class="about-block">
            <h2>FMD Host</h2>
            <p>Cliente moderno (Rust + Tauri) que reutiliza los módulos Lua de Free Manga Downloader 2.</p>
            <p>Descarga mangas/comics con la misma sesión HTTP y hooks por imagen que FMD2.</p>
            <p class="muted">MVP · cola SQLite · favoritos · catálogo · Cloudflare bypass básico</p>
          </div>
        </div>
      </section>

      <div class="log-drawer" id="log-drawer">
        <pre id="log" class="log">Listo.</pre>
      </div>
    </div>
  </div>

  <select id="module-sel" hidden><option value="">Auto</option></select>
`;

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const loadBtn = document.querySelector<HTMLButtonElement>("#load")!;
const moduleSel = document.querySelector<HTMLSelectElement>("#module-sel")!;
const catalogListEl = document.querySelector<HTMLDivElement>("#catalog-list")!;
const catalogStatsEl = document.querySelector<HTMLElement>("#catalog-stats")!;
const catalogQ = document.querySelector<HTMLInputElement>("#catalog-q")!;
const catalogClearBtn = document.querySelector<HTMLButtonElement>("#catalog-clear")!;
const busyEl = document.querySelector<HTMLElement>("#busy")!;
void busyEl; /* oculto; progreso va al log */
const titleEl = document.querySelector<HTMLElement>("#title")!;
const altTitlesEl = document.querySelector<HTMLElement>("#alt-titles")!;
const chaptersEl = document.querySelector<HTMLDivElement>("#chapters")!;
const chaptersAvailableEl = document.querySelector<HTMLElement>("#chapters-available")!;
const chaptersHeadEl = document.querySelector<HTMLElement>("#chapters-head")!;
const countEl = document.querySelector<HTMLElement>("#count")!;
const pathInput = document.querySelector<HTMLInputElement>("#path-input")!;
const logEl = document.querySelector<HTMLElement>("#log")!;
const queueListEl = document.querySelector<HTMLTableSectionElement>("#queue-list")!;
const queueEmptyEl = document.querySelector<HTMLElement>("#queue-empty")!;
const queueTableEl = document.querySelector<HTMLTableElement>("#queue-table")!;
const favListEl = document.querySelector<HTMLDivElement>("#fav-list")!;
const queueStatusEl = document.querySelector<HTMLElement>("#queue-status")!;
const sourceLabel = document.querySelector<HTMLElement>("#source-label")!;
const sourceTrigger = document.querySelector<HTMLButtonElement>("#source-trigger")!;
const sourceMenu = document.querySelector<HTMLDivElement>("#source-menu")!;
const sourceBackdrop = document.querySelector<HTMLDivElement>("#source-backdrop")!;
const sourceListEl = document.querySelector<HTMLDivElement>("#source-list")!;
const sourceQ = document.querySelector<HTMLInputElement>("#source-q")!;
const coverImg = document.querySelector<HTMLImageElement>("#cover-img")!;
const coverBlur = document.querySelector<HTMLDivElement>("#cover-blur")!;
const coverBlurImg = document.querySelector<HTMLImageElement>("#cover-blur-img")!;
const coverPh = document.querySelector<HTMLElement>("#cover-ph")!;
const infoRowsEl = document.querySelector<HTMLDivElement>("#info-rows")!;
const btnOnline = document.querySelector<HTMLButtonElement>("#btn-online")!;
const favAddBtn = document.querySelector<HTMLButtonElement>("#fav-add")!;
const favIco = document.querySelector<HTMLElement>("#fav-ico")!;
const favLabel = document.querySelector<HTMLElement>("#fav-label")!;
const urlClearBtn = document.querySelector<HTMLButtonElement>("#url-clear")!;
const selAllBtn = document.querySelector<HTMLButtonElement>("#sel-all")!;
const enqueueBtn = document.querySelector<HTMLButtonElement>("#enqueue")!;
const catalogRefreshIco = document.querySelector<HTMLElement>("#catalog-refresh-ico")!;
const themeIco = document.querySelector<HTMLElement>("#theme-ico")!;
const logDrawer = document.querySelector<HTMLDivElement>("#log-drawer")!;
const segSearchBtn = document.querySelector<HTMLButtonElement>("#seg-search")!;
const segFilterBtn = document.querySelector<HTMLButtonElement>("#seg-filter")!;
const filterPanel = document.querySelector<HTMLDivElement>("#filter-panel")!;
const infoCenter = document.querySelector<HTMLDivElement>(".info-center")!;
const infoSidebar = document.querySelector<HTMLElement>("#info-sidebar")!;
const filterGenresEl = document.querySelector<HTMLDivElement>("#filter-genres")!;
const filterCustomEl = document.querySelector<HTMLInputElement>("#filter-custom")!;
const filterTitleEl = document.querySelector<HTMLInputElement>("#filter-title")!;
const filterAuthorsEl = document.querySelector<HTMLInputElement>("#filter-authors")!;
const filterArtistsEl = document.querySelector<HTMLInputElement>("#filter-artists")!;
const filterStatusEl = document.querySelector<HTMLSelectElement>("#filter-status")!;
const filterSummaryEl = document.querySelector<HTMLInputElement>("#filter-summary")!;
const filterMatchOne = document.querySelector<HTMLInputElement>("#filter-match-one")!;
const filterMatchAll = document.querySelector<HTMLInputElement>("#filter-match-all")!;
const filterOnlyNew = document.querySelector<HTMLInputElement>("#filter-only-new")!;
const filterAllSites = document.querySelector<HTMLInputElement>("#filter-all-sites")!;
const filterRegex = document.querySelector<HTMLInputElement>("#filter-regex")!;
const catalogModeLabel = document.querySelector<HTMLElement>("#catalog-mode-label")!;
const filterHintEl = document.querySelector<HTMLElement>("#filter-hint")!;

filterHintEl.title = FILTER_CUSTOM_HINT;

function setBusy(_on: boolean, text?: string) {
  /* Mensajes de progreso → solo al log (sin barra en pantalla) */
  if (text) log(text);
}

function setCatalogLoading(on: boolean, text = "Cargando títulos…") {
  if (!on) return;
  catalogListEl.onscroll = null;
  catalogListEl.innerHTML = `<div class="panel-loading"><span class="spinner"></span>${escapeHtml(text)}</div>`;
}

function setSourcesLoading(on: boolean) {
  sourceTrigger.disabled = on;
  if (on) {
    sourceLabel.textContent = "Cargando fuentes…";
    catalogListEl.innerHTML = `<div class="panel-loading"><span class="spinner"></span>Cargando fuentes…</div>`;
  }
}

function scrollSourceItemIntoList(el: HTMLElement) {
  const list = sourceListEl;
  const top = el.offsetTop - (list.clientHeight - el.clientHeight) / 2;
  list.scrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
}

function log(msg: string, kind: "ok" | "err" | "" = "") {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.textContent = "";
}

function selectedModuleId(): string | null {
  const v = moduleSel.value.trim();
  return v || null;
}

function currentModule(): ModuleMeta | undefined {
  const id = selectedModuleId();
  return id ? modulesCache.find((m) => m.id === id) : undefined;
}

function updateSourceLabel() {
  const m = currentModule();
  sourceLabel.textContent = m ? m.name : "Seleccionar fuente…";
}

function renderSourceList() {
  const q = sourceFilter.trim().toLowerCase();
  const sorted = [...modulesCache].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = q
    ? sorted.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.root_url.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q),
      )
    : sorted;
  sourceListEl.innerHTML = "";
  const cur = selectedModuleId();
  let selectedEl: HTMLElement | null = null;
  for (const m of filtered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `dd-item${m.id === cur ? " on" : ""}`;
    btn.dataset.id = m.id;
    btn.innerHTML = `<span>${escapeHtml(m.name)}</span>${
      m.id === cur ? `<span class="ico ico-sm" style="--ico:${ICO.check}"></span>` : ""
    }`;
    btn.addEventListener("click", () => {
      const same = m.id === selectedModuleId();
      moduleSel.value = m.id;
      sourceOpen = false;
      sourceFilter = "";
      sourceQ.value = "";
      updateSourceMenu();
      updateSourceLabel();
      if (!same) {
        void refreshCatalogStats();
        void loadCatalog(true);
      }
    });
    sourceListEl.appendChild(btn);
    if (m.id === cur) selectedEl = btn;
  }
  if (!filtered.length) {
    sourceListEl.innerHTML = `<div class="catalog-empty" style="color:var(--on-accent);opacity:.7">Sin fuentes</div>`;
  }
  return selectedEl;
}

function updateSourceMenu() {
  sourceMenu.hidden = !sourceOpen;
  sourceBackdrop.hidden = !sourceOpen;
  if (sourceOpen) {
    const selectedEl = renderSourceList();
    requestAnimationFrame(() => {
      if (selectedEl) scrollSourceItemIntoList(selectedEl);
      sourceQ.focus();
    });
  }
}

function switchNav(nav: NavId) {
  activeNav = nav;
  document.querySelectorAll(".nav-item[data-nav]").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.nav === nav);
  });
  document.querySelector<HTMLElement>("#view-info")!.hidden = nav !== "info";
  document.querySelector<HTMLElement>("#view-downloads")!.hidden = nav !== "downloads";
  document.querySelector<HTMLElement>("#view-favorites")!.hidden = nav !== "favorites";
  document.querySelector<HTMLElement>("#view-options")!.hidden = nav !== "options";
  document.querySelector<HTMLElement>("#view-about")!.hidden = nav !== "about";
  if (nav === "downloads") void refreshQueue();
  if (nav === "favorites") void refreshFavorites();
  if (nav === "options") void loadSettingsForm();
}

document.querySelectorAll(".nav-item[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    const nav = (el as HTMLElement).dataset.nav as NavId;
    switchNav(nav);
  });
});

document.querySelector("#theme-toggle")!.addEventListener("click", () => {
  darkTheme = !darkTheme;
  app.classList.toggle("dark", darkTheme);
  localStorage.setItem(THEME_KEY, darkTheme ? "1" : "0");
  themeIco.style.setProperty("--ico", darkTheme ? ICO.sun : ICO.moon);
});

document.querySelector("#log-toggle")!.addEventListener("click", () => {
  logOpen = !logOpen;
  logDrawer.classList.toggle("open", logOpen);
  document.querySelector("#log-toggle")!.classList.toggle("is-on", logOpen);
});

function updateResponsive() {
  const w = window.innerWidth;
  app.classList.toggle("narrow", w < 860);
  app.classList.toggle("hide-info", w < 1040);
  app.classList.toggle("show-manga-info", !!manga || infoPanelOpen);
}
window.addEventListener("resize", updateResponsive);
updateResponsive();

sourceTrigger.addEventListener("click", () => {
  sourceOpen = !sourceOpen;
  updateSourceMenu();
  if (sourceOpen) sourceQ.focus();
});
sourceBackdrop.addEventListener("click", () => {
  sourceOpen = false;
  updateSourceMenu();
});
sourceQ.addEventListener("input", () => {
  sourceFilter = sourceQ.value;
  const selectedEl = renderSourceList();
  if (!sourceFilter.trim() && selectedEl) {
    requestAnimationFrame(() => scrollSourceItemIntoList(selectedEl));
  }
});
sourceQ.addEventListener("click", (e) => e.stopPropagation());

/* Autocomplete off en todos los inputs (por si el navegador lo ignora en markup) */
document.querySelectorAll("input").forEach((el) => {
  if (el instanceof HTMLInputElement && el.type !== "checkbox") {
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
  }
});

function refreshCount() {
  const hasManga = !!manga;
  chaptersHeadEl.hidden = !hasManga;
  chaptersAvailableEl.hidden = !hasManga;
  selAllBtn.hidden = !hasManga;
  countEl.hidden = !hasManga;
  if (hasManga) {
    countEl.textContent = `${selected.size} seleccionados`;
    chaptersAvailableEl.textContent = `${manga!.chapters.length} disponibles`;
    const allOn = manga!.chapters.length > 0 && selected.size === manga!.chapters.length;
    selAllBtn.textContent = allOn ? "Deseleccionar" : "Seleccionar todo";
  } else {
    countEl.textContent = "";
    chaptersAvailableEl.textContent = "";
  }
  enqueueBtn.disabled = !hasManga || selected.size === 0;
}

/** Vista de capítulos: más reciente arriba (sin copiar el array en cada paint). */
function chaptersViewLen(): number {
  return manga?.chapters.length ?? 0;
}

function chapterAtView(i: number): ChapterInfo | null {
  if (!manga) return null;
  const n = manga.chapters.length;
  if (i < 0 || i >= n) return null;
  return manga.chapters[n - 1 - i];
}

function chapterNum(index: number): string {
  return String(index + 1).padStart(4, "0");
}

function renderChapters() {
  if (!manga) {
    chaptersEl.onscroll = null;
    chaptersEl.innerHTML = `<div class="chapters-empty">
      <img class="chapters-empty-art" src="${chaptersEmptyUrl}" alt="" />
      <p class="chapters-empty-text">Doble clic en un título del catálogo, o pega un enlace arriba.</p>
    </div>`;
    refreshCount();
    return;
  }

  refreshCount();
  const n = chaptersViewLen();
  if (!n) {
    chaptersEl.onscroll = null;
    chaptersEl.innerHTML = `<div class="catalog-empty">Sin capítulos.</div>`;
    return;
  }

  let virtual = chaptersEl.querySelector<HTMLDivElement>(".chapters-virtual");
  if (!virtual) {
    chaptersEl.innerHTML = "";
    virtual = document.createElement("div");
    virtual.className = "chapters-virtual";
    chaptersEl.appendChild(virtual);
    chaptersEl.onscroll = () => paintVirtualChapters();
  }

  virtual.style.height = `${n * CH_ROW_STRIDE - CH_ROW_GAP}px`;
  paintVirtualChapters();
}

function paintVirtualChapters() {
  if (!manga) return;
  const n = chaptersViewLen();
  const virtual = chaptersEl.querySelector<HTMLDivElement>(".chapters-virtual");
  if (!virtual || !n) return;

  const scrollTop = chaptersEl.scrollTop;
  const viewH = chaptersEl.clientHeight || 400;
  let start = Math.floor(scrollTop / CH_ROW_STRIDE) - CH_OVERSCAN;
  let end = Math.ceil((scrollTop + viewH) / CH_ROW_STRIDE) + CH_OVERSCAN;
  start = Math.max(0, start);
  end = Math.min(n, end);

  const existing = new Map<string, HTMLButtonElement>();
  virtual.querySelectorAll<HTMLButtonElement>(".ch-card").forEach((el) => {
    const key = el.dataset.index;
    if (key != null) existing.set(key, el);
  });

  const keep = new Set<string>();
  for (let i = start; i < end; i++) {
    const c = chapterAtView(i);
    if (!c) continue;
    const key = String(c.index);
    keep.add(key);
    const on = selected.has(c.index);
    let btn = existing.get(key);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.index = key;
      btn.addEventListener("click", () => {
        const idx = Number(btn!.dataset.index);
        if (selected.has(idx)) selected.delete(idx);
        else selected.add(idx);
        refreshCount();
        paintVirtualChapters();
      });
      virtual.appendChild(btn);
    }
    btn.className = `ch-card${on ? " is-on" : ""}`;
    btn.style.top = `${i * CH_ROW_STRIDE}px`;
    btn.innerHTML = `
      <div class="ch-box">${
        on ? `<span class="ico ico-sm" style="--ico:${ICO.check}; color:var(--on-accent)"></span>` : ""
      }</div>
      <span class="ch-num">${chapterNum(c.index)}</span>
      <span class="ch-title">${escapeHtml(c.name || `Capítulo ${c.index + 1}`)}</span>
    `;
  }

  existing.forEach((el, key) => {
    if (!keep.has(key)) el.remove();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedChapters(): ChapterInfo[] {
  if (!manga) return [];
  return manga.chapters.filter((c) => selected.has(c.index));
}

function maybeFillHost(root: string, link: string): string {
  const l = link.trim();
  if (!l) return root;
  if (l.startsWith("http://") || l.startsWith("https://")) return l;
  const r = root.replace(/\/$/, "");
  return l.startsWith("/") ? `${r}${l}` : `${r}/${l}`;
}

function resolveCover(cover: string, root: string): string {
  const c = cover.trim();
  if (!c) return "";
  return maybeFillHost(root, c);
}

function setCover(url: string, opts?: { localFallback?: string; force?: boolean }) {
  coverImg.onerror = null;
  coverImg.onload = null;
  if (opts && "localFallback" in opts) {
    coverLocalFallback = opts.localFallback || "";
  }
  if (!url) {
    if (coverLocalFallback) {
      setCover(coverLocalFallback, { force: opts?.force });
      return;
    }
    applyDefaultCover();
    return;
  }
  if (!opts?.force && url === coverDisplayKey && !coverImg.classList.contains("is-default")) {
    return;
  }
  coverDisplayKey = url;
  coverImg.classList.remove("is-default");
  coverImg.onload = () => {
    coverImg.hidden = false;
    coverPh.hidden = true;
    coverBlur.hidden = false;
  };
  coverImg.onerror = () => {
    if (coverLocalFallback && url !== coverLocalFallback) {
      setCover(coverLocalFallback, { force: true });
      return;
    }
    applyDefaultCover();
  };
  coverImg.src = url;
  coverBlurImg.src = url;
  coverImg.hidden = false;
  coverPh.hidden = true;
  coverBlur.hidden = false;
}

function applyDefaultCover() {
  coverImg.onerror = null;
  coverImg.onload = null;
  coverDisplayKey = "";
  coverImg.classList.add("is-default");
  coverImg.src = coverDefaultUrl;
  coverBlurImg.src = coverDefaultUrl;
  coverImg.hidden = false;
  coverPh.hidden = true;
  coverBlur.hidden = false;
}

function setChaptersLoading(text = "Cargando capítulos…") {
  chaptersHeadEl.hidden = true;
  chaptersEl.onscroll = null;
  chaptersEl.innerHTML = `<div class="panel-loading"><span class="spinner"></span>${escapeHtml(text)}</div>`;
}

type SidebarStub = {
  title: string;
  authors?: string;
  artists?: string;
  genres?: string;
  status?: string;
  summary?: string;
  numchapter?: number;
  moduleName?: string;
  coverUrl?: string;
};

function paintSidebarContent(opts: SidebarStub) {
  updateResponsive();
  titleEl.textContent = opts.title.trim() || "(sin título)";
  altTitlesEl.textContent = "";
  altTitlesEl.hidden = true;

  const rows: { icon: string; label: string; value: string }[] = [];
  const authors = (opts.authors || "").trim();
  const artists = (opts.artists || "").trim();
  const genres = (opts.genres || "").trim();
  const status = (opts.status || "").trim();
  const summary = (opts.summary || "").trim();
  const moduleName = (opts.moduleName || "").trim();
  const capsN = opts.numchapter && opts.numchapter > 0 ? opts.numchapter : 0;

  if (authors) rows.push({ icon: ICO.user, label: "Autor", value: authors });
  if (artists) rows.push({ icon: ICO.brush, label: "Artista", value: artists });
  if (genres) rows.push({ icon: ICO.about, label: "Géneros", value: genres });
  if (status) rows.push({ icon: ICO.status, label: "Estado", value: status });

  const fuente = moduleName || currentModule()?.name || "—";
  const caps = capsN ? `caps. ${capsN}` : "caps. —";

  const rowHtml = (r: { icon: string; label: string; value: string }) => `
    <div class="info-row">
      <span class="ico" style="--ico:${r.icon}"></span>
      <div>
        <div class="info-row-label">${r.label}</div>
        <div class="info-row-value">${escapeHtml(r.value)}</div>
      </div>
    </div>`;

  infoRowsEl.innerHTML =
    rows.map(rowHtml).join("") +
    (summary
      ? `<div class="info-summary">
          <div class="info-row-label">Sinopsis</div>
          <div class="info-summary-text">${escapeHtml(summary)}</div>
        </div>`
      : "") +
    `<div class="info-meta-line">${escapeHtml(fuente)} <span class="info-meta-sep">—</span> ${escapeHtml(caps)}</div>`;
}

function renderInfoSidebar() {
  updateResponsive();
  if (!manga) {
    if (!infoPanelOpen) {
      titleEl.textContent = "";
      altTitlesEl.textContent = "";
      altTitlesEl.hidden = true;
      setCover("", { localFallback: "" });
      infoRowsEl.innerHTML = "";
      btnOnline.disabled = true;
      favAddBtn.disabled = true;
      isFavorite = false;
      updateFavButton();
    }
    return;
  }
  const alt = manga.alt_titles.trim();
  paintSidebarContent({
    title: manga.title,
    authors: manga.authors,
    artists: manga.artists,
    genres: manga.genres,
    status: manga.status,
    summary: manga.summary,
    numchapter: manga.chapters.length,
    moduleName: manga.module_name,
  });
  altTitlesEl.textContent = alt;
  altTitlesEl.hidden = !alt;
  const remote = resolveCover(manga.cover, manga.root_url);
  // Si ya hay cover local (data:), no la sustituyas por la remota.
  if (coverLocalFallback) {
    setCover(coverLocalFallback, { localFallback: coverLocalFallback });
  } else if (remote) {
    setCover(remote);
  } else {
    setCover("");
  }
  btnOnline.disabled = !mangaUrl;
  favAddBtn.disabled = false;
  updateFavButton();
}

async function applyCachedCover(moduleId: string, link: string) {
  const keys = [link.trim()].filter(Boolean);
  const root = currentModule()?.root_url || "";
  if (root) {
    const full = maybeFillHost(root, link);
    if (full && !keys.includes(full)) keys.push(full);
  }
  for (const key of keys) {
    try {
      const dataUrl = await invoke<string | null>("cover_local_path", { moduleId, link: key });
      if (!dataUrl) continue;
      coverLocalFallback = dataUrl;
      setCover(dataUrl, { localFallback: dataUrl, force: true });
      return;
    } catch {
      /* try next key */
    }
  }
}

async function ensureCoverAsync(
  seq: number,
  moduleId: string,
  link: string,
  coverUrl: string,
  referer: string,
) {
  const ensureId = ++coverEnsureSeq;
  if (!coverUrl.trim()) return;
  try {
    const dataUrl = await invoke<string>("cover_ensure", {
      moduleId,
      link,
      coverUrl,
      referer: referer || null,
    });
    if (seq !== mangaLoadSeq || ensureId !== coverEnsureSeq) return;
    coverLocalFallback = dataUrl;
    // Solo pintar data: si no hay imagen útil (default / vacío). No pisar remota OK.
    const needsPaint =
      coverImg.classList.contains("is-default") || !coverDisplayKey;
    if (needsPaint) {
      setCover(dataUrl, { localFallback: dataUrl, force: true });
    }
  } catch {
    /* keep remote / default */
  }
}

function applyCatalogStub(e: CatalogEntry) {
  infoPanelOpen = true;
  if (infoMode !== "filter") infoSidebar.hidden = false;
  updateResponsive();
  paintSidebarContent({
    title: e.title || e.link,
    authors: e.authors,
    artists: e.artists,
    genres: e.genres,
    status: e.status,
    summary: e.summary,
    numchapter: e.numchapter,
    moduleName: currentModule()?.name,
  });
  const root = currentModule()?.root_url || "";
  const hint = resolveCover(e.cover || "", root);
  // Mientras llega el data: local, intenta remota del catálogo (mejor que default).
  if (!coverLocalFallback && hint) {
    setCover(hint);
  }
  btnOnline.disabled = false;
  favAddBtn.disabled = false;
}

function updateFavButton() {
  favIco.style.setProperty("--ico", isFavorite ? ICO.heartSolid : ICO.heart);
  favLabel.textContent = isFavorite ? "En favoritos" : "Añadir a favoritos";
}

async function syncFavoriteState() {
  isFavorite = false;
  if (!mangaUrl) {
    updateFavButton();
    return;
  }
  try {
    const favs = await invoke<Favorite[]>("favorites_list");
    isFavorite = favs.some((f) => f.manga_url === mangaUrl);
  } catch {
    /* ignore */
  }
  updateFavButton();
}

function setPathDisplay(dir: string) {
  pathInput.value = dir || "";
  pathInput.placeholder = dir ? dir : "Sin carpeta de salida";
}

async function ensureOutputDir(): Promise<string | null> {
  if (outputDir) return outputDir;
  const saved = await invoke<string | null>("settings_get", { key: "default_output_dir" });
  if (saved) {
    outputDir = saved;
    setPathDisplay(saved);
    return saved;
  }
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") {
    outputDir = dir;
    setPathDisplay(dir);
    await invoke("settings_set", { key: "default_output_dir", value: dir });
    return dir;
  }
  return null;
}

async function initSettings() {
  const saved = await invoke<string | null>("settings_get", { key: "default_output_dir" });
  if (saved) {
    outputDir = saved;
    setPathDisplay(saved);
  }
}

async function loadModules() {
  setSourcesLoading(true);
  try {
    const mods = await invoke<ModuleMeta[]>("modules_list_cmd");
    modulesCache = mods;
    const current = moduleSel.value;
    moduleSel.innerHTML = `<option value="">Auto</option>`;
    const sorted = [...mods].sort((a, b) => a.name.localeCompare(b.name));
    for (const m of sorted) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.root_url.replace(/^https?:\/\//, "")})`;
      moduleSel.appendChild(opt);
    }
    if (current && [...moduleSel.options].some((o) => o.value === current)) {
      moduleSel.value = current;
    } else if ([...moduleSel.options].some((o) => o.value === LOLI_VAULT_ID)) {
      moduleSel.value = LOLI_VAULT_ID;
    } else if (sorted.length) {
      moduleSel.value = sorted[0].id;
    }
    updateSourceLabel();
    rebuildSitesFromModules();
    rebuildModulesFromFiles();
    log(`Módulos cargados: ${mods.length}`, "ok");
  } catch (e) {
    log(`No se pudo listar módulos: ${e}`, "err");
    sourceLabel.textContent = "Error al cargar";
  } finally {
    sourceTrigger.disabled = false;
  }
}

async function refreshCatalogStats() {
  const id = selectedModuleId();
  if (!id) {
    catalogStatsEl.textContent = "0";
    return;
  }
  try {
    const st = await invoke<CatalogStats>("catalog_stats", { moduleId: id });
    catalogStatsEl.textContent = String(st.count);
  } catch {
    catalogStatsEl.textContent = "—";
  }
}

function renderCatalogList() {
  if (!catalogEntries.length) {
    catalogListEl.onscroll = null;
    catalogListEl.innerHTML = `<div class="catalog-empty">Sin resultados.</div>`;
    return;
  }

  let virtual = catalogListEl.querySelector<HTMLDivElement>(".catalog-virtual");
  if (!virtual) {
    catalogListEl.innerHTML = "";
    virtual = document.createElement("div");
    virtual.className = "catalog-virtual";
    catalogListEl.appendChild(virtual);
    catalogListEl.onscroll = () => paintVirtualCatalog();
  }
  virtual.style.height = `${catalogEntries.length * CAT_ROW_H}px`;
  paintVirtualCatalog();
}

function paintVirtualCatalog() {
  const virtual = catalogListEl.querySelector<HTMLDivElement>(".catalog-virtual");
  if (!virtual || !catalogEntries.length) return;

  const scrollTop = catalogListEl.scrollTop;
  const viewH = catalogListEl.clientHeight || 400;
  let start = Math.floor(scrollTop / CAT_ROW_H) - CAT_OVERSCAN;
  let end = Math.ceil((scrollTop + viewH) / CAT_ROW_H) + CAT_OVERSCAN;
  start = Math.max(0, start);
  end = Math.min(catalogEntries.length, end);

  const existing = new Map<string, HTMLButtonElement>();
  virtual.querySelectorAll<HTMLButtonElement>(".catalog-row").forEach((el) => {
    const key = el.dataset.i;
    if (key != null) existing.set(key, el);
  });

  const keep = new Set<string>();
  for (let i = start; i < end; i++) {
    const e = catalogEntries[i];
    const key = String(i);
    keep.add(key);
    const title = e.title || e.link;
    let row = existing.get(key);
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.dataset.i = key;
      virtual.appendChild(row);
    }
    row.className = `catalog-row${title === activeCatalogTitle ? " active" : ""}`;
    row.style.top = `${i * CAT_ROW_H}px`;
    const caps =
      e.numchapter > 0
        ? e.numchapter
        : manga && (e.title || e.link) === activeCatalogTitle
          ? manga.chapters.length
          : 0;
    row.title = caps > 0 ? `${title} · ${caps} caps.` : title;
    let label = row.querySelector<HTMLElement>(".catalog-row-title");
    if (!label) {
      label = document.createElement("div");
      label.className = "catalog-row-title";
      row.appendChild(label);
    }
    label.textContent = title;
    let meta = row.querySelector<HTMLElement>(".catalog-row-meta");
    if (caps > 0) {
      if (!meta) {
        meta = document.createElement("span");
        meta.className = "catalog-row-meta";
        row.appendChild(meta);
      }
      meta.textContent = String(caps);
    } else if (meta) {
      meta.remove();
    }
  }

  existing.forEach((el, key) => {
    if (!keep.has(key)) el.remove();
  });
}

/** Doble clic por índice (sobrevive si el DOM virtual se recrea entre clics). */
let lastCatalogClickIdx = -1;
let lastCatalogClickAt = 0;

catalogListEl.addEventListener("click", (ev) => {
  const row = (ev.target as HTMLElement | null)?.closest?.(".catalog-row") as HTMLElement | null;
  if (!row || !catalogListEl.contains(row)) return;
  ev.preventDefault();
  const idx = Number(row.dataset.i);
  const entry = catalogEntries[idx];
  if (!entry) return;

  const title = entry.title || entry.link;
  activeCatalogTitle = title;
  catalogListEl.querySelectorAll(".catalog-row").forEach((el) => {
    const i = Number((el as HTMLElement).dataset.i);
    const t = catalogEntries[i];
    el.classList.toggle("active", !!(t && (t.title || t.link) === activeCatalogTitle));
  });

  const now = performance.now();
  if (lastCatalogClickIdx === idx && now - lastCatalogClickAt < 450) {
    lastCatalogClickIdx = -1;
    lastCatalogClickAt = 0;
    void openCatalogEntry(entry);
    return;
  }
  lastCatalogClickIdx = idx;
  lastCatalogClickAt = now;
});

catalogListEl.addEventListener("dblclick", (ev) => {
  /* Evitar selección de texto; la apertura la hace el 2º click arriba. */
  ev.preventDefault();
});

async function loadCatalog(force = false, silent = false) {
  const id = selectedModuleId();
  if (!id) return;
  const key = `${id}||${catalogQuery}`;
  if (!force && key === catalogLoadedKey && catalogEntries.length) {
    renderCatalogList();
    return;
  }

  const keepList = silent && !!catalogListEl.querySelector(".catalog-virtual");
  if (!keepList) {
    setCatalogLoading(true, "Cargando títulos…");
  }
  if (!silent) setBusy(true, "Cargando catálogo…");
  try {
    const all: CatalogEntry[] = [];
    let offset = 0;
    for (;;) {
      const rows = await invoke<CatalogEntry[]>("catalog_search", {
        moduleId: id,
        query: catalogQuery,
        limit: CATALOG_BATCH,
        offset,
      });
      all.push(...rows);
      if (rows.length < CATALOG_BATCH) break;
      offset += rows.length;
      if (!keepList) {
        setCatalogLoading(true, `Cargando títulos… (${all.length})`);
      }
    }
    catalogEntries = all;
    catalogLoadedKey = key;
    if (silent) catalogListEl.scrollTop = 0;
    renderCatalogList();
    await refreshCatalogStats();
    if (!silent) log(`Catálogo: ${all.length} títulos`, "ok");
    else catalogStatsEl.textContent = String(all.length);
  } catch (e) {
    catalogLoadedKey = "";
    log(String(e), "err");
    catalogListEl.innerHTML = `<div class="catalog-empty">Error al cargar el catálogo.</div>`;
  } finally {
    if (!silent) setBusy(false);
  }
}

function catalogLinkKey(link: string): string {
  const l = link.trim();
  try {
    if (l.startsWith("http://") || l.startsWith("https://")) {
      const u = new URL(l);
      return `${u.pathname}${u.search}`.replace(/\/$/, "") || "/";
    }
  } catch {
    /* ignore */
  }
  return (l.startsWith("/") ? l : `/${l}`).replace(/\/$/, "") || "/";
}

/** Refresca meta en memoria + manga_cache (no escribe masterlist). */
function syncMangaCacheFromInfo(mangaLink: string, info: MangaInfoResult) {
  const count = info.chapters.length;
  const cover = resolveCover(info.cover, info.root_url);
  const key = catalogLinkKey(mangaLink);
  const root = currentModule()?.root_url || info.root_url || "";
  let touched = false;
  for (const e of catalogEntries) {
    const full = maybeFillHost(root, e.link);
    if (catalogLinkKey(e.link) === key || catalogLinkKey(full) === key) {
      e.numchapter = count;
      e.authors = info.authors;
      e.artists = info.artists;
      e.genres = info.genres;
      e.status = info.status;
      e.summary = info.summary;
      e.cover = cover;
      touched = true;
    }
  }
  if (touched) paintVirtualCatalog();
  const moduleId = info.module_id || selectedModuleId();
  if (moduleId) {
    void invoke("manga_cache_upsert", {
      moduleId,
      link: mangaLink,
      authors: info.authors,
      artists: info.artists,
      genres: info.genres,
      status: info.status,
      summary: info.summary,
      numchapter: count,
      cover,
    }).catch(() => {
      /* best-effort */
    });
  }
}

async function openCatalogEntry(e: CatalogEntry) {
  const root = currentModule()?.root_url || "";
  const url = maybeFillHost(root, e.link);
  activeCatalogTitle = e.title || e.link;
  renderCatalogList();
  urlInput.value = url;
  syncUrlClear();
  if (mangaLoadingUrl === url) {
    log(`Ya se está cargando: ${e.title || e.link}`);
    infoPanelOpen = true;
    if (infoMode !== "filter") infoSidebar.hidden = false;
    updateResponsive();
    applyCatalogStub(e);
    return;
  }
  // Nueva apertura: no heredar cover del título anterior.
  coverEnsureSeq++;
  setCover("", { localFallback: "" });
  infoPanelOpen = true;
  if (infoMode !== "filter") infoSidebar.hidden = false;
  updateResponsive();
  applyCatalogStub(e);
  const moduleId = selectedModuleId();
  if (moduleId) void applyCachedCover(moduleId, e.link);
  log(`Abriendo ${e.title || e.link}…`);
  await loadMangaInfo();
}

function syncUrlClear() {
  urlClearBtn.hidden = !urlInput.value.trim();
}

function syncCatalogClear() {
  catalogClearBtn.hidden = !catalogQ.value.trim();
}

async function loadMangaInfo() {
  const seq = ++mangaLoadSeq;
  const url = urlInput.value.trim();
  mangaUrl = url;
  mangaLoadingUrl = url;
  infoPanelOpen = true;
  if (infoMode !== "filter") infoSidebar.hidden = false;
  updateResponsive();

  clearLog();
  setBusy(true, "Cargando GetInfo… (Cloudflare puede tardar)");
  loadBtn.disabled = true;
  setChaptersLoading();
  log("Cargando info vía Lua GetInfo…");

  const moduleId = selectedModuleId();
  if (moduleId) {
    void applyCachedCover(moduleId, url);
    void (async () => {
      try {
        const cached = await invoke<MangaCacheRow | null>("manga_cache_get", {
          moduleId,
          link: url,
        });
        if (seq !== mangaLoadSeq || !cached) return;
        if (!manga) {
          paintSidebarContent({
            title: activeCatalogTitle || cached.link,
            authors: cached.authors,
            artists: cached.artists,
            genres: cached.genres,
            status: cached.status,
            summary: cached.summary,
            numchapter: cached.numchapter,
            moduleName: currentModule()?.name,
          });
        }
        if (cached.cover && !coverLocalFallback) {
          const remote = resolveCover(cached.cover, currentModule()?.root_url || "");
          if (remote) setCover(remote);
        }
        await applyCachedCover(moduleId, url);
      } catch {
        /* ignore */
      }
    })();
  }

  try {
    const result = await invoke<MangaInfoResult>("get_manga_info", {
      url,
      moduleId,
    });
    if (seq !== mangaLoadSeq) return;
    manga = result;
    selected = new Set();
    chaptersEl.scrollTop = 0;
    if (result.module_id && [...moduleSel.options].some((o) => o.value === result.module_id)) {
      moduleSel.value = result.module_id;
      updateSourceLabel();
    }
    if (!activeCatalogTitle) activeCatalogTitle = result.title;
    renderChapters();
    renderInfoSidebar();
    syncMangaCacheFromInfo(url, result);
    const coverUrl = resolveCover(result.cover, result.root_url);
    const mid = result.module_id || selectedModuleId();
    // Un solo ensure: cache en disco; no pisa remota si ya se ve.
    const remoteShowing =
      coverDisplayKey.startsWith("http://") || coverDisplayKey.startsWith("https://");
    const toEnsure = coverUrl || (remoteShowing ? coverDisplayKey : "");
    const alreadyLocal = coverLocalFallback.startsWith("data:");
    if (mid && toEnsure && !alreadyLocal) {
      void ensureCoverAsync(seq, mid, url, toEnsure, result.root_url || url);
    }
    await syncFavoriteState();
    if (seq !== mangaLoadSeq) return;
    log(`OK: ${result.chapters.length} capítulos (${result.module_name})`, "ok");
  } catch (e) {
    if (seq !== mangaLoadSeq) return;
    manga = null;
    renderChapters();
    renderInfoSidebar();
    log(String(e), "err");
  } finally {
    if (seq === mangaLoadSeq) {
      mangaLoadingUrl = "";
      setBusy(false);
      loadBtn.disabled = false;
    }
  }
}

loadBtn.addEventListener("click", () => void loadMangaInfo());
urlInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") void loadMangaInfo();
});
urlInput.addEventListener("input", syncUrlClear);
urlClearBtn.addEventListener("click", () => {
  urlInput.value = "";
  syncUrlClear();
  urlInput.focus();
});

selAllBtn.addEventListener("click", () => {
  if (!manga) return;
  if (selected.size === manga.chapters.length) {
    selected.clear();
  } else {
    selected.clear();
    for (const c of manga.chapters) selected.add(c.index);
  }
  refreshCount();
  paintVirtualChapters();
});

document.querySelector("#pick")!.addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") {
    outputDir = dir;
    setPathDisplay(dir);
    await invoke("settings_set", { key: "default_output_dir", value: dir });
    log(`Carpeta por defecto: ${dir}`, "ok");
  }
});

enqueueBtn.addEventListener("click", async () => {
  if (!manga) {
    log("Carga un manga primero.", "err");
    return;
  }
  const chapters = selectedChapters();
  if (!chapters.length) {
    log("Selecciona al menos un capítulo.", "err");
    return;
  }
  const dir = await ensureOutputDir();
  if (!dir) {
    log("Elige una carpeta de salida.", "err");
    return;
  }
  try {
    const n = await invoke<number>("queue_add", {
      req: {
        manga_title: manga.title || "manga",
        root_url: manga.root_url,
        manga_url: mangaUrl,
        module_id: manga.module_id,
        output_dir: dir,
        chapters,
      },
    });
    log(`Encolados ${n} capítulo(s). Ve a Descargas.`, "ok");
  } catch (e) {
    log(String(e), "err");
  }
});

favAddBtn.addEventListener("click", async () => {
  if (!manga || !mangaUrl) {
    log("Carga un manga primero.", "err");
    return;
  }
  try {
    const fav = await invoke<Favorite>("favorites_add", {
      req: {
        module_id: manga.module_id,
        module_name: manga.module_name,
        root_url: manga.root_url,
        manga_url: mangaUrl,
        title: manga.title || mangaUrl,
        chapters: manga.chapters,
      },
    });
    isFavorite = true;
    updateFavButton();
    log(`Favorito guardado: ${fav.title} (último: ${fav.last_chapter_name || "—"})`, "ok");
  } catch (e) {
    log(String(e), "err");
  }
});

btnOnline.addEventListener("click", async () => {
  if (!mangaUrl) return;
  try {
    await openUrl(mangaUrl);
  } catch (e) {
    log(`No se pudo abrir: ${e}`, "err");
  }
});

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    pending: "badge pending",
    running: "badge running",
    done: "badge done",
    failed: "badge failed",
    cancelled: "badge cancelled",
  };
  return map[status] || "badge";
}

function groupKey(item: QueueItem): string {
  return `${item.manga_title}||${item.output_dir}`;
}

type MangaGroup = {
  key: string;
  manga_title: string;
  output_dir: string;
  items: QueueItem[];
};

function groupQueueItems(items: QueueItem[]): MangaGroup[] {
  const map = new Map<string, MangaGroup>();
  for (const item of items) {
    const key = groupKey(item);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        manga_title: item.manga_title,
        output_dir: item.output_dir,
        items: [],
      };
      map.set(key, g);
    }
    g.items.push(item);
  }
  return [...map.values()];
}

function groupStatus(items: QueueItem[]): string {
  if (items.some((i) => i.status === "running")) return "Downloading";
  if (items.some((i) => i.status === "pending")) return "Waiting…";
  if (items.every((i) => i.status === "done")) return "Completed";
  if (items.some((i) => i.status === "failed")) return "Failed";
  if (items.every((i) => i.status === "cancelled")) return "Stopped";
  return "Mixed";
}

function groupProgressClass(status: string): string {
  if (status === "Downloading") return "dl-bar running";
  if (status === "Completed") return "dl-bar done";
  if (status === "Failed") return "dl-bar failed";
  if (status === "Stopped") return "dl-bar stopped";
  return "dl-bar waiting";
}

function renderQueueTable(items: QueueItem[]) {
  lastQueueItems = items;
  const pending = items.filter((i) => i.status === "pending" || i.status === "running").length;
  queueStatusEl.textContent = `${pending} activos · ${items.length} caps`;
  queueListEl.innerHTML = "";

  if (!items.length) {
    queueTableEl.hidden = true;
    queueEmptyEl.hidden = false;
    return;
  }
  queueTableEl.hidden = false;
  queueEmptyEl.hidden = true;

  const groups = groupQueueItems(items);
  for (const g of groups) {
    const done = g.items.filter((i) => i.status === "done").length;
    const total = g.items.length;
    const status = groupStatus(g.items);
    const running = g.items.find((i) => i.status === "running");
    const live = running ? liveProgress.get(running.id) : undefined;

    let pct = total ? Math.round((done / total) * 100) : 0;
    let progressLabel = `${done}/${total}`;
    if (live && live.page_total > 0) {
      const chapterFrac = done / total;
      const pageFrac = live.page_current / live.page_total / total;
      pct = Math.min(100, Math.round((chapterFrac + pageFrac) * 100));
      progressLabel = `${done}/${total} · ${live.page_current}/${live.page_total}`;
    } else if (status === "Completed") {
      pct = 100;
    }

    const statusText = running
      ? `[${done + 1}/${total}] ${live?.message || running.chapter_name}`
      : status === "Waiting…"
        ? `[${done}/${total}] Waiting…`
        : `[${done}/${total}] ${status}`;

    const expanded = expandedGroups.has(g.key);
    const tr = document.createElement("tr");
    tr.className = `dl-row ${status.toLowerCase()}`;
    tr.innerHTML = `
      <td class="col-exp"><button type="button" class="exp-btn" title="Desglose">${expanded ? "▾" : "▸"}</button></td>
      <td class="col-manga" title="${escapeHtml(g.manga_title)}">${escapeHtml(g.manga_title)}</td>
      <td class="col-status">${escapeHtml(statusText)}</td>
      <td class="col-progress">
        <div class="dl-progress ${groupProgressClass(status)}">
          <div class="dl-progress-fill" style="width:${pct}%"></div>
          <span class="dl-progress-text">${progressLabel}</span>
        </div>
      </td>
      <td class="col-save" title="${escapeHtml(g.output_dir)}">${escapeHtml(g.output_dir)}</td>
      <td class="col-actions"></td>
    `;

    const expBtn = tr.querySelector<HTMLButtonElement>(".exp-btn")!;
    expBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expandedGroups.has(g.key)) expandedGroups.delete(g.key);
      else expandedGroups.add(g.key);
      renderQueueTable(lastQueueItems);
    });

    const actions = tr.querySelector(".col-actions")!;
    const activeItems = g.items.filter((i) => i.status === "pending" || i.status === "running");
    if (activeItems.length) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "row-btn";
      cancel.textContent = "Stop";
      cancel.addEventListener("click", async () => {
        for (const it of activeItems) {
          await invoke("queue_cancel", { id: it.id });
        }
        await refreshQueue();
      });
      actions.appendChild(cancel);
    }
    const retryItems = g.items.filter((i) => i.status === "cancelled" || i.status === "failed");
    if (retryItems.length) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "row-btn";
      retry.textContent = "Retry";
      retry.addEventListener("click", async () => {
        for (const it of retryItems) {
          await invoke("queue_retry", { id: it.id });
        }
        await refreshQueue();
      });
      actions.appendChild(retry);
    }
    const finished = g.items.filter((i) => i.status !== "running");
    if (finished.length === g.items.length) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "row-btn";
      remove.textContent = "Del";
      remove.addEventListener("click", async () => {
        for (const it of g.items) {
          await invoke("queue_remove", { id: it.id });
        }
        await refreshQueue();
      });
      actions.appendChild(remove);
    }

    queueListEl.appendChild(tr);

    if (expanded) {
      for (const item of g.items) {
        const liveItem = liveProgress.get(item.id);
        let subPct = 0;
        let subLabel = item.status;
        if (item.status === "done") {
          subPct = 100;
          subLabel = "Completed";
        } else if (item.status === "running" && liveItem && liveItem.page_total > 0) {
          subPct = Math.round((liveItem.page_current / liveItem.page_total) * 100);
          subLabel = `${liveItem.page_current}/${liveItem.page_total}`;
        } else if (item.status === "pending") {
          subLabel = "Waiting…";
        }

        const sub = document.createElement("tr");
        sub.className = "dl-row dl-sub";
        sub.innerHTML = `
          <td></td>
          <td class="col-manga sub-title">${escapeHtml(item.chapter_name)}</td>
          <td class="col-status"><span class="${statusBadge(item.status)}">${item.status}</span></td>
          <td class="col-progress">
            <div class="dl-progress ${groupProgressClass(
              item.status === "running"
                ? "Downloading"
                : item.status === "done"
                  ? "Completed"
                  : item.status === "failed"
                    ? "Failed"
                    : "Waiting…",
            )}">
              <div class="dl-progress-fill" style="width:${subPct}%"></div>
              <span class="dl-progress-text">${escapeHtml(subLabel)}</span>
            </div>
          </td>
          <td class="col-save muted">${escapeHtml(item.error || "")}</td>
          <td class="col-actions"></td>
        `;
        const subActions = sub.querySelector(".col-actions")!;
        if (item.status === "pending" || item.status === "running") {
          const c = document.createElement("button");
          c.type = "button";
          c.className = "row-btn";
          c.textContent = "Stop";
          c.addEventListener("click", async () => {
            await invoke("queue_cancel", { id: item.id });
            await refreshQueue();
          });
          subActions.appendChild(c);
        } else {
          if (item.status === "cancelled" || item.status === "failed") {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "row-btn";
            retry.textContent = "Retry";
            retry.addEventListener("click", async () => {
              await invoke("queue_retry", { id: item.id });
              await refreshQueue();
            });
            subActions.appendChild(retry);
          }
          const r = document.createElement("button");
          r.type = "button";
          r.className = "row-btn";
          r.textContent = "Del";
          r.addEventListener("click", async () => {
            await invoke("queue_remove", { id: item.id });
            await refreshQueue();
          });
          subActions.appendChild(r);
        }
        queueListEl.appendChild(sub);
      }
    }
  }
}

async function refreshQueue() {
  try {
    const items = await invoke<QueueItem[]>("queue_list");
    renderQueueTable(items);
  } catch (e) {
    log(String(e), "err");
  }
}

document.querySelector("#queue-refresh")!.addEventListener("click", () => void refreshQueue());
document.querySelector("#queue-clear")!.addEventListener("click", async () => {
  const n = await invoke<number>("queue_clear_finished");
  log(`Eliminados ${n} terminados`, "ok");
  await refreshQueue();
});
document.querySelector("#queue-start")!.addEventListener("click", async () => {
  await invoke("queue_start");
  log("Cola reanudada", "ok");
  await refreshQueue();
});

async function refreshFavorites() {
  try {
    const favs = await invoke<Favorite[]>("favorites_list");
    favListEl.innerHTML = "";
    if (!favs.length) {
      favListEl.innerHTML = `<div class="empty">Sin favoritos</div>`;
      return;
    }
    for (const fav of favs) {
      const row = document.createElement("div");
      row.className = "list-row";
      row.innerHTML = `
        <div class="list-main">
          <div><strong>${escapeHtml(fav.title)}</strong></div>
          <div class="muted">${escapeHtml(fav.module_name)} · ${fav.chapter_count} caps · último: ${escapeHtml(fav.last_chapter_name || "—")}</div>
        </div>
        <div class="list-actions"></div>
      `;
      const actions = row.querySelector(".list-actions")!;

      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "secondary";
      checkBtn.textContent = "Check";
      checkBtn.addEventListener("click", () => void runFavCheck(fav.id, false));

      const checkEnq = document.createElement("button");
      checkEnq.type = "button";
      checkEnq.className = "btn";
      checkEnq.textContent = "Check+cola";
      checkEnq.addEventListener("click", () => void runFavCheck(fav.id, true));

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "secondary";
      openBtn.textContent = "Abrir";
      openBtn.addEventListener("click", () => {
        urlInput.value = fav.manga_url;
        syncUrlClear();
        if ([...moduleSel.options].some((o) => o.value === fav.module_id)) {
          moduleSel.value = fav.module_id;
          updateSourceLabel();
        }
        switchNav("info");
        void loadMangaInfo();
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "secondary";
      del.textContent = "Quitar";
      del.addEventListener("click", async () => {
        await invoke("favorites_remove", { id: fav.id });
        await refreshFavorites();
        if (mangaUrl === fav.manga_url) {
          isFavorite = false;
          updateFavButton();
        }
      });

      actions.append(checkBtn, checkEnq, openBtn, del);
      favListEl.appendChild(row);
    }
  } catch (e) {
    log(String(e), "err");
  }
}

async function runFavCheck(id: number, enqueue: boolean) {
  setBusy(true, enqueue ? "Check + encolar…" : "Check favorito…");
  try {
    const r = await invoke<FavoriteCheckResult>("favorites_check", { id, enqueue });
    if (r.new_chapters.length) {
      log(
        `${r.favorite.title}: ${r.new_chapters.length} nuevos` +
          (enqueue ? `, encolados ${r.enqueued}` : ""),
        "ok",
      );
    } else {
      log(`${r.favorite.title}: sin capítulos nuevos`, "ok");
    }
    await refreshFavorites();
    if (enqueue && r.enqueued) await refreshQueue();
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
  }
}

document.querySelector("#fav-refresh")!.addEventListener("click", () => void refreshFavorites());
document.querySelector("#fav-check-all")!.addEventListener("click", async () => {
  setBusy(true, "Check todos…");
  try {
    const results = await invoke<FavoriteCheckResult[]>("favorites_check_all", {
      enqueue: false,
    });
    const news = results.reduce((a, r) => a + r.new_chapters.length, 0);
    log(`Check todos: ${news} capítulos nuevos en ${results.length} favoritos`, "ok");
    await refreshFavorites();
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
  }
});
document.querySelector("#fav-check-enqueue-all")!.addEventListener("click", async () => {
  const dir = await ensureOutputDir();
  if (!dir) {
    log("Elige carpeta de salida primero.", "err");
    return;
  }
  setBusy(true, "Check + encolar todos…");
  try {
    const results = await invoke<FavoriteCheckResult[]>("favorites_check_all", {
      enqueue: true,
    });
    const enq = results.reduce((a, r) => a + r.enqueued, 0);
    log(`Encolados ${enq} capítulos nuevos`, "ok");
    await refreshFavorites();
    await refreshQueue();
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
  }
});

let catalogSearchTimer: number | undefined;

function runCatalogSearch() {
  catalogQuery = catalogQ.value.trim();
  syncCatalogClear();
  void loadCatalog(true, true);
}

function scheduleCatalogSearch() {
  syncCatalogClear();
  window.clearTimeout(catalogSearchTimer);
  catalogSearchTimer = window.setTimeout(() => {
    const next = catalogQ.value.trim();
    if (next === catalogQuery && catalogLoadedKey.startsWith(`${selectedModuleId()}||`)) {
      return;
    }
    catalogQuery = next;
    void loadCatalog(true, true);
  }, 280);
}

function clearCatalogFilter() {
  window.clearTimeout(catalogSearchTimer);
  catalogQ.value = "";
  catalogQuery = "";
  syncCatalogClear();
  void loadCatalog(true, true);
}

/** Quita filtro avanzado (UI) + limpia el buscador de título. */
function clearAllFilters() {
  window.clearTimeout(catalogSearchTimer);
  catalogQ.value = "";
  catalogQuery = "";
  syncCatalogClear();
  advFilter = emptyAdvFilter();
  writeFilterStateToForm();
  advFilterApplied = false;
  syncCatalogModeLabel();
  void loadCatalog(true, true);
  log("Filtro quitado.", "ok");
}

const GENRE_TRI_CYCLE: GenreTri[] = ["ignore", "include", "exclude"];

function syncCatalogModeLabel() {
  if (advFilterApplied) {
    catalogModeLabel.textContent = "filtro (UI)";
  } else {
    catalogModeLabel.textContent = "búsqueda individual";
  }
}

function setInfoMode(mode: InfoMode) {
  if (infoMode === mode) return;
  infoMode = mode;
  const filterOn = mode === "filter";
  segSearchBtn.classList.toggle("active", !filterOn);
  segFilterBtn.classList.toggle("active", filterOn);
  filterPanel.hidden = !filterOn;
  infoCenter.hidden = filterOn;
  infoSidebar.hidden = filterOn;
  document.querySelector(".info-top")!.classList.toggle("is-filter", filterOn);
}

function genreChipClass(state: GenreTri): string {
  if (state === "include") return "chip inc";
  if (state === "exclude") return "chip exc";
  return "chip";
}

function updateFilterActiveCount() {
  const el = document.querySelector<HTMLElement>("#filter-active-count");
  if (!el) return;
  let n = 0;
  for (const g of DEFAULT_GENRES) {
    const st = advFilter.genres[g.id] ?? "ignore";
    if (st !== "ignore") n += 1;
  }
  if (filterCustomEl.value.trim()) n += 1;
  if (filterTitleEl.value.trim()) n += 1;
  if (filterAuthorsEl.value.trim()) n += 1;
  if (filterArtistsEl.value.trim()) n += 1;
  if (filterSummaryEl.value.trim()) n += 1;
  if (filterStatusEl.value !== "4") n += 1;
  if (filterOnlyNew.checked) n += 1;
  if (filterAllSites.checked) n += 1;
  if (filterRegex.checked) n += 1;
  el.textContent = String(n);
}

function renderFilterGenres() {
  filterGenresEl.innerHTML = "";
  for (const g of DEFAULT_GENRES) {
    const state = advFilter.genres[g.id] ?? "ignore";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = genreChipClass(state);
    btn.dataset.genre = g.id;
    btn.title =
      state === "include"
        ? "Incluir"
        : state === "exclude"
          ? "Excluir"
          : "No importa (clic para cambiar)";
    btn.innerHTML = `<span class="dot" aria-hidden="true"></span>${escapeHtml(g.label)}`;
    btn.addEventListener("click", () => {
      const cur = advFilter.genres[g.id] ?? "ignore";
      const next = GENRE_TRI_CYCLE[(GENRE_TRI_CYCLE.indexOf(cur) + 1) % GENRE_TRI_CYCLE.length]!;
      advFilter.genres[g.id] = next;
      btn.className = genreChipClass(next);
      btn.title =
        next === "include"
          ? "Incluir"
          : next === "exclude"
            ? "Excluir"
            : "No importa (clic para cambiar)";
      updateFilterActiveCount();
    });
    filterGenresEl.appendChild(btn);
  }
  updateFilterActiveCount();
}

function readFilterFormIntoState() {
  advFilter.customGenres = filterCustomEl.value;
  advFilter.title = filterTitleEl.value;
  advFilter.authors = filterAuthorsEl.value;
  advFilter.artists = filterArtistsEl.value;
  advFilter.summary = filterSummaryEl.value;
  const st = Number(filterStatusEl.value);
  advFilter.status = (st === 0 || st === 1 || st === 2 || st === 3 || st === 4 ? st : 4) as
    | 0
    | 1
    | 2
    | 3
    | 4;
  advFilter.matchMode = filterMatchAll.checked ? "all" : "one";
  advFilter.onlyNew = filterOnlyNew.checked;
  advFilter.allSites = filterAllSites.checked;
  advFilter.useRegex = filterRegex.checked;
}

function writeFilterStateToForm() {
  filterCustomEl.value = advFilter.customGenres;
  filterTitleEl.value = advFilter.title;
  filterAuthorsEl.value = advFilter.authors;
  filterArtistsEl.value = advFilter.artists;
  filterSummaryEl.value = advFilter.summary;
  filterStatusEl.value = String(advFilter.status);
  filterMatchAll.checked = advFilter.matchMode === "all";
  filterMatchOne.checked = advFilter.matchMode === "one";
  filterOnlyNew.checked = advFilter.onlyNew;
  filterAllSites.checked = advFilter.allSites;
  filterRegex.checked = advFilter.useRegex;
  renderFilterGenres();
  updateFilterActiveCount();
}

function applyAdvFilterStub() {
  readFilterFormIntoState();
  advFilterApplied = true;
  syncCatalogModeLabel();
  updateFilterActiveCount();
  log("Filtro preparado (UI; aún no aplica al catálogo).", "ok");
}

function removeAdvFilterStub() {
  clearAllFilters();
}

function resetAdvFilterForm() {
  advFilter = emptyAdvFilter();
  writeFilterStateToForm();
  log("Valores del filtro reiniciados.", "ok");
}

segSearchBtn.addEventListener("click", () => setInfoMode("search"));
segFilterBtn.addEventListener("click", () => setInfoMode("filter"));
document.querySelector("#filter-apply")!.addEventListener("click", applyAdvFilterStub);
document.querySelector("#filter-remove")!.addEventListener("click", removeAdvFilterStub);
document.querySelector("#filter-reset")!.addEventListener("click", resetAdvFilterForm);
document.querySelector("#filter-back")!.addEventListener("click", () => setInfoMode("search"));
document.querySelector("#filter-panel")!.addEventListener("change", updateFilterActiveCount);
document.querySelector("#filter-panel")!.addEventListener("input", updateFilterActiveCount);

writeFilterStateToForm();
syncCatalogModeLabel();

document.querySelector("#catalog-broom")!.addEventListener("click", clearCatalogFilter);
document.querySelector("#catalog-clear-adv")!.addEventListener("click", clearAllFilters);
catalogQ.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    window.clearTimeout(catalogSearchTimer);
    runCatalogSearch();
  }
});
catalogQ.addEventListener("input", scheduleCatalogSearch);
catalogClearBtn.addEventListener("click", clearCatalogFilter);

document.querySelector("#catalog-update")!.addEventListener("click", async () => {
  const id = selectedModuleId();
  if (!id) {
    log("Elige una fuente primero.", "err");
    return;
  }
  catalogRefreshIco.classList.add("ico-spin");
  setBusy(true, "Actualizando lista (GetNameAndLink)…");
  try {
    const st = await invoke<UpdateListStats>("catalog_update", { moduleId: id });
    log(
      `Catálogo OK: +${st.inserted} nuevas · ${st.total_in_db} total · ${st.pages_fetched} páginas`,
      "ok",
    );
    catalogQuery = "";
    catalogQ.value = "";
    syncCatalogClear();
    catalogLoadedKey = "";
    await loadCatalog(true);
  } catch (e) {
    log(String(e), "err");
  } finally {
    catalogRefreshIco.classList.remove("ico-spin");
    setBusy(false);
  }
});

void listen<{
  module_id: string;
  page: number;
  page_total: number;
  inserted_total: number;
  batch_rows: number;
}>("catalog-progress", (ev) => {
  const p = ev.payload;
  log(`Catálogo [${p.page + 1}/${p.page_total}] +${p.batch_rows} (acum ${p.inserted_total})`);
});

void listen<QueueProgressEvent>("queue-progress", (ev) => {
  const p = ev.payload;
  liveProgress.set(p.item_id, {
    page_current: p.page_current,
    page_total: p.page_total,
    message: p.message,
    chapter_name: p.chapter_name,
  });
  log(p.message);
  if (activeNav === "downloads") {
    renderQueueTable(lastQueueItems);
  }
});

void listen<string>("lua-log", (ev) => {
  log(ev.payload);
});

void listen("queue-changed", () => {
  if (activeNav === "downloads") void refreshQueue();
});

function switchOptionsTab(tabId: string) {
  document.querySelectorAll<HTMLButtonElement>(".options-cat").forEach((btn) => {
    const on = btn.dataset.optTab === tabId;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll<HTMLElement>(".options-panel").forEach((panel) => {
    const on = panel.dataset.optPanel === tabId;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  });
}

function setOptionsDirty(dirty: boolean) {
  const el = document.querySelector<HTMLElement>("#opt-dirty");
  if (el) el.hidden = !dirty;
}

function getPackFormat(): string {
  return (
    document.querySelector<HTMLElement>("#set-pack .st-seg-opt.on")?.dataset.pack ?? "none"
  );
}

function setPackFormat(value: string) {
  const v = ["none", "zip", "cbz", "pdf", "epub"].includes(value) ? value : "none";
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#set-pack .st-seg-opt")) {
    const on = btn.dataset.pack === v;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const pdfRow = document.querySelector<HTMLElement>("#set-pdf-quality-row");
  if (pdfRow) pdfRow.hidden = v !== "pdf";
}

function syncOptReveal() {
  const ext = document.querySelector<HTMLInputElement>("#opt-external");
  const extFields = document.querySelector<HTMLElement>("#opt-external-fields");
  if (ext && extFields) extFields.hidden = !ext.checked;
  const logEl = document.querySelector<HTMLInputElement>("#opt-log");
  const logExtra = document.querySelector<HTMLElement>("#opt-log-extra");
  if (logEl && logExtra) logExtra.hidden = !logEl.checked;
  const proxyOn = document.querySelector<HTMLInputElement>("#set-use-proxy");
  const proxyFields = document.querySelector<HTMLElement>("#opt-proxy-fields");
  if (proxyOn && proxyFields) proxyFields.hidden = !proxyOn.checked;
  const asciiOn = document.querySelector<HTMLInputElement>("#set-replace-ascii");
  const asciiFields = document.querySelector<HTMLElement>("#opt-replace-ascii-fields");
  if (asciiOn && asciiFields) asciiFields.hidden = !asciiOn.checked;
  const mangaFolder = document.querySelector<HTMLInputElement>("#set-manga-folder");
  const mangaPat = document.querySelector<HTMLElement>("#set-pat-manga-row");
  if (mangaFolder && mangaPat) mangaPat.hidden = !mangaFolder.checked;
  const chapterFolder = document.querySelector<HTMLInputElement>("#set-chapter-folder");
  const chapterPat = document.querySelector<HTMLElement>("#set-pat-chapter-row");
  if (chapterFolder && chapterPat) chapterPat.hidden = !chapterFolder.checked;
  const volPad = document.querySelector<HTMLInputElement>("#set-vol-pad");
  const volFields = document.querySelector<HTMLElement>("#opt-vol-pad-fields");
  if (volPad && volFields) volFields.hidden = !volPad.checked;
  const chapPad = document.querySelector<HTMLInputElement>("#set-chap-pad");
  const chapFields = document.querySelector<HTMLElement>("#opt-chap-pad-fields");
  if (chapPad && chapFields) chapFields.hidden = !chapPad.checked;
  const favInterval = document.querySelector<HTMLInputElement>("#set-fav-interval");
  const favIntervalFields = document.querySelector<HTMLElement>("#opt-fav-interval-fields");
  if (favInterval && favIntervalFields) favIntervalFields.hidden = !favInterval.checked;
  updateRenamePreview();
}

const RENAME_SAMPLE: Record<string, string> = {
  "%MANGA%": "One Piece",
  "%WEBSITE%": "MangaDex",
  "%AUTHOR%": "Eiichiro Oda",
  "%ARTIST%": "Eiichiro Oda",
  "%NUMBERING%": "003",
  "%CHAPTER%": "Chapter 3",
  "%FILENAME%": "003",
};

const PACK_EXT: Record<string, string> = {
  none: "",
  zip: ".zip",
  cbz: ".cbz",
  pdf: ".pdf",
  epub: ".epub",
};

function resolveRenamePattern(pattern: string): string {
  let out = pattern || "";
  for (const [token, value] of Object.entries(RENAME_SAMPLE)) {
    out = out.split(token).join(value);
  }
  return out;
}

function updateRenamePreview() {
  const el = document.querySelector<HTMLElement>("#set-rename-preview");
  if (!el) return;
  const root =
    document.querySelector<HTMLInputElement>("#set-output-dir")?.value.trim() ||
    "C:\\Users\\WILMER\\Desktop\\manga";
  const parts = [root.replace(/[\\/]+$/, "")];
  const mangaOn = document.querySelector<HTMLInputElement>("#set-manga-folder")?.checked;
  const chapterOn = document.querySelector<HTMLInputElement>("#set-chapter-folder")?.checked;
  if (mangaOn) {
    parts.push(
      resolveRenamePattern(
        document.querySelector<HTMLInputElement>("#set-pat-manga")?.value || "%MANGA%",
      ) || "Manga",
    );
  }
  if (chapterOn) {
    parts.push(
      resolveRenamePattern(
        document.querySelector<HTMLInputElement>("#set-pat-chapter")?.value || "%CHAPTER%",
      ) || "003",
    );
  }
  const leaf =
    resolveRenamePattern(
      document.querySelector<HTMLInputElement>("#set-pat-page")?.value || "%FILENAME%",
    ) || "003";
  const pack =
    document.querySelector<HTMLElement>("#set-pack .st-seg-opt.on")?.dataset.pack ?? "none";
  let out = `${parts.join("\\")}\\${leaf}${PACK_EXT[pack] ?? ""}`;
  const asciiOn = document.querySelector<HTMLInputElement>("#set-replace-ascii")?.checked;
  if (asciiOn) {
    const repl =
      document.querySelector<HTMLInputElement>("#set-replace-ascii-char")?.value || "_";
    out = out.replace(/[^\x00-\x7F]/g, repl);
  }
  el.textContent = out;
}

function parseProxyUrl(raw: string): {
  type: string;
  host: string;
  port: string;
  user: string;
  pass: string;
} {
  const empty = { type: "http", host: "", port: "8080", user: "", pass: "" };
  const s = raw.trim();
  if (!s) return empty;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    const proto = (u.protocol.replace(":", "") || "http").toLowerCase();
    const type = proto === "socks4" || proto === "socks5" ? proto : "http";
    return {
      type,
      host: u.hostname || "",
      port: u.port || (type === "http" ? "8080" : "1080"),
      user: decodeURIComponent(u.username || ""),
      pass: decodeURIComponent(u.password || ""),
    };
  } catch {
    return empty;
  }
}

function composeProxyUrl(): string {
  const host = document.querySelector<HTMLInputElement>("#set-proxy-host")!.value.trim();
  if (!host) return "";
  const type = document.querySelector<HTMLSelectElement>("#set-proxy-type")!.value || "http";
  const port = document.querySelector<HTMLInputElement>("#set-proxy-port")!.value.trim() || "8080";
  const user = document.querySelector<HTMLInputElement>("#set-proxy-user")!.value.trim();
  const pass = document.querySelector<HTMLInputElement>("#set-proxy-pass")!.value;
  const auth =
    user || pass
      ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ""}@`
      : "";
  return `${type}://${auth}${host}:${port}`;
}

function clampStepperInput(input: HTMLInputElement) {
  const min = input.min !== "" ? Number(input.min) : 0;
  const max = input.max !== "" ? Number(input.max) : Number.POSITIVE_INFINITY;
  let v = Number(input.value);
  if (!Number.isFinite(v)) v = min;
  v = Math.min(max, Math.max(min, Math.trunc(v)));
  input.value = String(v);
}

type SiteMod = { id: string; name: string; domain: string };
type SiteGroup = { id: string; label: string; sites: SiteMod[] };

type SitesFlatRow =
  | {
      kind: "group";
      key: string;
      groupId: string;
      label: string;
      total: number;
      onCount: number;
      open: boolean;
    }
  | {
      kind: "site";
      key: string;
      groupId: string;
      id: string;
      name: string;
      domain: string;
      on: boolean;
    };

const SITE_ROW_H = 31;
const SITE_OVERSCAN = 10;

const sitesState = {
  tab: "list" as string,
  query: "",
  onlyActive: false,
  /** module ids explicitly enabled (FMD2: MangaListSelect; vacío = todo desmarcado). */
  siteOn: {} as Record<string, true>,
  expanded: {} as Record<string, boolean>,
  groups: [] as SiteGroup[],
  flat: [] as SitesFlatRow[],
  total: 0,
  totalOn: 0,
};

function moduleDomain(rootUrl: string): string {
  return rootUrl
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/^www\./i, "");
}

/** Agrupa módulos por `category` como FMD2 (`vtOptionMangaSiteSelection`). */
function rebuildSitesFromModules() {
  const byCat = new Map<string, SiteMod[]>();
  for (const m of modulesCache) {
    const label = (m.category || "").trim() || "Other";
    let list = byCat.get(label);
    if (!list) {
      list = [];
      byCat.set(label, list);
    }
    list.push({ id: m.id, name: m.name, domain: moduleDomain(m.root_url) });
  }
  const labels = [...byCat.keys()].sort((a, b) => a.localeCompare(b));
  sitesState.groups = labels.map((label) => {
    const sites = (byCat.get(label) || []).sort((a, b) => a.name.localeCompare(b.name));
    return { id: label, label, sites };
  });
  // Drop stale on flags for removed modules
  const alive = new Set(modulesCache.map((m) => m.id));
  for (const id of Object.keys(sitesState.siteOn)) {
    if (!alive.has(id)) delete sitesState.siteOn[id];
  }
  renderSitesTree();
}

function siteIsOn(id: string): boolean {
  return !!sitesState.siteOn[id];
}

function setSitesOn(ids: string[], on: boolean) {
  for (const id of ids) {
    if (on) sitesState.siteOn[id] = true;
    else delete sitesState.siteOn[id];
  }
  setOptionsDirty(true);
  renderSitesTree();
}

function allSiteIds(): string[] {
  const out: string[] = [];
  for (const g of sitesState.groups) for (const st of g.sites) out.push(st.id);
  return out;
}

function switchSitesTab(tab: string) {
  sitesState.tab = tab;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".sites-tab")) {
    const on = btn.dataset.sitesTab === tab;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const pane of document.querySelectorAll<HTMLElement>("[data-sites-pane]")) {
    pane.hidden = pane.dataset.sitesPane !== tab;
  }
}

function syncSitesClear() {
  const q = document.querySelector<HTMLInputElement>("#sites-q");
  const btn = document.querySelector<HTMLButtonElement>("#sites-clear");
  if (btn) btn.hidden = !(q?.value.trim());
}

function buildSitesFlat(): SitesFlatRow[] {
  const sq = sitesState.query.trim().toLowerCase();
  const flat: SitesFlatRow[] = [];
  let total = 0;
  let totalOn = 0;

  for (const g of sitesState.groups) {
    for (const st of g.sites) {
      total++;
      if (siteIsOn(st.id)) totalOn++;
    }
    const gMatch = g.label.toLowerCase().includes(sq);
    let sites =
      sq && !gMatch
        ? g.sites.filter(
            (st) =>
              st.name.toLowerCase().includes(sq) ||
              st.domain.toLowerCase().includes(sq) ||
              st.id.toLowerCase().includes(sq),
          )
        : g.sites.slice();
    if (sitesState.onlyActive) sites = sites.filter((st) => siteIsOn(st.id));
    if (!sites.length) continue;

    const onCount = g.sites.filter((st) => siteIsOn(st.id)).length;
    const open = !!sitesState.expanded[g.id] || !!sq || sitesState.onlyActive;
    flat.push({
      kind: "group",
      key: `g:${g.id}`,
      groupId: g.id,
      label: g.label,
      total: g.sites.length,
      onCount,
      open,
    });
    if (!open) continue;
    for (const st of sites) {
      flat.push({
        kind: "site",
        key: `s:${st.id}`,
        groupId: g.id,
        id: st.id,
        name: st.name,
        domain: st.domain,
        on: siteIsOn(st.id),
      });
    }
  }

  sitesState.total = total;
  sitesState.totalOn = totalOn;
  sitesState.flat = flat;
  return flat;
}

function renderSitesTree() {
  const tree = document.querySelector<HTMLElement>("#sites-tree");
  const activeLabel = document.querySelector<HTMLElement>("#sites-active-label");
  const onlyBtn = document.querySelector<HTMLButtonElement>("#sites-only-active");
  if (!tree) return;

  const flat = buildSitesFlat();
  if (activeLabel) {
    activeLabel.textContent = `${sitesState.totalOn} de ${sitesState.total} sitios activos`;
  }
  if (onlyBtn) {
    onlyBtn.textContent = sitesState.onlyActive ? "Mostrar todos" : "Mostrar solo activos";
  }
  syncSitesClear();

  if (!modulesCache.length) {
    tree.onscroll = null;
    tree.innerHTML = `
      <div class="sites-tree-empty">
        <div class="sites-empty-title">Sin módulos</div>
        <div class="sites-empty-desc">Aún no se cargaron módulos de <code>lua/modules</code>.</div>
      </div>
    `;
    return;
  }

  if (!flat.length) {
    tree.onscroll = null;
    tree.innerHTML = `
      <div class="sites-tree-empty">
        <div class="sites-empty-title">Sin coincidencias</div>
        <div class="sites-empty-desc">Ningún sitio coincide con “${escapeHtml(sitesState.query)}”.</div>
      </div>
    `;
    return;
  }

  let virtual = tree.querySelector<HTMLDivElement>(".sites-virtual");
  if (!virtual) {
    tree.innerHTML = "";
    virtual = document.createElement("div");
    virtual.className = "sites-virtual";
    tree.appendChild(virtual);
    tree.onscroll = () => paintVirtualSites();
  }
  virtual.style.height = `${flat.length * SITE_ROW_H}px`;
  paintVirtualSites();
}

function paintVirtualSites() {
  const tree = document.querySelector<HTMLElement>("#sites-tree");
  const virtual = tree?.querySelector<HTMLDivElement>(".sites-virtual");
  const flat = sitesState.flat;
  if (!tree || !virtual || !flat.length) return;

  const scrollTop = tree.scrollTop;
  const viewH = tree.clientHeight || 400;
  let start = Math.floor(scrollTop / SITE_ROW_H) - SITE_OVERSCAN;
  let end = Math.ceil((scrollTop + viewH) / SITE_ROW_H) + SITE_OVERSCAN;
  start = Math.max(0, start);
  end = Math.min(flat.length, end);

  const existing = new Map<string, HTMLElement>();
  virtual.querySelectorAll<HTMLElement>(".sites-trow").forEach((el) => {
    const key = el.dataset.rowKey;
    if (key) existing.set(key, el);
  });

  const keep = new Set<string>();
  for (let i = start; i < end; i++) {
    const row = flat[i];
    keep.add(row.key);
    let el = existing.get(row.key);
    if (!el) {
      el = document.createElement("div");
      el.dataset.rowKey = row.key;
      virtual.appendChild(el);
    }
    el.style.top = `${i * SITE_ROW_H}px`;
    if (row.kind === "group") {
      const cbCls =
        row.onCount === 0 ? "" : row.onCount === row.total ? "on" : "some";
      const summary =
        row.onCount === row.total
          ? "Todos activos"
          : row.onCount === 0
            ? "Ninguno"
            : `${row.onCount} de ${row.total} activos`;
      el.className = "sites-trow sites-trow-group";
      el.dataset.group = row.groupId;
      el.style.background = "var(--card)";
      el.innerHTML = `
        <button type="button" class="sites-tw" data-sites-action="expand" data-group="${escapeHtml(row.groupId)}" aria-label="Expandir o contraer">
          <span class="ico ico-sm" style="--ico:${ICO.chevron};transform:${row.open ? "rotate(0deg)" : "rotate(-90deg)"}"></span>
        </button>
        <button type="button" class="sites-cb ${cbCls}" data-sites-action="group-check" data-group="${escapeHtml(row.groupId)}" style="--ico:${cbCls === "some" ? ICO.dash : ICO.check}" aria-label="Activar grupo">
          <span class="sites-cb-mk"></span>
        </button>
        <span class="sites-group-label">${escapeHtml(row.label)}</span>
        <span class="sites-group-count">(${row.total})</span>
        <div class="sites-row-spacer"></div>
        <span class="sites-group-summary">${escapeHtml(summary)}</span>
      `;
    } else {
      el.className = "sites-trow sites-trow-site";
      el.dataset.siteKey = row.id;
      el.dataset.sitesAction = "site-check";
      el.style.background = "";
      el.innerHTML = `
        <button type="button" class="sites-cb ${row.on ? "on" : ""}" data-sites-action="site-check" data-site-key="${escapeHtml(row.id)}" style="--ico:${ICO.check}" aria-label="Activar sitio">
          <span class="sites-cb-mk"></span>
        </button>
        <span class="sites-site-label" style="color:${row.on ? "var(--text)" : "var(--muted)"}">${escapeHtml(row.name)}</span>
        <div class="sites-row-spacer"></div>
        <span class="sites-site-domain">${escapeHtml(row.domain)}</span>
      `;
    }
  }

  for (const [key, el] of existing) {
    if (!keep.has(key)) el.remove();
  }
}

function initSitesPanel() {
  const root = document.querySelector<HTMLElement>("#opt-websites");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";

  root.querySelector(".sites-tabs")?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".sites-tab");
    if (!btn?.dataset.sitesTab) return;
    switchSitesTab(btn.dataset.sitesTab);
  });

  const sitesQ = document.querySelector<HTMLInputElement>("#sites-q");
  const sitesClear = document.querySelector<HTMLButtonElement>("#sites-clear");
  sitesQ?.addEventListener("input", () => {
    sitesState.query = sitesQ.value;
    syncSitesClear();
    renderSitesTree();
  });
  sitesClear?.addEventListener("click", () => {
    if (!sitesQ) return;
    sitesQ.value = "";
    sitesState.query = "";
    syncSitesClear();
    sitesQ.focus();
    renderSitesTree();
  });

  document.querySelector("#sites-all")?.addEventListener("click", () => {
    setSitesOn(allSiteIds(), true);
  });
  document.querySelector("#sites-none")?.addEventListener("click", () => {
    setSitesOn(allSiteIds(), false);
  });
  document.querySelector("#sites-expand")?.addEventListener("click", () => {
    sitesState.expanded = Object.fromEntries(
      sitesState.groups.map((g) => [g.id, true]),
    );
    renderSitesTree();
  });
  document.querySelector("#sites-collapse")?.addEventListener("click", () => {
    sitesState.expanded = {};
    sitesState.query = "";
    sitesState.onlyActive = false;
    if (sitesQ) sitesQ.value = "";
    syncSitesClear();
    renderSitesTree();
  });
  document.querySelector("#sites-only-active")?.addEventListener("click", () => {
    sitesState.onlyActive = !sitesState.onlyActive;
    renderSitesTree();
  });

  document.querySelector("#sites-tree")?.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const actionEl = t.closest<HTMLElement>("[data-sites-action]");
    const action = actionEl?.dataset.sitesAction;

    if (action === "group-check") {
      const gid = actionEl!.dataset.group;
      const g = sitesState.groups.find((x) => x.id === gid);
      if (!g) return;
      const ids = g.sites.map((st) => st.id);
      const onCount = g.sites.filter((st) => siteIsOn(st.id)).length;
      setSitesOn(ids, onCount !== g.sites.length);
      return;
    }

    if (action === "site-check") {
      const id =
        actionEl!.dataset.siteKey ||
        actionEl!.closest<HTMLElement>("[data-site-key]")?.dataset.siteKey;
      if (!id) return;
      setSitesOn([id], !siteIsOn(id));
      return;
    }

    if (action === "expand" || t.closest(".sites-trow-group")) {
      const row = t.closest<HTMLElement>(".sites-trow-group");
      const gid = actionEl?.dataset.group || row?.dataset.group;
      if (!gid) return;
      sitesState.expanded[gid] = !sitesState.expanded[gid];
      renderSitesTree();
    }
  });

  renderSitesTree();
}

/* ---- Módulos (Lua updater UI / OmniManga) ---- */

type ModRow = {
  key: string;
  file: string;
  mtime: number | null;
  when: string;
  dateTitle: string;
  msg: string;
  updated: boolean;
};

const MOD_ROW_H = 32;
const MOD_OVERSCAN = 10;
/** Highlight as "Nuevo" if mtime within this many days (local scan; GitHub updater pending). */
const MOD_NEW_DAYS = 14;

const modsState = {
  query: "",
  onlyUpdated: false,
  warn: true,
  autoRestart: false,
  checking: false,
  rows: [] as ModRow[],
  flat: [] as ModRow[],
};

function moduleFileName(m: ModuleMeta): string {
  const p = (m.file_path || "").replace(/\\/g, "/");
  const base = p.split("/").pop() || "";
  return base || `${m.id}.lua`;
}

function relDateFromUnix(sec: number | null | undefined): { when: string; title: string } {
  if (sec == null || !Number.isFinite(sec)) return { when: "—", title: "" };
  const d = new Date(sec * 1000);
  const title = d.toLocaleString();
  const days = Math.round((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return { when: "hoy", title };
  if (days === 1) return { when: "ayer", title };
  if (days < 30) return { when: `hace ${days} días`, title };
  if (days < 365) return { when: `hace ${Math.round(days / 30)} meses`, title };
  return { when: `hace ${(days / 365).toFixed(1)} años`, title };
}

function rebuildModulesFromFiles() {
  const byFile = new Map<string, ModRow>();
  const newCut = Date.now() - MOD_NEW_DAYS * 86400000;
  for (const m of modulesCache) {
    const file = moduleFileName(m);
    const mtime = m.mtime ?? null;
    const prev = byFile.get(file);
    if (prev && (prev.mtime ?? 0) >= (mtime ?? 0)) continue;
    const { when, title } = relDateFromUnix(mtime);
    byFile.set(file, {
      key: file,
      file,
      mtime,
      when,
      dateTitle: title,
      msg: "—",
      updated: mtime != null && mtime * 1000 >= newCut,
    });
  }
  modsState.rows = [...byFile.values()].sort((a, b) =>
    a.file.localeCompare(b.file, undefined, { sensitivity: "base" }),
  );
  renderModulesList();
}

function syncModsClear() {
  const q = document.querySelector<HTMLInputElement>("#mods-q");
  const btn = document.querySelector<HTMLButtonElement>("#mods-clear");
  if (btn) btn.hidden = !(q?.value.trim());
}

function syncModsChk(id: string, on: boolean) {
  const el = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (!el) return;
  el.setAttribute("aria-pressed", on ? "true" : "false");
  const cb = el.querySelector(".sites-cb");
  cb?.classList.toggle("on", on);
}

function buildModsFlat(): ModRow[] {
  const mq = modsState.query.trim().toLowerCase();
  let rows = modsState.rows;
  if (mq) {
    rows = rows.filter(
      (r) => r.file.toLowerCase().includes(mq) || r.msg.toLowerCase().includes(mq),
    );
  }
  if (modsState.onlyUpdated) rows = rows.filter((r) => r.updated);
  modsState.flat = rows;
  return rows;
}

function renderModulesList() {
  const list = document.querySelector<HTMLElement>("#mods-list");
  const summary = document.querySelector<HTMLElement>("#mods-summary");
  const onlyBtn = document.querySelector<HTMLButtonElement>("#mods-only-updated");
  if (!list) return;

  const flat = buildModsFlat();
  const updCount = modsState.rows.filter((r) => r.updated).length;
  if (summary) {
    summary.textContent = `${modsState.rows.length} módulos · ${updCount} actualizados recientemente`;
  }
  if (onlyBtn) {
    onlyBtn.textContent = modsState.onlyUpdated
      ? "Mostrar todos"
      : "Mostrar solo actualizados";
  }
  syncModsClear();

  if (!modsState.rows.length) {
    list.onscroll = null;
    list.innerHTML = `
      <div class="sites-tree-empty">
        <div class="sites-empty-title">Sin módulos</div>
        <div class="sites-empty-desc">No hay archivos en <code>lua/modules</code>.</div>
      </div>
    `;
    return;
  }

  if (!flat.length) {
    list.onscroll = null;
    list.innerHTML = `
      <div class="sites-tree-empty">
        <div class="sites-empty-title">Sin coincidencias</div>
        <div class="sites-empty-desc">Ningún módulo coincide con la búsqueda.</div>
      </div>
    `;
    return;
  }

  let virtual = list.querySelector<HTMLDivElement>(".mods-virtual");
  if (!virtual) {
    list.innerHTML = "";
    virtual = document.createElement("div");
    virtual.className = "mods-virtual";
    list.appendChild(virtual);
    list.onscroll = () => paintVirtualMods();
  }
  virtual.style.height = `${flat.length * MOD_ROW_H}px`;
  paintVirtualMods();
}

function paintVirtualMods() {
  const list = document.querySelector<HTMLElement>("#mods-list");
  const virtual = list?.querySelector<HTMLDivElement>(".mods-virtual");
  const flat = modsState.flat;
  if (!list || !virtual || !flat.length) return;

  const scrollTop = list.scrollTop;
  const viewH = list.clientHeight || 400;
  let start = Math.floor(scrollTop / MOD_ROW_H) - MOD_OVERSCAN;
  let end = Math.ceil((scrollTop + viewH) / MOD_ROW_H) + MOD_OVERSCAN;
  start = Math.max(0, start);
  end = Math.min(flat.length, end);

  const existing = new Map<string, HTMLElement>();
  virtual.querySelectorAll<HTMLElement>(".mods-row").forEach((el) => {
    const key = el.dataset.rowKey;
    if (key) existing.set(key, el);
  });

  const keep = new Set<string>();
  for (let i = start; i < end; i++) {
    const row = flat[i];
    keep.add(row.key);
    let el = existing.get(row.key);
    if (!el) {
      el = document.createElement("div");
      el.dataset.rowKey = row.key;
      virtual.appendChild(el);
    }
    el.className = `mods-row${row.updated ? " updated" : ""}`;
    el.style.top = `${i * MOD_ROW_H}px`;
    el.innerHTML = `
      <div class="mods-name">
        <span class="ico ico-sm" style="--ico:${ICO.file};color:var(--muted)"></span>
        <span class="ell mods-file">${escapeHtml(row.file)}</span>
        ${row.updated ? '<span class="mods-new">Nuevo</span>' : ""}
      </div>
      <span class="mods-when" title="${escapeHtml(row.dateTitle)}">${escapeHtml(row.when)}</span>
      <span class="ell mods-msg ${row.msg === "—" ? "muted" : ""}">${escapeHtml(row.msg)}</span>
    `;
  }
  for (const [key, el] of existing) {
    if (!keep.has(key)) el.remove();
  }
}

async function runModulesCheck() {
  if (modsState.checking) return;
  modsState.checking = true;
  const label = document.querySelector<HTMLElement>("#mods-check-label");
  const ico = document.querySelector<HTMLElement>("#mods-check-ico");
  if (label) label.textContent = "Revisando...";
  if (ico) ico.style.transform = "rotate(180deg)";
  try {
    const n = await invoke<number>("modules_refresh_cmd");
    await loadModules();
    log(`Módulos reescaneados: ${n}`, "ok");
  } catch (e) {
    log(`No se pudo revisar módulos: ${e}`, "err");
  } finally {
    modsState.checking = false;
    if (label) label.textContent = "Revisar actualización";
    if (ico) ico.style.transform = "";
  }
}

function initModulesPanel() {
  const root = document.querySelector<HTMLElement>("#opt-websites");
  if (!root || root.dataset.modsBound === "1") return;
  root.dataset.modsBound = "1";

  syncModsChk("mods-warn", modsState.warn);
  syncModsChk("mods-autorestart", modsState.autoRestart);

  document.querySelector("#mods-check")?.addEventListener("click", () => {
    void runModulesCheck();
  });
  document.querySelector("#mods-warn")?.addEventListener("click", () => {
    modsState.warn = !modsState.warn;
    syncModsChk("mods-warn", modsState.warn);
    setOptionsDirty(true);
  });
  document.querySelector("#mods-autorestart")?.addEventListener("click", () => {
    modsState.autoRestart = !modsState.autoRestart;
    syncModsChk("mods-autorestart", modsState.autoRestart);
    setOptionsDirty(true);
  });

  const modsQ = document.querySelector<HTMLInputElement>("#mods-q");
  const modsClear = document.querySelector<HTMLButtonElement>("#mods-clear");
  modsQ?.addEventListener("input", () => {
    modsState.query = modsQ.value;
    syncModsClear();
    renderModulesList();
  });
  modsClear?.addEventListener("click", () => {
    if (!modsQ) return;
    modsQ.value = "";
    modsState.query = "";
    syncModsClear();
    modsQ.focus();
    renderModulesList();
  });
  document.querySelector("#mods-only-updated")?.addEventListener("click", () => {
    modsState.onlyUpdated = !modsState.onlyUpdated;
    renderModulesList();
  });

  renderModulesList();
}

initSitesPanel();
initModulesPanel();

document.querySelector(".options-cats")!.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".options-cat");
  if (!btn?.dataset.optTab) return;
  switchOptionsTab(btn.dataset.optTab);
});

document.querySelector("#view-options")!.addEventListener("click", (ev) => {
  const tokenChip = (ev.target as HTMLElement).closest<HTMLButtonElement>(".st-token-chip");
  if (tokenChip?.dataset.token) {
    const wrap = tokenChip.closest<HTMLElement>(".st-token-insert");
    const inputId = wrap?.dataset.target;
    const input = inputId
      ? document.querySelector<HTMLInputElement>(`#${CSS.escape(inputId)}`)
      : null;
    if (input) {
      const token = tokenChip.dataset.token;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      const caret = start + token.length;
      input.focus();
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      setOptionsDirty(true);
      updateRenamePreview();
    }
    return;
  }
  const packBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>("#set-pack .st-seg-opt");
  if (packBtn?.dataset.pack) {
    setPackFormat(packBtn.dataset.pack);
    setOptionsDirty(true);
    updateRenamePreview();
    return;
  }
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".st-stepper-btn");
  if (!btn) return;
  ev.preventDefault();
  const root = btn.closest(".st-stepper");
  const input = root?.querySelector<HTMLInputElement>("input");
  if (!input) return;
  const step = Number(btn.dataset.step) || 0;
  clampStepperInput(input);
  input.value = String(Number(input.value) + step);
  clampStepperInput(input);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  setOptionsDirty(true);
});

document.querySelector("#view-options")!.addEventListener("change", (ev) => {
  const t = ev.target as HTMLElement;
  if (
    t.id === "opt-external" ||
    t.id === "opt-log" ||
    t.id === "set-use-proxy" ||
    t.id === "set-replace-ascii" ||
    t.id === "set-manga-folder" ||
    t.id === "set-chapter-folder" ||
    t.id === "set-vol-pad" ||
    t.id === "set-chap-pad" ||
    t.id === "set-fav-interval"
  ) {
    syncOptReveal();
  }
  if (t instanceof HTMLInputElement && t.classList.contains("st-stepper-input")) {
    clampStepperInput(t);
  }
  setOptionsDirty(true);
  if (
    t.id === "set-pat-manga" ||
    t.id === "set-pat-chapter" ||
    t.id === "set-pat-page" ||
    t.id === "set-replace-ascii-char" ||
    t.id === "set-output-dir"
  ) {
    updateRenamePreview();
  }
});
document.querySelector("#view-options")!.addEventListener("input", (ev) => {
  setOptionsDirty(true);
  const t = ev.target as HTMLElement;
  if (
    t.id === "set-pat-manga" ||
    t.id === "set-pat-chapter" ||
    t.id === "set-pat-page" ||
    t.id === "set-replace-ascii-char"
  ) {
    updateRenamePreview();
  }
});

async function loadSettingsForm() {
  const get = (k: string) => invoke<string | null>("settings_get", { key: k });
  const ua = document.querySelector<HTMLInputElement>("#set-ua")!;
  const threads = document.querySelector<HTMLInputElement>("#set-threads")!;
  const patM = document.querySelector<HTMLInputElement>("#set-pat-manga")!;
  const patC = document.querySelector<HTMLInputElement>("#set-pat-chapter")!;
  const patP = document.querySelector<HTMLInputElement>("#set-pat-page")!;
  const outDir = document.querySelector<HTMLInputElement>("#set-output-dir")!;
  const savedUa = ((await get("http.user_agent")) ?? "").trim();
  ua.value = savedUa || DEFAULT_USER_AGENT;
  const proxyRaw = (await get("http.proxy")) ?? "";
  const parsed = parseProxyUrl(proxyRaw);
  document.querySelector<HTMLSelectElement>("#set-proxy-type")!.value = parsed.type;
  document.querySelector<HTMLInputElement>("#set-proxy-host")!.value = parsed.host;
  document.querySelector<HTMLInputElement>("#set-proxy-port")!.value = parsed.port;
  document.querySelector<HTMLInputElement>("#set-proxy-user")!.value = parsed.user;
  document.querySelector<HTMLInputElement>("#set-proxy-pass")!.value = parsed.pass;
  document.querySelector<HTMLInputElement>("#set-use-proxy")!.checked = Boolean(proxyRaw.trim());
  threads.value = (await get("download.max_threads")) ?? "1";
  const packVal = (await get("download.pack_format")) ?? "none";
  const packOk = ["none", "zip", "cbz", "pdf", "epub"].includes(packVal) ? packVal : "none";
  setPackFormat(packOk);
  patM.value = (await get("download.manga_folder_pattern")) ?? "%MANGA%";
  patC.value = (await get("download.chapter_folder_pattern")) ?? "%CHAPTER%";
  patP.value = (await get("download.page_name_pattern")) ?? "%FILENAME%";
  const savedDir = (await get("default_output_dir")) ?? outputDir ?? "";
  outDir.value = savedDir;
  outDir.placeholder = savedDir ? savedDir : "Sin carpeta de salida";
  syncOptReveal();
  setOptionsDirty(false);
}

document.querySelector("#set-output-browse")!.addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string") return;
  const outDir = document.querySelector<HTMLInputElement>("#set-output-dir")!;
  outDir.value = dir;
  outDir.placeholder = dir;
  setOptionsDirty(true);
  updateRenamePreview();
});

document.querySelector("#set-cancel")!.addEventListener("click", () => {
  void loadSettingsForm();
});

document.querySelector("#set-save")!.addEventListener("click", async () => {
  const set = (key: string, value: string) => invoke("settings_set", { key, value });
  const uaVal = document.querySelector<HTMLInputElement>("#set-ua")!.value.trim();
  await set("http.user_agent", uaVal === DEFAULT_USER_AGENT ? "" : uaVal);
  const useProxy = document.querySelector<HTMLInputElement>("#set-use-proxy")!.checked;
  await set("http.proxy", useProxy ? composeProxyUrl() : "");
  await set("download.max_threads", document.querySelector<HTMLInputElement>("#set-threads")!.value);
  const packSel = getPackFormat();
  await set("download.pack_format", packSel);
  await set(
    "download.manga_folder_pattern",
    document.querySelector<HTMLInputElement>("#set-pat-manga")!.value,
  );
  await set(
    "download.chapter_folder_pattern",
    document.querySelector<HTMLInputElement>("#set-pat-chapter")!.value,
  );
  await set(
    "download.page_name_pattern",
    document.querySelector<HTMLInputElement>("#set-pat-page")!.value,
  );
  const dir = document.querySelector<HTMLInputElement>("#set-output-dir")!.value.trim();
  if (dir) {
    await set("default_output_dir", dir);
    outputDir = dir;
    setPathDisplay(dir);
  }
  setOptionsDirty(false);
  log("Ajustes guardados", "ok");
});

renderChapters();
renderInfoSidebar();
setSourcesLoading(true);

void initSettings()
  .then(() => loadModules())
  .then(() => {
    log("DB lista (favoritos/cola en AppData/fmd-mvp).", "ok");
    return loadCatalog(true);
  });
