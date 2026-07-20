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

type DownloadResult = {
  chapter_index: number;
  chapter_name: string;
  files: string[];
  errors: string[];
};

type DownloadProgressEvent = {
  current: number;
  total: number;
  chapter_name: string;
  message: string;
};

const PAGE_SIZE = 80;

let manga: MangaInfoResult | null = null;
let outputDir = "";
let visibleCount = PAGE_SIZE;
let selected = new Set<number>();

const app = document.querySelector("#app")!;

app.innerHTML = `
  <h1>FMD MVP</h1>
  <p class="sub">Host Rust/Tauri + módulo Lua LeerCapitulo. Pega una URL de manga, elige capítulos y descarga imágenes.</p>

  <div class="row">
    <input id="url" type="text" placeholder="https://www.leercapitulo.co/manga/..." />
    <button id="load" type="button">Cargar</button>
  </div>
  <p id="busy" class="sub" hidden>Trabajando en segundo plano… la ventana no debería congelarse.</p>

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
      <button id="download" type="button">Descargar</button>
    </div>
    <div class="progress"><span id="bar"></span></div>
  </div>

  <div class="panel">
    <pre id="log" class="log">Listo.</pre>
  </div>
`;

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const loadBtn = document.querySelector<HTMLButtonElement>("#load")!;
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
const downloadBtn = document.querySelector<HTMLButtonElement>("#download")!;
const moreBtn = document.querySelector<HTMLButtonElement>("#more")!;

function setBusy(on: boolean, text?: string) {
  busyEl.hidden = !on;
  if (text) busyEl.textContent = text;
  loadBtn.disabled = on;
  downloadBtn.disabled = on;
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

function refreshCount() {
  countEl.textContent = `${selected.size} seleccionados / ${manga?.chapters.length ?? 0} total`;
}

/** Muestra los capítulos más recientes primero (cola de la lista). */
function visibleSlice(): ChapterInfo[] {
  if (!manga) return [];
  const total = manga.chapters.length;
  const start = Math.max(0, total - visibleCount);
  // más nuevo arriba
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
    input.dataset.index = String(c.index);
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

loadBtn.addEventListener("click", async () => {
  clearLog();
  setBusy(true, "Cargando GetInfo en segundo plano…");
  log("Cargando info vía Lua GetInfo…");
  try {
    const result = await invoke<MangaInfoResult>("get_manga_info", {
      url: urlInput.value,
    });
    manga = result;
    selected = new Set();
    visibleCount = PAGE_SIZE;

    // Por defecto solo los últimos 10 (suele ser lo útil; evita marcar 1000+)
    const last = result.chapters.slice(-10);
    for (const c of last) selected.add(c.index);

    titleEl.textContent = result.title || "(sin título)";
    authorsEl.textContent = result.authors ? `Autor: ${result.authors}` : "";
    statusEl.textContent = `Módulo: ${result.module_name} · Capítulos: ${result.chapters.length}`;
    infoPanel.hidden = false;
    renderChapters();
    log(`OK: ${result.chapters.length} capítulos (mostrando ${Math.min(PAGE_SIZE, result.chapters.length)}; sel. últimos 10)`, "ok");
  } catch (e) {
    manga = null;
    infoPanel.hidden = true;
    log(String(e), "err");
  } finally {
    setBusy(false);
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
  }
});

void listen<DownloadProgressEvent>("download-progress", (ev) => {
  const p = ev.payload;
  const pct = Math.round((p.current / Math.max(p.total, 1)) * 100);
  barEl.style.width = `${pct}%`;
  busyEl.textContent = `${p.message} (${p.current}/${p.total})`;
});

downloadBtn.addEventListener("click", async () => {
  if (!manga) return;
  const chapters = selectedChapters();
  if (!outputDir) {
    log("Elige una carpeta de salida.", "err");
    return;
  }
  if (!chapters.length) {
    log("Selecciona al menos un capítulo.", "err");
    return;
  }
  if (chapters.length > 30) {
    const ok = confirm(
      `Vas a descargar ${chapters.length} capítulos. ¿Continuar? (recomendado: pocos a la vez)`
    );
    if (!ok) return;
  }

  setBusy(true, "Descargando en segundo plano…");
  barEl.style.width = "0%";
  log(`Descargando ${chapters.length} capítulo(s)…`);
  try {
    const results = await invoke<DownloadResult[]>("download_chapters", {
      req: {
        manga_title: manga.title || "manga",
        root_url: manga.root_url,
        output_dir: outputDir,
        chapters,
      },
    });

    let okFiles = 0;
    for (const r of results) {
      okFiles += r.files.length;
      if (r.errors.length) {
        log(
          `${r.chapter_name}: ${r.files.length} imgs, errores: ${r.errors.join("; ")}`,
          "err"
        );
      } else {
        log(`${r.chapter_name}: ${r.files.length} imágenes`, "ok");
      }
    }
    barEl.style.width = "100%";
    log(`Listo. Archivos guardados: ${okFiles}`, "ok");
  } catch (e) {
    log(String(e), "err");
  } finally {
    setBusy(false);
  }
});
