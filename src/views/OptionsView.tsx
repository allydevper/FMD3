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
import { VirtualList } from "../components/VirtualList";
import { ICO } from "../icons";
import { DEFAULT_USER_AGENT, PACK_EXT, SK } from "../constants";
import * as api from "../api/tauri";
import { useApp, type AppTheme } from "../context/AppContext";
import { formatMb, localeTag, parseLanguage, t, useLanguage, type AppLanguage } from "../i18n";
import type { HiddenEntry, LuaFileVersion, LuaRepoEntry } from "../types";
import { runModulesGithubUpdate, summarizeCheck } from "../utils/modulesUpdate";

/* ---------------------------------------------------------------------- */
/* Tipos y constantes                                                      */
/* ---------------------------------------------------------------------- */

type OptTabId =
  | "general"
  | "view"
  | "downloads"
  | "network"
  | "saveto"
  | "updates"
  | "hidden"
  | "websites";
type SitesTabId = "list" | "mods";

const OPTIONS_CATS: { id: OptTabId; icon: string }[] = [
  { id: "general", icon: ICO.settings },
  { id: "view", icon: ICO.layout },
  { id: "downloads", icon: ICO.download },
  { id: "network", icon: ICO.link },
  { id: "saveto", icon: ICO.folder },
  { id: "updates", icon: ICO.refresh },
  { id: "hidden", icon: ICO.trash },
  { id: "websites", icon: ICO.globe },
];

/** Papelera: tamaño de página del backend y alto de fila (lista virtual). */
const HIDDEN_PAGE = 200;
const HIDDEN_ROW_H = 48;

const PACK_FORMATS = ["none", "zip", "cbz", "pdf", "epub"] as const;

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
const RENAME_PRESETS: { id: string; shape: RenameShape }[] = [
  {
    id: "manga-chapter-page",
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
    shape: {
      mangaFolderOn: true,
      chapterFolderOn: false,
      patManga: "%MANGA%",
      patChapter: "%CHAPTER%",
      patPage: "%CHAPTER%_%FILENAME%",
    },
  },
];

function packOptions(): { value: (typeof PACK_FORMATS)[number]; label: string }[] {
  return [
    { value: "none", label: t("options.packNone") },
    { value: "zip", label: "ZIP" },
    { value: "cbz", label: "CBZ" },
    { value: "pdf", label: "PDF" },
    { value: "epub", label: "EPUB" },
  ];
}

const RENAME_PRESET_CUSTOM = "custom";

function renamePresetLabel(id: string): string {
  if (id === RENAME_PRESET_CUSTOM) return t("common.custom");
  return t(`options.renamePreset.${id}`);
}

const SITE_ROW_H = 31;
const SITE_OVERSCAN = 10;
const MOD_ROW_H = 32;
const MOD_OVERSCAN = 10;

