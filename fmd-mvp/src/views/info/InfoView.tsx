import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../components/Icon";
import { VirtualList } from "../../components/VirtualList";
import type { IconName } from "../../icons";
import {
  CATALOG_BATCH,
  CAT_OVERSCAN,
  CAT_ROW_H,
  CH_OVERSCAN,
  CH_ROW_GAP,
  CH_ROW_H,
  DEFAULT_GENRES,
  FILTER_CUSTOM_HINT,
  GENRE_TRI_CYCLE,
  emptyAdvFilter,
} from "../../constants";
import { useApp } from "../../context/AppContext";
import * as api from "../../api/tauri";
import { catalogLinkKey, maybeFillHost, normalizeMangaUrl, resolveCover } from "../../utils/url";
import coverDefaultUrl from "../../assets/cover-default.svg";
import chaptersEmptyUrl from "../../assets/chapters-empty.png";
import type {
  AdvFilterState,
  CatalogEntry,
  GenreTri,
  InfoMode,
  MangaInfoResult,
  ModuleMeta,
} from "../../types";

/** Rows painted in the info sidebar (mirrors `paintSidebarContent` in main.ts). */
type SidebarRows = {
  title: string;
  authors: string;
  artists: string;
  genres: string;
  status: string;
  summary: string;
  numchapter: number;
  moduleName: string;
};

const EMPTY_SIDEBAR_ROWS: SidebarRows = {
  title: "",
  authors: "",
  artists: "",
  genres: "",
  status: "",
  summary: "",
  numchapter: 0,
  moduleName: "",
};

type PaintOpts = {
  title: string;
  authors?: string;
  artists?: string;
  genres?: string;
  status?: string;
  summary?: string;
  numchapter?: number;
  moduleName?: string;
  /** When provided (including ""), updates alt titles; omit to leave current alt alone. */
  altTitles?: string;
};

/** FMD2 stores status as "0"/"1"/"2"/"3"; sidebar shows the label like ShowInformation. */
function formatMangaStatus(raw: string | undefined): string {
  const s = (raw || "").trim();
  switch (s) {
    case "0":
      return "Completado";
    case "1":
      return "En curso";
    case "2":
      return "Hiatus";
    case "3":
      return "Cancelado";
    case "Unknown":
      return "";
    default:
      return s;
  }
}

function chapterNum(index: number): string {
  return String(index + 1).padStart(4, "0");
}

function genreChipClass(state: GenreTri): string {
  if (state === "include") return "chip inc";
  if (state === "exclude") return "chip exc";
  return "chip";
}

