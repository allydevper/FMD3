import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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

const PAGE_SIZE = 80;
const CATALOG_PAGE = 80;
const LOLI_VAULT_ID = "218b722b1eb34f2aa3863f84538c5b08";

let manga: MangaInfoResult | null = null;
let mangaUrl = "";
let outputDir = "";
let visibleCount = PAGE_SIZE;
let selected = new Set<number>();
let activeTab: "manga" | "catalog" | "queue" | "favorites" = "manga";
let expandedGroups = new Set<string>();
let liveProgress = new Map<
  number,
  { page_current: number; page_total: number; message: string; chapter_name: string }
>();
let lastQueueItems: QueueItem[] = [];
let catalogEntries: CatalogEntry[] = [];
let catalogOffset = 0;
let catalogQuery = "";

const app = document.querySelector("#app")!;

app.innerHTML = `
  <h1>FMD Host</h1>
  <p class="sub">Catálogo · cola · favoritos · multi-módulo Lua</p>

  <div class="tabs">
    <button type="button" class="tab active" data-tab="manga">Manga</button>
    <button type="button" class="tab" data-tab="catalog">Catálogo</button>
    <button type="button" class="tab" data-tab="queue">Cola</button>
    <button type="button" class="tab" data-tab="favorites">Favoritos</button>
  </div>
  <p id="busy" class="sub" hidden></p>

  <section id="tab-manga">
    <div class="row">
      <input id="url" type="text" placeholder="https://www.leercapitulo.co/manga/..." />
      <button id="load" type="button">Cargar</button>
    </div>
    <div class="row">
      <label for="module-sel">Módulo:</label>
      <select id="module-sel">
        <option value="">Auto</option>
      </select>
    </div>

    <div id="info" class="panel" hidden>
      <div class="meta">
        <strong id="title"></strong>
        <div id="authors"></div>
        <div id="status"></div>
      </div>
      <div class="toolbar">
        <button id="sel-visible" class="secondary" type="button">Sel. visibles</button>
        <button id="sel-none" class="secondary" type="button">Ninguno</button>
        <button id="sel-last10" class="secondary" type="button">Últimos 10</button>
        <span id="count"></span>
      </div>
      <div id="chapters" class="chapters"></div>
      <div class="toolbar">
        <button id="more" class="secondary" type="button" hidden>Mostrar más</button>
      </div>
      <div class="toolbar">
        <button id="pick" class="secondary" type="button">Carpeta…</button>
        <span id="path" class="path">Sin carpeta de salida</span>
      </div>
      <div class="toolbar">
        <button id="enqueue" type="button">Encolar selección</button>
        <button id="fav-add" class="secondary" type="button">Añadir a favoritos</button>
      </div>
      <div class="progress"><span id="bar"></span></div>
    </div>
  </section>

  <section id="tab-catalog" hidden>
    <div class="row">
      <label for="catalog-module">Sitio:</label>
      <select id="catalog-module"></select>
      <button id="catalog-update" type="button">Actualizar lista</button>
      <button id="catalog-import" class="secondary" type="button">Importar .db…</button>
    </div>
    <div class="row">
      <input id="catalog-q" type="text" placeholder="Buscar título…" />
      <button id="catalog-search" class="secondary" type="button">Buscar</button>
      <span id="catalog-stats" class="path"></span>
    </div>
    <div id="catalog-list" class="list"></div>
    <div class="toolbar">
      <button id="catalog-more" class="secondary" type="button" hidden>Mostrar más</button>
    </div>
  </section>

  <section id="tab-queue" hidden>
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
  </section>

  <section id="tab-favorites" hidden>
    <div class="toolbar">
      <button id="fav-refresh" class="secondary" type="button">Actualizar</button>
      <button id="fav-check-all" class="secondary" type="button">Check todos</button>
      <button id="fav-check-enqueue-all" type="button">Check + encolar</button>
    </div>
    <div id="fav-list" class="list"></div>
  </section>

  <div class="panel">
    <pre id="log" class="log">Listo.</pre>
  </div>
`;

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const loadBtn = document.querySelector<HTMLButtonElement>("#load")!;
const moduleSel = document.querySelector<HTMLSelectElement>("#module-sel")!;
const catalogModuleSel = document.querySelector<HTMLSelectElement>("#catalog-module")!;
const catalogListEl = document.querySelector<HTMLDivElement>("#catalog-list")!;
const catalogStatsEl = document.querySelector<HTMLElement>("#catalog-stats")!;
const catalogQ = document.querySelector<HTMLInputElement>("#catalog-q")!;
const catalogMoreBtn = document.querySelector<HTMLButtonElement>("#catalog-more")!;
const busyEl = document.querySelector<HTMLElement>("#busy")!;
const infoPanel = document.querySelector<HTMLDivElement>("#info")!;
const titleEl = document.querySelector<HTMLElement>("#title")!;
const authorsEl = document.querySelector<HTMLElement>("#authors")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const chaptersEl = document.querySelector<HTMLDivElement>("#chapters")!;
const countEl = document.querySelector<HTMLElement>("#count")!;
const pathEl = document.querySelector<HTMLElement>("#path")!;
const logEl = document.querySelector<HTMLElement>("#log")!;
const barEl = document.querySelector<HTMLElement>("#bar")!;
const moreBtn = document.querySelector<HTMLButtonElement>("#more")!;
const queueListEl = document.querySelector<HTMLTableSectionElement>("#queue-list")!;
const queueEmptyEl = document.querySelector<HTMLElement>("#queue-empty")!;
const queueTableEl = document.querySelector<HTMLTableElement>("#queue-table")!;
const favListEl = document.querySelector<HTMLDivElement>("#fav-list")!;
const queueStatusEl = document.querySelector<HTMLElement>("#queue-status")!;