type OptionsFormState = {
  ua: string;
  cfInternalBrowser: boolean;
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
  language: AppLanguage;
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
  cfInternalBrowser: false,
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
  language: "es",
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
  /** Highlight: new or update from GitHub sync flags. */
  updated: boolean;
  badge: string | null;
  /** Excluded from the official sync; the row shows where it came from. */
  pinned: boolean;
  pinOrigin: string | null;
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
    return t("options.patNeedManga");
  }
  if (
    kind === "chapter" &&
    !upper.includes("%CHAPTER%") &&
    !upper.includes("%NUMBERING%") &&
    !upper.includes("%CHAPTERINDEX%")
  ) {
    return t("options.patNeedChapter");
  }
  if (kind === "page" && !upper.includes("%FILENAME%")) {
    return t("options.patNeedFile");
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

function repoEntryToRow(e: LuaRepoEntry): ModRow {
  const flag = (e.flag || "none").toLowerCase();
  const mtime = e.last_modified ?? null;
  const { when, title } = relDateFromUnix(mtime);
  const msg = (e.last_message || "").trim() || "—";
  let badge: string | null = null;
  let updated = false;
  if (e.pin) {
    // A pin outranks every other state: this file is the user's, full stop.
    return {
      key: e.name,
      file: e.name,
      mtime,
      when,
      dateTitle: title,
      msg: e.pin.origin,
      updated: false,
      badge: t("options.badgeMine"),
      pinned: true,
      pinOrigin: e.pin.origin,
    };
  }
  if (flag === "new") {
    badge = t("options.badgeNew");
    updated = true;
  } else if (flag === "update") {
    badge = t("options.badgeUpdate");
    updated = true;
  } else if (flag === "failed") {
    badge = t("options.badgeFail");
    updated = true;
  } else if (flag === "delete") {
    badge = t("options.badgeDelete");
    updated = true;
  }
  return {
    key: e.name,
    file: e.name,
    mtime,
    when,
    dateTitle: title,
    msg,
    updated,
    badge,
    pinned: false,
    pinOrigin: null,
  };
}

function relDateFromUnix(sec: number | null | undefined): { when: string; title: string } {
  if (sec == null || !Number.isFinite(sec)) return { when: t("common.dash"), title: "" };
  const d = new Date(sec * 1000);
  const title = d.toLocaleString(localeTag());
  const days = Math.round((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return { when: t("options.relToday"), title };
  if (days === 1) return { when: t("options.relYesterday"), title };
  if (days < 30) return { when: t("options.relDays", { n: days }), title };
  if (days < 365) return { when: t("options.relMonths", { n: Math.round(days / 30) }), title };
  return { when: t("options.relYears", { n: (days / 365).toFixed(1) }), title };
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
      title={title ?? (status === "none" ? t("options.stubNone") : status === "partial" ? t("options.stubPartial") : undefined)}
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
      <button type="button" className="st-stepper-btn" aria-label={t("common.less")} onClick={() => onChange(clampNum(value - 1, min, max))}>
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
      <button type="button" className="st-stepper-btn" aria-label={t("common.more")} onClick={() => onChange(clampNum(value + 1, min, max))}>
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
      title={title ?? (status === "none" ? t("options.stubNone") : status === "partial" ? t("options.stubPartial") : undefined)}
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
      <span className="st-token-insert-label">{t("options.insert")}</span>
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
  const {
    activeNav,
    log,
    outputDir,
    setOutputDir,
    modules,
    refreshModules,
    setTheme,
    setLanguage,
    refreshEnabledModules,
    enabledModuleIds,
    setFavAutoCheck,
    notifyCatalogChanged,
    modulesPending,
    setModulesPending,
    modulesJob,
    pendingOptionsTab,
    clearPendingOptionsTab,
  } = useApp();
  useLanguage();

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
  const [modsWarn, setModsWarn] = useState(true);
  const [modsFetchMeta, setModsFetchMeta] = useState(true);
  const [modsPreferLocal, setModsPreferLocal] = useState(true);
  const [modsOverlay, setModsOverlay] = useState(true);
  const [modsOverlayOwner, setModsOverlayOwner] = useState("allydevper");
  const [modsOverlayName, setModsOverlayName] = useState("FMD3");
  const [modsOverlayRef, setModsOverlayRef] = useState("master");
  const [modsBackupGens, setModsBackupGens] = useState(3);
  const [modsBackupMb, setModsBackupMb] = useState(64);
  const [modsBackupBytes, setModsBackupBytes] = useState(0);
  const [modsBackupFlash, setModsBackupFlash] = useState<
    "idle" | "working" | "done" | "error"
  >("idle");

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
        log(t("options.logDeleted"), "ok");
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
        title: t("options.cache.title"),
        message: t("options.cache.message"),
        okLabel: t("options.cache.button"),
        cancelLabel: t("common.cancel"),
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
    const cfInternalBrowser = parseB(await get(SK.CF_INTERNAL_BROWSER), false);
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
    const language = parseLanguage(await get(SK.LANG));
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
    setModsWarn(parseB(await get(SK.MODULES_UPDATER_SHOW_WARNING), true));
    const parseN = (raw: string | null, fallback: number) => {
      const n = Number((raw ?? "").trim());
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    setModsFetchMeta(parseB(await get(SK.MODULES_FETCH_METADATA), true));
    setModsPreferLocal(parseB(await get(SK.MODULES_PREFER_LOCAL_NEWER), true));
    setModsOverlay(parseB(await get(SK.MODULES_OVERLAY_ENABLED), true));
    setModsOverlayOwner((await get(SK.MODULES_OVERLAY_OWNER)) || "allydevper");
    setModsOverlayName((await get(SK.MODULES_OVERLAY_NAME)) || "FMD3");
    setModsOverlayRef((await get(SK.MODULES_OVERLAY_REF)) || "master");
    setModsBackupGens(parseN(await get(SK.MODULES_BACKUP_GENERATIONS), 3));
    setModsBackupMb(parseN(await get(SK.MODULES_BACKUP_MAX_MB), 64));
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
      cfInternalBrowser,
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
      language,
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

  // Keep checkbox list in sync when Info auto-enables a site from a pasted URL.
  useEffect(() => {
    if (dirty) return;
    setSiteOn(() => {
      const next: Record<string, true> = {};
      for (const id of enabledModuleIds) next[id] = true;
      return next;
    });
    enabledIdsRef.current = new Set(enabledModuleIds);
  }, [enabledModuleIds, dirty]);

  const handleSave = useCallback(async () => {
    if (saveFlash === "saving") return;
    setSaveFlash("saving");
    try {
    const uaVal = s.ua.trim();
    await api.settingsSet(SK.UA, uaVal === DEFAULT_USER_AGENT ? "" : uaVal);
    await api.settingsSet(SK.CF_INTERNAL_BROWSER, boolStr(s.cfInternalBrowser));
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
    await api.settingsSet(SK.LANG, s.language);
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
    await api.settingsSet(SK.MODULES_UPDATER_SHOW_WARNING, boolStr(modsWarn));
    await api.settingsSet(SK.MODULES_FETCH_METADATA, boolStr(modsFetchMeta));
    await api.settingsSet(SK.MODULES_PREFER_LOCAL_NEWER, boolStr(modsPreferLocal));
    await api.settingsSet(SK.MODULES_OVERLAY_ENABLED, boolStr(modsOverlay));
    await api.settingsSet(SK.MODULES_OVERLAY_OWNER, modsOverlayOwner.trim() || "allydevper");
    await api.settingsSet(SK.MODULES_OVERLAY_NAME, modsOverlayName.trim() || "FMD3");
    await api.settingsSet(SK.MODULES_OVERLAY_REF, modsOverlayRef.trim() || "master");
    await api.settingsSet(SK.MODULES_BACKUP_GENERATIONS, String(modsBackupGens));
    await api.settingsSet(SK.MODULES_BACKUP_MAX_MB, String(modsBackupMb));
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
    setLanguage(s.language);
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
        ? enabled.length === 1
          ? t("options.savedSites.one")
          : t("options.savedSites.other", { n: enabled.length })
        : t("options.savedSites.none"),
      "ok",
    );
    } catch (e) {
      setSaveFlash("error");
      if (saveFlashTimerRef.current != null) window.clearTimeout(saveFlashTimerRef.current);
      saveFlashTimerRef.current = window.setTimeout(() => {
        setSaveFlash("idle");
        saveFlashTimerRef.current = undefined;
      }, 2800);
      log(t("options.saveFailed", { err: String(e) }), "err");
    }
  }, [
    s,
    setOutputDir,
    log,
    modules,
    siteOn,
    setTheme,
    setLanguage,
    refreshEnabledModules,
    setFavAutoCheck,
    saveFlash,
    modsWarn,
    modsFetchMeta,
    modsPreferLocal,
    modsOverlay,
    modsOverlayOwner,
    modsOverlayName,
    modsOverlayRef,
    modsBackupGens,
    modsBackupMb,
  ]);

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

  /* ---- Panel Papelera (títulos quitados de la lista) ---- */

  /** Filas cargadas: array disperso de longitud `hiddenTotal` (huecos = sin pedir). */
  const [hiddenRows, setHiddenRows] = useState<(HiddenEntry | undefined)[]>([]);
  const [hiddenTotal, setHiddenTotal] = useState(0);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [hiddenQuery, setHiddenQuery] = useState("");
  /** `hiddenQuery` con debounce: es lo que se consulta al backend. */
  const [hiddenApplied, setHiddenApplied] = useState("");
  const [hiddenBusy, setHiddenBusy] = useState(false);
  const [hiddenResetSeq, setHiddenResetSeq] = useState(0);
  const hiddenRowsRef = useRef<(HiddenEntry | undefined)[]>([]);
  const hiddenPagesRef = useRef<Set<number>>(new Set());
  const hiddenInflightRef = useRef<Set<number>>(new Set());
  const hiddenGenRef = useRef(0);

  const setHiddenRowsBoth = useCallback((rows: (HiddenEntry | undefined)[]) => {
    hiddenRowsRef.current = rows;
    setHiddenRows(rows);
  }, []);

  const loadHidden = useCallback(
    async (query: string) => {
      const gen = ++hiddenGenRef.current;
      hiddenPagesRef.current = new Set();
      hiddenInflightRef.current = new Set();
      setHiddenLoading(true);
      try {
        const [total, page0] = await Promise.all([
          api.catalogHiddenCount(null, query),
          api.catalogHiddenList(null, query, HIDDEN_PAGE, 0),
        ]);
        if (gen !== hiddenGenRef.current) return;
        const rows: (HiddenEntry | undefined)[] = Array.from({ length: total });
        for (let i = 0; i < page0.length && i < total; i++) rows[i] = page0[i];
        if (total > 0) hiddenPagesRef.current.add(0);
        setHiddenTotal(total);
        setHiddenRowsBoth(rows);
        setHiddenResetSeq((n) => n + 1);
      } catch (e) {
        if (gen !== hiddenGenRef.current) return;
        setHiddenTotal(0);
        setHiddenRowsBoth([]);
        log(String(e), "err");
      } finally {
        if (gen === hiddenGenRef.current) setHiddenLoading(false);
      }
    },
    [log, setHiddenRowsBoth],
  );

  /** Trae las páginas que cubren el rango visible de la lista virtual. */
  const requestHiddenRange = useCallback(
    (start: number, end: number) => {
      if (end <= start) return;
      const gen = hiddenGenRef.current;
      const first = Math.floor(start / HIDDEN_PAGE);
      const last = Math.floor(Math.max(start, end - 1) / HIDDEN_PAGE);
      for (let page = first; page <= last; page++) {
        if (hiddenPagesRef.current.has(page) || hiddenInflightRef.current.has(page)) continue;
        hiddenInflightRef.current.add(page);
        void (async () => {
          try {
            const rows = await api.catalogHiddenList(
              null,
              hiddenApplied,
              HIDDEN_PAGE,
              page * HIDDEN_PAGE,
            );
            if (gen !== hiddenGenRef.current) return;
            const next = hiddenRowsRef.current.slice();
            const base = page * HIDDEN_PAGE;
            for (let i = 0; i < rows.length; i++) next[base + i] = rows[i];
            hiddenPagesRef.current.add(page);
            setHiddenRowsBoth(next);
          } catch (e) {
            if (gen === hiddenGenRef.current) log(String(e), "err");
          } finally {
            hiddenInflightRef.current.delete(page);
          }
        })();
      }
    },
    [hiddenApplied, log, setHiddenRowsBoth],
  );

  // Debounce del buscador: la búsqueda la resuelve SQL, no el cliente.
  useEffect(() => {
    const t = window.setTimeout(() => setHiddenApplied(hiddenQuery.trim()), 250);
    return () => window.clearTimeout(t);
  }, [hiddenQuery]);

  useEffect(() => {
    if (activeNav !== "options" || optTab !== "hidden") return;
    void loadHidden(hiddenApplied);
  }, [activeNav, optTab, hiddenApplied, loadHidden]);

  const moduleNameOf = useCallback(
    (row: HiddenEntry) =>
      row.module_name || modules.find((m) => m.id === row.module_id)?.name || row.module_id,
    [modules],
  );

  /** Restaura filas concretas y refresca el catálogo de Info. */
  const restoreHidden = useCallback(
    async (rows: HiddenEntry[]) => {
      if (!rows.length || hiddenBusy) return;
      setHiddenBusy(true);
      try {
        const byModule = new Map<string, string[]>();
        for (const r of rows) {
          const list = byModule.get(r.module_id) ?? [];
          list.push(r.link);
          byModule.set(r.module_id, list);
        }
        let n = 0;
        for (const [moduleId, links] of byModule) {
          n += await api.catalogUnhideLinks(moduleId, links);
        }
        const stale = rows.filter((r) => !r.has_snapshot).length;
        await loadHidden(hiddenApplied);
        notifyCatalogChanged([...byModule.keys()]);
        log(n === 1 ? t("options.restored.one") : t("options.restored.other", { n }), "ok");
        if (stale) {
          log(
            stale === 1
              ? t("options.restoredStale.one")
              : t("options.restoredStale.other", { n: stale }),
          );
        }
      } catch (e) {
        log(String(e), "err");
      } finally {
        setHiddenBusy(false);
      }
    },
    [hiddenApplied, hiddenBusy, loadHidden, log, notifyCatalogChanged],
  );

  /** Restaura todo lo que coincida con el filtro actual (lo que se está viendo). */
  const restoreAllHidden = useCallback(async () => {
    if (!hiddenTotal || hiddenBusy) return;
    const scope = hiddenApplied ? t("options.restoreMatch", { q: hiddenApplied }) : "";
    const ok = await appConfirm({
      title: t("options.restoreTitle"),
      message: t("options.restoreAllMsg", { n: hiddenTotal, scope }),
      okLabel: t("options.restoreAllOk"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setHiddenBusy(true);
    try {
      // Sin traerse la lista entera al cliente: el backend resuelve el filtro.
      // Puede tocar cualquier módulo, así que se avisa por todos.
      const n = await api.catalogUnhideAll(null, hiddenApplied);
      await loadHidden(hiddenApplied);
      notifyCatalogChanged(modules.map((m) => m.id));
      log(n === 1 ? t("options.restored.one") : t("options.restored.other", { n }), "ok");
    } catch (e) {
      log(String(e), "err");
    } finally {
      setHiddenBusy(false);
    }
  }, [hiddenApplied, hiddenBusy, hiddenTotal, loadHidden, log, modules, notifyCatalogChanged]);

  /* ---- Panel Sitios Web ---- */

  const [sitesTab, setSitesTab] = useState<SitesTabId>("list");

  // Deep-link from elsewhere (the "hay módulos por actualizar" toast, the gear
  // dot): land on the tab that actually holds the thing that was clicked.
  useEffect(() => {
    if (!pendingOptionsTab) return;
    const { tab, sub } = pendingOptionsTab;
    if (OPTIONS_CATS.some((c) => c.id === tab)) setOptTab(tab as OptTabId);
    if (sub === "list" || sub === "mods") setSitesTab(sub);
    clearPendingOptionsTab();
  }, [pendingOptionsTab, clearPendingOptionsTab]);
  const [sitesQuery, setSitesQuery] = useState("");
  const [sitesOnlyActive, setSitesOnlyActive] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const siteGroups = useMemo<SiteGroup[]>(() => {
    const byCat = new Map<string, SiteMod[]>();
    for (const m of modules) {
      // FMD2 omits modules with empty Category from the websites tree.
      const label = (m.category || "").trim();
      if (!label) continue;
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
  const [modsShowSupport, setModsShowSupport] = useState(false);
  const [modsChecking, setModsChecking] = useState(false);
  const [repoEntries, setRepoEntries] = useState<LuaRepoEntry[]>([]);
  const [modsSourceOpen, setModsSourceOpen] = useState(false);

  const loadRepoEntries = useCallback(async () => {
    try {
      const [list, bytes] = await Promise.all([
        api.modulesRepoList(),
        api.modulesBackupSize().catch(() => 0),
      ]);
      setRepoEntries(list);
      setModsBackupBytes(bytes);
    } catch (e) {
      log(t("options.listModsFailed", { err: String(e) }), "err");
    }
  }, [log]);

  const clearModulesBackups = useCallback(async () => {
    setModsBackupFlash("working");
    try {
      const n = await api.modulesBackupClear();
      setModsBackupBytes(0);
      setModsBackupFlash("done");
      log(t("options.backupsCleared", { n }), "ok");
      window.setTimeout(() => setModsBackupFlash("idle"), 2400);
    } catch (e) {
      setModsBackupFlash("error");
      log(t("options.backupsClearFailed", { err: String(e) }), "err");
      window.setTimeout(() => setModsBackupFlash("idle"), 2800);
    }
  }, [log]);

  useEffect(() => {
    if (optTab === "websites" && sitesTab === "mods") {
      void loadRepoEntries();
    }
  }, [optTab, sitesTab, loadRepoEntries]);

  const modRows = useMemo<ModRow[]>(() => {
    return repoEntries.map(repoEntryToRow).sort((a, b) =>
      a.file.localeCompare(b.file, undefined, { sensitivity: "base" }),
    );
  }, [repoEntries]);

  /** Counted over what the list is currently showing, so the footer adds up. */
  const modsUpdatedCount = useMemo(
    () =>
      modRows.filter(
        (r) => r.updated && (modsShowSupport || r.file.startsWith("modules/")),
      ).length,
    [modRows, modsShowSupport],
  );

  /**
   * What is actually pending, read off the stored state rather than off the
   * last background check. Silencing the toast must not make this tab lie:
   * you opened it on purpose, so it tells you the truth either way.
   */
  const modsPending = useMemo(() => {
    let nw = 0;
    let up = 0;
    let del = 0;
    for (const e of repoEntries) {
      switch ((e.flag || "").toLowerCase()) {
        case "new":
          nw++;
          break;
        case "update":
          up++;
          break;
        case "delete":
          del++;
          break;
      }
    }
    const parts: string[] = [];
    if (nw) parts.push(t("modules.new", { n: nw }));
    if (up) parts.push(t("modules.updated", { n: up }));
    if (del) parts.push(t("modules.deleted", { n: del }));
    return { total: nw + up + del, summary: parts.join(", ") };
  }, [repoEntries]);

  const modulesPendingCount = modsPending.total;
  const modsPinnedCount = useMemo(
    () => repoEntries.filter((e) => e.pin).length,
    [repoEntries],
  );
  const [modsBannerHidden, setModsBannerHidden] = useState(false);

  // A fresh background result is news again, even if the banner was hidden.
  useEffect(() => {
    if (modulesPending) setModsBannerHidden(false);
  }, [modulesPending]);

  // A finished sync makes the row list stale.
  useEffect(() => {
    if (modulesJob) return;
    if (optTab === "websites" && sitesTab === "mods") void loadRepoEntries();
  }, [modulesJob, optTab, sitesTab, loadRepoEntries]);

  /**
   * The sync tracks the whole Lua tree, but only `modules/` maps to a site the
   * user recognises. Templates, watermark PNGs and the bypass scripts are
   * support files they never look for by name — hidden by default, one click
   * away, and never excluded from the sync itself.
   */
  const modsSupportCount = useMemo(
    () => modRows.filter((r) => !r.file.startsWith("modules/")).length,
    [modRows],
  );

  const modsFlat = useMemo(() => {
    const mq = modsQuery.trim().toLowerCase();
    let rows = modRows;
    if (!modsShowSupport) rows = rows.filter((r) => r.file.startsWith("modules/"));
    if (mq) rows = rows.filter((r) => r.file.toLowerCase().includes(mq) || r.msg.toLowerCase().includes(mq));
    if (modsOnlyUpdated) rows = rows.filter((r) => r.updated);
    return rows;
  }, [modRows, modsQuery, modsOnlyUpdated, modsShowSupport]);

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
      // Persist the toggle first so the updater reads what is on screen.
      await api.settingsSet(SK.MODULES_UPDATER_SHOW_WARNING, modsWarn ? "1" : "0");
      await api.settingsSet(SK.MODULES_PREFER_LOCAL_NEWER, modsPreferLocal ? "1" : "0");
      await api.settingsSet(SK.MODULES_OVERLAY_ENABLED, modsOverlay ? "1" : "0");
      await api.settingsSet(SK.MODULES_OVERLAY_OWNER, modsOverlayOwner.trim() || "allydevper");
      await api.settingsSet(SK.MODULES_OVERLAY_NAME, modsOverlayName.trim() || "FMD3");
      await api.settingsSet(SK.MODULES_OVERLAY_REF, modsOverlayRef.trim() || "master");
      await runModulesGithubUpdate(log);
      setModulesPending(null);
      await refreshModules();
      await loadRepoEntries();
    } catch (e) {
      log(t("options.checkModsFailed", { err: String(e) }), "err");
    } finally {
      setModsChecking(false);
    }
  }, [
    modsChecking,
    modsWarn,
    modsPreferLocal,
    modsOverlay,
    modsOverlayOwner,
    modsOverlayName,
    modsOverlayRef,
    refreshModules,
    loadRepoEntries,
    setModulesPending,
    log,
  ]);

  /** Roll the last apply back; every overwritten file was snapshotted first. */
  const undoModulesUpdate = useCallback(async () => {
    if (modsChecking) return;
    const ok = await appConfirm({
      title: t("options.undoTitle"),
      message: t("options.undoMsg"),
      okLabel: t("options.undoOk"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setModsChecking(true);
    try {
      const r = await api.modulesUndo();
      log(
        t("options.modsRestored", {
          restored: r.restored,
          removed: r.removed,
          n: r.refreshed_count,
        }),
        r.failed.length ? "err" : "ok",
      );
      for (const f of r.failed.slice(0, 10)) log(t("options.modsLine", { msg: f }), "err");
      await refreshModules();
      await loadRepoEntries();
    } catch (e) {
      log(t("options.undoFailed", { err: String(e) }), "err");
    } finally {
      setModsChecking(false);
    }
  }, [modsChecking, refreshModules, loadRepoEntries, log]);

  /** Keep the .lua already on disk and take it out of the official sync. */
  const pinModuleFile = useCallback(
    async (path: string) => {
      const ok = await appConfirm({
        title: t("options.pinConfirmTitle"),
        message: t("options.pinMsg", { path }),
        okLabel: t("options.pin"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
      try {
        const r = await api.modulesPinKeep(path);
        log(t("options.pinnedOk", { path, n: r.refreshed_count }), "ok");
        await refreshModules();
        await loadRepoEntries();
      } catch (e) {
        log(t("options.pinFailed", { path, err: String(e) }), "err");
      }
    },
    [refreshModules, loadRepoEntries, log],
  );

  /** Hand a module back to the official sync. The file is left as it is. */
  const unpinModuleFile = useCallback(
    async (path: string) => {
      const ok = await appConfirm({
        title: t("options.unpinConfirmTitle"),
        message: t("options.unpinMsg", { path }),
        okLabel: t("options.unpin"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
      try {
        await api.modulesUnpin(path);
        log(t("options.unpinnedOk", { path }), "ok");
        await loadRepoEntries();
      } catch (e) {
        log(t("options.unpinFailed", { path, err: String(e) }), "err");
      }
    },
    [loadRepoEntries, log],
  );

  /** Per-file history: pick one stored version and write it back. */
  const revertModuleFile = useCallback(
    async (path: string) => {
      let versions: LuaFileVersion[] = [];
      try {
        versions = await api.modulesHistory(path);
      } catch (e) {
        log(t("options.historyFailed", { path, err: String(e) }), "err");
        return;
      }
      if (!versions.length) {
        await appConfirm({
          title: t("options.noHistoryTitle"),
          message: t("options.noHistoryMsg", { path }),
          alert: true,
          okLabel: t("common.understood"),
        });
        return;
      }
      const target = versions[0];
      const when = target.updated_at
        ? new Date(target.updated_at * 1000).toLocaleString()
        : t("options.unknownDate");
      const ok = await appConfirm({
        title: t("options.revertModTitle"),
        message: t("options.revertMsg", { path, when }),
        okLabel: t("options.revert"),
        cancelLabel: t("common.cancel"),
        items: versions
          .slice(0, 20)
          .map(
            (v, i) =>
              `${i === 0 ? "→ " : "  "}${
                v.updated_at ? new Date(v.updated_at * 1000).toLocaleString() : "—"
              } · ${v.origin} · ${v.message}`,
          ),
      });
      if (!ok) return;
      try {
        const r = await api.modulesRevert(path, target.content_id);
        log(t("options.revertedOk", { path, n: r.refreshed_count }), "ok");
        await refreshModules();
        await loadRepoEntries();
      } catch (e) {
        log(t("options.revertFailed", { path, err: String(e) }), "err");
      }
    },
    [refreshModules, loadRepoEntries, log],
  );

  /* ---------------------------------------------------------------------- */

  return (
    <section id="view-options" className="view" hidden={activeNav !== "options"}>
      <div className="options-shell">
        <header className="options-header">
          <div className="options-eyebrow">{t("options.eyebrow")}</div>
          <h1 className="options-title">{t("options.title")}</h1>
        </header>

        <div className="options-main">
          <nav className="options-cats" role="tablist" aria-label={t("options.catsAria")}>
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
                <span>{t(`options.cat.${cat.id}`)}</span>
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
                      <h2>{t("options.sectionApp")}</h2>
                    </div>
                    <div className="st-card">
                      <SelectRow
                        label={t("options.language.label")}
                        desc={t("options.language.desc")}
                        value={s.language}
                        onChange={(v) => update("language", parseLanguage(v))}
                        options={[
                          { value: "en", label: "English" },
                          { value: "es", label: "Español" },
                        ]}
                      />
                      <SelectRow
                        label={t("options.theme.label")}
                        desc={t("options.theme.desc")}
                        value={s.theme}
                        onChange={(v) =>
                          update("theme", (v === "dark" || v === "light" || v === "system" ? v : "system") as AppTheme)
                        }
                        options={[
                          { value: "system", label: t("options.theme.system") },
                          { value: "light", label: t("options.theme.light") },
                          { value: "dark", label: t("options.theme.dark") },
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
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.minimize} className="ico ico-sm" />
                      <h2>{t("options.sectionTray")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-tray-start"
                        label={t("options.trayStart.label")}
                        desc={t("options.trayStart.desc")}
                        checked={s.trayStart}
                        onChange={(v) => update("trayStart", v)}
                      />
                      <SwitchRow
                        id="opt-tray-minimize"
                        label={t("options.trayMinimize.label")}
                        desc={t("options.trayMinimize.desc")}
                        checked={s.trayMinimize}
                        onChange={(v) => update("trayMinimize", v)}
                      />
                      <SwitchRow id="opt-notify" label={t("options.notify.label")} desc={t("options.notify.desc")} checked={s.notify} onChange={(v) => update("notify", v)} />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.message} className="ico ico-sm" />
                      <h2>{t("options.sectionConfirm")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-confirm-exit"
                        label={t("options.confirmExit.label")}
                        desc={t("options.confirmExit.desc")}
                        checked={s.confirmExit}
                        onChange={(v) => update("confirmExit", v)}
                      />
                      <SwitchRow
                        id="opt-confirm-delete"
                        label={t("options.confirmDelete.label")}
                        desc={t("options.confirmDelete.desc")}
                        checked={s.confirmDelete}
                        onChange={(v) => update("confirmDelete", v)}
                      />
                      <SwitchRow
                        id="opt-confirm-empty"
                        label={t("options.confirmEmpty.label")}
                        desc={t("options.confirmEmpty.desc")}
                        checked={s.confirmEmptyList}
                        onChange={(v) => update("confirmEmptyList", v)}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.broom} className="ico ico-sm" />
                      <h2>{t("options.sectionMaint")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-vacuum"
                        label={t("options.vacuum.label")}
                        desc={t("options.vacuum.desc")}
                        checked={s.vacuum}
                        onChange={(v) => update("vacuum", v)}
                      />
                      <div className="st-row st-row-actions">
                        <div className="st-meta">
                          <div className="st-label">{t("options.cache.label")}</div>
                          <div className="st-desc">
                            {t("options.cache.desc")}
                          </div>
                          {cacheClearFlash === "done" ? (
                            <div className="st-inline-ok" role="status">
                              {t("options.cache.done")}
                            </div>
                          ) : cacheClearFlash === "error" ? (
                            <div className="st-inline-err" role="status">
                              {t("options.cache.error")}
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
                            ? t("options.cache.working")
                            : cacheClearFlash === "done"
                              ? t("common.ready")
                              : t("options.cache.button")}
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.file} className="ico ico-sm" />
                      <h2>{t("options.sectionLog")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-log"
                        label={t("options.logOn.label")}
                        desc={t("options.logOn.desc")}
                        checked={s.logOn}
                        onChange={(v) => update("logOn", v)}
                      />
                      <div id="opt-log-extra" hidden={!s.logOn}>
                        <div className="st-row">
                          <div className="st-form-inline">
                            <span className="st-form-key">{t("options.logFile")}</span>
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
                                {t("options.logCleared")}
                              </div>
                            ) : logClearFlash === "error" ? (
                              <div className="st-inline-err" role="status">
                                {t("options.logClearError")}
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
                              ? t("options.logClearing")
                              : logClearFlash === "done"
                                ? t("common.ready")
                                : t("options.logClearBtn")}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              void api.openLogFile().catch((e) => log(String(e), "err"));
                            }}
                          >
                            {t("options.logOpen")}
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
                      <h2>{t("options.sectionUi")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow id="opt-load-covers" label={t("options.loadCovers.label")} desc={t("options.loadCovers.desc")} checked={s.loadCovers} onChange={(v) => update("loadCovers", v)} />
                      <SwitchRow
                        id="opt-live-search"
                        label={t("options.liveSearch.label")}
                        desc={t("options.liveSearch.desc")}
                        checked={s.liveSearch}
                        onChange={(v) => update("liveSearch", v)}
                      />
                      <SwitchRow id="opt-goto-dl" label={t("options.gotoDl.label")} desc={t("options.gotoDl.desc")} checked={s.gotoDl} onChange={(v) => update("gotoDl", v)} />
                      <SwitchRow id="opt-goto-fav" label={t("options.gotoFav.label")} desc={t("options.gotoFav.desc")} checked={s.gotoFav} onChange={(v) => update("gotoFav", v)} />
                      <BoundStepperRow
                        id="opt-new-days"
                        label={t("options.newDays.label")}
                        desc={t("options.newDays.desc")}
                        value={s.newDays}
                        min={1}
                        max={365}
                        unit={t("units.days")}
                        onChange={(v) => update("newDays", v)}
                      />
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Descargas ---- */}
            <div className={`options-panel${optTab === "downloads" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "downloads"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.download} className="ico ico-sm" />
                      <h2>{t("options.sectionDownloads")}</h2>
                    </div>
                    <div className="st-card">
                      <BoundStepperRow label={t("options.parallelTasks.label")} desc={t("options.parallelTasks.desc")} value={s.parallelTasks} min={1} max={32} onChange={(v) => update("parallelTasks", v)} />
                      <SwitchRow
                        id="opt-one-chapter-per-manga"
                        label={t("options.oneChapter.label")}
                        desc={t("options.oneChapter.desc")}
                        checked={s.oneChapterPerManga}
                        onChange={(v) => update("oneChapterPerManga", v)}
                      />
                      <OptRow label={t("options.pageThreads.label")} desc={t("options.pageThreads.desc")}>
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
                      <BoundStepperRow label={t("options.taskRetries.label")} desc={t("options.taskRetries.desc")} value={s.taskRetries} min={0} max={10} onChange={(v) => update("taskRetries", v)} />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.layers} className="ico ico-sm" />
                      <h2>{t("options.sectionQueue")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-sort-on-add"
                        label={t("options.sortOnAdd.label")}
                        desc={t("options.sortOnAdd.desc")}
                        checked={s.sortOnAdd}
                        onChange={(v) => update("sortOnAdd", v)}
                      />
                      <SwitchRow
                        id="opt-clear-done"
                        label={t("options.clearDone.label")}
                        desc={t("options.clearDone.desc")}
                        checked={s.clearDoneExit}
                        onChange={(v) => update("clearDoneExit", v)}
                      />
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Red ---- */}
            <div className={`options-panel${optTab === "network" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "network"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.link} className="ico ico-sm" />
                      <h2>{t("options.sectionNetwork")}</h2>
                    </div>
                    <div className="st-card">
                      <BoundStepperRow label={t("options.timeout.label")} desc={t("options.timeout.desc")} value={s.httpTimeout} min={1} max={300} suffix="s" onChange={(v) => update("httpTimeout", v)} />
                      <BoundStepperRow
                        label={t("options.httpRetries.label")}
                        desc={t("options.httpRetries.desc")}
                        value={s.httpRetries}
                        min={0}
                        max={5}
                        onChange={(v) => update("httpRetries", v)}
                      />
                      <OptRow label={t("options.ua.label")} desc={t("options.ua.desc")}>
                        <input
                          id="set-ua"
                          className="st-field st-mono st-field-ua"
                          type="text"
                          value={s.ua}
                          placeholder={t("options.ua.placeholder")}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => update("ua", e.target.value)}
                        />
                      </OptRow>
                      <SwitchRow
                        id="set-cf-internal-browser"
                        label={t("options.cfBrowser.label")}
                        desc={t("options.cfBrowser.desc")}
                        checked={s.cfInternalBrowser}
                        onChange={(v) => update("cfInternalBrowser", v)}
                      />
                      <SwitchRow
                        id="set-use-proxy"
                        label={t("options.useProxy.label")}
                        desc={t("options.useProxy.desc")}
                        checked={s.useProxy}
                        onChange={(v) => update("useProxy", v)}
                      />
                      <div className="st-nest" hidden={!s.useProxy}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-type">{t("options.proxyType")}</label>
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
                            <label htmlFor="set-proxy-host">{t("options.proxyHost")}</label>
                            <input
                              id="set-proxy-host"
                              className="st-field st-mono"
                              type="text"
                              placeholder={t("options.proxyHostPh")}
                              autoComplete="off"
                              spellCheck={false}
                              value={s.proxyHost}
                              onChange={(e) => update("proxyHost", e.target.value)}
                            />
                          </div>
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-port">{t("options.proxyPort")}</label>
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
                            <label htmlFor="set-proxy-user">{t("options.proxyUser")}</label>
                            <input
                              id="set-proxy-user"
                              className="st-field st-mono"
                              type="text"
                              placeholder={t("common.optional")}
                              autoComplete="off"
                              spellCheck={false}
                              value={s.proxyUser}
                              onChange={(e) => update("proxyUser", e.target.value)}
                            />
                          </div>
                          <div className="st-nest-row">
                            <label htmlFor="set-proxy-pass">{t("options.proxyPass")}</label>
                            <input
                              id="set-proxy-pass"
                              className="st-field st-mono"
                              type="password"
                              placeholder={t("common.optional")}
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
                      <h2>{t("options.sectionDest")}</h2>
                    </div>
                    <div className="st-card">
                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">{t("options.outputPath.label")}</div>
                          <div className="st-desc">{t("options.outputPath.desc")}</div>
                        </div>
                        <div className="path-field path-field-exam">
                          <input
                            id="set-output-dir"
                            type="text"
                            readOnly
                            placeholder={t("options.noOutput")}
                            autoComplete="off"
                            value={s.outputDirField}
                          />
                          <button
                            type="button"
                            className="path-browse path-browse-label"
                            id="set-output-browse"
                            title={t("options.browseTitle")}
                            onClick={() => void handleBrowseOutputDir()}
                          >
                            <Icon ico={ICO.folder} className="ico ico-sm" />
                            {t("common.browse")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.file} className="ico ico-sm" />
                      <h2>{t("options.sectionPack")}</h2>
                    </div>
                    <div className="st-card">
                      <div className="st-row">
                        <div className="st-meta">
                          <div className="st-label">{t("options.packAs.label")}</div>
                          <div className="st-desc">{t("options.packAs.desc")}</div>
                        </div>
                        <div className="st-seg" id="set-pack" role="radiogroup" aria-label={t("options.packAs.label")}>
                          {packOptions().map((opt) => (
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
                        label={t("options.packDelete.label")}
                        desc={t("options.packDelete.desc")}
                        checked={s.packDelete}
                        onChange={(v) => update("packDelete", v)}
                      />
                      <div className="st-row" id="set-pdf-quality-row" hidden={s.packFormat !== "pdf"}>
                        <div className="st-meta">
                          <div className="st-label">{t("options.pdfQuality.label")}</div>
                          <div className="st-desc">
                            {t("options.pdfQuality.desc")}
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
                      <h2>{t("options.sectionConvert")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="set-png-as-jpeg"
                        label={t("options.pngAsJpeg.label")}
                        desc={t("options.pngAsJpeg.desc")}
                        checked={s.pngAsJpeg}
                        onChange={(v) => update("pngAsJpeg", v)}
                      />
                      <SelectRow
                        id="set-webp-as"
                        label={t("options.webpAs.label")}
                        desc={t("options.webpAs.desc")}
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
                        label={t("options.pngLevel.label")}
                        desc={t("options.pngLevel.desc")}
                        value={s.pngLevel}
                        onChange={(v) => update("pngLevel", v)}
                        options={[
                          { value: "0", label: t("common.none") },
                          { value: "1", label: t("options.pngFastest") },
                          { value: "2", label: t("options.pngDefault") },
                          { value: "3", label: t("options.pngMax") },
                        ]}
                      />
                      <BoundStepperRow
                        id="set-jpeg-quality"
                        label={t("options.jpegQuality.label")}
                        desc={t("options.jpegQuality.desc")}
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
                      <h2>{t("options.sectionRename")}</h2>
                    </div>
                    <div className="st-card">
                      <SelectRow
                        id="set-rename-preset"
                        label={t("options.renameStructure.label")}
                        desc={t("options.renameStructure.desc")}
                        value={renamePreset}
                        onChange={applyRenamePreset}
                        options={[
                          ...availablePresets.map((p) => ({ value: p.id, label: renamePresetLabel(p.id) })),
                          /* "Personalizado" es un estado, no un atajo: solo se lista
                             cuando ya lo estás, para que no haya opción que no haga nada. */
                          ...(renamePreset === RENAME_PRESET_CUSTOM
                            ? [{ value: RENAME_PRESET_CUSTOM, label: t("common.custom") }]
                            : []),
                        ]}
                      />
                      {/* Junto al preset: al elegir uno, el resultado se ve sin bajar. */}
                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">{t("options.renameResult.label")}</div>
                          <div className="st-desc">
                            {t("options.renameResult.desc")}
                          </div>
                        </div>
                        <div id="set-rename-preview" className="st-preview" aria-live="polite">
                          {renamePreview}
                        </div>
                      </div>
                      <SwitchRow
                        id="set-manga-folder"
                        label={t("options.mangaFolder.label")}
                        desc={t("options.mangaFolder.desc")}
                        checked={s.mangaFolderOn}
                        onChange={(v) => update("mangaFolderOn", v)}
                      />
                      <div className="st-row st-row-stack" hidden={!s.mangaFolderOn}>
                        <div className="st-meta">
                          <div className="st-label">{t("options.mangaPat.label")}</div>
                          <div className="st-desc">
                            {t("options.mangaPat.desc")}
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
                            title={t("common.clear")}
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
                        label={t("options.chapterFolder.label")}
                        desc={
                          packing
                            ? t("options.chapterFolderPack")
                            : t("options.chapterFolder.desc")
                        }
                        checked={s.chapterFolderOn}
                        onChange={(v) => update("chapterFolderOn", v)}
                      />
                      <div className="st-row st-row-stack" hidden={!s.chapterFolderOn}>
                        <div className="st-meta">
                          <div className="st-label">{t("options.chapterPat.label")}</div>
                          <div className="st-desc">
                            {packing
                              ? t("options.chapterPatPack")
                              : t("options.chapterPat.desc")}
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
                            title={t("common.clear")}
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
                          <div className="st-label">{t("options.pageName.label")}</div>
                          <div className="st-desc">
                            {packing
                              ? t("options.pageNamePack")
                              : t("options.pageName.desc")}
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
                            title={t("common.clear")}
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
                        label={t("options.removeManga.label")}
                        desc={t("options.removeManga.desc")}
                        checked={s.removeMangaFromChapter}
                        onChange={(v) => update("removeMangaFromChapter", v)}
                      />

                      <SwitchRow
                        id="set-vol-pad"
                        label={t("options.volPad.label")}
                        desc={t("options.volPad.desc")}
                        checked={s.volPadOn}
                        onChange={(v) => update("volPadOn", v)}
                      />
                      <div className="st-nest" hidden={!s.volPadOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-vol-digits">{t("options.digits")}</label>
                            <Stepper id="set-vol-digits" value={s.volDigits} min={1} max={4} onChange={(v) => update("volDigits", v)} />
                          </div>
                        </div>
                      </div>

                      <SwitchRow
                        id="set-chap-pad"
                        label={t("options.chapPad.label")}
                        desc={t("options.chapPad.desc")}
                        checked={s.chapPadOn}
                        onChange={(v) => update("chapPadOn", v)}
                      />
                      <div className="st-nest" hidden={!s.chapPadOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-chap-digits">{t("options.digits")}</label>
                            <Stepper id="set-chap-digits" value={s.chapDigits} min={1} max={5} onChange={(v) => update("chapDigits", v)} />
                          </div>
                        </div>
                      </div>

                      <SwitchRow
                        id="set-replace-ascii"
                        label={t("options.ascii.label")}
                        desc={t("options.ascii.desc")}
                        checked={s.asciiOn}
                        onChange={(v) => update("asciiOn", v)}
                      />
                      <div className="st-nest" hidden={!s.asciiOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row st-nest-row-compact">
                            <label htmlFor="set-replace-ascii-char">{t("options.asciiBy")}</label>
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

                      <SwitchRow
                        id="opt-long-paths"
                        label={t("options.longPaths.label")}
                        desc={t("options.longPaths.desc")}
                        checked={s.longPaths}
                        onChange={(v) => update("longPaths", v)}
                      />
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
                      <h2>{t("options.sectionUpdates")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        label={t("options.checkUpdate.label")}
                        desc={t("options.checkUpdate.desc")}
                        checked={s.checkUpdateStart}
                        onChange={(v) => update("checkUpdateStart", v)}
                      />
                      <SwitchRow
                        label={t("options.updateNoInfo.label")}
                        desc={t("options.updateNoInfo.desc")}
                        checked={s.updateListNoInfo}
                        onChange={(v) => update("updateListNoInfo", v)}
                      />
                      <SwitchRow
                        label={t("options.fullScan.label")}
                        desc={t("options.fullScan.desc")}
                        checked={s.updateListFullScan}
                        onChange={(v) => {
                          if (!v) {
                            update("updateListFullScan", false);
                            return;
                          }
                          void (async () => {
                            const ok = await appConfirm({
                              title: t("options.fullScan.title"),
                              message: t("options.fullScan.message"),
                              okLabel: t("common.activate"),
                              cancelLabel: t("common.cancel"),
                            });
                            if (ok) update("updateListFullScan", true);
                          })();
                        }}
                      />
                      <BoundStepperRow
                        label={t("options.updateThreads.label")}
                        desc={t("options.updateThreads.desc")}
                        value={s.updateListThreads}
                        min={1}
                        max={32}
                        onChange={(v) => update("updateListThreads", v)}
                      />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.heart} className="ico ico-sm" />
                      <h2>{t("options.sectionFav")}</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        label={t("options.favCheckStart.label")}
                        desc={t("options.favCheckStart.desc")}
                        checked={s.favCheckOnStart}
                        onChange={(v) => update("favCheckOnStart", v)}
                      />
                      <SwitchRow
                        id="set-fav-interval"
                        label={t("options.favInterval.label")}
                        desc={t("options.favInterval.desc")}
                        checked={s.favIntervalOn}
                        onChange={(v) => update("favIntervalOn", v)}
                      />
                      <div className="st-nest" hidden={!s.favIntervalOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-fav-interval-min">{t("options.favIntervalMin")}</label>
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
                        label={t("options.favDownload.label")}
                        desc={t("options.favDownload.desc")}
                        checked={s.favDownloadAfter}
                        onChange={(v) => update("favDownloadAfter", v)}
                      />
                      <BoundStepperRow
                        label={t("options.favThreads.label")}
                        desc={t("options.favThreads.desc")}
                        value={s.favThreads}
                        min={1}
                        max={32}
                        onChange={(v) => update("favThreads", v)}
                      />
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Papelera ---- */}
            <div className={`options-panel${optTab === "hidden" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "hidden"}>
              <div className="opt-scroll">
                <div className="st-wrap">
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.trash} className="ico ico-sm" />
                      <h2>{t("options.sectionTrash")}</h2>
                    </div>
                    <div className="st-card">
                      <div className="trash-toolbar">
                        <div className="sites-search-wrap">
                          <Icon ico={ICO.search} className="ico ico-sm sites-search-ico" />
                          <input
                            id="trash-q"
                            className="st-field"
                            type="text"
                            placeholder={t("options.trashSearch")}
                            autoComplete="off"
                            spellCheck={false}
                            value={hiddenQuery}
                            onChange={(e) => setHiddenQuery(e.target.value)}
                          />
                          <button
                            type="button"
                            className="sites-clear"
                            hidden={!hiddenQuery.trim()}
                            title={t("common.clear")}
                            onClick={() => setHiddenQuery("")}
                          >
                            <Icon ico={ICO.x} className="ico ico-sm" />
                          </button>
                        </div>
                        <div className="sites-toolbar-spacer" />
                        <div className="sites-toolbar-actions">
                          <button
                            type="button"
                            className="sites-tbtn"
                            disabled={hiddenLoading || hiddenBusy}
                            onClick={() => void loadHidden(hiddenApplied)}
                          >
                            <Icon ico={ICO.refresh} className="ico ico-sm" />
                            {t("options.reload")}
                          </button>
                          <button
                            type="button"
                            className="sites-tbtn"
                            disabled={!hiddenTotal || hiddenBusy}
                            onClick={() => void restoreAllHidden()}
                          >
                            <Icon ico={ICO.retry} className="ico ico-sm" />
                            {t("options.restoreAll", { n: hiddenTotal })}
                          </button>
                        </div>
                      </div>

                      {hiddenLoading && !hiddenTotal ? (
                        <div className="sites-tree-empty">
                          <div className="sites-empty-title">{t("common.loading")}</div>
                        </div>
                      ) : !hiddenTotal ? (
                        <div className="sites-tree-empty">
                          <div className="sites-empty-title">
                            {hiddenApplied ? t("options.noMatches") : t("options.trashEmpty")}
                          </div>
                          <div className="sites-empty-desc">
                            {hiddenApplied
                              ? t("options.noTitleMatch", { q: hiddenApplied })
                              : t("options.trashEmptyDesc")}
                          </div>
                        </div>
                      ) : (
                        <VirtualList
                          className="trash-list"
                          innerClassName="trash-virtual"
                          items={hiddenRows}
                          itemHeight={HIDDEN_ROW_H}
                          resetKey={hiddenResetSeq}
                          onRange={requestHiddenRange}
                          getKey={(row, i) => (row ? `${row.module_id}||${row.link}` : `ph:${i}`)}
                          renderItem={(row, _i, style) => {
                            if (!row) {
                              return <div className="trash-row is-loading" style={style} aria-hidden />;
                            }
                            return (
                              <div className="trash-row" style={style}>
                                <div className="trash-main">
                                  <span className="trash-title" title={row.link}>
                                    {row.title || row.link}
                                  </span>
                                  <span className="trash-meta">
                                    {moduleNameOf(row)}
                                    {row.hidden_at
                                      ? ` · ${row.hidden_at.slice(0, 16).replace("T", " ")}`
                                      : ""}
                                    {row.has_snapshot ? "" : t("options.noMeta")}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="sites-tbtn"
                                  disabled={hiddenBusy}
                                  onClick={() => void restoreHidden([row])}
                                >
                                  <Icon ico={ICO.retry} className="ico ico-sm" />
                                  {t("common.restore")}
                                </button>
                              </div>
                            );
                          }}
                        />
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </div>

            {/* ---- Sitios Web ---- */}
            <div className={`options-panel${optTab === "websites" ? " active" : ""}`} role="tabpanel" hidden={optTab !== "websites"}>
              <div className="sites-tabs" role="tablist" aria-label={t("options.sitesTab")}>
                <button
                  type="button"
                  className={`sites-tab${sitesTab === "list" ? " on" : ""}`}
                  role="tab"
                  aria-selected={sitesTab === "list"}
                  onClick={() => setSitesTab("list")}
                >
                  {t("options.sitesTab")}
                </button>
                <button
                  type="button"
                  className={`sites-tab${sitesTab === "mods" ? " on" : ""}`}
                  role="tab"
                  aria-selected={sitesTab === "mods"}
                  onClick={() => setSitesTab("mods")}
                >
                  {t("options.modsTab")}
                  {modulesPendingCount ? (
                    <span className="sites-tab-badge mono">{modulesPendingCount}</span>
                  ) : null}
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
                      placeholder={t("options.sitesSearch")}
                      autoComplete="off"
                      spellCheck={false}
                      value={sitesQuery}
                      onChange={(e) => setSitesQuery(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sites-clear"
                      hidden={!sitesQuery.trim()}
                      title={t("common.clear")}
                      onClick={() => setSitesQuery("")}
                    >
                      <Icon ico={ICO.x} className="ico ico-sm" />
                    </button>
                  </div>
                  <div className="sites-toolbar-spacer" />
                  <div className="sites-toolbar-actions">
                    <button type="button" className="sites-tbtn" onClick={() => setSitesOn(allSiteIds, true)}>
                      <Icon ico={ICO.check} className="ico ico-sm" />
                      {t("options.selectAll")}
                    </button>
                    <button type="button" className="sites-tbtn" onClick={() => setSitesOn(allSiteIds, false)}>
                      <Icon ico={ICO.x} className="ico ico-sm" />
                      {t("options.deselectAll")}
                    </button>
                    <button type="button" className="sites-tbtn" onClick={handleSitesExpandAll}>
                      <Icon ico={ICO.plus} className="ico ico-sm" />
                      {t("options.expandAll")}
                    </button>
                    <button type="button" className="sites-tbtn" onClick={handleSitesCollapseAll}>
                      <Icon ico={ICO.minus} className="ico ico-sm" />
                      {t("options.collapseAll")}
                    </button>
                  </div>
                </div>

                <div className="sites-tree" id="sites-tree" role="tree" ref={sitesTreeRef} onScroll={onSitesScroll}>
                  {modules.length === 0 ? (
                    <div className="sites-tree-empty">
                      <div className="sites-empty-title">{t("options.noModules")}</div>
                      <div className="sites-empty-desc">
                        {t("options.noModulesDesc")}
                      </div>
                    </div>
                  ) : sitesFlat.length === 0 ? (
                    <div className="sites-tree-empty">
                      <div className="sites-empty-title">{t("options.noMatches")}</div>
                      <div className="sites-empty-desc">{t("options.noSiteMatch", { q: sitesQuery })}</div>
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
                              ? t("options.allActive")
                              : row.onCount === 0
                                ? t("options.noneActive")
                                : t("options.someActive", { on: row.onCount, total: row.total });
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
                                aria-label={t("options.expandGroup")}
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
                                aria-label={t("options.enableGroup")}
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
                              aria-label={t("options.enableSite")}
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
                    {t("options.sitesFooter", { on: sitesTotalOn, total: sitesTotal })}
                  </span>
                  <div className="sites-footer-spacer" />
                  <button type="button" className="lnk" onClick={() => setSitesOnlyActive((v) => !v)}>
                    {sitesOnlyActive ? t("options.showAll") : t("options.showActive")}
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
                    <span>{modsChecking ? t("options.checking") : t("options.checkUpdateBtn")}</span>
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
                      {t("options.showWarn")}
                    </button>
                    <button
                      type="button"
                      className="mods-chk"
                      aria-pressed={modsPreferLocal}
                      onClick={() => {
                        setModsPreferLocal((v) => !v);
                        setDirty(true);
                      }}
                    >
                      <span className={`sites-cb${modsPreferLocal ? " on" : ""}`} style={{ ["--ico" as string]: ICO.check }}>
                        <span className="sites-cb-mk" />
                      </span>
                      {t("options.preferLocal")}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="mods-chk"
                    onClick={() => void undoModulesUpdate()}
                    title={t("options.undoLastTitle")}
                  >
                    <Icon ico={ICO.refresh} className="ico ico-sm" />
                    {t("options.undoLast")}
                  </button>
                  <div className="sites-toolbar-spacer" />
                  <div className="sites-search-wrap mods-search-wrap">
                    <Icon ico={ICO.search} className="ico ico-sm sites-search-ico" />
                    <input
                      id="mods-q"
                      className="st-field"
                      type="text"
                      placeholder={t("options.modsSearch")}
                      autoComplete="off"
                      spellCheck={false}
                      value={modsQuery}
                      onChange={(e) => setModsQuery(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sites-clear"
                      hidden={!modsQuery.trim()}
                      title={t("common.clear")}
                      onClick={() => setModsQuery("")}
                    >
                      <Icon ico={ICO.x} className="ico ico-sm" />
                    </button>
                  </div>
                </div>

                <div className="mods-source">
                  <button
                    type="button"
                    className="mods-source-head"
                    aria-expanded={modsSourceOpen}
                    onClick={() => setModsSourceOpen((v) => !v)}
                  >
                    <Icon
                      ico={ICO.chevron}
                      className="ico ico-sm"
                      style={{ transform: modsSourceOpen ? "none" : "rotate(-90deg)" }}
                    />
                    <span>{t("options.sourceBackup")}</span>
                    <span className="mods-source-current ell">
                      {modsPinnedCount
                        ? t("options.githubPinned", { n: modsPinnedCount })
                        : t("options.githubPlain")}
                    </span>
                  </button>
                  {modsSourceOpen ? (
                    <div className="st-nest-inner mods-source-body">
                      <OptRow
                        label={t("options.official.label")}
                        desc={t("options.official.desc")}
                      >
                        <span className="st-static mono">GitHub · dazedcat19/FMD2</span>
                      </OptRow>
                      <SwitchRow
                        id="opt-mods-overlay"
                        label={t("options.overlay.label")}
                        desc={t("options.overlay.desc")}
                        checked={modsOverlay}
                        onChange={(v) => {
                          setModsOverlay(v);
                          setDirty(true);
                        }}
                      />
                      {modsOverlay ? (
                        <div className="st-row">
                          <div className="st-form-inline">
                            <span className="st-form-key">{t("options.overlay.owner")}</span>
                            <input
                              className="st-field st-mono"
                              type="text"
                              value={modsOverlayOwner}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(e) => {
                                setModsOverlayOwner(e.target.value);
                                setDirty(true);
                              }}
                            />
                            <span className="st-form-key">{t("options.overlay.repo")}</span>
                            <input
                              className="st-field st-mono"
                              type="text"
                              value={modsOverlayName}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(e) => {
                                setModsOverlayName(e.target.value);
                                setDirty(true);
                              }}
                            />
                            <span className="st-form-key">{t("options.overlay.branch")}</span>
                            <input
                              className="st-field st-mono"
                              type="text"
                              value={modsOverlayRef}
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(e) => {
                                setModsOverlayRef(e.target.value);
                                setDirty(true);
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                      <SwitchRow
                        id="opt-mods-prefer-local"
                        label={t("options.preferIfNewer.label")}
                        desc={t("options.preferIfNewer.desc")}
                        checked={modsPreferLocal}
                        onChange={(v) => {
                          setModsPreferLocal(v);
                          setDirty(true);
                        }}
                      />
                      <SwitchRow
                        id="opt-mods-meta"
                        label={t("options.fetchMeta.label")}
                        desc={t("options.fetchMeta.desc")}
                        checked={modsFetchMeta}
                        onChange={(v) => {
                          setModsFetchMeta(v);
                          setDirty(true);
                        }}
                      />
                      <BoundStepperRow
                        id="opt-mods-gens"
                        label={t("options.backupGens.label")}
                        desc={t("options.backupGens.desc")}
                        value={modsBackupGens}
                        min={1}
                        max={50}
                        onChange={(v) => {
                          setModsBackupGens(v);
                          setDirty(true);
                        }}
                      />
                      <BoundStepperRow
                        id="opt-mods-mb"
                        label={t("options.backupMb.label")}
                        desc={t("options.backupMb.desc", { size: formatMb(modsBackupBytes) })}
                        value={modsBackupMb}
                        min={8}
                        max={2048}
                        unit="MB"
                        onChange={(v) => {
                          setModsBackupMb(v);
                          setDirty(true);
                        }}
                      />
                      <OptRow
                        label={t("options.clearBackups.label")}
                        desc={t("options.clearBackups.desc")}
                      >
                        <button
                          type="button"
                          className={`secondary${modsBackupFlash === "done" ? " is-saved" : ""}`}
                          disabled={modsBackupFlash === "working" || modsBackupBytes === 0}
                          onClick={() => void clearModulesBackups()}
                        >
                          {modsBackupFlash === "working"
                            ? t("options.logClearing")
                            : modsBackupFlash === "done"
                              ? t("common.ready")
                              : modsBackupFlash === "error"
                                ? t("common.error")
                                : t("options.clearBackups.button")}
                        </button>
                      </OptRow>
                    </div>
                  ) : null}
                </div>

                {modsPending.total > 0 && !modulesJob && !modsBannerHidden ? (
                  <div className="mods-banner" role="status">
                    <Icon ico={ICO.info} className="ico ico-sm" />
                    <span className="ell">
                      {t("options.pendingBanner", {
                        summary: modulesPending ? summarizeCheck(modulesPending) : modsPending.summary,
                      })}
                    </span>
                    <div className="sites-footer-spacer" />
                    <button type="button" className="lnk" onClick={() => void runModulesCheck()}>
                      {t("options.updateNow")}
                    </button>
                    <button
                      type="button"
                      className="lnk"
                      onClick={() => setModsBannerHidden(true)}
                    >
                      {t("common.hide")}
                    </button>
                  </div>
                ) : null}

                <div className="mods-list-wrap">
                  <div className="mods-head">
                    <span>{t("options.colFile")}</span>
                    <span>{t("options.colWhen")}</span>
                    <span>{t("options.colMsg")}</span>
                    <span />
                  </div>
                  <div className="mods-list" id="mods-list" ref={modsListRef} onScroll={onModsScroll}>
                    {modRows.length === 0 ? (
                      <div className="sites-tree-empty">
                        <div className="sites-empty-title">{t("options.noModules")}</div>
                        <div className="sites-empty-desc">
                          {t("options.noLuaRepo")}
                        </div>
                      </div>
                    ) : modsFlat.length === 0 ? (
                      <div className="sites-tree-empty">
                        <div className="sites-empty-title">{t("options.noMatches")}</div>
                        <div className="sites-empty-desc">{t("options.noModMatch")}</div>
                      </div>
                    ) : (
                      <div className="mods-virtual" style={{ height: modsFlat.length * MOD_ROW_H }}>
                        {modsFlat.slice(modsRange.start, modsRange.end).map((row, i) => {
                          const idx = modsRange.start + i;
                          const top = idx * MOD_ROW_H;
                          return (
                            <div
                              key={row.key}
                              className={`mods-row${row.updated ? " updated" : ""}${
                                row.pinned ? " pinned" : ""
                              }`}
                              style={{ top }}
                            >
                              <div className="mods-name">
                                <Icon ico={ICO.file} className="ico ico-sm" style={{ color: "var(--muted)" }} />
                                <span className="ell mods-file">{row.file}</span>
                                {row.badge ? <span className="mods-new">{row.badge}</span> : null}
                              </div>
                              <span className="mods-when" title={row.dateTitle}>
                                {row.when}
                              </span>
                              <span
                                className={`ell mods-msg${row.msg === "—" ? " muted" : ""}`}
                                title={row.pinOrigin ?? undefined}
                              >
                                {row.msg}
                              </span>
                              <div className="mods-actions">
                                {row.pinned ? (
                                  <button
                                    type="button"
                                    className="sites-tbtn"
                                    title={t("options.unpinTitle")}
                                    onClick={() => void unpinModuleFile(row.file)}
                                  >
                                    {t("options.unpin")}
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="sites-tbtn"
                                      title={t("options.pinTitle")}
                                      onClick={() => void pinModuleFile(row.file)}
                                    >
                                      {t("options.pin")}
                                    </button>
                                    <button
                                      type="button"
                                      className="sites-tbtn"
                                      title={t("options.revertTitle")}
                                      onClick={() => void revertModuleFile(row.file)}
                                    >
                                      {t("options.revert")}
                                    </button>
                                  </>
                                )}
                              </div>
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
                    {t("options.modsFooter", { n: modRows.length - modsSupportCount })}
                    {modsShowSupport ? t("options.supportCount", { n: modsSupportCount }) : ""}
                    {modsUpdatedCount ? t("options.changedCount", { n: modsUpdatedCount }) : ""}
                  </span>
                  <div className="sites-footer-spacer" />
                  <button
                    type="button"
                    className="lnk"
                    onClick={() => setModsShowSupport((v) => !v)}
                    title={t("options.supportTitle")}
                  >
                    {modsShowSupport
                      ? t("options.hideSupport")
                      : t("options.showSupport", { n: modsSupportCount })}
                  </button>
                  <button type="button" className="lnk" onClick={() => setModsOnlyUpdated((v) => !v)}>
                    {modsOnlyUpdated ? t("options.showAll") : t("options.showUpdated")}
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
              {t("common.saved")}
            </span>
          ) : saveFlash === "error" ? (
            <span className="options-save-err" id="opt-save-err" role="status">
              {t("options.saveError")}
            </span>
          ) : dirty ? (
            <span className="options-dirty" id="opt-dirty">
              {t("options.dirty")}
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
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={`btn${saveFlash === "saved" ? " is-saved" : ""}`}
            id="set-save"
            disabled={saveFlash === "saving"}
            onClick={() => void handleSave()}
          >
            {saveFlash === "saving" ? t("common.saving") : saveFlash === "saved" ? t("common.saved") : t("common.apply")}
          </button>
        </footer>
      </div>
    </section>
  );
}
