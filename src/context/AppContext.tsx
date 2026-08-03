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
  ModulesCheckReport,
  ModulesUpdateProgressEvent,
  FavoriteCheckResult,
  ModuleMeta,
  NavId,
} from "../types";
import * as api from "../api/tauri";
import { runAppUpdateCheck } from "../utils/appUpdate";
import { runModulesGithubUpdate, summarizeCheck } from "../utils/modulesUpdate";
import { appToast } from "../components/AppToast";
import { registerBusyProbe } from "../utils/restartGuard";

export type LogKind = "ok" | "err" | "";
export type AppTheme = "system" | "light" | "dark";

export type StartCatalogJobArgs = {
  mode: CatalogJobMode;
  scope: CatalogJobScope;
  /** Required when scope is "one". */
  moduleId?: string | null;
};

/**
 * Deep-link into a specific Options tab. `setActiveNav("options")` alone drops
 * the user on whatever tab was last open, which is not where the thing they
 * clicked actually lives.
 */
export type PendingOptionsTab = {
  /** Matches `OptTabId` in OptionsView, e.g. "websites". */
  tab: string;
  /** Sub-tab within that panel, e.g. "mods". */
  sub?: string;
};

export type PendingMangaOpen = {
  mangaUrl: string;
  moduleId: string | null;
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
  /** Apply favorites interval check after Options save (or boot). */
  setFavAutoCheck: (on: boolean) => Promise<void>;
  /** True while startup/interval favorites check is running (no top bar). */
  favAutoChecking: boolean;
  /** Why the background check is running (footer copy). */
  favAutoCheckSource: "inicio" | "intervalo";
  /** Bumps when an auto-check (startup / interval) finishes; Favorites UI syncs from this. */
  favAutoCheckSeq: number;
  lastFavAutoCheck: FavoriteCheckResult[] | null;
  catalogJob: CatalogJobState | null;
  /** Bumps when a catalog job finishes (success or cancel) so Info can refresh. */
  catalogJobDoneSeq: number;
  lastCatalogJobModuleIds: string[];
  startCatalogJob: (args: StartCatalogJobArgs) => Promise<void>;
  cancelCatalogJob: () => Promise<void>;
  /** Avisa que el catálogo cambió fuera de un job (p. ej. restaurar de la papelera). */
  notifyCatalogChanged: (moduleIds: string[]) => void;
  /** Drive the top progress bar for non-catalog jobs (e.g. favorites check). */
  setAppJob: (job: CatalogJobState | null) => void;
  /** True after Cancel on the progress bar until the current job clears it. */
  isAppJobCancelRequested: () => boolean;
  clearAppJobCancel: () => void;
  /** Deep-link from Downloads «Agregar más» → Info load. */
  pendingMangaOpen: PendingMangaOpen | null;
  setPendingMangaOpen: (v: PendingMangaOpen | null) => void;
  /** Changes a silent module check found and left for the user to confirm. */
  modulesPending: ModulesCheckReport | null;
  setModulesPending: (v: ModulesCheckReport | null) => void;
  /** Live progress of a running module sync; null when idle. Cancelling goes
   *  through `cancelCatalogJob`, which dispatches on the job mode. */
  modulesJob: ModulesUpdateProgressEvent | null;
  /** Version of a postponed app update, if any. */
  appUpdatePending: string | null;
  /** Options tab to open next; OptionsView consumes and clears it. */
  pendingOptionsTab: PendingOptionsTab | null;
  /** Navigate to Options and land on a specific tab. */
  openOptionsTab: (target: PendingOptionsTab) => void;
  clearPendingOptionsTab: () => void;
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
  const [catalogJob, setCatalogJob] = useState<CatalogJobState | null>(null);
  const [catalogJobDoneSeq, setCatalogJobDoneSeq] = useState(0);
  const [lastCatalogJobModuleIds, setLastCatalogJobModuleIds] = useState<string[]>([]);
  const [pendingMangaOpen, setPendingMangaOpen] = useState<PendingMangaOpen | null>(null);
  const catalogJobRunningRef = useRef(false);
  const catalogCancelRequestedRef = useRef(false);
  const catalogJobRef = useRef<CatalogJobState | null>(null);
  const [{ narrow, hideInfo }, setLayout] = useState(() =>
    layoutFromWidth(typeof window !== "undefined" ? window.innerWidth : 1280),
  );
  const favIntervalRef = useRef<number | null>(null);
  const modulesUpdateBusyRef = useRef(false);
  const runAutoModulesCheckRef = useRef<(silent: boolean) => Promise<void>>(async () => {});
  /** Set by a silent check that found changes; cleared once they are applied. */
  const [modulesPending, setModulesPending] = useState<ModulesCheckReport | null>(null);
  const [modulesJob, setModulesJob] = useState<ModulesUpdateProgressEvent | null>(null);
  /** Version the user postponed, so the reminder survives the session. */
  const [appUpdatePending, setAppUpdatePending] = useState<string | null>(null);
  const [pendingOptionsTab, setPendingOptionsTab] = useState<PendingOptionsTab | null>(null);
  const favDownloadAfterRef = useRef(false);
  const [favAutoCheckSeq, setFavAutoCheckSeq] = useState(0);
  const [lastFavAutoCheck, setLastFavAutoCheck] = useState<FavoriteCheckResult[] | null>(
    null,
  );
  const [favAutoChecking, setFavAutoChecking] = useState(false);
  const [favAutoCheckSource, setFavAutoCheckSource] = useState<"inicio" | "intervalo">(
    "inicio",
  );

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

  const log = useCallback((msg: string, kind: LogKind = "") => {
    setLogLines((prev) => [...prev.slice(-400), { text: msg, kind }]);
  }, []);

  const clearLog = useCallback(() => {
    setLogLines([{ text: "Listo.", kind: "" }]);
  }, []);

  const toggleLog = useCallback(() => setLogOpen((o) => !o), []);

  const clearFavInterval = useCallback(() => {
    if (favIntervalRef.current != null) {
      window.clearInterval(favIntervalRef.current);
      favIntervalRef.current = null;
    }
  }, []);

  const publishFavAutoCheck = useCallback(
    (results: FavoriteCheckResult[], downloadAfter: boolean, source: "inicio" | "intervalo") => {
      setLastFavAutoCheck(results);
      setFavAutoCheckSeq((n) => n + 1);
      const news = results.reduce((a, r) => a + r.new_chapters.length, 0);
      const enq = results.reduce((a, r) => a + r.enqueued, 0);
      if (downloadAfter) {
        log(
          `${source === "inicio" ? "Inicio" : "Intervalo"}: ${enq} capítulos encolados desde favoritos`,
          "ok",
        );
      } else {
        log(
          `${source === "inicio" ? "Inicio" : "Intervalo"}: ${news} capítulos nuevos en favoritos`,
          "ok",
        );
      }
    },
    [log],
  );

  const scheduleFavInterval = useCallback(
    async (on: boolean) => {
      clearFavInterval();
      if (!on) return;
      const intervalMin = Math.max(
        60,
        Number((await api.settingsGet(SK.FAV_INTERVAL_MIN)) ?? "60") || 60,
      );
      const downloadAfter = parseBool(await api.settingsGet(SK.FAV_DOWNLOAD_AFTER), false);
      favDownloadAfterRef.current = downloadAfter;
      if (intervalMin <= 0) return;
      favIntervalRef.current = window.setInterval(() => {
        void (async () => {
          setFavAutoCheckSource("intervalo");
          setFavAutoChecking(true);
          try {
            const results = await api.favoritesCheckAll(favDownloadAfterRef.current);
            publishFavAutoCheck(results, favDownloadAfterRef.current, "intervalo");
          } catch (e) {
            log(`Revisión periódica de favoritos: ${e}`, "err");
          } finally {
            setFavAutoChecking(false);
          }
          // FMD2: same AutoCheckLatestVersion also refreshes Lua modules on fav timer.
          const checkUpdate = parseBool(await api.settingsGet(SK.CHECK_UPDATE_START), true);
          if (checkUpdate) {
            await runAutoModulesCheckRef.current(true);
          }
        })();
      }, intervalMin * 60_000);
    },
    [clearFavInterval, log, publishFavAutoCheck],
  );

  const setFavAutoCheck = useCallback(
    async (on: boolean) => {
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

  const openOptionsTab = useCallback((target: PendingOptionsTab) => {
    setPendingOptionsTab(target);
    setActiveNav("options");
  }, []);

  const clearPendingOptionsTab = useCallback(() => setPendingOptionsTab(null), []);

  const runAutoModulesCheck = useCallback(
    async (silent: boolean) => {
      if (modulesUpdateBusyRef.current) return;
      modulesUpdateBusyRef.current = true;
      try {
        const { check, deferred } = await runModulesGithubUpdate(log, { silent });
        setModulesPending(deferred ? check : null);
        if (deferred) {
          // Silent must not mean invisible: without this the only sign is a
          // banner inside a settings sub-tab nobody opens.
          appToast({
            message: `Módulos por actualizar: ${summarizeCheck(check)}`,
            action: {
              label: "Ver",
              onClick: () => openOptionsTab({ tab: "websites", sub: "mods" }),
            },
          });
        } else {
          await refreshModules();
        }
      } catch (e) {
        log(`Revisión de módulos: ${e}`, "err");
        if (!silent) {
          appToast({
            message: "No se pudieron descargar los módulos.",
            kind: "err",
            action: {
              label: "Reintentar",
              onClick: () => void runAutoModulesCheckRef.current(false),
            },
          });
        }
      } finally {
        modulesUpdateBusyRef.current = false;
      }
    },
    [log, refreshModules],
  );

  useEffect(() => {
    runAutoModulesCheckRef.current = runAutoModulesCheck;
  }, [runAutoModulesCheck]);

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
    setEnabledModuleIds((prev) => {
      if (prev.size === next.size && ids.every((id) => prev.has(id))) return prev;
      return next;
    });
    return next;
  }, []);

  useEffect(() => {
    void refreshEnabledModules();
  }, [refreshEnabledModules]);

  useEffect(() => {
    catalogJobRef.current = catalogJob;
  }, [catalogJob]);

  // What a restart would interrupt. The queue is polled from the backend by
  // `busyReasons`; these two only exist in memory.
  useEffect(
    () =>
      registerBusyProbe(() => {
        if (modulesUpdateBusyRef.current) return "actualización de módulos en curso";
        const job = catalogJobRef.current;
        if (job) return `catálogo en curso (${job.moduleName || job.moduleId})`;
        return null;
      }),
    [],
  );

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

  const setAppJob = useCallback((job: CatalogJobState | null) => {
    catalogJobRef.current = job;
    setCatalogJob(job);
  }, []);

  // The module sync drives the same floating bar as catalog and favorites, so
  // progress and Cancel follow the user instead of disappearing the moment
  // they navigate away from the settings tab.
  useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    void api
      .onModulesUpdateProgress((p) => {
        if (p.phase === "done") {
          setModulesJob(null);
          setAppJob(null);
          return;
        }
        setModulesJob(p);
        setAppJob({
          mode: "modules",
          scope: "all",
          moduleId: "",
          moduleName: p.current || "",
          index: p.files_done,
          total: p.files_total,
          page: 0,
          pageTotal: 0,
          bytesDone: p.bytes_done,
          bytesTotal: p.bytes_total,
          message: p.message || p.current,
          phase: p.phase,
          cancelling: false,
        });
      })
      .then((u) => {
        if (cancelled) u();
        else un = u;
      });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [setAppJob]);

  const isAppJobCancelRequested = useCallback(
    () => catalogCancelRequestedRef.current,
    [],
  );

  const clearAppJobCancel = useCallback(() => {
    catalogCancelRequestedRef.current = false;
  }, []);

  const cancelCatalogJob = useCallback(async () => {
    catalogCancelRequestedRef.current = true;
    const mode = catalogJobRef.current?.mode;
    setCatalogJob((prev) => {
      const next = prev ? { ...prev, cancelling: true } : prev;
      catalogJobRef.current = next;
      return next;
    });
    // Favorites checks are frontend-loop only; skip Rust catalog cancel.
    if (mode === "favorites") return;
    try {
      // Same bar, different job: the modules sync has its own cancel flag.
      await (mode === "modules" ? api.modulesUpdateCancel() : api.catalogJobCancel());
    } catch {
      /* ignore */
    }
  }, []);

  const startCatalogJob = useCallback(
    async (args: StartCatalogJobArgs) => {
      if (catalogJobRunningRef.current || catalogJobRef.current) {
        log("Ya hay una tarea en curso.", "err");
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

  const notifyCatalogChanged = useCallback((moduleIds: string[]) => {
    setLastCatalogJobModuleIds(moduleIds);
    setCatalogJobDoneSeq((n) => n + 1);
  }, []);

  // Startup: theme, favorites check-on-start, interval timer, app update.
  // Empty deps: must run once per mount. A sticky bootDoneRef breaks under
  // React Strict Mode (first effect sets the flag, cleanup cancels work, second
  // effect sees the flag and skips — auto-check never runs in tauri dev).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const themeRaw = await api.settingsGet(SK.APP_THEME);
        if (cancelled) return;
        const t = parseTheme(themeRaw);
        setThemeState(t);
        applyResolvedDark(t);

        // Align defaults with OptionsView DEFAULT_STATE
        const checkOnStart = parseBool(await api.settingsGet(SK.FAV_CHECK_ON_START), true);
        const downloadAfter = parseBool(await api.settingsGet(SK.FAV_DOWNLOAD_AFTER), false);
        favDownloadAfterRef.current = downloadAfter;
        if (!cancelled && checkOnStart) {
          setFavAutoCheckSource("inicio");
          setFavAutoChecking(true);
          try {
            const results = await api.favoritesCheckAll(downloadAfter);
            if (!cancelled) publishFavAutoCheck(results, downloadAfter, "inicio");
          } catch (e) {
            if (!cancelled) log(`Revisión de favoritos al inicio: ${e}`, "err");
          } finally {
            setFavAutoChecking(false);
          }
        }

        const intervalOn = parseBool(await api.settingsGet(SK.FAV_INTERVAL_ON), false);
        if (!cancelled) {
          await scheduleFavInterval(intervalOn);
        }

        const checkUpdate = parseBool(await api.settingsGet(SK.CHECK_UPDATE_START), true);
        let installingApp = false;
        if (!cancelled && checkUpdate) {
          try {
            const r = await runAppUpdateCheck(log);
            installingApp = r.installing;
            if (r.deferred) setAppUpdatePending(r.version ?? null);
          } catch {
            // runAppUpdateCheck already logged
          }
          // If the app is about to be replaced there is no point syncing
          // modules — the process restarts and the check runs again anyway.
          if (!cancelled && !installingApp) {
            await runAutoModulesCheckRef.current(true);
          }
        }

        // The Lua tree no longer ships with the installer, so a fresh install
        // starts with nothing to browse. Sync it out loud — an empty site list
        // with no explanation reads as a broken app.
        if (!cancelled && !installingApp && (await api.modulesNeedsFirstSync())) {
          log("Primer arranque: descargando módulos…", "");
          await runAutoModulesCheckRef.current(false);
        }
      } catch (e) {
        if (!cancelled) log(String(e), "err");
      }
    })();

    return () => {
      cancelled = true;
      clearFavInterval();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional once-per-mount boot
  }, []);

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
    setFavAutoCheck,
    favAutoChecking,
    favAutoCheckSource,
    favAutoCheckSeq,
    lastFavAutoCheck,
    catalogJob,
    catalogJobDoneSeq,
    lastCatalogJobModuleIds,
    startCatalogJob,
    cancelCatalogJob,
    notifyCatalogChanged,
    setAppJob,
    isAppJobCancelRequested,
    clearAppJobCancel,
    pendingMangaOpen,
    setPendingMangaOpen,
    modulesPending,
    setModulesPending,
    modulesJob,
    appUpdatePending,
    pendingOptionsTab,
    openOptionsTab,
    clearPendingOptionsTab,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