function setBusy(on: boolean, text?: string) {
  busyEl.hidden = !on;
  if (text) busyEl.textContent = text;
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

function switchTab(tab: "manga" | "catalog" | "queue" | "favorites") {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.tab === tab);
  });
  document.querySelector<HTMLElement>("#tab-manga")!.hidden = tab !== "manga";
  document.querySelector<HTMLElement>("#tab-catalog")!.hidden = tab !== "catalog";
  document.querySelector<HTMLElement>("#tab-queue")!.hidden = tab !== "queue";
  document.querySelector<HTMLElement>("#tab-favorites")!.hidden = tab !== "favorites";
  if (tab === "queue") void refreshQueue();
  if (tab === "favorites") void refreshFavorites();
  if (tab === "catalog") void refreshCatalogStats();
}

document.querySelectorAll(".tab").forEach((el) => {
  el.addEventListener("click", () => {
    const tab = (el as HTMLElement).dataset.tab as typeof activeTab;
    switchTab(tab);
  });
});

function refreshCount() {
  countEl.textContent = `${selected.size} seleccionados / ${manga?.chapters.length ?? 0} total`;
}

function visibleSlice(): ChapterInfo[] {
  if (!manga) return [];
  const total = manga.chapters.length;
  const start = Math.max(0, total - visibleCount);
  return manga.chapters.slice(start).reverse();
}

function renderChapters() {
  if (!manga) return;
  const slice = visibleSlice();
  const frag = document.createDocumentFragment();
  chaptersEl.innerHTML = "";
  for (const c of slice) {
    const label = document.createElement("label");
    label.className = "chapter";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(c.index);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(c.index);
      else selected.delete(c.index);
      refreshCount();
    });
    const span = document.createElement("span");
    span.textContent = c.name || `Capítulo ${c.index + 1}`;
    label.append(input, span);
    frag.appendChild(label);
  }
  chaptersEl.appendChild(frag);
  moreBtn.hidden = visibleCount >= manga.chapters.length;
  const remaining = Math.max(0, manga.chapters.length - visibleCount);
  moreBtn.textContent = `Mostrar más antiguos (${Math.min(PAGE_SIZE, remaining)})`;
  refreshCount();
}

function selectedChapters(): ChapterInfo[] {
  if (!manga) return [];
  return manga.chapters.filter((c) => selected.has(c.index));
}

async function ensureOutputDir(): Promise<string | null> {
  if (outputDir) return outputDir;
  const saved = await invoke<string | null>("settings_get", { key: "default_output_dir" });
  if (saved) {
    outputDir = saved;
    pathEl.textContent = saved;
    return saved;
  }
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") {
    outputDir = dir;
    pathEl.textContent = dir;
    await invoke("settings_set", { key: "default_output_dir", value: dir });
    return dir;
  }
  return null;
}

async function initSettings() {
  const saved = await invoke<string | null>("settings_get", { key: "default_output_dir" });
  if (saved) {
    outputDir = saved;
    pathEl.textContent = saved;
  }
}

async function loadModules() {
  try {
    const mods = await invoke<ModuleMeta[]>("modules_list_cmd");
    const current = moduleSel.value;
    moduleSel.innerHTML = `<option value="">Auto</option>`;
    catalogModuleSel.innerHTML = "";
    const sorted = [...mods].sort((a, b) => a.name.localeCompare(b.name));
    for (const m of sorted) {
      const label = `${m.name} (${m.root_url.replace(/^https?:\/\//, "")})`;
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = label;
      moduleSel.appendChild(opt);
      const opt2 = document.createElement("option");
      opt2.value = m.id;
      opt2.textContent = label;
      catalogModuleSel.appendChild(opt2);
    }
    if (current && [...moduleSel.options].some((o) => o.value === current)) {
      moduleSel.value = current;
    }
    if ([...catalogModuleSel.options].some((o) => o.value === LOLI_VAULT_ID)) {
      catalogModuleSel.value = LOLI_VAULT_ID;
    }
    log(`Módulos cargados: ${mods.length}`, "ok");
  } catch (e) {
    log(`No se pudo listar módulos: ${e}`, "err");
  }
}

