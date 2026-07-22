import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
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
};

type CatalogStats = {
  module_id: string;
  path: string;
  count: number;
};

type UpdateListStats = {
  module_id: string;
  inserted: number;
  total_in_db: number;
  pages_fetched: number;
};

type NavId = "downloads" | "info" | "favorites" | "about" | "options";

const PAGE_SIZE = 80;
const CATALOG_BATCH = 500;
const LOLI_VAULT_ID = "218b722b1eb34f2aa3863f84538c5b08";
const THEME_KEY = "fmd-theme-dark";
const CH_ROW_H = 52;
const CH_ROW_GAP = 8;
const CH_ROW_STRIDE = CH_ROW_H + CH_ROW_GAP;
const CH_OVERSCAN = 8;
const CAT_ROW_H = 34;
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
  x: svgIco('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: svgIco('<path d="M20 6 9 17l-5-5"/>'),
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
  terminal: svgIco(
    '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  ),
};

let manga: MangaInfoResult | null = null;
let mangaUrl = "";
let outputDir = "";
let visibleCount = PAGE_SIZE;
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

const app = document.querySelector("#app")!;
app.className = `app${darkTheme ? " dark" : ""}`;

app.innerHTML = `
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
              <button type="button" class="seg-btn active" id="seg-search">búsqueda</button>
              <button type="button" class="seg-btn" id="seg-filter" disabled title="Próximamente">Filtro</button>
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
              <button type="button" class="ghost" id="catalog-search" title="Buscar">
                <span class="ico" style="--ico:${ICO.arrowRight}"></span>
              </button>
            </div>
          </div>
          <div class="search-mode-bar">
            <span>Modo: <strong>búsqueda individual</strong></span>
            <div class="search-mode-right">
              <button type="button" class="ghost ghost-sm" id="catalog-import" title="Importar .db…">
                <span class="ico ico-sm" style="--ico:${ICO.import}"></span>
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
                <div class="chapters-head">
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
                <div class="chapters-more" id="chapters-more-wrap">
                  <button type="button" class="secondary" id="more" hidden>Mostrar más</button>
                </div>
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
        <div class="view-pad">
          <div class="panel">
            <h3>Descarga / red</h3>
            <div class="row"><label>User-Agent</label><input id="set-ua" type="text" style="flex:1" placeholder="(default)" autocomplete="off" spellcheck="false" /></div>
            <div class="row"><label>Proxy</label><input id="set-proxy" type="text" style="flex:1" placeholder="http://host:port" autocomplete="off" spellcheck="false" /></div>
            <div class="row"><label>Threads/cap</label><input id="set-threads" type="number" min="1" max="16" value="1" autocomplete="off" /></div>
            <div class="row">
              <label>Pack</label>
              <select id="set-pack"><option value="none">none</option><option value="cbz">cbz</option><option value="zip">zip</option></select>
              <label><input id="set-pack-del" type="checkbox" /> borrar carpeta tras pack</label>
            </div>
            <div class="row">
              <label>Convertir a</label>
              <select id="set-convert"><option value="keep">keep</option><option value="jpg">jpg</option><option value="png">png</option><option value="webp">webp</option></select>
            </div>
            <div class="row"><label>Carpeta manga</label><input id="set-pat-manga" type="text" style="flex:1" value="%Manga%" autocomplete="off" spellcheck="false" /></div>
            <div class="row"><label>Carpeta cap</label><input id="set-pat-chapter" type="text" style="flex:1" value="%ChapterIndex%_%Chapter%" autocomplete="off" spellcheck="false" /></div>
            <div class="row"><label>Página</label><input id="set-pat-page" type="text" style="flex:1" value="%Page%" autocomplete="off" spellcheck="false" /></div>
            <div class="toolbar"><button id="set-save" class="btn" type="button">Guardar ajustes</button></div>
          </div>
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
const countEl = document.querySelector<HTMLElement>("#count")!;
const pathInput = document.querySelector<HTMLInputElement>("#path-input")!;
const logEl = document.querySelector<HTMLElement>("#log")!;
const moreBtn = document.querySelector<HTMLButtonElement>("#more")!;
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
  app.classList.toggle("show-manga-info", !!manga);
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
  const total = manga?.chapters.length ?? 0;
  chaptersAvailableEl.hidden = !hasManga;
  selAllBtn.hidden = !hasManga;
  countEl.hidden = !hasManga;
  if (hasManga) {
    countEl.textContent = `${selected.size} seleccionados`;
    chaptersAvailableEl.textContent = `${total} disponibles`;
    const allOn = total > 0 && selected.size === total;
    selAllBtn.textContent = allOn ? "Deseleccionar" : "Seleccionar todo";
  } else {
    countEl.textContent = "";
    chaptersAvailableEl.textContent = "";
  }
  enqueueBtn.disabled = !hasManga || selected.size === 0;
}

function visibleSlice(): ChapterInfo[] {
  if (!manga) return [];
  const total = manga.chapters.length;
  const start = Math.max(0, total - visibleCount);
  return manga.chapters.slice(start).reverse();
}

function chapterNum(index: number): string {
  return String(index + 1).padStart(4, "0");
}

function renderChapters() {
  if (!manga) {
    chaptersEl.onscroll = null;
    chaptersEl.innerHTML = `<div class="catalog-empty">Carga una URL o elige un título del catálogo.</div>`;
    moreBtn.hidden = true;
    document.querySelector("#chapters-more-wrap")?.classList.remove("is-visible");
    refreshCount();
    return;
  }

  const slice = visibleSlice();
  const showMore = visibleCount < manga.chapters.length;
  moreBtn.hidden = !showMore;
  document.querySelector("#chapters-more-wrap")!.classList.toggle("is-visible", showMore);
  const remaining = Math.max(0, manga.chapters.length - visibleCount);
  moreBtn.textContent = `Mostrar más antiguos (${Math.min(PAGE_SIZE, remaining)})`;
  refreshCount();

  if (!slice.length) {
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

  virtual.style.height = `${slice.length * CH_ROW_STRIDE - CH_ROW_GAP}px`;
  paintVirtualChapters();
}

function paintVirtualChapters() {
  if (!manga) return;
  const slice = visibleSlice();
  const virtual = chaptersEl.querySelector<HTMLDivElement>(".chapters-virtual");
  if (!virtual) return;

  const scrollTop = chaptersEl.scrollTop;
  const viewH = chaptersEl.clientHeight || 400;
  let start = Math.floor(scrollTop / CH_ROW_STRIDE) - CH_OVERSCAN;
  let end = Math.ceil((scrollTop + viewH) / CH_ROW_STRIDE) + CH_OVERSCAN;
  start = Math.max(0, start);
  end = Math.min(slice.length, end);

  const existing = new Map<string, HTMLButtonElement>();
  virtual.querySelectorAll<HTMLButtonElement>(".ch-card").forEach((el) => {
    const key = el.dataset.index;
    if (key != null) existing.set(key, el);
  });

  const keep = new Set<string>();
  for (let i = start; i < end; i++) {
    const c = slice[i];
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

function setCover(url: string) {
  if (!url) {
    coverImg.hidden = true;
    coverPh.hidden = false;
    coverBlur.hidden = true;
    coverImg.removeAttribute("src");
    coverBlurImg.removeAttribute("src");
    return;
  }
  coverImg.src = url;
  coverBlurImg.src = url;
  coverImg.hidden = false;
  coverPh.hidden = true;
  coverBlur.hidden = false;
}

function renderInfoSidebar() {
  updateResponsive();
  if (!manga) {
    titleEl.textContent = "";
    altTitlesEl.textContent = "";
    altTitlesEl.hidden = true;
    setCover("");
    infoRowsEl.innerHTML = "";
    btnOnline.disabled = true;
    favAddBtn.disabled = true;
    isFavorite = false;
    updateFavButton();
    return;
  }
  titleEl.textContent = manga.title.trim() || "(sin título)";
  const alt = manga.alt_titles.trim();
  altTitlesEl.textContent = alt;
  altTitlesEl.hidden = !alt;
  setCover(resolveCover(manga.cover, manga.root_url));
  btnOnline.disabled = !mangaUrl;
  favAddBtn.disabled = false;

  const rows: { icon: string; label: string; value: string }[] = [];
  const authors = manga.authors.trim();
  const artists = manga.artists.trim();
  const genres = manga.genres.trim();
  const status = manga.status.trim();
  const moduleName = manga.module_name.trim();

  if (authors) rows.push({ icon: ICO.user, label: "Autor", value: authors });
  if (artists) rows.push({ icon: ICO.brush, label: "Artista", value: artists });
  const fuente = [moduleName, genres].filter(Boolean).join(" · ");
  if (fuente) rows.push({ icon: ICO.heart, label: "Fuente", value: fuente });
  if (status) rows.push({ icon: ICO.status, label: "Estado", value: status });
  if (manga.chapters.length) {
    rows.push({ icon: ICO.book, label: "Capítulos", value: String(manga.chapters.length) });
  }

  infoRowsEl.innerHTML = rows
    .map(
      (r) => `
    <div class="info-row">
      <span class="ico" style="--ico:${r.icon}"></span>
      <div>
        <div class="info-row-label">${r.label}</div>
        <div class="info-row-value">${escapeHtml(r.value)}</div>
      </div>
    </div>`,
    )
    .join("");
  updateFavButton();
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
    catalogListEl.innerHTML = `<div class="catalog-empty">Sin resultados. Actualiza la lista o importa un .db.</div>`;
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
      row.title = "Doble clic para abrir";
      virtual.appendChild(row);
    }
    row.className = `catalog-row${title === activeCatalogTitle ? " active" : ""}`;
    row.style.top = `${i * CAT_ROW_H}px`;
    let label = row.querySelector<HTMLElement>(".catalog-row-title");
    if (!label) {
      label = document.createElement("div");
      label.className = "catalog-row-title";
      row.appendChild(label);
    }
    label.textContent = title;
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

async function loadCatalog(force = false) {
  const id = selectedModuleId();
  if (!id) return;
  const key = `${id}||${catalogQuery}`;
  if (!force && key === catalogLoadedKey && catalogEntries.length) {
    renderCatalogList();
    return;
  }

  setCatalogLoading(true, "Cargando títulos…");
  setBusy(true, "Cargando catálogo…");
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
      setCatalogLoading(true, `Cargando títulos… (${all.length})`);
    }
    catalogEntries = all;
    catalogLoadedKey = key;
    renderCatalogList();
    await refreshCatalogStats();
    log(`Catálogo: ${all.length} títulos`, "ok");
  } catch (e) {
    catalogLoadedKey = "";
    log(String(e), "err");
    catalogListEl.innerHTML = `<div class="catalog-empty">Error al cargar el catálogo.</div>`;
  } finally {
    setBusy(false);
  }
}

async function openCatalogEntry(e: CatalogEntry) {
  const root = currentModule()?.root_url || "";
  const url = maybeFillHost(root, e.link);
  activeCatalogTitle = e.title || e.link;
  renderCatalogList();
  urlInput.value = url;
  syncUrlClear();
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
  clearLog();
  setBusy(true, "Cargando GetInfo… (Cloudflare puede tardar)");
  loadBtn.disabled = true;
  log("Cargando info vía Lua GetInfo…");
  try {
    mangaUrl = urlInput.value.trim();
    const moduleId = selectedModuleId();
    const result = await invoke<MangaInfoResult>("get_manga_info", {
      url: mangaUrl,
      moduleId,
    });
    manga = result;
    selected = new Set();
    visibleCount = PAGE_SIZE;
    if (result.module_id && [...moduleSel.options].some((o) => o.value === result.module_id)) {
      moduleSel.value = result.module_id;
      updateSourceLabel();
    }
    if (!activeCatalogTitle) activeCatalogTitle = result.title;
    renderChapters();
    renderInfoSidebar();
    await syncFavoriteState();
    log(`OK: ${result.chapters.length} capítulos (${result.module_name})`, "ok");
  } catch (e) {
    manga = null;
    renderChapters();
    renderInfoSidebar();
    log(String(e), "err");
  } finally {
    setBusy(false);
    loadBtn.disabled = false;
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
    visibleCount = Math.max(visibleCount, manga.chapters.length);
  }
  renderChapters();
});

moreBtn.addEventListener("click", () => {
  visibleCount += PAGE_SIZE;
  renderChapters();
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

function runCatalogSearch() {
  catalogQuery = catalogQ.value.trim();
  syncCatalogClear();
  void loadCatalog(true);
}

document.querySelector("#catalog-search")!.addEventListener("click", runCatalogSearch);
catalogQ.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") runCatalogSearch();
});
catalogQ.addEventListener("input", syncCatalogClear);
catalogClearBtn.addEventListener("click", () => {
  catalogQ.value = "";
  catalogQuery = "";
  syncCatalogClear();
  void loadCatalog(true);
});

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

document.querySelector("#catalog-import")!.addEventListener("click", async () => {
  const id = selectedModuleId();
  if (!id) {
    log("Elige un módulo antes de importar.", "err");
    return;
  }
  const file = await open({
    multiple: false,
    filters: [{ name: "SQLite FMD", extensions: ["db"] }],
  });
  if (typeof file !== "string") return;
  setBusy(true, "Importando .db…");
  try {
    const st = await invoke<CatalogStats>("catalog_import", { moduleId: id, path: file });
    log(`Importado: ${st.count} títulos → ${st.path}`, "ok");
    catalogLoadedKey = "";
    await loadCatalog(true);
  } catch (e) {
    log(String(e), "err");
  } finally {
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

async function loadSettingsForm() {
  const get = (k: string) => invoke<string | null>("settings_get", { key: k });
  const ua = document.querySelector<HTMLInputElement>("#set-ua")!;
  const proxy = document.querySelector<HTMLInputElement>("#set-proxy")!;
  const threads = document.querySelector<HTMLInputElement>("#set-threads")!;
  const pack = document.querySelector<HTMLSelectElement>("#set-pack")!;
  const packDel = document.querySelector<HTMLInputElement>("#set-pack-del")!;
  const convert = document.querySelector<HTMLSelectElement>("#set-convert")!;
  const patM = document.querySelector<HTMLInputElement>("#set-pat-manga")!;
  const patC = document.querySelector<HTMLInputElement>("#set-pat-chapter")!;
  const patP = document.querySelector<HTMLInputElement>("#set-pat-page")!;
  ua.value = (await get("http.user_agent")) ?? "";
  proxy.value = (await get("http.proxy")) ?? "";
  threads.value = (await get("download.max_threads")) ?? "1";
  pack.value = (await get("download.pack_format")) ?? "none";
  packDel.checked = ["1", "true", "yes"].includes(
    ((await get("download.pack_delete_folder")) ?? "").toLowerCase(),
  );
  convert.value = (await get("download.convert_to")) ?? "keep";
  patM.value = (await get("download.manga_folder_pattern")) ?? "%Manga%";
  patC.value = (await get("download.chapter_folder_pattern")) ?? "%ChapterIndex%_%Chapter%";
  patP.value = (await get("download.page_name_pattern")) ?? "%Page%";
}

document.querySelector("#set-save")!.addEventListener("click", async () => {
  const set = (key: string, value: string) => invoke("settings_set", { key, value });
  await set("http.user_agent", document.querySelector<HTMLInputElement>("#set-ua")!.value);
  await set("http.proxy", document.querySelector<HTMLInputElement>("#set-proxy")!.value);
  await set("download.max_threads", document.querySelector<HTMLInputElement>("#set-threads")!.value);
  await set("download.pack_format", document.querySelector<HTMLSelectElement>("#set-pack")!.value);
  await set(
    "download.pack_delete_folder",
    document.querySelector<HTMLInputElement>("#set-pack-del")!.checked ? "true" : "false",
  );
  await set("download.convert_to", document.querySelector<HTMLSelectElement>("#set-convert")!.value);
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
