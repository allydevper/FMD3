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
import { Icon } from "../components/Icon";
import { ICO } from "../icons";
import { DEFAULT_USER_AGENT, RENAME_SAMPLE, PACK_EXT } from "../constants";
import * as api from "../api/tauri";
import { useApp } from "../context/AppContext";
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
  packFormat: string;
  patManga: string;
  patChapter: string;
  patPage: string;
  outputDirField: string;
  extOn: boolean;
  logOn: boolean;
  mangaFolderOn: boolean;
  chapterFolderOn: boolean;
  volPadOn: boolean;
  chapPadOn: boolean;
  asciiOn: boolean;
  asciiChar: string;
  favIntervalOn: boolean;
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
  packFormat: "none",
  patManga: "%MANGA%",
  patChapter: "%CHAPTER%",
  patPage: "%FILENAME%",
  outputDirField: "",
  extOn: false,
  logOn: false,
  mangaFolderOn: true,
  chapterFolderOn: true,
  volPadOn: true,
  chapPadOn: true,
  asciiOn: false,
  asciiChar: "_",
  favIntervalOn: true,
};

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

function resolveRenamePattern(pattern: string): string {
  let out = pattern || "";
  for (const [token, value] of Object.entries(RENAME_SAMPLE)) {
    out = out.split(token).join(value);
  }
  return out;
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

function OptRow({ label, desc, children }: { label: string; desc: string; children: ReactNode }) {
  return (
    <div className="st-row">
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
}: {
  id?: string;
  label: string;
  desc: string;
  warn?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="st-row click">
      <div className="st-meta">
        <div className="st-label">
          {label}
          {warn ? <span className="st-warn">{warn}</span> : null}
        </div>
        <div className="st-desc">{desc}</div>
      </div>
      <span className="st-switch">
        <input id={id} className="opt-stub" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="sw" aria-hidden="true">
          <span className="knob" />
        </span>
      </span>
    </label>
  );
}

function StubSwitchRow({
  id,
  label,
  desc,
  warn,
  defaultChecked = false,
  onDirty,
}: {
  id?: string;
  label: string;
  desc: string;
  warn?: string;
  defaultChecked?: boolean;
  onDirty: () => void;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <SwitchRow
      id={id}
      label={label}
      desc={desc}
      warn={warn}
      checked={checked}
      onChange={(v) => {
        setChecked(v);
        onDirty();
      }}
    />
  );
}

function StubSelectRow({
  id,
  label,
  desc,
  options,
  defaultValue,
  onDirty,
}: {
  id?: string;
  label: string;
  desc: string;
  options: { value: string; label: string }[];
  defaultValue: string;
  onDirty: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <OptRow label={label} desc={desc}>
      <div className="st-select filter-select-wrap">
        <select
          id={id}
          className="opt-stub"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            onDirty();
          }}
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

function StubStepperRow({
  id,
  label,
  desc,
  defaultValue,
  min,
  max,
  suffix,
  unit,
  onDirty,
}: {
  id?: string;
  label: string;
  desc: string;
  defaultValue: number;
  min: number;
  max: number;
  suffix?: string;
  unit?: string;
  onDirty: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <OptRow label={label} desc={desc}>
      <div className="st-num-wrap">
        <Stepper
          id={id}
          value={value}
          min={min}
          max={max}
          suffix={suffix}
          onChange={(v) => {
            setValue(v);
            onDirty();
          }}
        />
        {unit ? <span className="st-unit">{unit}</span> : null}
      </div>
    </OptRow>
  );
}

function StubRangeRow({
  label,
  desc,
  defaultValue,
  min,
  max,
  onDirty,
}: {
  label: string;
  desc: string;
  defaultValue: number;
  min: number;
  max: number;
  onDirty: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <OptRow label={label} desc={desc}>
      <input
        className="st-range opt-stub"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          setValue(Number(e.target.value));
          onDirty();
        }}
      />
    </OptRow>
  );
}