function maybeFillHost(root: string, link: string): string {
  const l = link.trim();
  if (!l) return root;
  if (l.startsWith("http://") || l.startsWith("https://")) return l;
  const r = root.replace(/\/$/, "");
  return l.startsWith("/") ? `${r}${l}` : `${r}/${l}`;
}

async function refreshCatalogStats() {
  const id = catalogModuleSel.value;
  if (!id) {
    catalogStatsEl.textContent = "";
    return;
  }
  try {
    const st = await invoke<CatalogStats>("catalog_stats", { moduleId: id });
    catalogStatsEl.textContent = `${st.count} títulos · ${st.path}`;
  } catch (e) {
    catalogStatsEl.textContent = String(e);
  }
}

function renderCatalogList(append: boolean) {
  if (!append) catalogListEl.innerHTML = "";
  if (!catalogEntries.length && !append) {
    catalogListEl.innerHTML = `<div class="empty">Sin resultados. Actualiza la lista o importa un .db.</div>`;
    catalogMoreBtn.hidden = true;
    return;
  }
  for (const e of catalogEntries) {
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `<strong>${e.title || e.link}</strong><div class="path">${e.link}</div>`;
    row.addEventListener("click", () => void openCatalogEntry(e));
    catalogListEl.appendChild(row);
  }
  catalogMoreBtn.hidden = catalogEntries.length < CATALOG_PAGE;
}

async function loadCatalog(reset: boolean) {
  const id = catalogModuleSel.value;
  if (!id) return;
  if (reset) {
    catalogOffset = 0;
    catalogEntries = [];
  }
  setBusy(true, "Buscando catálogo…");
  try {
    const rows = await invoke<CatalogEntry[]>("catalog_search", {
      moduleId: id,
      query: catalogQuery,
      limit: CATALOG_PAGE,
      offset: catalogOffset,
    });
    if (reset) catalogEntries = rows;
    else catalogEntries = catalogEntries.concat(rows);
    catalogOffset = catalogEntries.length;
    renderCatalogList(!reset);
    await refreshCatalogStats();
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
  }
}

async function openCatalogEntry(e: CatalogEntry) {
  const id = catalogModuleSel.value;
  let root = "";
  try {
    const list = await invoke<ModuleMeta[]>("modules_list_cmd");
    root = list.find((m) => m.id === id)?.root_url || "";
  } catch {
    /* ignore */
  }
  const url = maybeFillHost(root, e.link);
  urlInput.value = url;
  moduleSel.value = id;
  switchTab("manga");
  log(`Abriendo ${e.title || e.link}…`);
  loadBtn.click();
}

function selectedModuleId(): string | null {
  const v = moduleSel.value.trim();
  return v || null;
}

loadBtn.addEventListener("click", async () => {
  clearLog();
  setBusy(true, "Cargando GetInfo…");
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
    for (const c of result.chapters.slice(-10)) selected.add(c.index);
    titleEl.textContent = result.title || "(sin título)";
    authorsEl.textContent = result.authors ? `Autor: ${result.authors}` : "";
    statusEl.textContent = `Módulo: ${result.module_name} · Capítulos: ${result.chapters.length}`;
    if (result.module_id && [...moduleSel.options].some((o) => o.value === result.module_id)) {
      moduleSel.value = result.module_id;
    }
    infoPanel.hidden = false;
    renderChapters();
    log(`OK: ${result.chapters.length} capítulos (${result.module_name})`, "ok");
  } catch (e) {
    manga = null;
    infoPanel.hidden = true;
    log(String(e), "err");
  } finally {
    setBusy(false);
    loadBtn.disabled = false;
  }
});

document.querySelector("#sel-visible")!.addEventListener("click", () => {
  if (!manga) return;
  for (const c of visibleSlice()) selected.add(c.index);
  renderChapters();
});

document.querySelector("#sel-none")!.addEventListener("click", () => {
  selected.clear();
  renderChapters();
});

document.querySelector("#sel-last10")!.addEventListener("click", () => {
  if (!manga) return;
  selected.clear();
  for (const c of manga.chapters.slice(-10)) selected.add(c.index);
  visibleCount = Math.max(visibleCount, 10);
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
    pathEl.textContent = dir;
    await invoke("settings_set", { key: "default_output_dir", value: dir });
    log(`Carpeta por defecto: ${dir}`, "ok");
  }
});

