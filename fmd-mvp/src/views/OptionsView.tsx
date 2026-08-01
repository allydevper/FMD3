import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { appConfirm } from "../components/AppConfirm";
import { Icon } from "../components/Icon";
import { ICO } from "../icons";
import { DEFAULT_USER_AGENT, PACK_EXT, SK } from "../constants";
import * as api from "../api/tauri";
import { useApp, type AppTheme } from "../context/AppContext";
import type { ModuleMeta } from "../types";

/* ---------------------------------------------------------------------- */
/* Tipos y constantes                                                      */
/* ---------------------------------------------------------------------- */

type OptTabId = "general" | "view" | "connections" | "saveto" | "updates" | "dialogs" | "websites";
type SitesTabId = "list" | "mods";

const OPTIONS_CATS: { id: OptTabId; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: ICO.settings },
  { id: "view", label: "Vista", icon: ICO.layout },
  { id: "connections", label: "Conexiones", icon: ICO.link },
  { id: "saveto", label: "Guardar en", icon: ICO.folder },
  { id: "updates", label: "Actualizaciones", icon: ICO.refresh },
  { id: "dialogs", label: "Diálogos", icon: ICO.message },
  { id: "websites", label: "Sitios Web", icon: ICO.globe },
];

const PACK_FORMATS = ["none", "zip", "cbz", "pdf", "epub"] as const;
const PACK_OPTIONS: { value: (typeof PACK_FORMATS)[number]; label: string }[] = [
  { value: "none", label: "Ninguno" },
  { value: "zip", label: "ZIP" },
  { value: "cbz", label: "CBZ" },
  { value: "pdf", label: "PDF" },
  { value: "epub", label: "EPUB" },
];

const TOKENS_MANGA = ["%WEBSITE%", "%MANGA%", "%AUTHOR%", "%ARTIST%"];
const TOKENS_CHAPTER = ["%WEBSITE%", "%MANGA%", "%CHAPTER%", "%AUTHOR%", "%ARTIST%", "%NUMBERING%"];
const TOKENS_PAGE = ["%WEBSITE%", "%MANGA%", "%CHAPTER%", "%FILENAME%"];

/** Los cinco campos que define un preset de renombrado. */
type RenameShape = {
  mangaFolderOn: boolean;
  chapterFolderOn: boolean;
  patManga: string;
  patChapter: string;
  patPage: string;
};

/* Atajos para las combinaciones habituales. Sin `\` ni `/` en los patrones:
   `apply_pattern` los pasa por `sanitize_filename`, que los elimina. */
const RENAME_PRESETS: { id: string; label: string; shape: RenameShape }[] = [
  {
    id: "manga-chapter-page",
    label: "Manga / Capítulo / página",
    shape: {
      mangaFolderOn: true,
      chapterFolderOn: true,
      patManga: "%MANGA%",
      patChapter: "%CHAPTER%",
      patPage: "%FILENAME%",
    },
  },
  {
    id: "manga-numbered-chapter-page",
    label: "Manga / Nº - Capítulo / página",
    shape: {
      mangaFolderOn: true,
      chapterFolderOn: true,
      patManga: "%MANGA%",
      patChapter: "%NUMBERING% - %CHAPTER%",
      patPage: "%FILENAME%",
    },
  },
  {
    id: "site-manga-chapter-page",
    label: "Sitio - Manga / Capítulo / página",
    shape: {
      mangaFolderOn: true,
      chapterFolderOn: true,
      patManga: "%WEBSITE% - %MANGA%",
      patChapter: "%CHAPTER%",
      patPage: "%FILENAME%",
    },
  },
  {
    id: "manga-chapter-in-filename",
    label: "Manga / capítulo_página",
    shape: {
      mangaFolderOn: true,
      chapterFolderOn: false,
      patManga: "%MANGA%",
      patChapter: "%CHAPTER%",
      patPage: "%CHAPTER%_%FILENAME%",
    },
  },
];

const RENAME_PRESET_CUSTOM = "custom";

const SITE_ROW_H = 31;
const SITE_OVERSCAN = 10;
const MOD_ROW_H = 32;
const MOD_OVERSCAN = 10;
/** Highlight as "Nuevo" if mtime within this many days (local scan; GitHub updater pending). */
const MOD_NEW_DAYS = 14;

type OptionsFormState = {
  ua: string;
  useProxy: boolean;
  proxyType: string;
  proxyHost: string;
  proxyPort: number;
  proxyUser: string;
  proxyPass: string;
  threads: number;
  parallelTasks: number;
  oneChapterPerManga: boolean;
  taskRetries: number;
  httpTimeout: number;
  httpRetries: number;
  packFormat: string;
  packDelete: boolean;
  convertTo: string;
  patManga: string;
  patChapter: string;
  patPage: string;
  outputDirField: string;
  logOn: boolean;
  logFile: string;
  mangaFolderOn: boolean;
  chapterFolderOn: boolean;
  volPadOn: boolean;
  chapPadOn: boolean;
  volDigits: number;
  chapDigits: number;
  asciiOn: boolean;
  asciiChar: string;
  favIntervalOn: boolean;
  favIntervalMin: number;
  favCheckOnStart: boolean;
  favDownloadAfter: boolean;
  loadCovers: boolean;
  liveSearch: boolean;
  gotoDl: boolean;
  gotoFav: boolean;
  newDays: number;
  theme: AppTheme;
  afterFinish: string;
  trayMinimize: boolean;
  trayStart: boolean;
  notify: boolean;
  vacuum: boolean;
  clearDoneExit: boolean;
  longPaths: boolean;
  confirmExit: boolean;
  confirmDelete: boolean;
  confirmEmptyList: boolean;
  pngAsJpeg: boolean;
  webpAs: string;
  pngLevel: string;
  jpegQuality: number;
  pdfQuality: number;
  removeMangaFromChapter: boolean;
  sortOnAdd: boolean;
  checkUpdateStart: boolean;
  updateListNoInfo: boolean;
  updateListFullScan: boolean;
  updateListThreads: number;
  favThreads: number;
};

const DEFAULT_SETTINGS: OptionsFormState = {
  ua: DEFAULT_USER_AGENT,
  useProxy: false,
  proxyType: "http",
  proxyHost: "",
  proxyPort: 8080,
  proxyUser: "",
  proxyPass: "",
  threads: 1,
  parallelTasks: 1,
  oneChapterPerManga: false,
  taskRetries: 1,
  httpTimeout: 30,
  httpRetries: 5,
  packFormat: "none",
  packDelete: true,
  convertTo: "keep",
  patManga: "%MANGA%",
  patChapter: "%CHAPTER%",
  patPage: "%FILENAME%",
  outputDirField: "",
  logOn: false,
  logFile: "fmd.log",
  mangaFolderOn: true,
  chapterFolderOn: true,
  volPadOn: true,
  chapPadOn: true,
  volDigits: 2,
  chapDigits: 3,
  asciiOn: true,
  asciiChar: "_",
  favIntervalOn: false,
  favIntervalMin: 60,
  favCheckOnStart: true,
  favDownloadAfter: false,
  loadCovers: true,
  liveSearch: true,
  gotoDl: true,
  gotoFav: false,
  newDays: 1,
  theme: "system",
  afterFinish: "none",
  trayMinimize: false,
  trayStart: false,
  notify: true,
  vacuum: false,
  clearDoneExit: false,
  longPaths: false,
  confirmExit: true,
  confirmDelete: true,
  confirmEmptyList: true,
  pngAsJpeg: false,
  webpAs: "1",
  pngLevel: "1",
  jpegQuality: 80,
  pdfQuality: 85,
  removeMangaFromChapter: false,
  sortOnAdd: false,
  checkUpdateStart: true,
  updateListNoInfo: false,
  updateListFullScan: false,
  updateListThreads: 1,
  favThreads: 1,
};

function boolStr(v: boolean) {
  return v ? "1" : "0";
}
function parseB(raw: string | null, def: boolean) {
  if (raw == null || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
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

type ModRow = {
  key: string;
  file: string;
  mtime: number | null;
  when: string;
  dateTitle: string;
  msg: string;
  updated: boolean;
};

/* ---------------------------------------------------------------------- */
/* Helpers puros                                                          */
/* ---------------------------------------------------------------------- */

function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** Always persist `keep`. Per-format conversion (PNG→JPEG, WebP→PNG/JPEG) is
 * applied in Rust from those settings — never force a global convert_to (that
 * used to re-encode every JPEG to PNG when WebP→PNG was the default). */
function deriveConvertTo(_convertTo: string, _pngAsJpeg: boolean, _webpAs: string): string {
  return "keep";
}

/** Aviso (no bloqueante) cuando un patrón se queda sin el token que lo hace único. */
function patternMissingRequired(kind: "manga" | "chapter" | "page", pattern: string): string | null {
  const upper = pattern.toUpperCase();
  if (kind === "manga" && !upper.includes("%MANGA%")) {
    return "Debe incluir al menos %MANGA%.";
  }
  if (
    kind === "chapter" &&
    !upper.includes("%CHAPTER%") &&
    !upper.includes("%NUMBERING%") &&
    !upper.includes("%CHAPTERINDEX%")
  ) {
    return "Debe incluir %CHAPTER% o %NUMBERING%.";
  }
  if (kind === "page" && !upper.includes("%FILENAME%")) {
    return "Debe incluir al menos %FILENAME%.";
  }
  return null;
}

function parseProxyUrl(raw: string): {
  type: string;
  host: string;
  port: number;
  user: string;
  pass: string;
} {
  const empty = { type: "http", host: "", port: 8080, user: "", pass: "" };
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
      port: u.port ? Number(u.port) : type === "http" ? 8080 : 1080,
      user: decodeURIComponent(u.username || ""),
      pass: decodeURIComponent(u.password || ""),
    };
  } catch {
    return empty;
  }
}

function composeProxyUrl(type: string, host: string, port: number, user: string, pass: string): string {
  const h = host.trim();
  if (!h) return "";
  const p = port || 8080;
  const u = user.trim();
  const auth = u || pass ? `${encodeURIComponent(u)}${pass ? `:${encodeURIComponent(pass)}` : ""}@` : "";
  return `${type}://${auth}${h}:${p}`;
}

function moduleDomain(rootUrl: string): string {
  return rootUrl
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/^www\./i, "");
}

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