export function InfoView() {
  const {
    activeNav,
    setActiveNav,
    log,
    clearLog,
    modules,
    selectedModuleId,
    setSelectedModuleId,
    currentModule,
    outputDir,
    setOutputDir,
    refreshModules,
    setShowMangaInfo,
    enabledModuleIds,
    hideInfo,
    catalogJob,
    catalogJobDoneSeq,
    lastCatalogJobModuleIds,
    startCatalogJob,
  } = useApp();

  /* ---------------------------------------------------------------------
   * Source picker
   * ------------------------------------------------------------------- */
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const sourceQRef = useRef<HTMLInputElement>(null);
  const sourceListRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------------
   * Catalog (left panel)
   * ------------------------------------------------------------------- */
  const [catalogEntries, setCatalogEntriesState] = useState<CatalogEntry[]>([]);
  const catalogEntriesRef = useRef<CatalogEntry[]>([]);
  const setCatalogEntries = useCallback((v: CatalogEntry[]) => {
    catalogEntriesRef.current = v;
    setCatalogEntriesState(v);
  }, []);

  const [catalogText, setCatalogText] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingText, setCatalogLoadingText] = useState("Cargando títulos…");
  const [catalogError, setCatalogError] = useState(false);
  const [catalogStatsText, setCatalogStatsText] = useState("0");
  const [catalogResetSeq, setCatalogResetSeq] = useState(0);
  const [activeCatalogTitle, setActiveCatalogTitle] = useState("");

  const catalogQueryRef = useRef("");
  const catalogLoadedKeyRef = useRef("");
  const catalogSearchTimerRef = useRef<number | undefined>(undefined);
  const catalogLoadGenRef = useRef(0);
  const catalogLoadingDelayRef = useRef<number | undefined>(undefined);
  const catalogSpinnerShownRef = useRef(false);
  const lastCatalogClickRef = useRef<{ idx: number; at: number }>({ idx: -1, at: 0 });

  function bumpCatalogReset() {
    setCatalogResetSeq((s) => s + 1);
  }

  /* ---------------------------------------------------------------------
   * Manga info / chapters
   * ------------------------------------------------------------------- */
  const [manga, setMangaState] = useState<MangaInfoResult | null>(null);
  const mangaRef = useRef<MangaInfoResult | null>(null);
  const setManga = useCallback((m: MangaInfoResult | null) => {
    mangaRef.current = m;
    setMangaState(m);
  }, []);

  const [urlInput, setUrlInput] = useState("");
  const [mangaUrl, setMangaUrl] = useState("");
  const [mangaLoadingUrl, setMangaLoadingUrl] = useState("");
  const [loadBtnDisabled, setLoadBtnDisabled] = useState(false);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [chaptersResetSeq, setChaptersResetSeq] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);
  const [infoSidebarCollapsed, setInfoSidebarCollapsed] = useState(false);
  const [sourceToolsOpen, setSourceToolsOpen] = useState(false);
  const [sourceToolsAction, setSourceToolsAction] = useState<
    "update_one" | "fetch_one" | "update_all" | "fetch_all"
  >("update_one");
  const [isFavorite, setIsFavorite] = useState(false);
  const [taskStopped, setTaskStopped] = useState(false);
  const [loadCovers, setLoadCovers] = useState(true);

  const [sidebarRows, setSidebarRows] = useState<SidebarRows>(EMPTY_SIDEBAR_ROWS);
  const [altTitles, setAltTitles] = useState("");

  const mangaLoadSeqRef = useRef(0);
  const coverEnsureSeqRef = useRef(0);

  function bumpChaptersReset() {
    setChaptersResetSeq((s) => s + 1);
  }

  /* ---------------------------------------------------------------------
   * Cover
   * ------------------------------------------------------------------- */
  /** Apply sharpen/contrast only for small source covers (natural height). */
  const COVER_ENHANCE_MAX_H = 300;
  const [coverSrc, setCoverSrc] = useState(coverDefaultUrl);
  const [coverIsDefault, setCoverIsDefaultState] = useState(true);
  const [coverEnhanced, setCoverEnhanced] = useState(false);
  const coverIsDefaultRef = useRef(true);
  const coverLocalFallbackRef = useRef("");
  const coverDisplayKeyRef = useRef("");

  function setCoverIsDefault(v: boolean) {
    coverIsDefaultRef.current = v;
    setCoverIsDefaultState(v);
  }

  function applyDefaultCover() {
    coverDisplayKeyRef.current = "";
    setCoverIsDefault(true);
    setCoverEnhanced(false);
    setCoverSrc(coverDefaultUrl);
  }

  function setCover(url: string, opts?: { localFallback?: string; force?: boolean }) {
    if (opts && "localFallback" in opts) {
      coverLocalFallbackRef.current = opts.localFallback || "";
    }
    if (!url) {
      if (coverLocalFallbackRef.current) {
        setCover(coverLocalFallbackRef.current, { force: opts?.force });
        return;
      }
      applyDefaultCover();
      return;
    }
    coverDisplayKeyRef.current = url;
    setCoverIsDefault(false);
    setCoverEnhanced(false);
    setCoverSrc(url);
  }

  function handleCoverImgLoad(e: SyntheticEvent<HTMLImageElement>) {
    if (coverIsDefaultRef.current) {
      setCoverEnhanced(false);
      return;
    }
    const h = e.currentTarget.naturalHeight;
    setCoverEnhanced(h > 0 && h < COVER_ENHANCE_MAX_H);
  }

  function handleCoverImgError() {
    const fb = coverLocalFallbackRef.current;
    if (fb && coverDisplayKeyRef.current !== fb) {
      setCover(fb, { force: true });
      return;
    }
    applyDefaultCover();
  }

  /* ---------------------------------------------------------------------
   * Filter panel / info mode
   * ------------------------------------------------------------------- */
  const [infoMode, setInfoModeState] = useState<InfoMode>("search");
  const [advFilter, setAdvFilter] = useState<AdvFilterState>(() => emptyAdvFilter());
  const [advFilterApplied, setAdvFilterApplied] = useState(false);
  const [filterNewDays, setFilterNewDays] = useState(1);
  const [liveSearch, setLiveSearch] = useState(true);

  /* ---------------------------------------------------------------------
   * Bootstrap: modules + output dir + initial catalog load
   * ------------------------------------------------------------------- */
  useEffect(() => {
    if (!modules.length) void refreshModules();
    if (!outputDir) {
      void api.settingsGet("default_output_dir").then((saved) => {
        if (saved) setOutputDir(saved);
      });
    }
    void api.settingsGet("ui.load_covers").then((v) => {
      if (v === "0" || v === "false") setLoadCovers(false);
    });
    void api.settingsGet("ui.new_days").then((v) => {
      const n = Number(v ?? "1");
      if (Number.isFinite(n) && n > 0) setFilterNewDays(n);
    });
    void api.settingsGet("ui.live_search").then((v) => {
      if (v === "0" || v === "false") setLiveSearch(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabledModules = useMemo(
    () => modules.filter((m) => enabledModuleIds.has(m.id)),
    [modules, enabledModuleIds],
  );

  function entryMatchesFilter(e: CatalogEntry, f: AdvFilterState, newDays: number): boolean {
    const textMatch = (hay: string, needle: string) => {
      const n = needle.trim();
      if (!n) return true;
      if (f.useRegex) {
        try {
          return new RegExp(n, "i").test(hay);
        } catch {
          return hay.toLowerCase().includes(n.toLowerCase());
        }
      }
      return hay.toLowerCase().includes(n.toLowerCase());
    };
    if (!textMatch(e.title + " " + (e.alttitles || ""), f.title)) return false;
    if (!textMatch(e.authors || "", f.authors)) return false;
    if (!textMatch(e.artists || "", f.artists)) return false;
    if (!textMatch(e.summary || "", f.summary)) return false;
    if (f.status !== 4) {
      const st = (e.status || "").trim().toLowerCase();
      // Dropdown: 0=Completado, 1=En curso, 2=Hiatus, 3=Cancelado (FMD codes 0/1/2/3).
      const map: Record<number, string[]> = {
        0: ["0", "completed", "completo", "completado", "finalizado", "tamat"],
        1: ["1", "ongoing", "en curso", "en desarrollo", "berjalan", "releasing"],
        2: ["2", "hiatus", "pausado", "on hold"],
        3: ["3", "cancelled", "canceled", "cancelado"],
      };
      const want = map[f.status] || [];
      if (want.length && !want.some((w) => st === w || st.includes(w))) return false;
    }
    const genreList = (e.genres || "")
      .split(/[,;]/)
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean);
    const includes: string[] = [];
    const excludes: string[] = [];
    for (const g of DEFAULT_GENRES) {
      const state = f.genres[g.id] ?? "ignore";
      if (state === "include") includes.push(g.id.toLowerCase(), g.label.toLowerCase());
      if (state === "exclude") excludes.push(g.id.toLowerCase(), g.label.toLowerCase());
    }
    for (const part of f.customGenres.split(",")) {
      const raw = part.trim();
      if (!raw) continue;
      if (raw.startsWith("!") || raw.startsWith("-")) excludes.push(raw.slice(1).trim().toLowerCase());
      else includes.push(raw.toLowerCase());
    }
    for (const ex of excludes) {
      if (ex && genreList.some((g) => g.includes(ex))) return false;
    }
    if (includes.length) {
      const hit = includes.filter(Boolean).map((inc) => genreList.some((g) => g.includes(inc)));
      if (f.matchMode === "all" ? !hit.every(Boolean) : !hit.some(Boolean)) return false;
    }
    if (f.onlyNew && newDays > 0 && e.jdn) {
      const nowJdn = Math.floor(Date.now() / 86400000) + 2440587.5;
      if (nowJdn - e.jdn > newDays) return false;
    }
    return true;
  }

  const visibleCatalog = useMemo(() => {
    if (!advFilterApplied) return catalogEntries;
    return catalogEntries.filter((e) => entryMatchesFilter(e, advFilter, filterNewDays));
  }, [catalogEntries, advFilter, advFilterApplied, filterNewDays]);

  function applyAdvFilter() {
    setAdvFilterApplied(true);
    const n = catalogEntries.filter((e) => entryMatchesFilter(e, advFilter, filterNewDays)).length;
    log(`Filtro aplicado: ${n} títulos`, "ok");
  }

  function removeAdvFilter() {
    clearAllFilters();
    setAdvFilterApplied(false);
  }

  useEffect(() => {
    if (modules.length) setSourcesLoading(false);
  }, [modules]);

  /** Keep combo on an enabled source; empty list → no selection. */
  useEffect(() => {
    if (!enabledModules.length) {
      if (selectedModuleId) setSelectedModuleId(null);
      return;
    }
    if (selectedModuleId && enabledModules.some((m) => m.id === selectedModuleId)) return;
    setSelectedModuleId(enabledModules[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledModules]);

  async function refreshCatalogStats() {
    const id = selectedModuleId;
    if (!id || !enabledModuleIds.has(id)) {
      setCatalogStatsText("0");
      return;
    }
    try {
      const st = await api.catalogStats(id);
      setCatalogStatsText(String(st.count));
    } catch {
      setCatalogStatsText("—");
    }
  }

  async function loadCatalog(force = false, silent = false) {
    const id = selectedModuleId;
    if (!enabledModules.length) {
      catalogLoadGenRef.current += 1;
      window.clearTimeout(catalogLoadingDelayRef.current);
      setCatalogEntries([]);
      setCatalogError(false);
      setCatalogLoading(false);
      setCatalogStatsText("0");
      catalogLoadedKeyRef.current = "";
      if (!silent) {
        log(
          "No hay sitios activos. Ve a Ajustes → Sitios Web, marca los que quieras y guarda.",
          "err",
        );
      }
      return;
    }
    if (!id || !enabledModuleIds.has(id)) {
      catalogLoadGenRef.current += 1;
      window.clearTimeout(catalogLoadingDelayRef.current);
      setCatalogEntries([]);
      setCatalogError(false);
      setCatalogLoading(false);
      if (!silent) {
        log("Elige una fuente en el selector (o actívala en Ajustes → Sitios Web).", "err");
      }
      return;
    }
    const key = `${id}||${catalogQueryRef.current}`;
    if (!force && key === catalogLoadedKeyRef.current && catalogEntriesRef.current.length) {
      return;
    }

    const gen = ++catalogLoadGenRef.current;
    window.clearTimeout(catalogLoadingDelayRef.current);
    const keepList = silent && catalogEntriesRef.current.length > 0;

    // Avoid spinner flash on fast/empty responses: only show loading after a short delay.
    if (!keepList) {
      setCatalogEntries([]);
      setCatalogError(false);
      setCatalogLoading(false);
      catalogSpinnerShownRef.current = false;
      catalogLoadingDelayRef.current = window.setTimeout(() => {
        if (gen !== catalogLoadGenRef.current) return;
        catalogSpinnerShownRef.current = true;
        setCatalogLoading(true);
        setCatalogLoadingText("Cargando títulos…");
      }, 200);
    }

    try {
      const all: CatalogEntry[] = [];
      let offset = 0;
      for (;;) {
        const rows = await api.catalogSearch(id, catalogQueryRef.current, CATALOG_BATCH, offset);
        if (gen !== catalogLoadGenRef.current) return;
        all.push(...rows);
        if (rows.length < CATALOG_BATCH) break;
        offset += rows.length;
        if (catalogSpinnerShownRef.current) {
          setCatalogLoadingText(`Cargando títulos… (${all.length})`);
        }
      }
      if (gen !== catalogLoadGenRef.current) return;
      setCatalogEntries(all);
      catalogLoadedKeyRef.current = key;
      if (silent) bumpCatalogReset();
      await refreshCatalogStats();
      if (gen !== catalogLoadGenRef.current) return;
      if (!silent && all.length > 0) log(`Catálogo: ${all.length} títulos`, "ok");
      else if (silent) setCatalogStatsText(String(all.length));
    } catch (e) {
      if (gen !== catalogLoadGenRef.current) return;
      catalogLoadedKeyRef.current = "";
      setCatalogEntries([]);
      setCatalogError(true);
      const msg = String(e);
      if (/deshabilitado|disabled|no activado/i.test(msg)) {
        log(
          "No hay sitios activos. Ve a Ajustes → Sitios Web, marca los que quieras y guarda.",
          "err",
        );
      } else {
        log(msg, "err");
      }
    } finally {
      if (gen === catalogLoadGenRef.current) {
        window.clearTimeout(catalogLoadingDelayRef.current);
        setCatalogLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!selectedModuleId || !enabledModuleIds.has(selectedModuleId)) return;
    void refreshCatalogStats();
    void loadCatalog(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModuleId, enabledModuleIds]);

  useEffect(() => {
    if (enabledModules.length) return;
    setCatalogEntries([]);
    setCatalogError(false);
    setCatalogLoading(false);
    setCatalogStatsText("0");
    catalogLoadedKeyRef.current = "";
  }, [enabledModules.length]);

  useEffect(() => {
    if (!catalogJobDoneSeq) return;
    if (!selectedModuleId) return;
    if (!lastCatalogJobModuleIds.includes(selectedModuleId)) return;
    void loadCatalog(true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogJobDoneSeq]);

  /* ---------------------------------------------------------------------
   * Show right info sidebar on the .app shell (CSS: .app.show-manga-info)
   * ------------------------------------------------------------------- */
  useEffect(() => {
    if (!sourceToolsOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSourceToolsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sourceToolsOpen]);

  useEffect(() => {
    setShowMangaInfo(!!manga || infoPanelOpen);
    return () => setShowMangaInfo(false);
  }, [manga, infoPanelOpen, setShowMangaInfo]);

  /* ---------------------------------------------------------------------
   * Source dropdown behaviour
   * ------------------------------------------------------------------- */
  const sortedModules = useMemo(
    () => [...enabledModules].sort((a, b) => a.name.localeCompare(b.name)),
    [enabledModules],
  );
  const filteredSourceModules = useMemo(() => {
    const q = sourceFilter.trim().toLowerCase();
    if (!q) return sortedModules;
    return sortedModules.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.root_url.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q),
    );
  }, [sortedModules, sourceFilter]);

  function scrollSelectedSourceIntoView() {
    const list = sourceListRef.current;
    const el = list?.querySelector<HTMLElement>(".dd-item.on");
    if (!list || !el) return;
    const top = el.offsetTop - (list.clientHeight - el.clientHeight) / 2;
    list.scrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
  }

  useEffect(() => {
    if (!sourceOpen) return;
    const raf = requestAnimationFrame(() => {
      sourceQRef.current?.focus();
      scrollSelectedSourceIntoView();
    });
    return () => cancelAnimationFrame(raf);
  }, [sourceOpen]);

  useEffect(() => {
    if (!sourceOpen || sourceFilter.trim()) return;
    const raf = requestAnimationFrame(scrollSelectedSourceIntoView);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, sourceOpen]);

  function handleSelectSource(m: ModuleMeta) {
    setSelectedModuleId(m.id);
    setSourceOpen(false);
    setSourceFilter("");
  }

  /* ---------------------------------------------------------------------
   * Catalog search (debounced)
   * ------------------------------------------------------------------- */
  function scheduleCatalogSearch(value: string) {
    window.clearTimeout(catalogSearchTimerRef.current);
    catalogSearchTimerRef.current = window.setTimeout(() => {
      const next = value.trim();
      if (next === catalogQueryRef.current && catalogLoadedKeyRef.current.startsWith(`${selectedModuleId}||`)) {
        return;
      }
      catalogQueryRef.current = next;
      void loadCatalog(true, true);
    }, 280);
  }

  function handleCatalogInputChange(value: string) {
    setCatalogText(value);
    if (liveSearch) scheduleCatalogSearch(value);
  }

  function runCatalogSearch() {
    window.clearTimeout(catalogSearchTimerRef.current);
    catalogQueryRef.current = catalogText.trim();
    void loadCatalog(true, true);
  }

  function clearCatalogFilter() {
    window.clearTimeout(catalogSearchTimerRef.current);
    setCatalogText("");
    catalogQueryRef.current = "";
    void loadCatalog(true, true);
  }

  function clearAllFilters() {
    window.clearTimeout(catalogSearchTimerRef.current);
    setCatalogText("");
    catalogQueryRef.current = "";
    setAdvFilter(emptyAdvFilter());
    setAdvFilterApplied(false);
    void loadCatalog(true, true);
    log("Filtro quitado.", "ok");
  }

  /* ---------------------------------------------------------------------
   * Sidebar painting helpers
   * ------------------------------------------------------------------- */
  function paintRows(opts: PaintOpts) {
    setSidebarRows({
      title: opts.title.trim() || "(sin título)",
      authors: (opts.authors || "").trim(),
      artists: (opts.artists || "").trim(),
      genres: (opts.genres || "").trim(),
      status: formatMangaStatus(opts.status),
      summary: (opts.summary || "").trim(),
      numchapter: opts.numchapter && opts.numchapter > 0 ? opts.numchapter : 0,
      moduleName: (opts.moduleName || "").trim(),
    });
    if (opts.altTitles !== undefined) {
      setAltTitles(opts.altTitles.trim());
    }
  }

  async function applyCachedCover(moduleId: string, link: string) {
    const keys = [link.trim()].filter(Boolean);
    const root = currentModule?.root_url || "";
    if (root) {
      const full = maybeFillHost(root, link);
      if (full && !keys.includes(full)) keys.push(full);
    }
    for (const key of keys) {
      try {
        const dataUrl = await api.coverLocalPath(moduleId, key);
        if (!dataUrl) continue;
        coverLocalFallbackRef.current = dataUrl;
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
    if (!loadCovers) return;
    const ensureId = ++coverEnsureSeqRef.current;
    if (!coverUrl.trim()) return;
    try {
      const dataUrl = await api.coverEnsure(moduleId, link, coverUrl, referer || null);
      if (seq !== mangaLoadSeqRef.current || ensureId !== coverEnsureSeqRef.current) return;
      coverLocalFallbackRef.current = dataUrl;
      const needsPaint = coverIsDefaultRef.current || !coverDisplayKeyRef.current;
      if (needsPaint) setCover(dataUrl, { localFallback: dataUrl, force: true });
    } catch {
      /* keep remote / default */
    }
  }

  function applyCatalogStub(e: CatalogEntry) {
    setInfoPanelOpen(true);
    paintRows({
      title: e.title || e.link,
      authors: e.authors,
      artists: e.artists,
      genres: e.genres,
      status: e.status,
      summary: e.summary,
      numchapter: e.numchapter,
      moduleName: currentModule?.name,
      altTitles: e.alttitles || "",
    });
    const root = currentModule?.root_url || "";
    const hint = resolveCover(e.cover || "", root);
    if (!coverLocalFallbackRef.current && hint) setCover(hint);
  }

  function syncMangaCacheFromInfo(mangaLink: string, info: MangaInfoResult) {
    const count = info.chapters.length;
    const cover = resolveCover(info.cover, info.root_url);
    const key = catalogLinkKey(mangaLink);
    const root = currentModule?.root_url || info.root_url || "";
    let touched = false;
    const next = catalogEntriesRef.current.map((e) => {
      const full = maybeFillHost(root, e.link);
      if (catalogLinkKey(e.link) === key || catalogLinkKey(full) === key) {
        touched = true;
        return {
          ...e,
          title: info.title || e.title,
          alttitles: info.alt_titles || e.alttitles,
          numchapter: count,
          authors: info.authors,
          artists: info.artists,
          genres: info.genres,
          status: info.status,
          summary: info.summary,
          cover,
        };
      }
      return e;
    });
    if (touched) setCatalogEntries(next);
    const moduleId = info.module_id || selectedModuleId;
    if (moduleId) {
      void api
        .mangaCacheUpsert({
          moduleId,
          link: mangaLink,
          title: info.title,
          altTitles: info.alt_titles,
          authors: info.authors,
          artists: info.artists,
          genres: info.genres,
          status: info.status,
          summary: info.summary,
          numchapter: count,
          cover,
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }

  async function syncFavoriteState(url: string) {
    setIsFavorite(false);
    if (!url) return;
    try {
      const favs = await api.favoritesList();
      setIsFavorite(favs.some((f) => f.manga_url === url));
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------------
   * Load manga info
   * ------------------------------------------------------------------- */
  async function loadMangaInfo(explicitUrl?: string) {
    const seq = ++mangaLoadSeqRef.current;
    const raw = (explicitUrl ?? urlInput).trim();
    setInfoPanelOpen(true);
    clearLog();

    const url = normalizeMangaUrl(raw);
    if (!url) {
      log(
        "URL inválida. Pega un enlace http(s) completo del manga (ej. https://sitio.com/manga/…).",
        "err",
      );
      return;
    }
    if (url !== raw) setUrlInput(url);

    setMangaUrl(url);
    setMangaLoadingUrl(url);
    log("Cargando info vía Lua GetInfo…");
    setLoadBtnDisabled(true);
    setChaptersLoading(true);

    if (!enabledModules.length) {
      log(
        "No hay sitios activos. Ve a Ajustes → Sitios Web, marca los que quieras y guarda.",
        "err",
      );
      setManga(null);
      setChaptersLoading(false);
      setMangaLoadingUrl("");
      setLoadBtnDisabled(false);
      return;
    }

    // Match URL host for the fetch; do not change the combo selection.
    let moduleId = selectedModuleId || undefined;
    try {
      const matches = await api.modulesMatchUrl(url);
      if (seq !== mangaLoadSeqRef.current) return;
      const enabled = matches.filter((m) => enabledModuleIds.has(m.id));
      if (enabled.length > 0) {
        const preferred = enabled.find((m) => m.id === selectedModuleId) ?? enabled[0];
        moduleId = preferred.id;
      } else if (!moduleId) {
        log(
          "Ningún módulo coincide con esta URL. Activa el sitio en Ajustes → Sitios Web o elige uno en el selector.",
          "err",
        );
        setManga(null);
        setChaptersLoading(false);
        setMangaLoadingUrl("");
        setLoadBtnDisabled(false);
        return;
      } else if (matches.length > 0) {
        log(
          "El módulo de esta URL no está activado en Ajustes → Sitios Web; se usa el seleccionado.",
          "",
        );
      }
    } catch {
      /* keep selected module */
    }

    if (moduleId) {
      void applyCachedCover(moduleId, url);
      void (async () => {
        try {
          const cached = await api.mangaCacheGet(moduleId, url);
          if (seq !== mangaLoadSeqRef.current || !cached) return;
          if (!mangaRef.current) {
            paintRows({
              title: cached.title?.trim() || activeCatalogTitle || cached.link,
              authors: cached.authors,
              artists: cached.artists,
              genres: cached.genres,
              status: cached.status,
              summary: cached.summary,
              numchapter: cached.numchapter,
              moduleName: currentModule?.name,
              altTitles: cached.alt_titles || "",
            });
          }
          if (cached.cover && !coverLocalFallbackRef.current) {
            const remote = resolveCover(cached.cover, currentModule?.root_url || "");
            if (remote) setCover(remote);
          }
          await applyCachedCover(moduleId, url);
        } catch {
          /* ignore */
        }
      })();
    }

    try {
      const result = await api.getMangaInfo(url, moduleId ?? null);
      if (seq !== mangaLoadSeqRef.current) return;

      setManga(result);
      setSelected(new Set());
      bumpChaptersReset();
      setChaptersLoading(false);
      setActiveCatalogTitle((cur) => cur || result.title);
      paintRows({
        title: result.title,
        authors: result.authors,
        artists: result.artists,
        genres: result.genres,
        status: result.status,
        summary: result.summary,
        numchapter: result.chapters.length,
        moduleName: result.module_name,
        altTitles: result.alt_titles,
      });

      const remote = resolveCover(result.cover, result.root_url);
      if (coverLocalFallbackRef.current) {
        setCover(coverLocalFallbackRef.current, { localFallback: coverLocalFallbackRef.current });
      } else if (remote) {
        setCover(remote);
      } else {
        setCover("");
      }

      syncMangaCacheFromInfo(url, result);

      const coverUrl = resolveCover(result.cover, result.root_url);
      const mid = result.module_id || moduleId;
      const remoteShowing =
        coverDisplayKeyRef.current.startsWith("http://") ||
        coverDisplayKeyRef.current.startsWith("https://");
      const toEnsure = coverUrl || (remoteShowing ? coverDisplayKeyRef.current : "");
      const alreadyLocal = coverLocalFallbackRef.current.startsWith("data:");
      if (loadCovers && mid && toEnsure && !alreadyLocal) {
        void ensureCoverAsync(seq, mid, url, toEnsure, result.root_url || url);
      }

      await syncFavoriteState(url);
      if (seq !== mangaLoadSeqRef.current) return;
      if (!result.title.trim() && result.chapters.length === 0) {
        log(
          `Sin datos (${result.module_name}). ¿URL correcta o sitio bloqueado?`,
          "err",
        );
      } else if (result.chapters.length === 0) {
        log(`OK sin capítulos (${result.module_name})`, "ok");
      } else {
        log(`OK: ${result.chapters.length} capítulos (${result.module_name})`, "ok");
      }
    } catch (e) {
      if (seq !== mangaLoadSeqRef.current) return;
      setManga(null);
      setChaptersLoading(false);
      log(String(e), "err");
    } finally {
      if (seq === mangaLoadSeqRef.current) {
        setMangaLoadingUrl("");
        setLoadBtnDisabled(false);
      }
    }
  }

  async function openCatalogEntry(e: CatalogEntry) {
    const root = currentModule?.root_url || "";
    const url = maybeFillHost(root, e.link);
    const title = e.title || e.link;
    setActiveCatalogTitle(title);
    setUrlInput(url);
    if (mangaLoadingUrl === url) {
      log(`Ya se está cargando: ${title}`);
      setInfoPanelOpen(true);
      applyCatalogStub(e);
      return;
    }
    coverEnsureSeqRef.current++;
    setCover("", { localFallback: "" });
    setInfoPanelOpen(true);
    applyCatalogStub(e);
    const moduleId = selectedModuleId;
    if (moduleId) void applyCachedCover(moduleId, e.link);
    log(`Abriendo ${title}…`);
    await loadMangaInfo(url);
  }

  function handleCatalogRowClick(idx: number, entry: CatalogEntry) {
    const title = entry.title || entry.link;
    setActiveCatalogTitle(title);
    const now = performance.now();
    const last = lastCatalogClickRef.current;
    if (last.idx === idx && now - last.at < 450) {
      lastCatalogClickRef.current = { idx: -1, at: 0 };
      void openCatalogEntry(entry);
      return;
    }
    lastCatalogClickRef.current = { idx, at: now };
  }

  /* ---------------------------------------------------------------------
   * Chapters
   * ------------------------------------------------------------------- */
  const chaptersView = useMemo(
    () => (manga ? [...manga.chapters].reverse() : []),
    [manga],
  );

  function toggleChapterSelected(idx: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function handleSelectAll() {
    if (!manga) return;
    setSelected((prev) => {
      if (manga.chapters.length > 0 && prev.size === manga.chapters.length) return new Set();
      return new Set(manga.chapters.map((c) => c.index));
    });
  }

  /* ---------------------------------------------------------------------
   * Output dir / enqueue / favorite / online
   * ------------------------------------------------------------------- */
  async function ensureOutputDir(): Promise<string | null> {
    if (outputDir) return outputDir;
    const saved = await api.settingsGet("default_output_dir");
    if (saved) {
      setOutputDir(saved);
      return saved;
    }
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      await api.settingsSet("default_output_dir", dir);
      return dir;
    }
    return null;
  }

  async function handlePickOutputDir() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      await api.settingsSet("default_output_dir", dir);
      log(`Carpeta por defecto: ${dir}`, "ok");
    }
  }

  async function handleEnqueue() {
    if (!manga) {
      log("Carga un manga primero.", "err");
      return;
    }
    const chapters = manga.chapters.filter((c) => selected.has(c.index));
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
      const n = await api.queueAdd({
        manga_title: manga.title || "manga",
        root_url: manga.root_url,
        manga_url: mangaUrl,
        module_id: manga.module_id,
        output_dir: dir,
        chapters,
        start: !taskStopped,
      });
      const gotoDl = await api.settingsGet("ui.goto_downloads_on_add");
      if (gotoDl !== "0" && gotoDl !== "false") setActiveNav("downloads");
      log(
        taskStopped
          ? `Encolados ${n} (detenidos). Ve a Descargas y reanuda.`
          : `Encolados ${n} capítulo(s).`,
        "ok",
      );
    } catch (e) {
      log(String(e), "err");
    }
  }

  async function handleSplitDownload() {
    if (!manga) return;
    const chapters = manga.chapters.filter((c) => selected.has(c.index));
    if (chapters.length < 2) {
      log("Selecciona al menos 2 capítulos para dividir.", "err");
      return;
    }
    const dir = await ensureOutputDir();
    if (!dir) {
      log("Elige una carpeta de salida.", "err");
      return;
    }
    const mid = Math.ceil(chapters.length / 2);
    const batches = [chapters.slice(0, mid), chapters.slice(mid)];
    try {
      let total = 0;
      for (const batch of batches) {
        total += await api.queueAdd({
          manga_title: manga.title || "manga",
          root_url: manga.root_url,
          manga_url: mangaUrl,
          module_id: manga.module_id,
          output_dir: dir,
          chapters: batch,
          start: !taskStopped,
        });
      }
      log(`Dividido en ${batches.length} tareas (${total} caps).`, "ok");
    } catch (e) {
      log(String(e), "err");
    }
  }

  async function handleFavAdd() {
    if (!manga || !mangaUrl) {
      log("Carga un manga primero.", "err");
      return;
    }
    try {
      const fav = await api.favoritesAdd({
        module_id: manga.module_id,
        module_name: manga.module_name,
        root_url: manga.root_url,
        manga_url: mangaUrl,
        title: manga.title || mangaUrl,
        chapters: manga.chapters,
      });
      setIsFavorite(true);
      log(`Favorito guardado: ${fav.title} (último: ${fav.last_chapter_name || "—"})`, "ok");
      const gotoFav = await api.settingsGet("ui.goto_favorites_on_add");
      if (gotoFav === "1" || gotoFav === "true") setActiveNav("favorites");
    } catch (e) {
      log(String(e), "err");
    }
  }

  async function handleOnlineClick() {
    if (!mangaUrl) return;
    try {
      await openUrl(mangaUrl);
    } catch (e) {
      log(`No se pudo abrir: ${e}`, "err");
    }
  }

  /* ---------------------------------------------------------------------
   * Filter panel
   * ------------------------------------------------------------------- */
  function setInfoMode(mode: InfoMode) {
    setInfoModeState(mode);
  }

  function cycleGenre(id: string) {
    setAdvFilter((prev) => {
      const cur = prev.genres[id] ?? "ignore";
      const next = GENRE_TRI_CYCLE[(GENRE_TRI_CYCLE.indexOf(cur) + 1) % GENRE_TRI_CYCLE.length];
      return { ...prev, genres: { ...prev.genres, [id]: next } };
    });
  }

  function updateFilterField<K extends keyof AdvFilterState>(key: K, value: AdvFilterState[K]) {
    setAdvFilter((prev) => ({ ...prev, [key]: value }));
  }

  const filterActiveCount = useMemo(() => {
    let n = 0;
    for (const g of DEFAULT_GENRES) {
      if ((advFilter.genres[g.id] ?? "ignore") !== "ignore") n += 1;
    }
    if (advFilter.customGenres.trim()) n += 1;
    if (advFilter.title.trim()) n += 1;
    if (advFilter.authors.trim()) n += 1;
    if (advFilter.artists.trim()) n += 1;
    if (advFilter.summary.trim()) n += 1;
    if (advFilter.status !== 4) n += 1;
    if (advFilter.onlyNew) n += 1;
    if (advFilter.allSites) n += 1;
    if (advFilter.useRegex) n += 1;
    return n;
  }, [advFilter]);

  function resetAdvFilterForm() {
    setAdvFilter(emptyAdvFilter());
    log("Valores del filtro reiniciados.", "ok");
  }

  /* ---------------------------------------------------------------------
   * Derived render values
   * ------------------------------------------------------------------- */
  const sourceLabel = sourcesLoading
    ? "Cargando fuentes…"
    : currentModule && enabledModuleIds.has(currentModule.id)
      ? currentModule.name
      : enabledModules.length
        ? "Seleccionar fuente…"
        : "Sin fuentes";

  const infoRows: { icon: IconName; label: string; value: string }[] = [];
  if (sidebarRows.authors) infoRows.push({ icon: "user", label: "Autor", value: sidebarRows.authors });
  if (sidebarRows.artists) infoRows.push({ icon: "brush", label: "Artista", value: sidebarRows.artists });
  if (sidebarRows.genres) infoRows.push({ icon: "about", label: "Géneros", value: sidebarRows.genres });
  if (sidebarRows.status) infoRows.push({ icon: "status", label: "Estado", value: sidebarRows.status });
  const fuente = sidebarRows.moduleName || currentModule?.name || "—";
  const capsLabel = sidebarRows.numchapter ? `caps. ${sidebarRows.numchapter}` : "caps. —";

  const chaptersHasManga = !!manga;
  const selectAllLabel =
    manga && manga.chapters.length > 0 && selected.size === manga.chapters.length
      ? "Deseleccionar"
      : "Seleccionar todo";

  function renderChaptersBody() {
    if (chaptersLoading) {
      return (
        <div className="chapters-list" id="chapters">
          <div className="panel-loading">
            <span className="spinner" />
            Cargando capítulos…
          </div>
        </div>
      );
    }
    if (!manga) {
      return (
        <div className="chapters-list" id="chapters">
          <div className="chapters-empty">
            <img className="chapters-empty-art" src={chaptersEmptyUrl} alt="" />
            <p className="chapters-empty-text">
              Doble clic en un título del catálogo, o pega un enlace arriba.
            </p>
          </div>
        </div>
      );
    }
    if (!manga.chapters.length) {
      return (
        <div className="chapters-list" id="chapters">
          <div className="catalog-empty">Sin capítulos.</div>
        </div>
      );
    }
    return (
      <VirtualList
        id="chapters"
        className="chapters-list"
        innerClassName="chapters-virtual"
        items={chaptersView}
        itemHeight={CH_ROW_H}
        gap={CH_ROW_GAP}
        overscan={CH_OVERSCAN}
        resetKey={chaptersResetSeq}
        getKey={(c) => c.index}
        renderItem={(c, _i, style: CSSProperties) => {
          const on = selected.has(c.index);
          return (
            <button
              type="button"
              className={`ch-card${on ? " is-on" : ""}`}
              style={style}
              onClick={() => toggleChapterSelected(c.index)}
            >
              <div className="ch-box">
                {on && <Icon name="check" className="ico ico-sm" style={{ color: "var(--on-accent)" }} />}
              </div>
              <span className="ch-num">{chapterNum(c.index)}</span>
              <span className="ch-title">{c.name || `Capítulo ${c.index + 1}`}</span>
            </button>
          );
        }}
      />
    );
  }

  function renderCatalogBody() {
    if (!enabledModules.length) {
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="catalog-empty">
            No hay sitios activos.
            <br />
            Ve a Ajustes → Sitios Web, marca los que quieras y guarda.
          </div>
        </div>
      );
    }
    if (catalogLoading) {
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="panel-loading">
            <span className="spinner" />
            {catalogLoadingText}
          </div>
        </div>
      );
    }
    if (catalogError) {
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="catalog-empty">Error al cargar el catálogo.</div>
        </div>
      );
    }
    if (!visibleCatalog.length) {
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="catalog-empty">Sin resultados.</div>
        </div>
      );
    }
    return (
      <VirtualList
        id="catalog-list"
        className="catalog-results"
        innerClassName="catalog-virtual"
        items={visibleCatalog}
        itemHeight={CAT_ROW_H}
        overscan={CAT_OVERSCAN}
        resetKey={catalogResetSeq}
        getKey={(e, i) => `${i}:${e.link}`}
        renderItem={(e, i, style: CSSProperties) => {
          const title = e.title || e.link;
          const caps =
            e.numchapter > 0
              ? e.numchapter
              : manga && title === activeCatalogTitle
                ? manga.chapters.length
                : 0;
          return (
            <button
              type="button"
              className={`catalog-row${title === activeCatalogTitle ? " active" : ""}`}
              style={style}
              title={caps > 0 ? `${title} · ${caps} caps.` : title}
              onClick={() => handleCatalogRowClick(i, e)}
            >
              <div className="catalog-row-title">{title}</div>
              {caps > 0 && <span className="catalog-row-meta">{caps}</span>}
            </button>
          );
        }}
      />
    );
  }

  /* ---------------------------------------------------------------------
   * Render
   * ------------------------------------------------------------------- */
  return (
    <section id="view-info" className="view view-info" hidden={activeNav !== "info"}>
      <aside className="search-panel">
        <div className="search-panel-head">
          <div className="seg">
            <button
              type="button"
              className={`seg-btn${infoMode === "search" ? " active" : ""}`}
              id="seg-search"
              onClick={() => setInfoMode("search")}
            >
              Info
            </button>
            <button
              type="button"
              className={`seg-btn${infoMode === "filter" ? " active" : ""}`}
              id="seg-filter"
              onClick={() => setInfoMode("filter")}
            >
              Filtro
            </button>
          </div>
          <div className="field-label">Fuente</div>
          <div className="source-row">
            <div className="source-dd">
              <button
                type="button"
                className="source-trigger"
                id="source-trigger"
                disabled={sourcesLoading}
                onClick={() => setSourceOpen((o) => !o)}
              >
                <span id="source-label">{sourceLabel}</span>
                <Icon
                  name="chevron"
                  className="ico ico-sm"
                  style={{ color: "var(--on-accent)", opacity: 0.55 }}
                />
              </button>
              <div
                className="source-backdrop"
                id="source-backdrop"
                hidden={!sourceOpen}
                onClick={() => setSourceOpen(false)}
              />
              <div className="source-menu" id="source-menu" hidden={!sourceOpen}>
                <div className="source-search-wrap">
                  <Icon name="search" className="ico ico-sm" />
                  <input
                    ref={sourceQRef}
                    id="source-q"
                    type="text"
                    placeholder="Buscar fuente..."
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={sourceFilter}
                    onChange={(ev) => setSourceFilter(ev.target.value)}
                    onClick={(ev) => ev.stopPropagation()}
                  />
                </div>
                <div className="source-list" id="source-list" ref={sourceListRef}>
                  {filteredSourceModules.length ? (
                    filteredSourceModules.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`dd-item${m.id === selectedModuleId ? " on" : ""}`}
                        data-id={m.id}
                        onClick={() => handleSelectSource(m)}
                      >
                        <span>{m.name}</span>
                        {m.id === selectedModuleId && <Icon name="check" className="ico ico-sm" />}
                      </button>
                    ))
                  ) : (
                    <div className="catalog-empty" style={{ color: "var(--on-accent)", opacity: 0.7 }}>
                      Sin fuentes
                    </div>
                  )}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="ghost"
              id="source-tools"
              title="Herramientas de catálogo"
              disabled={!!catalogJob}
              onClick={() => setSourceToolsOpen(true)}
            >
              <Icon name="sliders" className="ico" />
            </button>
          </div>
          <div className="search-input-row">
            <div className="search-field">
              <Icon name="search" className="ico ico-sm" />
              <input
                id="catalog-q"
                type="text"
                placeholder="Buscar título..."
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{ fontSize: "12px", fontWeight: 400, lineHeight: "36px" }}
                value={catalogText}
                onChange={(ev) => handleCatalogInputChange(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    window.clearTimeout(catalogSearchTimerRef.current);
                    runCatalogSearch();
                  }
                }}
              />
              <button
                type="button"
                className="search-clear"
                id="catalog-clear"
                hidden={!catalogText.trim()}
                title="Limpiar"
                onClick={clearCatalogFilter}
              >
                <Icon name="x" className="ico ico-sm" />
              </button>
            </div>
            <button
              type="button"
              className="ghost"
              id="catalog-broom"
              title="Limpiar filtro"
              onClick={clearCatalogFilter}
            >
              <Icon name="broom" className="ico" />
            </button>
          </div>
        </div>
        <div className="search-mode-bar">
          <span>
            Modo:{" "}
            <strong id="catalog-mode-label">
              {advFilterApplied ? "filtro (UI)" : "búsqueda individual"}
            </strong>
          </span>
          <div className="search-mode-right">
            <button
              type="button"
              className="ghost ghost-sm"
              id="catalog-clear-adv"
              title="Quitar filtro"
              onClick={clearAllFilters}
            >
              <Icon name="filterOff" className="ico ico-sm" />
            </button>
            <span className="result-badge" id="catalog-stats">
              {catalogStatsText}
            </span>
          </div>
        </div>
        {renderCatalogBody()}
      </aside>

      <div className="info-main">
        <div className={`info-top${infoMode === "filter" ? " is-filter" : ""}`}>
          <div className="info-center" hidden={infoMode === "filter"}>
            <div className="url-bar-wrap">
              <div className="url-bar">
                <input
                  id="url"
                  type="text"
                  inputMode="url"
                  placeholder="https://sitio.com/manga/…"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={urlInput}
                  onChange={(ev) => setUrlInput(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void loadMangaInfo();
                  }}
                />
                <button
                  type="button"
                  className="url-clear"
                  id="url-clear"
                  hidden={!urlInput.trim()}
                  title="Limpiar"
                  onClick={() => setUrlInput("")}
                >
                  <Icon name="x" className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className="url-go"
                  id="load"
                  title="Cargar"
                  disabled={loadBtnDisabled || !urlInput.trim()}
                  onClick={() => void loadMangaInfo()}
                >
                  <Icon name="arrowRight" className="ico" />
                </button>
              </div>
            </div>

            <div className="chapters-panel">
              <div className="chapters-tex" aria-hidden="true" />
              <div className="chapters-head" id="chapters-head" hidden={!chaptersHasManga}>
                <div className="chapters-head-left">
                  <span className="chapters-label">Capítulos</span>
                  <span className="chapters-meta" id="chapters-available" hidden={!chaptersHasManga}>
                    {manga ? `${manga.chapters.length} disponibles` : ""}
                  </span>
                </div>
                <div className="chapters-head-right">
                  <span className="sel-count" id="count" hidden={!chaptersHasManga}>
                    {manga ? `${selected.size} seleccionados` : ""}
                  </span>
                  <button
                    type="button"
                    className="btn-select-all"
                    id="sel-all"
                    hidden={!chaptersHasManga}
                    onClick={handleSelectAll}
                  >
                    {selectAllLabel}
                  </button>
                </div>
              </div>
              {renderChaptersBody()}
            </div>
          </div>

          <aside
            className={`info-sidebar${infoSidebarCollapsed ? " is-collapsed" : ""}`}
            id="info-sidebar"
            hidden={infoMode === "filter"}
          >
            <button
              type="button"
              className="info-sidebar-notch"
              id="info-sidebar-notch"
              title={infoSidebarCollapsed ? "Mostrar panel" : "Ocultar panel"}
              aria-expanded={!infoSidebarCollapsed}
              hidden={hideInfo || (!manga && !infoPanelOpen)}
              onClick={() => setInfoSidebarCollapsed((c) => !c)}
            >
              <Icon
                name="chevron"
                className={`ico ico-sm info-sidebar-notch-ico${infoSidebarCollapsed ? " is-collapsed" : ""}`}
              />
            </button>
            <div className="info-sidebar-body">
            <div className="info-sidebar-blur" id="cover-blur">
              <img id="cover-blur-img" src={coverSrc} alt="" />
            </div>
            <div className="info-sidebar-fade" aria-hidden="true" />
            <div className="info-sidebar-scroll">
              <div className="info-sidebar-inner">
                <div className="cover-frame">
                  <img
                    id="cover-img"
                    alt="portada"
                    src={coverSrc}
                    className={[
                      coverIsDefault ? "is-default" : "",
                      coverEnhanced ? "is-enhanced" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined}
                    onLoad={handleCoverImgLoad}
                    onError={handleCoverImgError}
                  />
                  <div className="cover-placeholder" id="cover-ph" hidden>
                    Sin portada
                  </div>
                </div>
                <div>
                  <h1 className="info-title" id="title">
                    {sidebarRows.title}
                  </h1>
                  <div className="info-alt" id="alt-titles" hidden={!altTitles}>
                    {altTitles}
                  </div>
                </div>
                <div className="info-actions">
                  <button
                    type="button"
                    className="info-action-btn"
                    id="btn-online"
                    disabled={!mangaUrl}
                    onClick={() => void handleOnlineClick()}
                  >
                    <Icon name="external" className="ico ico-sm" /> Leer en línea
                  </button>
                  <button
                    type="button"
                    className="info-action-btn"
                    id="fav-add"
                    disabled={!infoPanelOpen}
                    onClick={() => void handleFavAdd()}
                  >
                    <Icon name={isFavorite ? "heartSolid" : "heart"} className="ico ico-sm" />
                    <span id="fav-label">{isFavorite ? "En favoritos" : "Añadir a favoritos"}</span>
                  </button>
                </div>
                <div className="info-rows" id="info-rows">
                  {infoRows.map((r) => (
                    <div className="info-row" key={r.label}>
                      <Icon name={r.icon} className="ico" />
                      <div>
                        <div className="info-row-label">{r.label}</div>
                        <div className="info-row-value">{r.value}</div>
                      </div>
                    </div>
                  ))}
                  {sidebarRows.summary ? (
                    <div className="info-summary">
                      <div className="info-row-label">Sinopsis</div>
                      <div className="info-summary-text">{sidebarRows.summary}</div>
                    </div>
                  ) : null}
                  <div className="info-meta-line">
                    {fuente} <span className="info-meta-sep">—</span> {capsLabel}
                  </div>
                </div>
              </div>
            </div>
            </div>
          </aside>

          <div className="filter-panel" id="filter-panel" hidden={infoMode !== "filter"}>
            <header className="filter-head">
              <div>
                <div className="filter-eyebrow">Búsqueda avanzada</div>
                <h1 className="filter-title">Filtro</h1>
              </div>
              <div className="filter-head-meta">
                <Icon name="filter" className="ico ico-sm" />
                <span>
                  <span className="filter-active-n" id="filter-active-count">
                    {filterActiveCount}
                  </span>{" "}
                  filtros activos
                </span>
              </div>
            </header>

            <div className="filter-scroll">
              <div className="filter-grid">
                <section className="filter-card filter-card-genres">
                  <div className="filter-card-head">
                    <div className="filter-card-title">
                      <Icon name="tag" className="ico ico-sm" />
                      <h2>Géneros</h2>
                      <Icon
                        name="about"
                        className="filter-hint ico ico-sm"
                        title={FILTER_CUSTOM_HINT}
                      />
                    </div>
                    <div className="filter-legend" aria-hidden="true">
                      <span className="filter-legend-item">
                        <span className="filter-legend-dot inc" />
                        Incluir
                      </span>
                      <span className="filter-legend-item">
                        <span className="filter-legend-dot exc" />
                        Excluir
                      </span>
                    </div>
                  </div>
                  <div className="filter-genres" id="filter-genres" role="group" aria-label="Géneros">
                    {DEFAULT_GENRES.map((g) => {
                      const state = advFilter.genres[g.id] ?? "ignore";
                      return (
                        <button
                          key={g.id}
                          type="button"
                          className={genreChipClass(state)}
                          data-genre={g.id}
                          title={
                            state === "include"
                              ? "Incluir"
                              : state === "exclude"
                                ? "Excluir"
                                : "No importa (clic para cambiar)"
                          }
                          onClick={() => cycleGenre(g.id)}
                        >
                          <span className="dot" aria-hidden="true" />
                          {g.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="filter-extra">
                    <label className="filter-extra-label" id="filter-custom-label" htmlFor="filter-custom">
                      Géneros extra
                    </label>
                    <input
                      id="filter-custom"
                      className="st-field"
                      type="text"
                      placeholder="Ej.: Aventura, !Ecchi, Comedia"
                      autoComplete="off"
                      spellCheck={false}
                      value={advFilter.customGenres}
                      onChange={(ev) => updateFilterField("customGenres", ev.target.value)}
                    />
                    <div className="filter-extra-hint">
                      Antepón <code>!</code> para excluir un género
                    </div>
                  </div>
                </section>

                <section className="filter-card filter-card-details">
                  <div className="filter-card-head">
                    <div className="filter-card-title">
                      <Icon name="text" className="ico ico-sm" />
                      <h2>Detalles</h2>
                    </div>
                  </div>
                  <div className="filter-details">
                    <label htmlFor="filter-title">Título</label>
                    <div className="fl-row">
                      <input
                        id="filter-title"
                        className="st-field"
                        type="text"
                        placeholder="Parte del título"
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.title}
                        onChange={(ev) => updateFilterField("title", ev.target.value)}
                      />
                    </div>
                    <label htmlFor="filter-authors">Autor</label>
                    <div className="fl-row">
                      <input
                        id="filter-authors"
                        className="st-field"
                        type="text"
                        placeholder="Nombre del autor"
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.authors}
                        onChange={(ev) => updateFilterField("authors", ev.target.value)}
                      />
                    </div>
                    <label htmlFor="filter-artists">Artista</label>
                    <div className="fl-row">
                      <input
                        id="filter-artists"
                        className="st-field"
                        type="text"
                        placeholder="Nombre del artista"
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.artists}
                        onChange={(ev) => updateFilterField("artists", ev.target.value)}
                      />
                    </div>
                    <label htmlFor="filter-status">Estado</label>
                    <div className="fl-row">
                      <div className="filter-select-wrap">
                        <select
                          id="filter-status"
                          className="st-field"
                          value={advFilter.status}
                          onChange={(ev) =>
                            updateFilterField(
                              "status",
                              Number(ev.target.value) as AdvFilterState["status"],
                            )
                          }
                        >
                          <option value={0}>Completado</option>
                          <option value={1}>En curso</option>
                          <option value={2}>En pausa</option>
                          <option value={3}>Cancelado</option>
                          <option value={4}>Sin filtrar</option>
                        </select>
                      </div>
                    </div>
                    <label htmlFor="filter-summary">Sinopsis</label>
                    <div className="fl-row">
                      <input
                        id="filter-summary"
                        className="st-field"
                        type="text"
                        placeholder="Texto en la sinopsis"
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.summary}
                        onChange={(ev) => updateFilterField("summary", ev.target.value)}
                      />
                    </div>
                  </div>
                </section>

                <div className="filter-col filter-col-side">
                  <section className="filter-card">
                    <h2 className="filter-card-label">Coincidencia de géneros</h2>
                    <label className="opt-row">
                      <input
                        type="radio"
                        name="filter-match"
                        id="filter-match-one"
                        value="one"
                        checked={advFilter.matchMode === "one"}
                        onChange={() => updateFilterField("matchMode", "one")}
                      />
                      <span className="radio" aria-hidden="true" />
                      <div>
                        <div className="opt-row-title">Cualquiera de los marcados</div>
                        <div className="opt-row-desc">Coincide con al menos uno</div>
                      </div>
                    </label>
                    <label className="opt-row">
                      <input
                        type="radio"
                        name="filter-match"
                        id="filter-match-all"
                        value="all"
                        checked={advFilter.matchMode === "all"}
                        onChange={() => updateFilterField("matchMode", "all")}
                      />
                      <span className="radio" aria-hidden="true" />
                      <div>
                        <div className="opt-row-title">Todos los marcados</div>
                        <div className="opt-row-desc">Debe cumplir todos</div>
                      </div>
                    </label>
                  </section>

                  <section className="filter-card">
                    <h2 className="filter-card-label">Opciones</h2>
                    <label className="opt-row opt-row-switch">
                      <div>
                        <div className="opt-row-title">Solo mangas nuevos</div>
                        <div className="opt-row-desc">Recién añadidos o actualizados</div>
                      </div>
                      <span className="st-switch">
                        <input
                          type="checkbox"
                          id="filter-only-new"
                          checked={advFilter.onlyNew}
                          onChange={(ev) => updateFilterField("onlyNew", ev.target.checked)}
                        />
                        <span className="sw" aria-hidden="true">
                          <span className="knob" />
                        </span>
                      </span>
                    </label>
                    <label
                      className="opt-row opt-row-switch ui-status-none"
                      title="Sin función — paridad imposible por ahora"
                    >
                      <div>
                        <div className="opt-row-title">Buscar en todas las fuentes</div>
                        <div className="opt-row-desc">Ignora la fuente seleccionada</div>
                      </div>
                      <span className="st-switch">
                        <input
                          type="checkbox"
                          id="filter-all-sites"
                          checked={advFilter.allSites}
                          onChange={(ev) => updateFilterField("allSites", ev.target.checked)}
                        />
                        <span className="sw" aria-hidden="true">
                          <span className="knob" />
                        </span>
                      </span>
                    </label>
                    <label className="opt-row opt-row-switch">
                      <div>
                        <div className="opt-row-title">Usar expresión regular</div>
                        <div className="opt-row-desc">Patrones avanzados en los campos de texto</div>
                      </div>
                      <span className="st-switch">
                        <input
                          type="checkbox"
                          id="filter-regex"
                          checked={advFilter.useRegex}
                          onChange={(ev) => updateFilterField("useRegex", ev.target.checked)}
                        />
                        <span className="sw" aria-hidden="true">
                          <span className="knob" />
                        </span>
                      </span>
                    </label>
                  </section>
                </div>
              </div>
            </div>

            <div className="filter-actions">
              <button type="button" className="btn" id="filter-apply" onClick={applyAdvFilter}>
                <Icon name="filter" className="ico ico-sm" /> Aplicar filtro
              </button>
              <button type="button" className="secondary" id="filter-remove" onClick={removeAdvFilter}>
                Quitar filtro
              </button>
              <button type="button" className="secondary" id="filter-reset" onClick={resetAdvFilterForm}>
                Reiniciar
              </button>
              <div className="filter-actions-spacer" />
              <button
                type="button"
                className="secondary"
                id="filter-back"
                onClick={() => setInfoMode("search")}
              >
                <Icon name="arrowLeft" className="ico ico-sm" /> Regresar
              </button>
            </div>
          </div>
        </div>

        <div className="action-bar">
          <div className="action-path">
            <span className="action-path-label">Guardar en</span>
            <div className="path-field">
              <input
                id="path-input"
                type="text"
                readOnly
                placeholder="Sin carpeta de salida"
                autoComplete="off"
                value={outputDir}
              />
              <button
                type="button"
                className="path-browse"
                id="pick"
                title="Examinar…"
                onClick={() => void handlePickOutputDir()}
              >
                <Icon name="folder" className="ico ico-sm" />
              </button>
            </div>
          </div>
          <label className="action-check" title="Encolar sin iniciar el worker">
            <input
              type="checkbox"
              id="task-stopped"
              checked={taskStopped}
              onChange={(e) => setTaskStopped(e.target.checked)}
            />{" "}
            Tarea detenida
          </label>
          <div className="action-btns">
            <button
              type="button"
              className="btn-split"
              id="btn-split"
              disabled={!manga || selected.size < 2}
              title="Partir la selección en dos tareas de cola"
              onClick={() => void handleSplitDownload()}
            >
              <Icon name="split" className="ico ico-sm" /> Dividir descarga
            </button>
            <button
              type="button"
              className="btn-download"
              id="enqueue"
              disabled={!manga || selected.size === 0}
              onClick={() => void handleEnqueue()}
            >
              <Icon name="download" className="ico ico-sm" /> Descargar
            </button>
          </div>
        </div>
      </div>

      {sourceToolsOpen ? (
        <div
          className="info-modal-backdrop"
          role="presentation"
          onClick={() => setSourceToolsOpen(false)}
        >
          <div
            className="info-modal info-modal-catalog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-tools-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="info-modal-head">
              <h2 id="source-tools-title" className="info-modal-title">
                Catálogo
              </h2>
              <button
                type="button"
                className="ghost"
                title="Cerrar"
                onClick={() => setSourceToolsOpen(false)}
              >
                <Icon name="x" className="ico" />
              </button>
            </header>
            <div className="info-modal-body">
              <div className="catalog-tools-radios" role="radiogroup" aria-label="Acción de catálogo">
                <div className="catalog-tools-group">
                  <label
                    className={`catalog-tools-radio${sourceToolsAction === "update_one" ? " is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="catalog-tools-action"
                      checked={sourceToolsAction === "update_one"}
                      disabled={!!catalogJob}
                      onChange={() => setSourceToolsAction("update_one")}
                    />
                    <span className="catalog-tools-radio-mark" aria-hidden="true" />
                    <span>Actualizar lista de manga</span>
                  </label>
                  <label
                    className={`catalog-tools-radio${sourceToolsAction === "fetch_one" ? " is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="catalog-tools-action"
                      checked={sourceToolsAction === "fetch_one"}
                      disabled={!!catalogJob}
                      onChange={() => setSourceToolsAction("fetch_one")}
                    />
                    <span className="catalog-tools-radio-mark" aria-hidden="true" />
                    <span>Descargar la lista de manga desde el servidor FMD</span>
                  </label>
                </div>
                <div className="catalog-tools-group is-split">
                  <label
                    className={`catalog-tools-radio${sourceToolsAction === "update_all" ? " is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="catalog-tools-action"
                      checked={sourceToolsAction === "update_all"}
                      disabled={!!catalogJob}
                      onChange={() => setSourceToolsAction("update_all")}
                    />
                    <span className="catalog-tools-radio-mark" aria-hidden="true" />
                    <span>Actualizar todas las listas inmediatamente</span>
                  </label>
                  <label
                    className={`catalog-tools-radio${sourceToolsAction === "fetch_all" ? " is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="catalog-tools-action"
                      checked={sourceToolsAction === "fetch_all"}
                      disabled={!!catalogJob}
                      onChange={() => setSourceToolsAction("fetch_all")}
                    />
                    <span className="catalog-tools-radio-mark" aria-hidden="true" />
                    <span>Descargar todas las listas desde el servidor FMD inmediatamente</span>
                  </label>
                </div>
              </div>
            </div>
            <footer className="info-modal-foot">
              <button
                type="button"
                className="info-modal-btn"
                onClick={() => setSourceToolsOpen(false)}
              >
                Cerrar
              </button>
              <button
                type="button"
                className="info-modal-btn info-modal-btn-primary"
                disabled={!!catalogJob}
                onClick={() => {
                  const scope =
                    sourceToolsAction === "update_all" || sourceToolsAction === "fetch_all"
                      ? "all"
                      : "one";
                  const mode =
                    sourceToolsAction === "fetch_one" || sourceToolsAction === "fetch_all"
                      ? "fetch"
                      : "update";
                  setSourceToolsOpen(false);
                  void startCatalogJob({
                    mode,
                    scope,
                    moduleId: selectedModuleId,
                  });
                }}
              >
                Aplicar
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