document.querySelector("#enqueue")!.addEventListener("click", async () => {
  if (!manga) return;
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
        module_id: manga.module_id,
        output_dir: dir,
        chapters,
      },
    });
    log(`Encolados ${n} capítulo(s). Ve a la pestaña Cola.`, "ok");
    barEl.style.width = "0%";
  } catch (e) {
    log(String(e), "err");
  }
});

document.querySelector("#fav-add")!.addEventListener("click", async () => {
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
    log(`Favorito guardado: ${fav.title} (último: ${fav.last_chapter_name || "—"})`, "ok");
  } catch (e) {
    log(String(e), "err");
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
      // blend chapter progress with page progress of current chapter
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
      <td class="col-manga" title="${g.manga_title}">${g.manga_title}</td>
      <td class="col-status">${statusText}</td>
      <td class="col-progress">
        <div class="dl-progress ${groupProgressClass(status)}">
          <div class="dl-progress-fill" style="width:${pct}%"></div>
          <span class="dl-progress-text">${progressLabel}</span>
        </div>
      </td>
      <td class="col-save" title="${g.output_dir}">${g.output_dir}</td>
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
          <td class="col-manga sub-title">${item.chapter_name}</td>
          <td class="col-status"><span class="${statusBadge(item.status)}">${item.status}</span></td>
          <td class="col-progress">
            <div class="dl-progress ${groupProgressClass(
              item.status === "running"
                ? "Downloading"
                : item.status === "done"
                  ? "Completed"
                  : item.status === "failed"
                    ? "Failed"
                    : "Waiting…"
            )}">
              <div class="dl-progress-fill" style="width:${subPct}%"></div>
              <span class="dl-progress-text">${subLabel}</span>
            </div>
          </td>
          <td class="col-save muted">${item.error || ""}</td>
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
          <div><strong>${fav.title}</strong></div>
          <div class="muted">${fav.module_name} · ${fav.chapter_count} caps · último: ${fav.last_chapter_name || "—"}</div>
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
      checkEnq.textContent = "Check+cola";
      checkEnq.addEventListener("click", () => void runFavCheck(fav.id, true));

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "secondary";
      openBtn.textContent = "Abrir";
      openBtn.addEventListener("click", () => {
        urlInput.value = fav.manga_url;
        switchTab("manga");
        loadBtn.click();
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "secondary";
      del.textContent = "Quitar";
      del.addEventListener("click", async () => {
        await invoke("favorites_remove", { id: fav.id });
        await refreshFavorites();
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
        "ok"
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

document.querySelector("#catalog-search")!.addEventListener("click", () => {
  catalogQuery = catalogQ.value.trim();
  void loadCatalog(true);
});
catalogQ.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    catalogQuery = catalogQ.value.trim();
    void loadCatalog(true);
  }
});
catalogMoreBtn.addEventListener("click", () => void loadCatalog(false));
catalogModuleSel.addEventListener("change", () => {
  void refreshCatalogStats();
  void loadCatalog(true);
});

document.querySelector("#catalog-update")!.addEventListener("click", async () => {
  const id = catalogModuleSel.value;
  if (!id) return;
  setBusy(true, "Actualizando lista (GetNameAndLink)…");
  try {
    const st = await invoke<UpdateListStats>("catalog_update", { moduleId: id });
    log(
      `Catálogo OK: +${st.inserted} nuevas · ${st.total_in_db} total · ${st.pages_fetched} páginas`,
      "ok",
    );
    catalogQuery = "";
    catalogQ.value = "";
    await loadCatalog(true);
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#catalog-import")!.addEventListener("click", async () => {
  const id = catalogModuleSel.value;
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
  busyEl.hidden = false;
  busyEl.textContent = `Catálogo [${p.page + 1}/${p.page_total}] +${p.batch_rows} (acum ${p.inserted_total})`;
});

void listen<QueueProgressEvent>("queue-progress", (ev) => {
  const p = ev.payload;
  liveProgress.set(p.item_id, {
    page_current: p.page_current,
    page_total: p.page_total,
    message: p.message,
    chapter_name: p.chapter_name,
  });
  busyEl.hidden = false;
  busyEl.textContent = p.message;
  if (activeTab === "queue") {
    renderQueueTable(lastQueueItems);
  }
});

void listen("queue-changed", () => {
  if (activeTab === "queue") void refreshQueue();
  // clear finished live entries on full refresh
  busyEl.hidden = true;
});

void initSettings()
  .then(() => loadModules())
  .then(() => log("DB lista (favoritos/cola en AppData/fmd-mvp).", "ok"));
