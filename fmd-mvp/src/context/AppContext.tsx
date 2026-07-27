import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SK, THEME_KEY } from "../constants";
import type {
  CatalogJobMode,
  CatalogJobScope,
  CatalogJobState,
  ModuleMeta,
  NavId,
} from "../types";
import * as api from "../api/tauri";

export type LogKind = "ok" | "err" | "";
export type AppTheme = "system" | "light" | "dark";

export type StartCatalogJobArgs = {
  mode: CatalogJobMode;
  scope: CatalogJobScope;
  /** Required when scope is "one". */
  moduleId?: string | null;
};

type AppContextValue = {
  activeNav: NavId;
  setActiveNav: (nav: NavId) => void;
  darkTheme: boolean;
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  logOpen: boolean;
  setLogOpen: (open: boolean) => void;
  toggleLog: () => void;
  logLines: { text: string; kind: LogKind }[];
  log: (msg: string, kind?: LogKind) => void;
  clearLog: () => void;
  modules: ModuleMeta[];
  setModules: (mods: ModuleMeta[]) => void;
  selectedModuleId: string | null;
  setSelectedModuleId: (id: string | null) => void;
  currentModule: ModuleMeta | undefined;
  outputDir: string;
  setOutputDir: (dir: string) => void;
  /** Layout: search panel compact (< 860px). */
  narrow: boolean;
  /** Layout: hide right info sidebar (< 1040px). */
  hideInfo: boolean;
  /** Layout: show right info sidebar when manga/stub is open. */
  showMangaInfo: boolean;
  setShowMangaInfo: (open: boolean) => void;
  refreshModules: () => Promise<ModuleMeta[]>;
  /** Opt-in website IDs from Settings (modules.enabled). */
  enabledModuleIds: Set<string>;
  refreshEnabledModules: () => Promise<Set<string>>;
  /** Favorites auto-check interval (Options + Favorites footer). */
  favAutoCheck: boolean;
  setFavAutoCheck: (on: boolean) => Promise<void>;
  catalogJob: CatalogJobState | null;
  /** Bumps when a catalog job finishes (success or cancel) so Info can refresh. */
  catalogJobDoneSeq: number;
  lastCatalogJobModuleIds: string[];
  startCatalogJob: (args: StartCatalogJobArgs) => Promise<void>;
  cancelCatalogJob: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

function layoutFromWidth(w: number) {
  return {
    narrow: w < 860,
    hideInfo: w < 1040,
  };
}

function resolveDark(theme: AppTheme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
}

function parseTheme(raw: string | null): AppTheme {
  const v = (raw || "").trim().toLowerCase();
  if (v === "light" || v === "claro") return "light";
  if (v === "dark" || v === "oscuro") return "dark";
  if (v === "system" || v === "sistema" || v === "") return "system";
  return "system";
}

function parseBool(raw: string | null, def = false): boolean {
  if (raw == null || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [activeNav, setActiveNav] = useState<NavId>("info");
  const [theme, setThemeState] = useState<AppTheme>("system");
  const [darkTheme, setDarkTheme] = useState(() => localStorage.getItem(THEME_KEY) === "1");
  const [logOpen, setLogOpen] = useState(false);
  const [logLines, setLogLines] = useState<{ text: string; kind: LogKind }[]>([
    { text: "Listo.", kind: "" },
  ]);
  const [modules, setModules] = useState<ModuleMeta[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState("");
  const [showMangaInfo, setShowMangaInfo] = useState(false);
  const [enabledModuleIds, setEnabledModuleIds] = useState<Set<string>>(() => new Set());
  const [favAutoCheck, setFavAutoCheckState] = useState(true);
  const [catalogJob, setCatalogJob] = useState<CatalogJobState | null>(null);
  const [catalogJobDoneSeq, setCatalogJobDoneSeq] = useState(0);
  const [lastCatalogJobModuleIds, setLastCatalogJobModuleIds] = useState<string[]>([]);
  const catalogJobRunningRef = useRef(false);
  const catalogCancelRequestedRef = useRef(false);
  const catalogJobRef = useRef<CatalogJobState | null>(null);
  const [{ narrow, hideInfo }, setLayout] = useState(() =>
    layoutFromWidth(typeof window !== "undefined" ? window.innerWidth : 1280),
  );
  const favIntervalRef = useRef<number | null>(null);
  const favDownloadAfterRef = useRef(false);
  const bootDoneRef = useRef(false);

  const applyResolvedDark = useCallback((nextTheme: AppTheme) => {
    const dark = resolveDark(nextTheme);
    setDarkTheme(dark);
    localStorage.setItem(THEME_KEY, dark ? "1" : "0");
  }, []);

  const setTheme = useCallback(
    (next: AppTheme) => {
      setThemeState(next);
      applyResolvedDark(next);
      void api.settingsSet(SK.APP_THEME, next);
    },
    [applyResolvedDark],
  );

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const currentlyDark = resolveDark(prev);
      const next: AppTheme = currentlyDark ? "light" : "dark";
      applyResolvedDark(next);
      void api.settingsSet(SK.APP_THEME, next);
      return next;
    });
  }, [applyResolvedDark]);

  const clearFavInterval = useCallback(() => {
    if (favIntervalRef.current != null) {
      window.clearInterval(favIntervalRef.current);
      favIntervalRef.current = null;
    }
  }, []);

  const scheduleFavInterval = useCallback(
    async (on: boolean) => {
      clearFavInterval();
      if (!on) return;
      const intervalMin = Number((await api.settingsGet(SK.FAV_INTERVAL_MIN)) ?? "60") || 60;
      const downloadAfter = parseBool(await api.settingsGet(SK.FAV_DOWNLOAD_AFTER), false);
      favDownloadAfterRef.current = downloadAfter;
      if (intervalMin <= 0) return;
      favIntervalRef.current = window.setInterval(() => {
        void api.favoritesCheckAll(favDownloadAfterRef.current).catch(() => {
          /* ignore background errors */
        });
      }, intervalMin * 60_000);
    },
    [clearFavInterval],
  );

  const setFavAutoCheck = useCallback(
    async (on: boolean) => {
      setFavAutoCheckState(on);
      await api.settingsSet(SK.FAV_INTERVAL_ON, on ? "1" : "0");
      await scheduleFavInterval(on);
    },
    [scheduleFavInterval],
  );

  useEffect(() => {
    const onResize = () => setLayout(layoutFromWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyResolvedDark("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, applyResolvedDark]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api
      .onLuaLog((msg) => {
        setLogLines((prev) => [...prev.slice(-400), { text: msg, kind: "" }]);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  const log = useCallback((msg: string, kind: LogKind = "") => {
    setLogLines((prev) => [...prev.slice(-400), { text: msg, kind }]);
  }, []);

  const clearLog = useCallback(() => {
    setLogLines([{ text: "Listo.", kind: "" }]);
  }, []);

  const toggleLog = useCallback(() => setLogOpen((o) => !o), []);

  const currentModule = useMemo(
    () => modules.find((m) => m.id === selectedModuleId),
    [modules, selectedModuleId],
  );

  const refreshModules = useCallback(async () => {
    const mods = await api.modulesList();
    setModules(mods);
    if (selectedModuleId && !mods.some((m) => m.id === selectedModuleId)) {
      setSelectedModuleId(null);
    }
    return mods;
  }, [selectedModuleId]);

  const refreshEnabledModules = useCallback(async () => {
    const raw = (await api.settingsGet(SK.MODULES_ENABLED)) ?? "[]";
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch {
      ids = [];
    }
    const next = new Set(ids);
    setEnabledModuleIds(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshEnabledModules();
  }, [refreshEnabledModules]);

  useEffect(() => {
    catalogJobRef.current = catalogJob;
  }, [catalogJob]);

  useEffect(() => {
    let cancelled = false;
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    void api
      .onCatalogProgress((p) => {
        const body = (p.message && p.message.trim()) || (p.log && p.log.trim()) || "";
        const job = catalogJobRef.current;
        if (body && job?.mode === "update") {
          const phase =
            p.phase === "scrape"
              ? "Explorando el catálogo del sitio"
              : p.phase === "getinfo"
                ? "Importando metadatos de obras nuevas"
                : p.phase === "done"
                  ? "Lista actualizada"
                  : "Actualizando lista";
          log(
            `${phase} [${job.index}/${job.total}] ${job.moduleName} | ${body}`,
            "",
          );
        } else if (p.log?.trim()) {
          log(p.log.trim(), "");
        }
        setCatalogJob((prev) =>
          prev
            ? {
                ...prev,
                moduleId: p.module_id || prev.moduleId,
                page: p.page,
                pageTotal: p.page_total,
                getinfoIndex: p.getinfo_index,
                getinfoTotal: p.getinfo_total,
                phase: p.phase,
                message: (p.message && p.message.trim()) || prev.message,
              }
            : prev,
        );
      })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        un1 = u;
      });
    void api
      .onCatalogFetchProgress((p) => {
        setCatalogJob((prev) =>
          prev
            ? {
                ...prev,
                moduleId: p.module_id || prev.moduleId,
                bytesDone: p.bytes_done,
                bytesTotal: p.bytes_total,
                message: p.message || prev.message,
              }
            : prev,
        );
      })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        un2 = u;
      });
    return () => {
      cancelled = true;
      un1?.();
      un2?.();
    };
  }, [log]);

  const cancelCatalogJob = useCallback(async () => {
    catalogCancelRequestedRef.current = true;
    setCatalogJob((prev) => (prev ? { ...prev, cancelling: true } : prev));
    try {
      await api.catalogJobCancel();
    } catch {
      /* ignore */
    }
  }, []);

  const startCatalogJob = useCallback(
    async (args: StartCatalogJobArgs) => {
      if (catalogJobRunningRef.current) {
        log("Ya hay una actualización de catálogo en curso.", "err");
        return;
      }
      const enabled = modules.filter((m) => enabledModuleIds.has(m.id));
      let targets: ModuleMeta[] = [];
      if (args.scope === "one") {
        const id = args.moduleId;
        if (!id) {
          log("Elige una fuente en el selector primero.", "err");
          return;
        }
        const m = modules.find((x) => x.id === id);
        if (!m || !enabledModuleIds.has(id)) {
          log("La fuente no está activa. Actívala en Ajustes → Sitios Web.", "err");
          return;
        }
        targets = [m];
      } else {
        targets = [...enabled].sort((a, b) => a.name.localeCompare(b.name));
        if (!targets.length) {
          log(
            "No hay sitios activos. Ve a Ajustes → Sitios Web, marca los que quieras y guarda.",
            "err",
          );
          return;
        }
      }

      catalogJobRunningRef.current = true;
      catalogCancelRequestedRef.current = false;
      const doneIds: string[] = [];
      const touchedIds: string[] = [];
      try {
        await api.catalogJobBegin();
        const verb = args.mode === "fetch" ? "Descarga" : "Actualización";
        log(
          `${verb} de catálogo: ${targets.length} sitio${targets.length === 1 ? "" : "s"}…`,
          "",
        );
        for (let i = 0; i < targets.length; i++) {
          if (catalogCancelRequestedRef.current) break;
          const m = targets[i];
          touchedIds.push(m.id);
          setCatalogJob({
            mode: args.mode,
            scope: args.scope,
            moduleId: m.id,
            moduleName: m.name,
            index: i + 1,
            total: targets.length,
            page: 0,
            pageTotal: 0,
            bytesDone: 0,
            bytesTotal: 0,
            message: args.mode === "fetch" ? "Descargando…" : "Actualizando…",
            cancelling: false,
          });
          catalogJobRef.current = {
            mode: args.mode,
            scope: args.scope,
            moduleId: m.id,
            moduleName: m.name,
            index: i + 1,
            total: targets.length,
            page: 0,
            pageTotal: 0,
            bytesDone: 0,
            bytesTotal: 0,
            message: args.mode === "fetch" ? "Descargando…" : "Actualizando…",
            cancelling: false,
          };
          try {
            if (args.mode === "update") {
              const st = await api.catalogUpdate(m.id);
              doneIds.push(m.id);
              log(
                `Catálogo OK (${m.name}): +${st.inserted} · ${st.total_in_db} total · ${st.pages_fetched} páginas` +
                  (st.skipped ? ` · ${st.skipped} omitidos` : ""),
                "ok",
              );
            } else {
              const st = await api.catalogFetchFromServer(m.id);
              doneIds.push(m.id);
              log(`Catálogo reemplazado (${m.name}): ${st.count} títulos`, "ok");
            }
          } catch (e) {
            const msg = String(e);
            if (/cancelado/i.test(msg) || catalogCancelRequestedRef.current) {
              log(`${verb} cancelada.`, "");
              break;
            }
            log(`${verb} falló (${m.name}): ${msg}`, "err");
            if (args.scope === "one") break;
          }
        }
        if (catalogCancelRequestedRef.current) {
          log(`${verb} interrumpida.`, "");
        } else if (doneIds.length) {
          log(`${verb} terminada.`, "ok");
        }
      } finally {
        catalogJobRunningRef.current = false;
        catalogCancelRequestedRef.current = false;
        setCatalogJob(null);
        setLastCatalogJobModuleIds(touchedIds.length ? touchedIds : doneIds);
        setCatalogJobDoneSeq((n) => n + 1);
      }
    },
    [enabledModuleIds, log, modules],
  );

  useEffect(() => {
    if (bootDoneRef.current) return;
    bootDoneRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const themeRaw = await api.settingsGet(SK.APP_THEME);
        if (cancelled) return;
        const t = parseTheme(themeRaw);
        setThemeState(t);
        applyResolvedDark(t);

        const openOnStart = parseBool(await api.settingsGet(SK.FAV_OPEN_ON_START), false);
        if (!cancelled && openOnStart) setActiveNav("favorites");

        // Align defaults with OptionsView DEFAULT_STATE
        const checkOnStart = parseBool(await api.settingsGet(SK.FAV_CHECK_ON_START), true);
        const downloadAfter = parseBool(await api.settingsGet(SK.FAV_DOWNLOAD_AFTER), false);
        favDownloadAfterRef.current = downloadAfter;
        if (!cancelled && checkOnStart) {
          try {
            const results = await api.favoritesCheckAll(downloadAfter);
            const news = results.reduce((a, r) => a + r.new_chapters.length, 0);
            const enq = results.reduce((a, r) => a + r.enqueued, 0);
            log(
              downloadAfter
                ? `Inicio: ${enq} capítulos encolados desde favoritos`
                : `Inicio: ${news} capítulos nuevos en favoritos`,
              "ok",
            );
          } catch (e) {
            log(`Revisión de favoritos al inicio: ${e}`, "err");
          }
        }

        const intervalOn = parseBool(await api.settingsGet(SK.FAV_INTERVAL_ON), true);
        if (!cancelled) {
          setFavAutoCheckState(intervalOn);
          await scheduleFavInterval(intervalOn);
        }

        const checkUpdate = parseBool(await api.settingsGet(SK.CHECK_UPDATE_START), true);
        if (!cancelled && checkUpdate) {
          try {
            const msg = await api.checkAppUpdate();
            log(msg || "Sin actualizaciones disponibles", "ok");
          } catch (e) {
            log(`Comprobar actualización: ${e}`, "err");
          }
        }
      } catch (e) {
        log(String(e), "err");
      }
    })();

    return () => {
      cancelled = true;
      clearFavInterval();
    };
  }, [applyResolvedDark, clearFavInterval, log, scheduleFavInterval]);

  const value: AppContextValue = {
    activeNav,
    setActiveNav,
    darkTheme,
    theme,
    setTheme,
    toggleTheme,
    logOpen,
    setLogOpen,
    toggleLog,
    logLines,
    log,
    clearLog,
    modules,
    setModules,
    selectedModuleId,
    setSelectedModuleId,
    currentModule,
    outputDir,
    setOutputDir,
    narrow,
    hideInfo,
    showMangaInfo,
    setShowMangaInfo,
    refreshModules,
    enabledModuleIds,
    refreshEnabledModules,
    favAutoCheck,
    setFavAutoCheck,
    catalogJob,
    catalogJobDoneSeq,
    lastCatalogJobModuleIds,
    startCatalogJob,
    cancelCatalogJob,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