function StubPlainInput({
  defaultValue,
  placeholder,
  mono,
  onDirty,
}: {
  defaultValue: string;
  placeholder?: string;
  mono?: boolean;
  onDirty: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <input
      className={`st-field opt-stub${mono ? " st-mono" : ""}`}
      type="text"
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        onDirty();
      }}
    />
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
  const { activeNav, log, outputDir, setOutputDir, modules, refreshModules } = useApp();

  const [optTab, setOptTab] = useState<OptTabId>("general");
  const [dirty, setDirty] = useState(false);
  const [s, setS] = useState<OptionsFormState>(DEFAULT_SETTINGS);

  const outputDirRef = useRef(outputDir);
  useEffect(() => {
    outputDirRef.current = outputDir;
  }, [outputDir]);

  const markDirty = useCallback(() => setDirty(true), []);

  const update = useCallback(<K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) => {
    setS((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  /* ---- Cargar / guardar ajustes reales ---- */

  const loadSettings = useCallback(async () => {
    const get = (k: string) => api.settingsGet(k);
    const savedUa = ((await get("http.user_agent")) ?? "").trim();
    const proxyRaw = (await get("http.proxy")) ?? "";
    const parsed = parseProxyUrl(proxyRaw);
    const threadsRaw = (await get("download.max_threads")) ?? "1";
    const packRaw = (await get("download.pack_format")) ?? "none";
    const packOk = (PACK_FORMATS as readonly string[]).includes(packRaw) ? packRaw : "none";
    const patM = (await get("download.manga_folder_pattern")) ?? "%MANGA%";
    const patC = (await get("download.chapter_folder_pattern")) ?? "%CHAPTER%";
    const patP = (await get("download.page_name_pattern")) ?? "%FILENAME%";
    const savedDir = (await get("default_output_dir")) ?? outputDirRef.current ?? "";
    setS((prev) => ({
      ...prev,
      ua: savedUa || DEFAULT_USER_AGENT,
      useProxy: Boolean(proxyRaw.trim()),
      proxyType: parsed.type,
      proxyHost: parsed.host,
      proxyPort: parsed.port,
      proxyUser: parsed.user,
      proxyPass: parsed.pass,
      threads: Number(threadsRaw) || 1,
      packFormat: packOk,
      patManga: patM,
      patChapter: patC,
      patPage: patP,
      outputDirField: savedDir,
    }));
    setDirty(false);
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSave = useCallback(async () => {
    const uaVal = s.ua.trim();
    await api.settingsSet("http.user_agent", uaVal === DEFAULT_USER_AGENT ? "" : uaVal);
    await api.settingsSet(
      "http.proxy",
      s.useProxy ? composeProxyUrl(s.proxyType, s.proxyHost, s.proxyPort, s.proxyUser, s.proxyPass) : "",
    );
    await api.settingsSet("download.max_threads", String(s.threads));
    await api.settingsSet("download.pack_format", s.packFormat);
    await api.settingsSet("download.manga_folder_pattern", s.patManga);
    await api.settingsSet("download.chapter_folder_pattern", s.patChapter);
    await api.settingsSet("download.page_name_pattern", s.patPage);
    const dir = s.outputDirField.trim();
    if (dir) {
      await api.settingsSet("default_output_dir", dir);
      setOutputDir(dir);
    }
    setDirty(false);
    log("Ajustes guardados", "ok");
  }, [s, setOutputDir, log]);

  const handleBrowseOutputDir = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    update("outputDirField", dir);
  }, [update]);

  /* ---- Vista previa de renombrado ---- */

  const renamePreview = useMemo(() => {
    const root = (s.outputDirField.trim() || "C:\\Users\\WILMER\\Desktop\\manga").replace(/[\\/]+$/, "");
    const parts = [root];
    if (s.mangaFolderOn) parts.push(resolveRenamePattern(s.patManga || "%MANGA%") || "Manga");
    if (s.chapterFolderOn) parts.push(resolveRenamePattern(s.patChapter || "%CHAPTER%") || "003");
    const leaf = resolveRenamePattern(s.patPage || "%FILENAME%") || "003";
    let out = `${parts.join("\\")}\\${leaf}${PACK_EXT[s.packFormat] ?? ""}`;
    if (s.asciiOn) {
      const repl = s.asciiChar || "_";
      out = out.replace(/[^\x00-\x7F]/g, repl);
    }
    return out;
  }, [
    s.outputDirField,
    s.mangaFolderOn,
    s.patManga,
    s.chapterFolderOn,
    s.patChapter,
    s.patPage,
    s.packFormat,
    s.asciiOn,
    s.asciiChar,
  ]);

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

  /* ---- Campos "stub" con revelado propio (no persistidos) ---- */

  const [pdfQuality, setPdfQuality] = useState(100);
  const [volDigits, setVolDigits] = useState(2);
  const [chapDigits, setChapDigits] = useState(3);
  const [favIntervalMin, setFavIntervalMin] = useState(60);

  /* ---- Panel Sitios Web ---- */

  const [sitesTab, setSitesTab] = useState<SitesTabId>("list");
  const [sitesQuery, setSitesQuery] = useState("");
  const [sitesOnlyActive, setSitesOnlyActive] = useState(false);
  const [siteOn, setSiteOn] = useState<Record<string, true>>({});
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
    const alive = new Set(modules.map((m) => m.id));
    setSiteOn((prev) => {
      let changed = false;
      const next: Record<string, true> = {};
      for (const id of Object.keys(prev)) {
        if (alive.has(id)) next[id] = true;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [modules]);

  const { flat: sitesFlat, total: sitesTotal, totalOn: sitesTotalOn } = useMemo(
    () => buildSitesFlat(siteGroups, sitesQuery, sitesOnlyActive, expanded, siteOn),
    [siteGroups, sitesQuery, sitesOnlyActive, expanded, siteOn],
  );

  const allSiteIds = useMemo(() => siteGroups.flatMap((g) => g.sites.map((st) => st.id)), [siteGroups]);

  const setSitesOn = useCallback((ids: string[], on: boolean) => {
    setSiteOn((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        if (on) next[id] = true;
        else delete next[id];
      }
      return next;
    });
    setDirty(true);
  }, []);

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
                      <StubSelectRow
                        label="Tema"
                        desc="Apariencia clara, oscura o según el sistema"
                        defaultValue="Sistema"
                        onDirty={markDirty}
                        options={[
                          { value: "Sistema", label: "Sistema" },
                          { value: "Claro", label: "Claro" },
                          { value: "Oscuro", label: "Oscuro" },
                        ]}
                      />
                      <StubSelectRow
                        label="Tras terminar"
                        desc="Acción al completar todas las descargas"
                        defaultValue="nada"
                        onDirty={markDirty}
                        options={[
                          { value: "nada", label: "No hacer nada" },
                          { value: "exit", label: "Salir del programa" },
                          { value: "shutdown", label: "Apagar equipo" },
                          { value: "suspend", label: "Suspender" },
                        ]}
                      />
                      <StubStepperRow
                        id="opt-new-days"
                        label="Marcar manga como nuevo"
                        desc="Días desde la última actualización"
                        defaultValue={1}
                        min={1}
                        max={365}
                        unit="días"
                        onDirty={markDirty}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.sliders} className="ico ico-sm" />
                      <h2>Comportamiento</h2>
                    </div>
                    <div className="st-card">
                      <StubSwitchRow label="Minimizar al iniciar" desc="Arranca en la bandeja del sistema" onDirty={markDirty} />
                      <StubSwitchRow
                        label="Minimizar a la bandeja"
                        desc="Al cerrar, oculta en la bandeja en vez de salir"
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Permitir solo una instancia"
                        desc="Evita abrir la app dos veces"
                        defaultChecked
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Búsqueda en vivo"
                        desc="Filtra mientras escribes (lento en listas largas)"
                        defaultChecked
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Borrar tareas completadas al cerrar"
                        desc="Limpia la cola de descargas al salir"
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Ordenar descargas al añadir tareas"
                        desc="Reordena la cola automáticamente"
                        onDirty={markDirty}
                      />
                      <StubSwitchRow label="Vacuum de bases al salir" desc="Compacta las bases de datos al cerrar" onDirty={markDirty} />
                      <StubSwitchRow
                        label="Rutas de nombre largo"
                        warn="Cuidado"
                        desc="Permite rutas de más de 260 caracteres"
                        onDirty={markDirty}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.external} className="ico ico-sm" />
                      <h2>Programa externo</h2>
                    </div>
                    <div className="st-card">
                      <SwitchRow
                        id="opt-external"
                        label="Abrir manga con programa externo"
                        desc="Usa otra aplicación para abrir los capítulos"
                        checked={s.extOn}
                        onChange={(v) => update("extOn", v)}
                      />
                      <div className="st-row st-row-stack" hidden={!s.extOn}>
                        <div className="st-form-grid">
                          <label>Ruta</label>
                          <StubPlainInput
                            defaultValue=""
                            placeholder="C:\Program Files\...\visor.exe"
                            mono
                            onDirty={markDirty}
                          />
                          <label>Parámetros</label>
                          <StubPlainInput defaultValue="%PATH%%CHAPTER%" placeholder="%PATH%%CHAPTER%" mono onDirty={markDirty} />
                        </div>
                      </div>
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
                            <StubPlainInput defaultValue="fmd.log" mono onDirty={markDirty} />
                          </div>
                        </div>
                        <div className="st-row st-row-actions">
                          <button
                            type="button"
                            className="secondary opt-stub"
                            onClick={() => log("Borrar archivo de log: próximamente", "ok")}
                          >
                            Borrar archivo de log
                          </button>
                          <button type="button" className="secondary opt-stub" onClick={() => log("Abrir log: próximamente", "ok")}>
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
                      <Icon ico={ICO.layout} className="ico ico-sm" />
                      <h2>Drop Box</h2>
                    </div>
                    <div className="st-card">
                      <StubSwitchRow label="Mostrar Drop Box" desc="Ventana flotante para soltar enlaces" onDirty={markDirty} />
                      <StubSelectRow
                        label="Modo"
                        desc="Qué hacer con los enlaces soltados"
                        defaultValue="download"
                        onDirty={markDirty}
                        options={[
                          { value: "download", label: "Descargar todo" },
                          { value: "favorite", label: "Añadir a favoritos" },
                        ]}
                      />
                      <StubRangeRow label="Opacidad" desc="Transparencia de la ventana Drop Box" defaultValue={255} min={5} max={255} onDirty={markDirty} />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.sliders} className="ico ico-sm" />
                      <h2>Interfaz</h2>
                    </div>
                    <div className="st-card">
                      <StubSwitchRow label="Mostrar barra de descargas" desc="Toolbar superior en la cola" defaultChecked onDirty={markDirty} />
                      <StubSwitchRow
                        label="Botón borrar completadas"
                        desc="Mostrar «Borrar todas las tareas completadas»"
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Barra izquierda de descargas"
                        desc="Controles adicionales a la izquierda"
                        defaultChecked
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Cargar portada del manga"
                        desc="Descarga y muestra la imagen de portada"
                        defaultChecked
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Globo de notificación"
                        desc="Avisos del sistema al completar tareas"
                        defaultChecked
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Ir a Descargas al añadir"
                        desc="Cambia a la vista Descargas al crear tareas"
                        defaultChecked
                        onDirty={markDirty}
                      />
                      <StubSwitchRow
                        label="Ir a Favoritos al añadir manga"
                        desc="Cambia a Favoritos al guardar un título"
                        onDirty={markDirty}
                      />
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
                      <StubStepperRow label="Tareas en paralelo" desc="Mangas descargando a la vez" defaultValue={1} min={1} max={8} onDirty={markDirty} />
                      <OptRow label="Archivos por tarea" desc="Hilos de descarga dentro de un capítulo">
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
                      <StubStepperRow label="Reintentos de tarea" desc="Si la tarea falla, cuántas veces reintentar" defaultValue={1} min={0} max={10} onDirty={markDirty} />
                      <StubSwitchRow
                        label="Reiniciar desde capítulos fallidos"
                        desc="Continúa siempre desde el último fallo"
                        defaultChecked
                        onDirty={markDirty}
                      />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.sliders} className="ico ico-sm" />
                      <h2>Misceláneo</h2>
                    </div>
                    <div className="st-card">
                      <StubStepperRow label="Hilos de favoritos" desc="Comprobaciones de favoritos a la vez" defaultValue={1} min={1} max={32} onDirty={markDirty} />
                      <StubStepperRow label="Hilos de actualizar lista" desc="Paralelismo al actualizar el catálogo" defaultValue={1} min={1} max={32} onDirty={markDirty} />
                      <StubStepperRow label="Hilos en segundo plano" desc="Cargas en background" defaultValue={1} min={1} max={32} onDirty={markDirty} />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.link} className="ico ico-sm" />
                      <h2>Red</h2>
                    </div>
                    <div className="st-card">
                      <StubStepperRow label="Timeout" desc="Segundos de espera de conexión" defaultValue={30} min={1} max={300} suffix="s" onDirty={markDirty} />
                      <StubStepperRow
                        label="Reintentos de conexión"
                        desc="−1 = reintentar siempre"
                        defaultValue={5}
                        min={-1}
                        max={5}
                        onDirty={markDirty}
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
                              className="st-field st-mono opt-stub"
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
                              className="st-field st-mono opt-stub"
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
                      <div className="st-row" id="set-pdf-quality-row" hidden={s.packFormat !== "pdf"}>
                        <div className="st-meta">
                          <div className="st-label">Calidad del PDF</div>
                          <div className="st-desc">Menor calidad, archivos más ligeros</div>
                        </div>
                        <div className="st-num-wrap">
                          <Stepper
                            id="set-pdf-quality"
                            value={pdfQuality}
                            min={5}
                            max={100}
                            suffix="%"
                            onChange={(v) => {
                              setPdfQuality(v);
                              markDirty();
                            }}
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
                      <StubSwitchRow
                        id="set-png-as-jpeg"
                        label="Guardar PNG como JPEG"
                        desc="Reduce mucho el peso; pierde la transparencia"
                        onDirty={markDirty}
                      />
                      <StubSelectRow
                        id="set-webp-as"
                        label="Guardar WebP como"
                        desc="Formato al convertir imágenes WebP"
                        defaultValue="1"
                        onDirty={markDirty}
                        options={[
                          { value: "0", label: "WebP" },
                          { value: "1", label: "PNG" },
                          { value: "2", label: "JPEG" },
                        ]}
                      />
                      <StubSelectRow
                        id="set-png-level"
                        label="Compresión PNG"
                        desc="Más compresión, guardado más lento"
                        defaultValue="1"
                        onDirty={markDirty}
                        options={[
                          { value: "0", label: "Ninguno" },
                          { value: "1", label: "El más rápido" },
                          { value: "2", label: "Predeterminado" },
                          { value: "3", label: "Máximo" },
                        ]}
                      />
                      <StubStepperRow
                        id="set-jpeg-quality"
                        label="Calidad JPEG"
                        desc="Aplica a las imágenes convertidas a JPEG"
                        defaultValue={80}
                        min={1}
                        max={100}
                        suffix="%"
                        onDirty={markDirty}
                      />
                    </div>
                  </section>

                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.file} className="ico ico-sm" />
                      <h2>Renombrado</h2>
                    </div>
                    <div className="st-card">
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
                          <div className="st-desc">Plantilla del nombre de carpeta del manga</div>
                        </div>
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
                        <TokenInsert tokens={TOKENS_MANGA} onInsert={(t) => insertTokenInto(patMangaRef, "patManga", t)} />
                      </div>

                      <SwitchRow
                        id="set-chapter-folder"
                        label="Carpeta por capítulo"
                        desc="Cada capítulo en su propia subcarpeta"
                        checked={s.chapterFolderOn}
                        onChange={(v) => update("chapterFolderOn", v)}
                      />
                      <div className="st-row st-row-stack" hidden={!s.chapterFolderOn}>
                        <div className="st-meta">
                          <div className="st-label">Patrón del capítulo</div>
                          <div className="st-desc">Plantilla del nombre de carpeta del capítulo</div>
                        </div>
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
                        <TokenInsert tokens={TOKENS_CHAPTER} onInsert={(t) => insertTokenInto(patChapterRef, "patChapter", t)} />
                      </div>

                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">Nombre del archivo</div>
                          <div className="st-desc">Plantilla del archivo final</div>
                        </div>
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
                        <TokenInsert tokens={TOKENS_PAGE} onInsert={(t) => insertTokenInto(patPageRef, "patPage", t)} />
                      </div>

                      <StubSwitchRow
                        id="set-remove-manga-name"
                        label="Quitar el nombre del manga del capítulo"
                        desc="Evita repetir el título en cada capítulo"
                        onDirty={markDirty}
                      />

                      <SwitchRow
                        id="set-vol-pad"
                        label="Rellenar el volumen con ceros"
                        desc="v2 se convierte en v02"
                        checked={s.volPadOn}
                        onChange={(v) => update("volPadOn", v)}
                      />
                      <div className="st-nest" hidden={!s.volPadOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-vol-digits">Dígitos</label>
                            <Stepper id="set-vol-digits" value={volDigits} min={1} max={4} onChange={(v) => { setVolDigits(v); markDirty(); }} />
                          </div>
                        </div>
                      </div>

                      <SwitchRow
                        id="set-chap-pad"
                        label="Rellenar el capítulo con ceros"
                        desc="3 se convierte en 003"
                        checked={s.chapPadOn}
                        onChange={(v) => update("chapPadOn", v)}
                      />
                      <div className="st-nest" hidden={!s.chapPadOn}>
                        <div className="st-nest-inner">
                          <div className="st-nest-row">
                            <label htmlFor="set-chap-digits">Dígitos</label>
                            <Stepper id="set-chap-digits" value={chapDigits} min={1} max={5} onChange={(v) => { setChapDigits(v); markDirty(); }} />
                          </div>
                        </div>
                      </div>

                      <SwitchRow
                        id="set-replace-ascii"
                        label="Reemplazar caracteres no ASCII"
                        desc="Evita nombres inválidos en algunos sistemas"
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

                      <div className="st-row st-row-stack">
                        <div className="st-meta">
                          <div className="st-label">Resultado</div>
                          <div className="st-desc">Ejemplo con el capítulo 3 de un manga de tu lista</div>
                        </div>
                        <div id="set-rename-preview" className="st-preview" aria-live="polite">
                          {renamePreview}
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
                      <StubSwitchRow label="Comprobar versión al iniciar" desc="Busca actualizaciones de la app" defaultChecked onDirty={markDirty} />
                      <StubSwitchRow
                        label="No cargar info al actualizar lista"
                        desc="Más rápido; el filtro avanzado no funcionará"
                        onDirty={markDirty}
                      />
                    </div>
                  </section>
                  <section className="st-section">
                    <div className="st-section-head">
                      <Icon ico={ICO.heart} className="ico ico-sm" />
                      <h2>Favoritos</h2>
                    </div>
                    <div className="st-card">
                      <StubSwitchRow label="Comprobar al iniciar" desc="Busca capítulos nuevos al arrancar" defaultChecked onDirty={markDirty} />
                      <StubSwitchRow label="Abrir Favoritos al iniciar" desc="Muestra esa vista al abrir la app" onDirty={markDirty} />
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
                                value={favIntervalMin}
                                min={1}
                                max={1440}
                                wide
                                onChange={(v) => {
                                  setFavIntervalMin(v);
                                  markDirty();
                                }}
                              />
                              <span className="st-unit">min</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <StubSwitchRow label="Descargar tras comprobar" desc="Encola capítulos nuevos automáticamente" onDirty={markDirty} />
                      <StubSwitchRow label="Quitar mangas completados" desc="Los elimina de Favoritos al terminar" onDirty={markDirty} />
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
                      <StubSwitchRow label="Salir" desc="Pedir confirmación antes de cerrar" defaultChecked onDirty={markDirty} />
                      <StubSwitchRow label="Borrar descarga / manga / favorito" desc="Confirmar eliminaciones" defaultChecked onDirty={markDirty} />
                      <StubSwitchRow
                        label="Descargar lista si está vacía"
                        desc="Preguntar antes de Update List"
                        defaultChecked
                        onDirty={markDirty}
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
                          <div key={row.key} className="sites-trow sites-trow-site" style={{ top }}>
                            <button
                              type="button"
                              className={`sites-cb${row.on ? " on" : ""}`}
                              style={{ ["--ico" as string]: ICO.check }}
                              aria-label="Activar sitio"
                              onClick={() => setSitesOn([row.id], !row.on)}
                            >
                              <span className="sites-cb-mk" />
                            </button>
                            <span className="sites-site-label" style={{ color: row.on ? "var(--text)" : "var(--muted)" }}>
                              {row.name}
                            </span>
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
          <span className="options-dirty" id="opt-dirty" hidden={!dirty}>
            Cambios sin guardar
          </span>
          <div className="options-footer-spacer" />
          <button type="button" className="secondary" id="set-cancel" onClick={() => void loadSettings()}>
            Cancelar
          </button>
          <button type="button" className="btn" id="set-save" onClick={() => void handleSave()}>
            Aplicar
          </button>
        </footer>
      </div>
    </section>
  );
}