function buildSitesFlat(
  groups: SiteGroup[],
  query: string,
  onlyActive: boolean,
  expanded: Record<string, boolean>,
  siteOn: Record<string, true>,
): { flat: SitesFlatRow[]; total: number; totalOn: number } {
  const sq = query.trim().toLowerCase();
  const flat: SitesFlatRow[] = [];
  let total = 0;
  let totalOn = 0;
  const isOn = (id: string) => !!siteOn[id];

  for (const g of groups) {
    for (const st of g.sites) {
      total++;
      if (isOn(st.id)) totalOn++;
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
    if (onlyActive) sites = sites.filter((st) => isOn(st.id));
    if (!sites.length) continue;

    const onCount = g.sites.filter((st) => isOn(st.id)).length;
    const open = !!expanded[g.id] || !!sq || onlyActive;
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
        on: isOn(st.id),
      });
    }
  }

  return { flat, total, totalOn };
}

/* ---------------------------------------------------------------------- */
/* Hook de virtualización simple (listas sites-tree / mods-list)          */
/* ---------------------------------------------------------------------- */

function useVirtualRange(length: number, rowHeight: number, overscan: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(length, 60) });

  const recompute = useCallback(() => {
    const el = containerRef.current;
    const viewH = el?.clientHeight || 400;
    const scrollTop = el?.scrollTop || 0;
    let start = Math.floor(scrollTop / rowHeight) - overscan;
    let end = Math.ceil((scrollTop + viewH) / rowHeight) + overscan;
    start = Math.max(0, start);
    end = Math.min(length, Math.max(end, start));
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [length, rowHeight, overscan]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  return { containerRef, range, onScroll: recompute, recompute };
}

/* ---------------------------------------------------------------------- */
/* Pequeños componentes reutilizables                                     */
/* ---------------------------------------------------------------------- */

function OptRow({
  label,
  desc,
  children,
  status,
  title,
}: {
  label: string;
  desc: string;
  children: ReactNode;
  status?: "none" | "partial";
  title?: string;
}) {
  const statusClass =
    status === "none" ? " ui-status-none" : status === "partial" ? " ui-status-partial" : "";
  return (
    <div
      className={`st-row${statusClass}`}
      title={title ?? (status === "none" ? "Sin función" : status === "partial" ? "Incompleto" : undefined)}
    >
      <div className="st-meta">
        <div className="st-label">{label}</div>
        <div className="st-desc">{desc}</div>
      </div>
      {children}
    </div>
  );
}

function Stepper({
  id,
  value,
  onChange,
  min,
  max,
  suffix,
  wide,
}: {
  id?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  wide?: boolean;
}) {
  return (
    <div className="st-stepper">
      <button type="button" className="st-stepper-btn" aria-label="Menos" onClick={() => onChange(clampNum(value - 1, min, max))}>
        −
      </button>
      <input
        id={id}
        className={`st-stepper-input${wide ? " st-stepper-wide" : ""}`}
        type="number"
        min={min}
        max={max}
        value={value}
        autoComplete="off"
        onChange={(e) => onChange(clampNum(Number(e.target.value), min, max))}
      />
      {suffix ? <span className="st-stepper-suffix">{suffix}</span> : null}
      <button type="button" className="st-stepper-btn" aria-label="Más" onClick={() => onChange(clampNum(value + 1, min, max))}>
        +
      </button>
    </div>
  );
}

function SwitchRow({
  id,
  label,
  desc,
  warn,
  checked,
  onChange,
  status,
  title,
}: {
  id?: string;
  label: string;
  desc: string;
  warn?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  status?: "none" | "partial";
  title?: string;
}) {
  const statusClass =
    status === "none" ? " ui-status-none" : status === "partial" ? " ui-status-partial" : "";
  return (
    <label
      className={`st-row click${statusClass}`}
      title={title ?? (status === "none" ? "Sin función" : status === "partial" ? "Incompleto" : undefined)}
    >
      <div className="st-meta">
        <div className="st-label">
          {label}
          {warn ? <span className="st-warn">{warn}</span> : null}
        </div>
        <div className="st-desc">{desc}</div>
      </div>
      <span className="st-switch">
        <input
          id={id}
          className="opt-stub"
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="sw" aria-hidden="true">
          <span className="knob" />
        </span>
      </span>
    </label>
  );
}

function StubSelectRow({
  id,
  label,
  desc,
  options,
  defaultValue,
}: {
  id?: string;
  label: string;
  desc: string;
  options: { value: string; label: string }[];
  defaultValue: string;
  onDirty?: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <OptRow label={label} desc={desc} status="none">
      <div className="st-select filter-select-wrap">
        <select
          id={id}
          className="opt-stub"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </OptRow>
  );
}

function SelectRow({
  id,
  label,
  desc,
  value,
  onChange,
  options,
}: {
  id?: string;
  label: string;
  desc: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <OptRow label={label} desc={desc}>
      <div className="st-select filter-select-wrap">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </OptRow>
  );
}

function BoundStepperRow({
  id,
  label,
  desc,
  value,
  onChange,
  min,
  max,
  suffix,
  unit,
}: {
  id?: string;
  label: string;
  desc: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  unit?: string;
}) {
  return (
    <OptRow label={label} desc={desc}>
      <div className="st-num-wrap">
        <Stepper id={id} value={value} min={min} max={max} suffix={suffix} onChange={onChange} />
        {unit ? <span className="st-unit">{unit}</span> : null}
      </div>
    </OptRow>
  );
}

function TokenInsert({ tokens, onInsert }: { tokens: string[]; onInsert: (token: string) => void }) {
  return (
    <div className="st-token-insert">
      <span className="st-token-insert-label">Insertar:</span>
      {tokens.map((t) => (
        <button key={t} type="button" className="st-token-chip" onClick={() => onInsert(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Componente principal                                                   */
/* ---------------------------------------------------------------------- */

export function OptionsView() {
  const { activeNav, log, outputDir, setOutputDir, modules, refreshModules, setTheme, refreshEnabledModules, setFavAutoCheck } =
    useApp();

  const [optTab, setOptTab] = useState<OptTabId>("general");
  const [dirty, setDirty] = useState(false);
  const [saveFlash, setSaveFlash] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveFlashTimerRef = useRef<number | undefined>(undefined);
  const [cacheClearFlash, setCacheClearFlash] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const cacheClearTimerRef = useRef<number | undefined>(undefined);
  const [logClearFlash, setLogClearFlash] = useState<"idle" | "working" | "done" | "error">("idle");
  const logClearTimerRef = useRef<number | undefined>(undefined);
  const [s, setS] = useState<OptionsFormState>(DEFAULT_SETTINGS);

  const outputDirRef = useRef(outputDir);
  useEffect(() => {
    outputDirRef.current = outputDir;
  }, [outputDir]);

  const clearSaveFlash = useCallback(() => {
    if (saveFlashTimerRef.current != null) {
      window.clearTimeout(saveFlashTimerRef.current);
      saveFlashTimerRef.current = undefined;
    }
    setSaveFlash("idle");
  }, []);

  const markDirty = useCallback(() => {
    clearSaveFlash();
    setDirty(true);
  }, [clearSaveFlash]);

  const update = useCallback(
    <K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) => {
      setS((prev) => ({ ...prev, [key]: value }));
      clearSaveFlash();
      setDirty(true);
    },
    [clearSaveFlash],
  );

  useEffect(() => {
    return () => {
      if (saveFlashTimerRef.current != null) window.clearTimeout(saveFlashTimerRef.current);
      if (cacheClearTimerRef.current != null) window.clearTimeout(cacheClearTimerRef.current);
      if (logClearTimerRef.current != null) window.clearTimeout(logClearTimerRef.current);
    };
  }, []);

  function runLogClear() {
    if (logClearFlash === "working") return;
    setLogClearFlash("working");
    void api
      .clearLogFile()
      .then(() => {
        setLogClearFlash("done");
        log("Log borrado", "ok");
        if (logClearTimerRef.current != null) window.clearTimeout(logClearTimerRef.current);
        logClearTimerRef.current = window.setTimeout(() => {
          setLogClearFlash("idle");
          logClearTimerRef.current = undefined;
        }, 2500);
      })
      .catch((e) => {
        setLogClearFlash("error");
        log(String(e), "err");
        if (logClearTimerRef.current != null) window.clearTimeout(logClearTimerRef.current);
        logClearTimerRef.current = window.setTimeout(() => {
          setLogClearFlash("idle");
          logClearTimerRef.current = undefined;
        }, 2500);
      });
  }

  function runCacheClear() {
    if (cacheClearFlash === "working") return;
    void (async () => {
      const ok = await appConfirm({
        title: "Limpiar caché",
        message: "¿Borrar info y portadas en caché?\n\nFavoritos, cola y catálogo no se tocan.",
        okLabel: "Limpiar",
        cancelLabel: "Cancelar",
      });
      if (!ok) return;
      setCacheClearFlash("working");
      void api
        .cacheClear()
        .then((msg) => {
          setCacheClearFlash("done");
          log(msg, "ok");
          if (cacheClearTimerRef.current != null) window.clearTimeout(cacheClearTimerRef.current);
          cacheClearTimerRef.current = window.setTimeout(() => {
            setCacheClearFlash("idle");
            cacheClearTimerRef.current = undefined;
          }, 2500);
        })
        .catch((e) => {
          setCacheClearFlash("error");
          log(String(e), "err");
          if (cacheClearTimerRef.current != null) window.clearTimeout(cacheClearTimerRef.current);
          cacheClearTimerRef.current = window.setTimeout(() => {
            setCacheClearFlash("idle");
            cacheClearTimerRef.current = undefined;
          }, 3000);
        });
    })();
  }

  const [siteOn, setSiteOn] = useState<Record<string, true>>({});
  const enabledIdsRef = useRef<Set<string>>(new Set());
  const knownModulesRef = useRef<Set<string>>(new Set());

  /* ---- Cargar / guardar ajustes reales ---- */

  const loadSettings = useCallback(async () => {
    const get = (k: string) => api.settingsGet(k);
    const savedUa = ((await get(SK.UA)) ?? "").trim();
    const proxyRaw = (await get(SK.PROXY)) ?? "";
    const parsed = parseProxyUrl(proxyRaw);
    const packRaw = (await get(SK.PACK)) ?? "none";
    const packOk = (PACK_FORMATS as readonly string[]).includes(packRaw) ? packRaw : "none";
    const enabledRaw = (await get(SK.MODULES_ENABLED)) ?? "[]";
    let enabled: string[] = [];
    try {
      enabled = JSON.parse(enabledRaw);
    } catch {
      enabled = [];
    }
    const enabledSet = new Set(enabled);
    enabledIdsRef.current = enabledSet;
    knownModulesRef.current = new Set(modules.map((m) => m.id));
    setSiteOn(() => {
      const next: Record<string, true> = {};
      for (const m of modules) {
        if (enabledSet.has(m.id)) next[m.id] = true;
      }
      return next;
    });

    const maxThreads = Number((await get(SK.MAX_THREADS)) ?? "1") || 1;
    const parallelTasks = Math.min(
      32,
      Math.max(1, Number((await get(SK.PARALLEL_TASKS)) ?? "1") || 1),
    );
    const oneChapterPerManga = parseB(await get(SK.ONE_CHAPTER_PER_MANGA), false);
    const taskRetries = Number((await get(SK.TASK_RETRIES)) ?? "1") || 0;
    const httpTimeout = Number((await get(SK.TIMEOUT)) ?? "30") || 30;
    const httpRetriesRaw = Number((await get(SK.HTTP_RETRIES)) ?? "5");
    const httpRetries = !Number.isFinite(httpRetriesRaw) || httpRetriesRaw < 0
      ? 5
      : Math.min(5, Math.floor(httpRetriesRaw));
    const packDelete = parseB(await get(SK.PACK_DELETE), true);
    // Legacy global convert_to (png/jpg) is ignored; per-format toggles own conversion.
    const convertTo = "keep";
    const patManga = (await get(SK.PAT_MANGA)) ?? "%MANGA%";
    const patChapter = (await get(SK.PAT_CHAPTER)) ?? "%CHAPTER%";
    const patPage = (await get(SK.PAT_PAGE)) ?? "%FILENAME%";
    const outputDirField =
      ((await get(SK.OUTPUT_DIR)) ?? "").trim() ||
      outputDirRef.current.trim() ||
      (await api.defaultSaveDir());
    const mangaFolderOn = parseB(await get(SK.MANGA_FOLDER_ON), true);
    const chapterFolderOn = parseB(await get(SK.CHAPTER_FOLDER_ON), true);
    const asciiOn = parseB(await get(SK.ASCII_ON), true);
    const asciiChar = (await get(SK.ASCII_CHAR)) || "_";
    const volPadOn = parseB(await get(SK.VOL_PAD), true);
    const chapPadOn = parseB(await get(SK.CHAP_PAD), true);
    const volDigits = Number((await get(SK.VOL_DIGITS)) ?? "2") || 2;
    const chapDigits = Number((await get(SK.CHAP_DIGITS)) ?? "3") || 3;
    const favIntervalOn = parseB(await get(SK.FAV_INTERVAL_ON), false);
    const favIntervalMin = Math.max(60, Number((await get(SK.FAV_INTERVAL_MIN)) ?? "60") || 60);
    const favCheckOnStart = parseB(await get(SK.FAV_CHECK_ON_START), true);
    const favDownloadAfter = parseB(await get(SK.FAV_DOWNLOAD_AFTER), false);
    const loadCovers = parseB(await get(SK.UI_LOAD_COVERS), true);
    const liveSearch = parseB(await get(SK.UI_LIVE_SEARCH), true);
    const gotoDl = parseB(await get(SK.UI_GOTO_DL), true);
    const gotoFav = parseB(await get(SK.UI_GOTO_FAV), false);
    const newDays = Number((await get(SK.UI_NEW_DAYS)) ?? "1") || 1;
    const themeRaw = ((await get(SK.APP_THEME)) || "system").toLowerCase();
    const theme: AppTheme =
      themeRaw === "dark" || themeRaw === "oscuro"
        ? "dark"
        : themeRaw === "light" || themeRaw === "claro"
          ? "light"
          : "system";
    const afterFinish =
      ((await get(SK.AFTER_FINISH)) || "none").toLowerCase() === "exit" ? "exit" : "none";
    const logOn = parseB(await get(SK.LOG_ON), false);
    const logFile = (await get(SK.LOG_FILE)) || "fmd.log";
    const trayMinimize = parseB(await get(SK.TRAY_MINIMIZE), false);
    const trayStart = parseB(await get(SK.TRAY_START), false);
    const notify = parseB(await get(SK.NOTIFY), true);
    const vacuum = parseB(await get(SK.VACUUM), false);
    const clearDoneExit = parseB(await get(SK.CLEAR_DONE_EXIT), false);
    const longPaths = parseB(await get(SK.LONG_PATHS), false);
    const confirmExit = parseB(await get(SK.CONFIRM_EXIT), true);
    const confirmDelete = parseB(await get(SK.CONFIRM_DELETE), true);
    const confirmEmptyList = parseB(await get(SK.CONFIRM_EMPTY_LIST), true);
    const pngAsJpeg = parseB(await get(SK.PNG_AS_JPEG), false);
    const webpAs = (await get(SK.WEBP_AS)) || "1";
    const pngLevel = (await get(SK.PNG_LEVEL)) || "1";
    const jpegQuality = Number((await get(SK.JPEG_QUALITY)) ?? "80") || 80;
    const pdfQuality = Number((await get(SK.PDF_QUALITY)) ?? "85") || 85;
    const removeMangaFromChapter = parseB(await get(SK.REMOVE_MANGA_FROM_CHAPTER), false);
    const sortOnAdd = parseB(await get(SK.SORT_ON_ADD), false);
    const checkUpdateStart = parseB(await get(SK.CHECK_UPDATE_START), true);
    const updateListNoInfo = parseB(await get(SK.UPDATE_LIST_NO_INFO), false);
    const updateListFullScan = parseB(await get(SK.UPDATE_LIST_FULL_SCAN), false);
    const updateListThreads = Math.min(
      32,
      Math.max(1, Number((await get(SK.UPDATE_LIST_THREADS)) ?? "1") || 1),
    );
    const favThreads = Math.min(
      32,
      Math.max(1, Number((await get(SK.FAV_THREADS)) ?? "1") || 1),
    );

    setS((prev) => ({
      ...prev,
      ua: savedUa || DEFAULT_USER_AGENT,
      useProxy: Boolean(proxyRaw.trim()),
      proxyType: parsed.type,
      proxyHost: parsed.host,
      proxyPort: parsed.port,
      proxyUser: parsed.user,
      proxyPass: parsed.pass,
      threads: maxThreads,
      parallelTasks,
      oneChapterPerManga,
      taskRetries,
      httpTimeout,
      httpRetries,
      packFormat: packOk,
      packDelete,
      convertTo,
      patManga,
      patChapter,
      patPage,
      outputDirField,
      mangaFolderOn,
      chapterFolderOn,
      asciiOn,
      asciiChar,
      volPadOn,
      chapPadOn,
      volDigits,
      chapDigits,
      favIntervalOn,
      favIntervalMin,
      favCheckOnStart,
      favDownloadAfter,
      loadCovers,
      liveSearch,
      gotoDl,
      gotoFav,
      newDays,
      theme,
      afterFinish,
      logOn,
      logFile,
      trayMinimize,
      trayStart,
      notify,
      vacuum,
      clearDoneExit,
      longPaths,
      confirmExit,
      confirmDelete,
      confirmEmptyList,
      pngAsJpeg,
      webpAs,
      pngLevel,
      jpegQuality,
      pdfQuality,
      removeMangaFromChapter,
      sortOnAdd,
      checkUpdateStart,
      updateListNoInfo,
      updateListFullScan,
      updateListThreads,
      favThreads,
    }));
    setDirty(false);
  }, [modules]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSave = useCallback(async () => {
    if (saveFlash === "saving") return;
    setSaveFlash("saving");
    try {
    const uaVal = s.ua.trim();
    await api.settingsSet(SK.UA, uaVal === DEFAULT_USER_AGENT ? "" : uaVal);
    await api.settingsSet(
      SK.PROXY,
      s.useProxy ? composeProxyUrl(s.proxyType, s.proxyHost, s.proxyPort, s.proxyUser, s.proxyPass) : "",
    );
    await api.settingsSet(SK.MAX_THREADS, String(s.threads));
    await api.settingsSet(SK.UPDATE_LIST_THREADS, String(s.updateListThreads));
    await api.settingsSet(SK.FAV_THREADS, String(s.favThreads));
    await api.settingsSet(SK.PARALLEL_TASKS, String(s.parallelTasks));
    await api.settingsSet(SK.ONE_CHAPTER_PER_MANGA, boolStr(s.oneChapterPerManga));
    await api.settingsSet(SK.TASK_RETRIES, String(s.taskRetries));
    await api.settingsSet(SK.TIMEOUT, String(s.httpTimeout));
    await api.settingsSet(SK.HTTP_RETRIES, String(s.httpRetries));
    await api.settingsSet(SK.PACK, s.packFormat);
    await api.settingsSet(SK.PACK_DELETE, boolStr(s.packDelete));
    await api.settingsSet(SK.CONVERT, deriveConvertTo(s.convertTo, s.pngAsJpeg, s.webpAs));
    await api.settingsSet(SK.PDF_QUALITY, String(s.pdfQuality));
    await api.settingsSet(SK.PAT_MANGA, s.patManga);
    await api.settingsSet(SK.PAT_CHAPTER, s.patChapter);
    await api.settingsSet(SK.PAT_PAGE, s.patPage);
    await api.settingsSet(SK.MANGA_FOLDER_ON, boolStr(s.mangaFolderOn));
    await api.settingsSet(SK.CHAPTER_FOLDER_ON, boolStr(s.chapterFolderOn));
    await api.settingsSet(SK.ASCII_ON, boolStr(s.asciiOn));
    await api.settingsSet(SK.ASCII_CHAR, s.asciiChar || "_");
    await api.settingsSet(SK.VOL_PAD, boolStr(s.volPadOn));
    await api.settingsSet(SK.CHAP_PAD, boolStr(s.chapPadOn));
    await api.settingsSet(SK.VOL_DIGITS, String(s.volDigits));
    await api.settingsSet(SK.CHAP_DIGITS, String(s.chapDigits));
    await api.settingsSet(SK.FAV_INTERVAL_ON, boolStr(s.favIntervalOn));
    await api.settingsSet(SK.FAV_INTERVAL_MIN, String(Math.max(60, s.favIntervalMin)));
    await api.settingsSet(SK.FAV_CHECK_ON_START, boolStr(s.favCheckOnStart));
    await api.settingsSet(SK.FAV_DOWNLOAD_AFTER, boolStr(s.favDownloadAfter));
    await api.settingsSet(SK.UI_LOAD_COVERS, boolStr(s.loadCovers));
    await api.settingsSet(SK.UI_LIVE_SEARCH, boolStr(s.liveSearch));
    await api.settingsSet(SK.UI_GOTO_DL, boolStr(s.gotoDl));
    await api.settingsSet(SK.UI_GOTO_FAV, boolStr(s.gotoFav));
    await api.settingsSet(SK.UI_NEW_DAYS, String(s.newDays));
    await api.settingsSet(SK.APP_THEME, s.theme);
    await api.settingsSet(SK.AFTER_FINISH, s.afterFinish === "exit" ? "exit" : "none");
    await api.settingsSet(SK.LOG_ON, boolStr(s.logOn));
    await api.settingsSet(SK.LOG_FILE, s.logFile || "fmd.log");
    await api.settingsSet(SK.TRAY_MINIMIZE, boolStr(s.trayMinimize));
    await api.settingsSet(SK.TRAY_START, boolStr(s.trayStart));
    await api.settingsSet(SK.NOTIFY, boolStr(s.notify));
    await api.settingsSet(SK.VACUUM, boolStr(s.vacuum));
    await api.settingsSet(SK.CLEAR_DONE_EXIT, boolStr(s.clearDoneExit));
    await api.settingsSet(SK.LONG_PATHS, boolStr(s.longPaths));
    await api.settingsSet(SK.CONFIRM_EXIT, boolStr(s.confirmExit));
    await api.settingsSet(SK.CONFIRM_DELETE, boolStr(s.confirmDelete));
    await api.settingsSet(SK.CONFIRM_EMPTY_LIST, boolStr(s.confirmEmptyList));
    await api.settingsSet(SK.PNG_AS_JPEG, boolStr(s.pngAsJpeg));
    await api.settingsSet(SK.WEBP_AS, s.webpAs);
    await api.settingsSet(SK.PNG_LEVEL, s.pngLevel);
    await api.settingsSet(SK.JPEG_QUALITY, String(s.jpegQuality));
    await api.settingsSet(SK.REMOVE_MANGA_FROM_CHAPTER, boolStr(s.removeMangaFromChapter));
    await api.settingsSet(SK.SORT_ON_ADD, boolStr(s.sortOnAdd));
    await api.settingsSet(SK.CHECK_UPDATE_START, boolStr(s.checkUpdateStart));
    await api.settingsSet(SK.UPDATE_LIST_NO_INFO, boolStr(s.updateListNoInfo));
    await api.settingsSet(SK.UPDATE_LIST_FULL_SCAN, boolStr(s.updateListFullScan));
    const enabled = modules.filter((m) => siteOn[m.id]).map((m) => m.id);
    enabledIdsRef.current = new Set(enabled);
    await api.settingsSet(SK.MODULES_ENABLED, JSON.stringify(enabled));
    const dir = s.outputDirField.trim();
    if (dir) {
      await api.settingsSet(SK.OUTPUT_DIR, dir);
      setOutputDir(dir);
    }
    setTheme(s.theme);
    await refreshEnabledModules();
    await setFavAutoCheck(s.favIntervalOn);
    setDirty(false);
    setSaveFlash("saved");
    if (saveFlashTimerRef.current != null) window.clearTimeout(saveFlashTimerRef.current);
    saveFlashTimerRef.current = window.setTimeout(() => {
      setSaveFlash("idle");
      saveFlashTimerRef.current = undefined;
    }, 2200);
    log(
      enabled.length
        ? `Ajustes guardados · ${enabled.length} sitio${enabled.length === 1 ? "" : "s"} activo${enabled.length === 1 ? "" : "s"}`
        : "Ajustes guardados · ningún sitio activo",
      "ok",
    );
    } catch (e) {
      setSaveFlash("error");
      if (saveFlashTimerRef.current != null) window.clearTimeout(saveFlashTimerRef.current);
      saveFlashTimerRef.current = window.setTimeout(() => {
        setSaveFlash("idle");
        saveFlashTimerRef.current = undefined;
      }, 2800);
      log(`No se pudieron guardar los ajustes: ${e}`, "err");
    }
  }, [s, setOutputDir, log, modules, siteOn, setTheme, refreshEnabledModules, setFavAutoCheck, saveFlash]);

  const handleBrowseOutputDir = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    update("outputDirField", dir);
  }, [update]);

  /* ---- Vista previa de renombrado ---- */

  // El backend arma la ruta de ejemplo con el mismo código que nombra las
  // descargas reales, así que la vista previa no puede desviarse.
  const renameOpts = useMemo<api.RenameOpts>(
    () => ({
      mangaFolderOn: s.mangaFolderOn,
      chapterFolderOn: s.chapterFolderOn,
      patManga: s.patManga,
      patChapter: s.patChapter,
      patPage: s.patPage,
      asciiOn: s.asciiOn,
      asciiChar: s.asciiChar,
      removeMangaFromChapter: s.removeMangaFromChapter,
      volDigits: s.volPadOn ? s.volDigits : 0,
      chapDigits: s.chapPadOn ? s.chapDigits : 0,
    }),
    [
      s.mangaFolderOn,
      s.chapterFolderOn,
      s.patManga,
      s.patChapter,
      s.patPage,
      s.asciiOn,
      s.asciiChar,
      s.removeMangaFromChapter,
      s.volPadOn,
      s.chapPadOn,
      s.volDigits,
      s.chapDigits,
    ],
  );

  const [renamePreview, setRenamePreview] = useState("");

  useEffect(() => {
    const root = s.outputDirField.trim() || outputDirRef.current.trim() || ".";
    const packExt = PACK_EXT[s.packFormat] ?? "";
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .renamePreview(renameOpts, root, packExt)
        .then((out) => {
          if (!cancelled) setRenamePreview(out);
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [renameOpts, s.outputDirField, s.packFormat]);

  const mangaPatHint = useMemo(
    () => (s.mangaFolderOn ? patternMissingRequired("manga", s.patManga) : null),
    [s.mangaFolderOn, s.patManga],
  );
  const chapterPatHint = useMemo(
    () => (s.chapterFolderOn ? patternMissingRequired("chapter", s.patChapter) : null),
    [s.chapterFolderOn, s.patChapter],
  );
  const pagePatHint = useMemo(() => patternMissingRequired("page", s.patPage), [s.patPage]);

  /* ---- Empaquetado ----
     El archivo se nombra a partir de la carpeta que se empaqueta, así que sin
     carpeta de capítulo se empaquetaría la del manga. Los textos de la sección
     lo avisan; el switch se deja libre para no pelearse con el usuario. */
  const packing = s.packFormat !== "none";

  /* ---- Presets de renombrado ---- */

  // El preset activo se deriva de los campos, no se guarda: editar uno a mano
  // pasa el selector a "Personalizado" solo. Solo se comparan los patrones que
  // están en uso — un patrón de capítulo oculto no debería romper la detección.
  // Con empaquetado, los presets sin carpeta de capítulo no son aplicables.
  const availablePresets = useMemo(
    () => (packing ? RENAME_PRESETS.filter((p) => p.shape.chapterFolderOn) : RENAME_PRESETS),
    [packing],
  );

  const renamePreset = useMemo(() => {
    const match = RENAME_PRESETS.find(
      ({ shape }) =>
        shape.mangaFolderOn === s.mangaFolderOn &&
        shape.chapterFolderOn === s.chapterFolderOn &&
        shape.patPage === s.patPage &&
        (!s.mangaFolderOn || shape.patManga === s.patManga) &&
        (!s.chapterFolderOn || shape.patChapter === s.patChapter),
    );
    return match?.id ?? RENAME_PRESET_CUSTOM;
  }, [s.mangaFolderOn, s.chapterFolderOn, s.patManga, s.patChapter, s.patPage]);

  const applyRenamePreset = useCallback(
    (id: string) => {
      const preset = RENAME_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      for (const [key, value] of Object.entries(preset.shape)) {
        update(key as keyof RenameShape, value as never);
      }
    },
    [update],
  );

  const patMangaRef = useRef<HTMLInputElement>(null);
  const patChapterRef = useRef<HTMLInputElement>(null);
  const patPageRef = useRef<HTMLInputElement>(null);

  const insertTokenInto = useCallback(
    (ref: RefObject<HTMLInputElement | null>, key: "patManga" | "patChapter" | "patPage", token: string) => {
      const input = ref.current;
      const current = s[key];
      const start = input?.selectionStart ?? current.length;
      const end = input?.selectionEnd ?? current.length;
      const next = current.slice(0, start) + token + current.slice(end);
      update(key, next);
      const caret = start + token.length;
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(caret, caret);
      });
    },
    [s, update],
  );

  /* ---- Panel Sitios Web ---- */

  const [sitesTab, setSitesTab] = useState<SitesTabId>("list");
  const [sitesQuery, setSitesQuery] = useState("");
  const [sitesOnlyActive, setSitesOnlyActive] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const siteGroups = useMemo<SiteGroup[]>(() => {
    const byCat = new Map<string, SiteMod[]>();
    for (const m of modules) {
      const label = (m.category || "").trim() || "Other";
      const list = byCat.get(label) ?? [];
      list.push({ id: m.id, name: m.name, domain: moduleDomain(m.root_url) });
      byCat.set(label, list);
    }
    const labels = [...byCat.keys()].sort((a, b) => a.localeCompare(b));
    return labels.map((label) => {
      const sites = (byCat.get(label) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      return { id: label, label, sites };
    });
  }, [modules]);

  useEffect(() => {
    setSiteOn((prev) => {
      const next: Record<string, true> = {};
      let changed = false;
      const alive = new Set(modules.map((m) => m.id));
      for (const id of Object.keys(prev)) {
        if (alive.has(id)) next[id] = true;
        else changed = true;
      }
      for (const m of modules) {
        if (!knownModulesRef.current.has(m.id)) {
          // New modules stay OFF (opt-in).
          knownModulesRef.current.add(m.id);
          changed = true;
        } else if (prev[m.id]) {
          next[m.id] = true;
        }
      }
      return changed ? next : prev;
    });
  }, [modules]);

  const { flat: sitesFlat, total: sitesTotal, totalOn: sitesTotalOn } = useMemo(
    () => buildSitesFlat(siteGroups, sitesQuery, sitesOnlyActive, expanded, siteOn),
    [siteGroups, sitesQuery, sitesOnlyActive, expanded, siteOn],
  );

  const allSiteIds = useMemo(() => siteGroups.flatMap((g) => g.sites.map((st) => st.id)), [siteGroups]);

  const setSitesOn = useCallback(
    (ids: string[], on: boolean) => {
      setSiteOn((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          if (on) next[id] = true;
          else delete next[id];
        }
        return next;
      });
      markDirty();
    },
    [markDirty],
  );

  const toggleGroupExpand = useCallback((gid: string) => {
    setExpanded((prev) => ({ ...prev, [gid]: !prev[gid] }));
  }, []);

  const handleSitesExpandAll = useCallback(() => {
    setExpanded(Object.fromEntries(siteGroups.map((g) => [g.id, true])));
  }, [siteGroups]);

  const handleSitesCollapseAll = useCallback(() => {
    setExpanded({});
    setSitesQuery("");
    setSitesOnlyActive(false);
  }, []);

  const {
    containerRef: sitesTreeRef,
    range: sitesRange,
    onScroll: onSitesScroll,
    recompute: recomputeSites,
  } = useVirtualRange(sitesFlat.length, SITE_ROW_H, SITE_OVERSCAN);

  useEffect(() => {
    if (optTab === "websites" && sitesTab === "list") recomputeSites();
  }, [optTab, sitesTab, recomputeSites]);

  /* ---- Panel Módulos ---- */

  const [modsQuery, setModsQuery] = useState("");
  const [modsOnlyUpdated, setModsOnlyUpdated] = useState(false);
  const [modsWarn, setModsWarn] = useState(true);
  const [modsAutoRestart, setModsAutoRestart] = useState(false);
  const [modsChecking, setModsChecking] = useState(false);

  const modRows = useMemo<ModRow[]>(() => {
    const byFile = new Map<string, ModRow>();
    const newCut = Date.now() - MOD_NEW_DAYS * 86400000;
    for (const m of modules) {
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
    return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file, undefined, { sensitivity: "base" }));
  }, [modules]);

  const modsUpdatedCount = useMemo(() => modRows.filter((r) => r.updated).length, [modRows]);

  const modsFlat = useMemo(() => {
    const mq = modsQuery.trim().toLowerCase();
    let rows = modRows;
    if (mq) rows = rows.filter((r) => r.file.toLowerCase().includes(mq) || r.msg.toLowerCase().includes(mq));
    if (modsOnlyUpdated) rows = rows.filter((r) => r.updated);
    return rows;
  }, [modRows, modsQuery, modsOnlyUpdated]);

  const {
    containerRef: modsListRef,
    range: modsRange,
    onScroll: onModsScroll,
    recompute: recomputeMods,
  } = useVirtualRange(modsFlat.length, MOD_ROW_H, MOD_OVERSCAN);

  useEffect(() => {
    if (optTab === "websites" && sitesTab === "mods") recomputeMods();
  }, [optTab, sitesTab, recomputeMods]);

  const runModulesCheck = useCallback(async () => {
    if (modsChecking) return;
    setModsChecking(true);
    try {
      const n = await api.modulesRefresh();
      await refreshModules();
      log(`Módulos reescaneados: ${n}`, "ok");
    } catch (e) {
      log(`No se pudo revisar módulos: ${e}`, "err");
    } finally {
      setModsChecking(false);
    }
  }, [modsChecking, refreshModules, log]);

  /* ---------------------------------------------------------------------- */

  return (
    <section id="view-options" className="view" hidden={activeNav !== "options"}>
      <div className="options-shell">
        <header className="options-header">
          <div className="options-eyebrow">Preferencias</div>
          <h1 className="options-title">Configuración</h1>
        </header>

        <div className="options-main">
          <nav className="options-cats" role="tablist" aria-label="Categorías">
            {OPTIONS_CATS.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`options-cat${optTab === cat.id ? " active" : ""}`}
                role="tab"
                aria-selected={optTab === cat.id}
                onClick={() => setOptTab(cat.id)}
              >
                <Icon ico={cat.icon} className="ico ico-sm" />
                <span>{cat.label}</span>
              </button>
            ))}
          </nav>

          <div className="options-body">
            {/* ---- General ---- */}
            <div className={`options-panel${optTab === "general" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "general"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.settings} className="ico ico-sm" />
                      <h2>Aplicación</h2>
                    </div>
                    <div className="st-card">
                      <StubSelectRow
                        label="Idioma"
                        desc="Idioma de la interfaz"
                        defaultValue="en"
                        onDirty={markDirty}
                        options={[
                          { value: "de", label: "Deutsch" },
                          { value: "en", label: "English" },
                          { value: "es", label: "Español" },
                          { value: "fr", label: "Français" },
                          { value: "id_ID", label: "Bahasa Indonesia" },
                          { value: "pl_PL", label: "Polski" },
                          { value: "pt_BR", label: "Português (Brasil)" },
                          { value: "ru_RU", label: "Русский" },
                          { value: "tr_TR", label: "Türkçe" },
                          { value: "zh", label: "中文" },
                          { value: "el_GR", label: "Ελληνικά" },
                        ]}
                      />
                      <SelectRow
                        label="Tema"
                        desc="Apariencia clara, oscura o según el sistema"
                        value={s.theme}
                        onChange={(v) => {
                          const t = (v === "dark" || v === "light" || v === "system" ? v : "system") as AppTheme;
                          // Aplica y guarda al instante; no marca “Cambios sin guardar”.
                          setS((prev) => ({ ...prev, theme: t }));
                          setTheme(t);
                        }}
                        options={[
                          { value: "system", label: "Sistema" },
                          { value: "light", label: "Claro" },
                          { value: "dark", label: "Oscuro" },
                        ]}
                      />
                      {/* FMD2 "After download finish" / LetFMDDo — oculto por ahora (casi no aporta
                          sin countdown / apagar / hibernar). Reactivar junto con stubs en
                          settings_keys + queue.rs when ready to test.
                      <SelectRow
                        label="Tras terminar"
                        desc="Acción al completar todas las descargas"
                        value={s.afterFinish === "exit" ? "exit" : "none"}
                        onChange={(v) => update("afterFinish", v === "exit" ? "exit" : "none")}
                        options={[
                          { value: "none", label: "No hacer nada" },
                          { value: "exit", label: "Salir del programa" },
                          { value: "shutdown", label: "Apagar el sistema" },
                          { value: "hibernate", label: "Hibernar el sistema" },
                        ]}
                      />
                      */}
                      <BoundStepperRow
                        id="opt-new-days"
                        label="Marcar manga como nuevo"
                        desc="Días desde que se añadió al catálogo"
                        value={s.newDays}
                        min={1}
                        max={365}
                        unit="días"
                        onChange={(v) => update("newDays", v)}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.sliders} className="ico ico-sm" />
                      <h2>Comportamiento</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-tray-start"
                        label="Minimizar al iniciar"
                        desc="Arranca en la bandeja del sistema"
                        checked={s.trayStart}
                        onChange={(v) => update("trayStart", v)}
                      />
                      <SwitchRow
                        id="opt-tray-minimize"
                        label="Minimizar a la bandeja"
                        desc="Al minimizar, se oculta en la bandeja"
                        checked={s.trayMinimize}
                        onChange={(v) => update("trayMinimize", v)}
                      />
                      <SwitchRow
                        id="opt-live-search"
                        label="Búsqueda en vivo"
                        desc="Filtra mientras escribes (lento en listas largas)"
                        checked={s.liveSearch}
                        onChange={(v) => update("liveSearch", v)}
                      />
                      <SwitchRow
                        id="opt-clear-done"
                        label="Borrar tareas completadas al cerrar"
                        desc="Al salir, quita de la cola solo las terminadas con éxito"
                        checked={s.clearDoneExit}
                        onChange={(v) => update("clearDoneExit", v)}
                      />
                      <SwitchRow
                        id="opt-sort-on-add"
                        label="Ordenar cola al añadir tareas"
                        desc="Si está apagado, lo nuevo va al final; si está activo, reordena por título A–Z"
                        checked={s.sortOnAdd}
                        onChange={(v) => update("sortOnAdd", v)}
                      />
                      <SwitchRow
                        id="opt-vacuum"
                        label="Vacuum de bases al salir"
                        desc="Compacta favoritos y la base de la app al cerrar"
                        checked={s.vacuum}
                        onChange={(v) => update("vacuum", v)}
                      />
                      <SwitchRow
                        id="opt-long-paths"
                        label="Rutas de nombre largo"
                        desc="Conserva títulos y carpetas completos aunque sean muy largos. Si está apagado, se acortan para que la descarga no falle."
                        checked={s.longPaths}
                        onChange={(v) => update("longPaths", v)}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.file} className="ico ico-sm" />
                      <h2>Registro (log)</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-log"
                        label="Activar registro"
                        desc="Guarda la actividad en un archivo de log"
                        checked={s.logOn}
                        onChange={(v) => update("logOn", v)}
                      />
                      <div hidden={!s.logOn}>
                        <div className="st-row">
                          <div className="st-form-inline">
                            <span className="st-form-key">Archivo</span>
                            <input
                              className="st-field st-mono"
                              type="text"
                              value={s.logFile}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(e) => update("logFile", e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="st-row st-row-actions">
                          <div className="st-meta">
                            {logClearFlash === "done" ? (
                              <div className="st-inline-ok" role="status">
                                Archivo de log borrado
                              </div>
                            ) : logClearFlash === "error" ? (
                              <div className="st-inline-err" role="status">
                                No se pudo borrar
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className={`secondary${logClearFlash === "done" ? " is-saved" : ""}`}
                            disabled={logClearFlash === "working"}
                            onClick={runLogClear}
                          >
                            {logClearFlash === "working"
                              ? "Borrando…"
                              : logClearFlash === "done"
                                ? "Listo"
                                : "Borrar archivo de log"}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              void api.openLogFile().catch((e) => log(String(e), "err"));
                            }}
                          >
                            Abrir log
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Vista ---- */}
            <div className={`options-panel${optTab === "view" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "view"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.sliders} className="ico ico-sm" />
                      <h2>Interfaz</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow id="opt-load-covers" label="Cargar portada del manga" desc="Descarga portadas; si está apagado solo usa las ya en caché" checked={s.loadCovers} onChange={(v) => update("loadCovers", v)} />
                      <div className="st-row st-row-actions">
                        <div className="st-meta">
                          <div className="st-label">Caché</div>
                          <div className="st-desc">
                            Borra info y portadas guardadas. No afecta favoritos, cola ni catálogo.
                          </div>
                          {cacheClearFlash === "done" ? (
                            <div className="st-inline-ok" role="status">
                              Caché limpiada
                            </div>
                          ) : cacheClearFlash === "error" ? (
                            <div className="st-inline-err" role="status">
                              No se pudo limpiar
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className={`secondary${cacheClearFlash === "done" ? " is-saved" : ""}`}
                          id="opt-clear-cache"
                          disabled={cacheClearFlash === "working"}
                          onClick={runCacheClear}
                        >
                          {cacheClearFlash === "working"
                            ? "Limpiando…"
                            : cacheClearFlash === "done"
                              ? "Listo"
                              : "Limpiar"}
                        </button>
                      </div>
                      <SwitchRow id="opt-notify" label="Globo de notificación" desc="Aviso del sistema al terminar todos los capítulos en cola de un manga" checked={s.notify} onChange={(v) => update("notify", v)} />
                      <SwitchRow id="opt-goto-dl" label="Ir a Descargas al añadir" desc="Cambia a la vista Descargas al crear tareas" checked={s.gotoDl} onChange={(v) => update("gotoDl", v)} />
                      <SwitchRow id="opt-goto-fav" label="Ir a Favoritos al añadir manga" desc="Cambia a Favoritos al guardar un título" checked={s.gotoFav} onChange={(v) => update("gotoFav", v)} />
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Conexiones ---- */}
            <div className={`options-panel${optTab === "connections" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "connections"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.download} className="ico ico-sm" />
                      <h2>Descargas</h2>
                    </div>
                    <div className="st-card">
                      <BoundStepperRow label="Tareas en paralelo" desc="Capítulos descargando a la vez" value={s.parallelTasks} min={1} max={32} onChange={(v) => update("parallelTasks", v)} />
                      <SwitchRow
                        id="opt-one-chapter-per-manga"
                        label="Un capítulo a la vez por obra"
                        desc="No inicia otro capítulo del mismo manga mientras uno está en progreso; otras obras sí usan los slots libres"
                        checked={s.oneChapterPerManga}
                        onChange={(v) => update("oneChapterPerManga", v)}
                      />
                      <OptRow label="Páginas en paralelo" desc="Imágenes bajando a la vez dentro de un capítulo">
                        <div className="st-num-wrap">
                          <Stepper
                            id="set-threads"
                            value={s.threads}
                            min={1}
                            max={32}
                            onChange={(v) => update("threads", v)}
                          />
                        </div>
                      </OptRow>
                      <BoundStepperRow label="Reintentos de tarea" desc="Si la tarea falla, cuántas veces reintentar" value={s.taskRetries} min={0} max={10} onChange={(v) => update("taskRetries", v)} />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.sliders} className="ico ico-sm" />
                      <h2>Misceláneo</h2>
                    </div>
                    <div className="st-card">
                      <BoundStepperRow
                        label="Hilos de actualizar lista"
                        desc="Paralelismo al actualizar el catálogo"
                        value={s.updateListThreads}
                        min={1}
                        max={32}
                        onChange={(v) => update("updateListThreads", v)}
                      />
                      <BoundStepperRow
                        label="Hilos de favoritos"
                        desc="Comprobaciones de favoritos a la vez"
                        value={s.favThreads}
                        min={1}
                        max={32}
                        onChange={(v) => update("favThreads", v)}
                      />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.link} className="ico ico-sm" />
                      <h2>Red</h2>
                    </div>
                    <div className="st-card">
                      <BoundStepperRow label="Timeout" desc="Segundos de espera de conexión" value={s.httpTimeout} min={1} max={300} suffix="s" onChange={(v) => update("httpTimeout", v)} />
                      <BoundStepperRow
                        label="Reintentos de conexión"
                        desc="Reintentos por petición HTTP (0 = no reintentar)"
                        value={s.httpRetries}
                        min={0}
                        max={5}
                        onChange={(v) => update("httpRetries", v)}
                      />
                      <OptRow label="User-Agent" desc="Cabecera HTTP enviada por defecto">
                        <input
                          id="set-ua"
                          className="st-field st-mono st-field-ua"
                          type="text"
                          value={s.ua}
                          placeholder="(por defecto)"
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => update("ua", e.target.value)}
                        />
                      </OptRow>
                      <SwitchRow
                        id="set-use-proxy"
                        label="Usar proxy"
                        desc="Enruta el tráfico HTTP por un proxy"
                        checked={s.useProxy}
                        onChange={(v) => update("useProxy", v)}
                      />
                      <div className="st-nest" hidden={!s.useProxy}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-type">Tipo</label>
                            <div className="st-select st-select-full filter-select-wrap">
                              <select
                                id="set-proxy-type"
                                value={s.proxyType}
                                onChange={(e) => update("proxyType", e.target.value)}
                              >
                                <option value="http">HTTP</option>
                                <option value="socks4">SOCKS4</option>
                                <option value="socks5">SOCKS5</option>
                              </select>
                            </div>
                          </div>
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-host">Host</label>
                            <input
                              id="set-proxy-host"
                              className="st-field st-mono"
                              type="text"
                              placeholder="host o IP"
                              autoComplete="off"
                              spellCheck={false}
                              value={s.proxyHost}
                              onChange={(e) => update("proxyHost", e.target.value)}
                            />
                          </div>
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-port">Puerto</label>
                            <div>
                              <Stepper
                                id="set-proxy-port"
                                value={s.proxyPort}
                                min={1}
                                max={65535}
                                wide
                                onChange={(v) => update("proxyPort", v)}
                              />
                            </div>
                          </div>
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-user">Usuario</label>
                            <input
                              id="set-proxy-user"
                              className="st-field st-mono"
                              type="text"
                              placeholder="opcional"
                              autoComplete="off"
                              spellCheck={false}
                              value={s.proxyUser}
                              onChange={(e) => update("proxyUser", e.target.value)}
                            />
                          </div>
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-pass">Contraseña</label>
                            <input
                              id="set-proxy-pass"
                              className="st-field st-mono"
                              type="password"
                              placeholder="opcional"
                              autoComplete="off"
                              value={s.proxyPass}
                              onChange={(e) => update("proxyPass", e.target.value)}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Guardar en ---- */}
            <div className={`options-panel${optTab === "saveto" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "saveto"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.folder} className="ico ico-sm" />
                      <h2>Destino</h2>
                    </div>
                    <div className="st-card">
                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">Ruta de descarga por defecto</div>
                          <div className="st-desc">Carpeta raíz donde se guardan los capítulos</div>
                        </div>
                        <div className="path-field path-field-exam">
                          <input
                            id="set-output-dir"
                            type="text"
                            readOnly
                            placeholder="Sin carpeta de salida"
                            autoComplete="off"
                            value={s.outputDirField}
                          />
                          <button
                            type="button"
                            className="path-browse path-browse-label"
                            id="set-output-browse"
                            title="Examinar…"
                            onClick={() => void handleBrowseOutputDir()}
                          >
                            <Icon ico={ICO.folder} className="ico ico-sm" />
                            Examinar
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.file} className="ico ico-sm" />
                      <h2>Formato de salida</h2>
                    </div>
                    <div className="st-card">
                      <div className="st-row">
                        <div className="st-meta">
                          <div className="st-label">Guardar capítulos como</div>
                          <div className="st-desc">Contenedor del capítulo descargado</div>
                        </div>
                        <div className="st-seg" id="set-pack" role="radiogroup" aria-label="Guardar capítulos como">
                          {PACK_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              className={`st-seg-opt${s.packFormat === opt.value ? " on" : ""}`}
                              aria-pressed={s.packFormat === opt.value}
                              onClick={() => update("packFormat", opt.value)}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <SwitchRow
                        id="set-pack-delete"
                        label="Borrar carpeta tras empaquetar"
                        desc="Elimina la carpeta de imágenes al crear el archivo"
                        checked={s.packDelete}
                        onChange={(v) => update("packDelete", v)}
                      />
                      <div className="st-row" id="set-pdf-quality-row" hidden={s.packFormat !== "pdf"}>
                        <div className="st-meta">
                          <div className="st-label">Calidad del PDF</div>
                          <div className="st-desc">
                            Las imágenes que ya estén en esta calidad o por debajo se
                            incluyen sin recomprimir; solo se recomprimen las que la superan
                          </div>
                        </div>
                        <div className="st-num-wrap">
                          <Stepper
                            id="set-pdf-quality"
                            value={s.pdfQuality}
                            min={1}
                            max={100}
                            suffix="%"
                            onChange={(v) => update("pdfQuality", v)}
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.image} className="ico ico-sm" />
                      <h2>Conversión de imagen</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="set-png-as-jpeg"
                        label="Guardar PNG como JPEG"
                        desc="Reduce mucho el peso; pierde la transparencia"
                        checked={s.pngAsJpeg}
                        onChange={(v) => update("pngAsJpeg", v)}
                      />
                      <SelectRow
                        id="set-webp-as"
                        label="Guardar WebP como"
                        desc="Formato al convertir imágenes WebP"
                        value={s.webpAs}
                        onChange={(v) => update("webpAs", v)}
                        options={[
                          { value: "0", label: "WebP" },
                          { value: "1", label: "PNG" },
                          { value: "2", label: "JPEG" },
                        ]}
                      />
                      <SelectRow
                        id="set-png-level"
                        label="Compresión PNG"
                        desc="Más compresión, guardado más lento"
                        value={s.pngLevel}
                        onChange={(v) => update("pngLevel", v)}
                        options={[
                          { value: "0", label: "Ninguno" },
                          { value: "1", label: "El más rápido" },
                          { value: "2", label: "Predeterminado" },
                          { value: "3", label: "Máximo" },
                        ]}
                      />
                      <BoundStepperRow
                        id="set-jpeg-quality"
                        label="Calidad JPEG"
                        desc="Aplica a las imágenes convertidas a JPEG"
                        value={s.jpegQuality}
                        min={1}
                        max={100}
                        suffix="%"
                        onChange={(v) => update("jpegQuality", v)}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.file} className="ico ico-sm" />
                      <h2>Renombrado</h2>
                    </div>
                    <div className="st-card">
                      <SelectRow
                        id="set-rename-preset"
                        label="Estructura"
                        desc="Atajo: rellena los patrones de abajo, que siguen siendo editables"
                        value={renamePreset}
                        onChange={applyRenamePreset}
                        options={[
                          ...availablePresets.map((p) => ({ value: p.id, label: p.label })),
                          /* "Personalizado" es un estado, no un atajo: solo se lista
                             cuando ya lo estás, para que no haya opción que no haga nada. */
                          ...(renamePreset === RENAME_PRESET_CUSTOM
                            ? [{ value: RENAME_PRESET_CUSTOM, label: "Personalizado" }]
                            : []),
                        ]}
                      />
                      {/* Junto al preset: al elegir uno, el resultado se ve sin bajar. */}
                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">Resultado</div>
                          <div className="st-desc">
                            Ejemplo con datos de muestra; refleja tus ajustes actuales
                          </div>
                        </div>
                        <div id="set-rename-preview" className="st-preview" aria-live="polite">
                          {renamePreview}
                        </div>
                      </div>
                      <SwitchRow
                        id="set-manga-folder"
                        label="Carpeta por manga"
                        desc="Crea una carpeta con el nombre del manga"
                        checked={s.mangaFolderOn}
                        onChange={(v) => update("mangaFolderOn", v)}
                      />
                      <div className="st-row st-row-stack" hidden={!s.mangaFolderOn}>
                        <div className="st-meta">
                          <div className="st-label">Patrón de la carpeta</div>
                          <div className="st-desc">
                            Nombre de la carpeta del manga. No admite «\» ni «/»: se eliminan
                          </div>
                        </div>
                        <div className="st-field-wrap">
                          <input
                            ref={patMangaRef}
                            id="set-pat-manga"
                            className="st-field st-mono"
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={s.patManga}
                            onChange={(e) => update("patManga", e.target.value)}
                          />
                          <button
                            type="button"
                            className="sites-clear"
                            hidden={!s.patManga}
                            title="Limpiar"
                            onClick={() => {
                              update("patManga", "");
                              patMangaRef.current?.focus();
                            }}
                          >
                            <Icon ico={ICO.x} className="ico ico-sm" />
                          </button>
                        </div>
                        <TokenInsert tokens={TOKENS_MANGA} onInsert={(t) => insertTokenInto(patMangaRef, "patManga", t)} />
                        {mangaPatHint ? (
                          <div className="st-pat-hint">
                            {mangaPatHint}
                          </div>
                        ) : null}
                      </div>

                      <SwitchRow
                        id="set-chapter-folder"
                        label="Carpeta por capítulo"
                        desc={
                          packing
                            ? "Al empaquetar debe estar activa: su nombre es el del archivo, y al terminar solo queda ese archivo"
                            : "Cada capítulo en su propia subcarpeta"
                        }
                        checked={s.chapterFolderOn}
                        onChange={(v) => update("chapterFolderOn", v)}
                      />
                      <div className="st-row st-row-stack" hidden={!s.chapterFolderOn}>
                        <div className="st-meta">
                          <div className="st-label">Patrón del capítulo</div>
                          <div className="st-desc">
                            {packing
                              ? "Nombre de la carpeta y, por tanto, del archivo empaquetado"
                              : "Nombre de la carpeta del capítulo"}
                          </div>
                        </div>
                        <div className="st-field-wrap">
                          <input
                            ref={patChapterRef}
                            id="set-pat-chapter"
                            className="st-field st-mono"
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={s.patChapter}
                            onChange={(e) => update("patChapter", e.target.value)}
                          />
                          <button
                            type="button"
                            className="sites-clear"
                            hidden={!s.patChapter}
                            title="Limpiar"
                            onClick={() => {
                              update("patChapter", "");
                              patChapterRef.current?.focus();
                            }}
                          >
                            <Icon ico={ICO.x} className="ico ico-sm" />
                          </button>
                        </div>
                        <TokenInsert tokens={TOKENS_CHAPTER} onInsert={(t) => insertTokenInto(patChapterRef, "patChapter", t)} />
                        {chapterPatHint ? (
                          <div className="st-pat-hint">
                            {chapterPatHint}
                          </div>
                        ) : null}
                      </div>

                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">Nombre de las páginas</div>
                          <div className="st-desc">
                            {packing
                              ? "Nombre de cada imagen dentro del archivo empaquetado"
                              : "Nombre de cada imagen descargada"}
                          </div>
                        </div>
                        <div className="st-field-wrap">
                          <input
                            ref={patPageRef}
                            id="set-pat-page"
                            className="st-field st-mono"
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={s.patPage}
                            onChange={(e) => update("patPage", e.target.value)}
                          />
                          <button
                            type="button"
                            className="sites-clear"
                            hidden={!s.patPage}
                            title="Limpiar"
                            onClick={() => {
                              update("patPage", "");
                              patPageRef.current?.focus();
                            }}
                          >
                            <Icon ico={ICO.x} className="ico ico-sm" />
                          </button>
                        </div>
                        <TokenInsert tokens={TOKENS_PAGE} onInsert={(t) => insertTokenInto(patPageRef, "patPage", t)} />
                        {pagePatHint ? (
                          <div className="st-pat-hint">
                            {pagePatHint}
                          </div>
                        ) : null}
                      </div>

                      <SwitchRow
                        id="set-remove-manga-name"
                        label="Quitar el nombre del manga del capítulo"
                        desc="Evita repetir el título en cada capítulo"
                        checked={s.removeMangaFromChapter}
                        onChange={(v) => update("removeMangaFromChapter", v)}
                      />

                      <SwitchRow
                        id="set-vol-pad"
                        label="Rellenar el volumen con ceros"
                        desc="Vol.2 se convierte en Vol.02, solo si el título trae «Vol»"
                        checked={s.volPadOn}
                        onChange={(v) => update("volPadOn", v)}
                      />
                      <div className="st-nest" hidden={!s.volPadOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-vol-digits">Dígitos</label>
                            <Stepper id="set-vol-digits" value={s.volDigits} min={1} max={4} onChange={(v) => update("volDigits", v)} />
                          </div>
                        </div>
                      </div>

                      <SwitchRow
                        id="set-chap-pad"
                        label="Rellenar el capítulo con ceros"
                        desc="3 se convierte en 003; también fija los dígitos de %NUMBERING%"
                        checked={s.chapPadOn}
                        onChange={(v) => update("chapPadOn", v)}
                      />
                      <div className="st-nest" hidden={!s.chapPadOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-chap-digits">Dígitos</label>
                            <Stepper id="set-chap-digits" value={s.chapDigits} min={1} max={5} onChange={(v) => update("chapDigits", v)} />
                          </div>
                        </div>
                      </div>

                      <SwitchRow
                        id="set-replace-ascii"
                        label="Reemplazar caracteres no ASCII"
                        desc="Solo en los nombres generados; la carpeta de «Guardar en» no se toca"
                        checked={s.asciiOn}
                        onChange={(v) => update("asciiOn", v)}
                      />
                      <div className="st-nest" hidden={!s.asciiOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row st-nest-row-compact">
                            <label htmlFor="set-replace-ascii-char">Reemplazar por</label>
                            <input
                              id="set-replace-ascii-char"
                              className="st-field st-char"
                              type="text"
                              maxLength={4}
                              placeholder="_"
                              autoComplete="off"
                              spellCheck={false}
                              value={s.asciiChar}
                              onChange={(e) => update("asciiChar", e.target.value)}
                            />
                          </div>
                        </div>
                      </div>

                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Actualizaciones ---- */}
            <div className={`options-panel${optTab === "updates" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "updates"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.refresh} className="ico ico-sm" />
                      <h2>Actualizaciones</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        label="Comprobar versión al iniciar"
                        desc="Busca actualizaciones de la app"
                        checked={s.checkUpdateStart}
                        onChange={(v) => update("checkUpdateStart", v)}
                      />
                      <SwitchRow
                        label="No cargar info al actualizar lista"
                        desc="Más rápido; el filtro avanzado no funcionará"
                        checked={s.updateListNoInfo}
                        onChange={(v) => update("updateListNoInfo", v)}
                      />
                      <SwitchRow
                        label="Escanear directorio completo"
                        desc="Recorre todas las páginas, no solo las más recientes"
                        checked={s.updateListFullScan}
                        onChange={(v) => {
                          if (!v) {
                            update("updateListFullScan", false);
                            return;
                          }
                          void (async () => {
                            const ok = await appConfirm({
                              title: "Escanear directorio completo",
                              message:
                                "Al actualizar la lista se recorrerán todas las páginas del sitio, no solo las más recientes.\n\nEso suele tardar bastante más y, en la mayoría de los casos, no hace falta: el modo normal ya encuentra los títulos nuevos.\n\nÚsalo solo si sospechas huecos en el catálogo o quieres un barrido a fondo.\n\n¿Activar el escaneo completo?",
                              okLabel: "Activar",
                              cancelLabel: "Cancelar",
                            });
                            if (ok) update("updateListFullScan", true);
                          })();
                        }}
                      />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.heart} className="ico ico-sm" />
                      <h2>Favoritos</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        label="Comprobar al iniciar"
                        desc="Busca capítulos nuevos al arrancar"
                        checked={s.favCheckOnStart}
                        onChange={(v) => update("favCheckOnStart", v)}
                      />
                      <SwitchRow
                        id="set-fav-interval"
                        label="Comprobar en intervalo"
                        desc="Revisa favoritos periódicamente"
                        checked={s.favIntervalOn}
                        onChange={(v) => update("favIntervalOn", v)}
                      />
                      <div className="st-nest" hidden={!s.favIntervalOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-fav-interval-min">Intervalo</label>
                            <div className="st-inline-end">
                              <Stepper
                                id="set-fav-interval-min"
                                value={s.favIntervalMin}
                                min={60}
                                max={1440}
                                wide
                                onChange={(v) => update("favIntervalMin", v)}
                              />
                              <span className="st-unit">min</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <SwitchRow
                        label="Descargar tras comprobar"
                        desc="Encola capítulos nuevos automáticamente"
                        checked={s.favDownloadAfter}
                        onChange={(v) => update("favDownloadAfter", v)}
                      />
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Diálogos ---- */}
            <div className={`options-panel${optTab === "dialogs" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "dialogs"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.message} className="ico ico-sm" />
                      <h2>Confirmaciones</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-confirm-exit"
                        label="Salir"
                        desc="Pedir confirmación antes de cerrar"
                        checked={s.confirmExit}
                        onChange={(v) => update("confirmExit", v)}
                      />
                      <SwitchRow
                        id="opt-confirm-delete"
                        label="Borrar descarga / manga / favorito"
                        desc="Confirmar eliminaciones"
                        checked={s.confirmDelete}
                        onChange={(v) => update("confirmDelete", v)}
                      />
                      <SwitchRow
                        id="opt-confirm-empty"
                        label="Descargar lista si está vacía"
                        desc="Preguntar antes de Update List"
                        checked={s.confirmEmptyList}
                        onChange={(v) => update("confirmEmptyList", v)}
                      />
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Sitios Web ---- */}
            <div className={`options-panel${optTab === "websites" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "websites"}>
              <div className="sites-tabs" role="tablist" aria-label="Sitios Web">
                <button
                  type="button"
                  className={`sites-tab${sitesTab === "list" ? " on" : ""}`}
                  role="tab"
                  aria-selected={sitesTab === "list"}
                  onClick={() => setSitesTab("list")}
                >
                  Sitios Web
                </button>
                <button
                  type="button"
                  className={`sites-tab${sitesTab === "mods" ? " on" : ""}`}
                  role="tab"
                  aria-selected={sitesTab === "mods"}
                  onClick={() => setSitesTab("mods")}
                >
                  Módulos
                </button>
              </div>

              <div className="sites-pane" hidden={sitesTab !== "list"}>
                <div className="sites-toolbar">
                  <div className="sites-search-wrap">
                    <Icon ico={ICO.search} className="ico ico-sm sites-search-ico" />
                    <input
                      id="sites-q"
                      className="st-field"
                      type="text"
                      placeholder="Buscar sitio web..."
                      autoComplete="off"
                      spellCheck={false}
                      value={sitesQuery}
                      onChange={(e) => setSitesQuery(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sites-clear"
                      hidden={!sitesQuery.trim()}
                      title="Limpiar"
                      onClick={() => setSitesQuery("")}
                    >
                      <Icon ico={ICO.x} className="ico ico-sm" />
                    </button>
                  </div>
                  <div className="sites-toolbar-spacer" />
                  <div className="sites-toolbar-actions">
                    <button type="button" className="sites-tbtn" onClick={() => setSitesOn(allSiteIds, true)}>
                      <Icon ico={ICO.check} className="ico ico-sm" />
                      Seleccionar todo
                    </button>
                    <button type="button" className="sites-tbtn" onClick={() => setSitesOn(allSiteIds, false)}>
                      <Icon ico={ICO.x} className="ico ico-sm" />
                      Deseleccionar todo
                    </button>
                    <button type="button" className="sites-tbtn" onClick={handleSitesExpandAll}>
                      <Icon ico={ICO.plus} className="ico ico-sm" />
                      Expandir todo
                    </button>
                    <button type="button" className="sites-tbtn" onClick={handleSitesCollapseAll}>
                      <Icon ico={ICO.minus} className="ico ico-sm" />
                      Contraer todo
                    </button>
                  </div>
                </div>

                <div className="sites-tree" id="sites-tree" role="tree" ref={sitesTreeRef} onScroll={onSitesScroll}>
                  {modules.length === 0 ? (
                    <div className="sites-tree-empty">
                      <div className="sites-empty-title">Sin módulos</div>
                      <div className="sites-empty-desc">
                        Aún no se cargaron módulos de <code>lua/modules</code>.
                      </div>
                    </div>
                  ) : sitesFlat.length === 0 ? (
                    <div className="sites-tree-empty">
                      <div className="sites-empty-title">Sin coincidencias</div>
                      <div className="sites-empty-desc">Ningún sitio coincide con "{sitesQuery}".</div>
                    </div>
                  ) : (
                    <div className="sites-virtual" style={{ height: sitesFlat.length * SITE_ROW_H }}>
                      {sitesFlat.slice(sitesRange.start, sitesRange.end).map((row, i) => {
                        const idx = sitesRange.start + i;
                        const top = idx * SITE_ROW_H;
                        if (row.kind === "group") {
                          const cbCls = row.onCount === 0 ? "" : row.onCount === row.total ? "on" : "some";
                          const summary =
                            row.onCount === row.total
                              ? "Todos activos"
                              : row.onCount === 0
                                ? "Ninguno"
                                : `${row.onCount} de ${row.total} activos`;
                          return (
                            <div
                              key={row.key}
                              className="sites-trow sites-trow-group"
                              style={{ top, background: "var(--card)" }}
                              onClick={() => toggleGroupExpand(row.groupId)}
                            >
                              <button
                                type="button"
                                className="sites-tw"
                                aria-label="Expandir o contraer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleGroupExpand(row.groupId);
                                }}
                              >
                                <Icon
                                  ico={ICO.chevron}
                                  className="ico ico-sm"
                                  style={{ transform: row.open ? "rotate(0deg)" : "rotate(-90deg)" }}
                                />
                              </button>
                              <button
                                type="button"
                                className={`sites-cb${cbCls ? ` ${cbCls}` : ""}`}
                                style={{ ["--ico" as string]: cbCls === "some" ? ICO.dash : ICO.check }}
                                aria-label="Activar grupo"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const g = siteGroups.find((x) => x.id === row.groupId);
                                  if (!g) return;
                                  const ids = g.sites.map((st) => st.id);
                                  setSitesOn(ids, row.onCount !== g.sites.length);
                                }}
                              >
                                <span className="sites-cb-mk" />
                              </button>
                              <span className="sites-group-label">{row.label}</span>
                              <span className="sites-group-count">({row.total})</span>
                              <div className="sites-row-spacer" />
                              <span className="sites-group-summary">{summary}</span>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={row.key}
                            className={`sites-trow sites-trow-site${row.on ? " is-on" : ""}`}
                            style={{ top }}
                            role="checkbox"
                            aria-checked={row.on}
                            tabIndex={0}
                            onClick={() => setSitesOn([row.id], !row.on)}
                            onKeyDown={(e) => {
                              if (e.key === " " || e.key === "Enter") {
                                e.preventDefault();
                                setSitesOn([row.id], !row.on);
                              }
                            }}
                          >
                            <button
                              type="button"
                              className={`sites-cb${row.on ? " on" : ""}`}
                              style={{ ["--ico" as string]: ICO.check }}
                              aria-label="Activar sitio"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSitesOn([row.id], !row.on);
                              }}
                            >
                              <span className="sites-cb-mk" />
                            </button>
                            <span className="sites-site-label">{row.name}</span>
                            <div className="sites-row-spacer" />
                            <span className="sites-site-domain">{row.domain}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="sites-footer">
                  <Icon ico={ICO.globe} className="ico ico-sm" />
                  <span id="sites-active-label">
                    {sitesTotalOn} de {sitesTotal} sitios activos
                  </span>
                  <div className="sites-footer-spacer" />
                  <button type="button" className="lnk" onClick={() => setSitesOnlyActive((v) => !v)}>
                    {sitesOnlyActive ? "Mostrar todos" : "Mostrar solo activos"}
                  </button>
                </div>
              </div>

              <div className="sites-pane" hidden={sitesTab !== "mods"}>
                <div className="mods-toolbar">
                  <button type="button" className="mods-btn-p" onClick={() => void runModulesCheck()}>
                    <Icon
                      ico={ICO.refresh}
                      className="ico ico-sm"
                      style={{ transform: modsChecking ? "rotate(180deg)" : "none" }}
                    />
                    <span>{modsChecking ? "Revisando..." : "Revisar actualización"}</span>
                  </button>
                  <div className="mods-checks">
                    <button
                      type="button"
                      className="mods-chk"
                      aria-pressed={modsWarn}
                      onClick={() => {
                        setModsWarn((v) => !v);
                        setDirty(true);
                      }}
                    >
                      <span className={`sites-cb${modsWarn ? " on" : ""}`} style={{ ["--ico" as string]: ICO.check }}>
                        <span className="sites-cb-mk" />
                      </span>
                      Mostrar advertencia de actualización
                    </button>
                    <button
                      type="button"
                      className="mods-chk"
                      aria-pressed={modsAutoRestart}
                      onClick={() => {
                        setModsAutoRestart((v) => !v);
                        setDirty(true);
                      }}
                    >
                      <span className={`sites-cb${modsAutoRestart ? " on" : ""}`} style={{ ["--ico" as string]: ICO.check }}>
                        <span className="sites-cb-mk" />
                      </span>
                      Auto reinicio
                    </button>
                  </div>
                  <div className="sites-toolbar-spacer" />
                  <div className="sites-search-wrap mods-search-wrap">
                    <Icon ico={ICO.search} className="ico ico-sm sites-search-ico" />
                    <input
                      id="mods-q"
                      className="st-field"
                      type="text"
                      placeholder="Buscar módulo..."
                      autoComplete="off"
                      spellCheck={false}
                      value={modsQuery}
                      onChange={(e) => setModsQuery(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sites-clear"
                      hidden={!modsQuery.trim()}
                      title="Limpiar"
                      onClick={() => setModsQuery("")}
                    >
                      <Icon ico={ICO.x} className="ico ico-sm" />
                    </button>
                  </div>
                </div>

                <div className="mods-list-wrap">
                  <div className="mods-head">
                    <span>Nombre del archivo (modules/)</span>
                    <span>Última modificación</span>
                    <span>Último mensaje</span>
                  </div>
                  <div className="mods-list" id="mods-list" ref={modsListRef} onScroll={onModsScroll}>
                    {modRows.length === 0 ? (
                      <div className="sites-tree-empty">
                        <div className="sites-empty-title">Sin módulos</div>
                        <div className="sites-empty-desc">
                          No hay archivos en <code>lua/modules</code>.
                        </div>
                      </div>
                    ) : modsFlat.length === 0 ? (
                      <div className="sites-tree-empty">
                        <div className="sites-empty-title">Sin coincidencias</div>
                        <div className="sites-empty-desc">Ningún módulo coincide con la búsqueda.</div>
                      </div>
                    ) : (
                      <div className="mods-virtual" style={{ height: modsFlat.length * MOD_ROW_H }}>
                        {modsFlat.slice(modsRange.start, modsRange.end).map((row, i) => {
                          const idx = modsRange.start + i;
                          const top = idx * MOD_ROW_H;
                          return (
                            <div key={row.key} className={`mods-row${row.updated ? " updated" : ""}`} style={{ top }}>
                              <div className="mods-name">
                                <Icon ico={ICO.file} className="ico ico-sm" style={{ color: "var(--muted)" }} />
                                <span className="ell mods-file">{row.file}</span>
                                {row.updated ? <span className="mods-new">Nuevo</span> : null}
                              </div>
                              <span className="mods-when" title={row.dateTitle}>
                                {row.when}
                              </span>
                              <span className={`ell mods-msg${row.msg === "—" ? " muted" : ""}`}>{row.msg}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="sites-footer">
                  <Icon ico={ICO.terminal} className="ico ico-sm" />
                  <span id="mods-summary">
                    {modRows.length} módulos · {modsUpdatedCount} actualizados recientemente
                  </span>
                  <div className="sites-footer-spacer" />
                  <button type="button" className="lnk" onClick={() => setModsOnlyUpdated((v) => !v)}>
                    {modsOnlyUpdated ? "Mostrar todos" : "Mostrar solo actualizados"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="options-footer">
          {saveFlash === "saved" ? (
            <span className="options-saved" id="opt-saved" role="status">
              <Icon ico={ICO.check} className="ico ico-sm" />
              Guardado
            </span>
          ) : saveFlash === "error" ? (
            <span className="options-save-err" id="opt-save-err" role="status">
              Error al guardar
            </span>
          ) : dirty ? (
            <span className="options-dirty" id="opt-dirty">
              Cambios sin guardar
            </span>
          ) : (
            <span className="options-dirty" id="opt-dirty" hidden />
          )}
          <div className="options-footer-spacer" />
          <button
            type="button"
            className="secondary"
            id="set-cancel"
            disabled={saveFlash === "saving"}
            onClick={() => {
              clearSaveFlash();
              void loadSettings();
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            className={`btn${saveFlash === "saved" ? " is-saved" : ""}`}
            id="set-save"
            disabled={saveFlash === "saving"}
            onClick={() => void handleSave()}
          >
            {saveFlash === "saving" ? "Guardando…" : saveFlash === "saved" ? "Guardado" : "Aplicar"}
          </button>
        </footer>
      </div>
    </section>
  );
}
