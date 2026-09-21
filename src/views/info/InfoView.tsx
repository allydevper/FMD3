import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appConfirm } from "../../components/AppConfirm";
import { appToast, appToastUndo } from "../../components/AppToast";
import { Icon } from "../../components/Icon";
import {
  VirtualList,
  type VirtualListHandle,
} from "../../components/VirtualList";
import {
  resolveListKeyAction,
  resolveRowClick,
  useListSelection,
} from "../../hooks/useListSelection";
import type { IconName } from "../../icons";
import {
  CATALOG_PAGE,
  CAT_OVERSCAN,
  CAT_ROW_H,
  CAT_ROW_H_ALL_SITES,
  CAT_PAGE_STEP,
  CH_OVERSCAN,
  CH_PAGE_STEP,
  CH_ROW_GAP,
  CH_ROW_H,
  DEFAULT_GENRES,
  GENRE_TRI_CYCLE,
  MARK_REFRESH_DEBOUNCE_MS,
  emptyAdvFilter,
  cloneAdvFilter,
  advFilterToPayload,
  isCatalogEntryNew,
  SK,
} from "../../constants";
import { useApp } from "../../context/AppContext";
import * as api from "../../api/tauri";
import { confirmIfEnabled } from "../../utils/settings";
import { genreLabel, t, tPlural, useLanguage } from "../../i18n";
import {
  catalogLinkKey,
  maybeFillHost,
  normalizeMangaUrl,
  resolveCover,
  urlMatchesModuleHost,
  urlsReferToSameManga,
} from "../../utils/url";
import {
  favoritesCacheRemove,
  favoritesCacheUpsert,
  loadFavoritesCached,
  matchFavorite,
  matchFavoriteCached,
} from "../../utils/favoritesCache";
import coverDefaultUrl from "../../assets/cover-default.svg";
import chaptersEmptyUrl from "../../assets/chapters-empty.png";
import type {
  AdvFilterState,
  CatalogEntry,
  FavoriteAddRequest,
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
      return t("mangaStatus.completed");
    case "1":
      return t("mangaStatus.ongoing");
    case "2":
      return t("mangaStatus.hiatus");
    case "3":
      return t("mangaStatus.cancelled");
    case "Unknown":
      return "";
    default:
      return s;
  }
}

function chapterNum(index: number): string {
  return String(index + 1).padStart(4, "0");
}

function isNaTitle(title: string | undefined | null): boolean {
  const raw = (title || "").trim();
  return !raw || raw.toUpperCase() === "N/A";
}

function inaccessibleInfoMessage(moduleName: string): string {
  const mod = moduleName.trim() || t("explore.moduleFallback");
  return t("explore.inaccessible", { mod });
}

function genreChipClass(state: GenreTri): string {
  if (state === "include") return "chip inc";
  if (state === "exclude") return "chip exc";
  return "chip";
}

export function InfoView() {
  useLanguage();
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
    refreshEnabledModules,
    setShowMangaInfo,
    enabledModuleIds,
    hideInfo,
    catalogJob,
    catalogJobDoneSeq,
    lastCatalogJobModuleIds,
    startCatalogJob,
    pendingMangaOpen,
    setPendingMangaOpen,
    ensureModuleEnabled,
  } = useApp();

  /* ---------------------------------------------------------------------
   * Source picker
   * ------------------------------------------------------------------- */
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesBooted, setSourcesBooted] = useState(false);
  const sourceQRef = useRef<HTMLInputElement>(null);
  const sourceListRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------------
   * Catalog (left panel)
   * ------------------------------------------------------------------- */
  const [catalogRows, setCatalogRowsState] = useState<(CatalogEntry | undefined)[]>([]);
  const catalogRowsRef = useRef<(CatalogEntry | undefined)[]>([]);
  const setCatalogRows = useCallback((v: (CatalogEntry | undefined)[]) => {
    catalogRowsRef.current = v;
    setCatalogRowsState(v);
  }, []);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const catalogTotalRef = useRef(0);

  const [catalogText, setCatalogText] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  /** True after at least one catalog query finished for the current selection. */
  const [catalogFetched, setCatalogFetched] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogStatsText, setCatalogStatsText] = useState("0");
  const [catalogResetSeq, setCatalogResetSeq] = useState(0);
  const [activeCatalogTitle, setActiveCatalogTitle] = useState("");
  /** Title from last catalog stub — survives async GetInfo when painting fail state. */
  const pendingSidebarTitleRef = useRef("");
  const [catalogCtxMenu, setCatalogCtxMenu] = useState<{
    x: number;
    y: number;
    entry: CatalogEntry;
    isFav: boolean;
    favoriteId: number | null;
    /** Multi-select: only bulk-add is offered. */
    isBulk: boolean;
    bulkCount: number;
  } | null>(null);
  const catalogCtxMenuRef = useRef<HTMLDivElement | null>(null);
  const [catalogSelectedKeys, setCatalogSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const catalogSelectedEntriesRef = useRef<Map<string, CatalogEntry>>(new Map());
  const catalogSelectAnchorIdxRef = useRef(0);
  /** Fila del cursor de teclado en el catálogo (-1 = ninguna). */
  const [catalogCursorIdx, setCatalogCursorIdxState] = useState(-1);
  const catalogCursorIdxRef = useRef(-1);
  const catalogApiRef = useRef<VirtualListHandle | null>(null);
  const visibleCatalogRef = useRef<(CatalogEntry | undefined)[]>([]);

  const catalogQueryRef = useRef("");
  const catalogLoadedKeyRef = useRef("");
  /** Dedupes auto-load effect when deps churn with the same module id. */
  const catalogAutoLoadKeyRef = useRef("");
  const catalogSearchTimerRef = useRef<number | undefined>(undefined);
  const catalogLoadGenRef = useRef(0);
  const loadedPagesRef = useRef<Set<number>>(new Set());
  const inflightRef = useRef<Set<number>>(new Set());
  const wantedPagesRef = useRef<number[]>([]);
  const fillRunningRef = useRef(false);
  const fillWaitersRef = useRef<Array<() => void>>([]);
  const lastCatalogClickRef = useRef<{ idx: number; at: number }>({ idx: -1, at: 0 });
  const downloadAllFromCatalogBulkRef = useRef<(entries?: CatalogEntry[]) => void>(
    () => {},
  );
  const removeFromCatalogRef = useRef<(entries: CatalogEntry[]) => void>(() => {});
  /** Último rango visible de la lista virtual, para repoblarlo tras recargar. */
  const catalogRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  function bumpCatalogReset() {
    setCatalogResetSeq((s) => s + 1);
  }

  function setCatalogCursorIdx(idx: number) {
    catalogCursorIdxRef.current = idx;
    setCatalogCursorIdxState(idx);
  }

  function focusCatalogList() {
    catalogApiRef.current?.getContainer()?.focus({ preventScroll: true });
  }

  function clearCatalogSelection() {
    setCatalogSelectedKeys(new Set());
    catalogSelectedEntriesRef.current = new Map();
    setCatalogCursorIdx(-1);
  }

  function catalogRowKey(entry: CatalogEntry): string {
    return `${entry.module_id || selectedModuleId || ""}:${entry.link}`;
  }

  /** True if this catalog row is the title currently shown in the info sidebar. */
  function catalogEntryMatchesSidebar(entry: CatalogEntry, entryUrl?: string): boolean {
    const rowKey = catalogRowKey(entry);
    if (rowKey && rowKey === sidebarCatalogRowKeyRef.current) return true;
    const openUrl = (mangaUrl || urlInput || "").trim();
    if (!openUrl) return false;
    const openKey = catalogLinkKey(openUrl);
    if (entryUrl && catalogLinkKey(entryUrl) === openKey) return true;
    const { mod } = catalogEntryModule(entry);
    const filled = maybeFillHost(mod?.root_url || "", entry.link);
    return !!filled && catalogLinkKey(filled) === openKey;
  }

  function applySidebarFavoriteState(isFav: boolean, id: number | null) {
    setIsFavorite(isFav);
    setFavoriteId(id);
  }

  function showFavoriteRemovedToast(snapshot: FavoriteAddRequest, matchesSidebar: boolean) {
    appToastUndo({
      message: tPlural("favorites.removed", 1),
      durationMs: 6000,
      onUndo: async () => {
        try {
          const fav = await api.favoritesAdd(snapshot);
          favoritesCacheUpsert(fav);
          if (matchesSidebar) applySidebarFavoriteState(true, fav.id);
          log(t("explore.favRestored", { title: fav.title }), "ok");
        } catch (e) {
          log(String(e), "err");
        }
      },
    });
  }

  function replaceCatalogSelection(entry: CatalogEntry, idx: number) {
    const key = catalogRowKey(entry);
    const map = new Map<string, CatalogEntry>([[key, entry]]);
    catalogSelectedEntriesRef.current = map;
    setCatalogSelectedKeys(new Set([key]));
    catalogSelectAnchorIdxRef.current = idx;
    setCatalogCursorIdx(idx);
  }

  /** Rango ancla->idx sobre las filas ya cargadas; los huecos se saltan. */
  function selectCatalogRange(idx: number) {
    const rows = visibleCatalogRef.current;
    const anchor = catalogSelectAnchorIdxRef.current;
    const from = Math.min(anchor, idx);
    const to = Math.max(anchor, idx);
    const next = new Set<string>();
    const map = new Map<string, CatalogEntry>();
    for (let i = from; i <= to; i++) {
      const e = rows[i];
      if (!e) continue;
      const k = catalogRowKey(e);
      next.add(k);
      map.set(k, e);
    }
    catalogSelectedEntriesRef.current = map;
    setCatalogSelectedKeys(next);
    setCatalogCursorIdx(idx);
    lastCatalogClickRef.current = { idx: -1, at: 0 };
  }

  /** Ctrl+clic / Espacio: alterna una fila sin tocar el resto. */
  function toggleCatalogEntry(entry: CatalogEntry, idx: number) {
    const key = catalogRowKey(entry);
    const next = new Set(catalogSelectedKeys);
    const map = new Map(catalogSelectedEntriesRef.current);
    if (next.has(key)) {
      next.delete(key);
      map.delete(key);
      /* No dejar esta fila como "active": el fondo de foco se confunde con selección. */
      if (map.size === 0) {
        setActiveCatalogTitle("");
      } else {
        const rest = [...map.values()];
        const fallback = rest[rest.length - 1]!;
        setActiveCatalogTitle(fallback.title || fallback.link);
      }
    } else {
      next.add(key);
      map.set(key, entry);
      setActiveCatalogTitle(entry.title || entry.link);
    }
    catalogSelectedEntriesRef.current = map;
    setCatalogSelectedKeys(next);
    catalogSelectAnchorIdxRef.current = idx;
    setCatalogCursorIdx(idx);
    lastCatalogClickRef.current = { idx: -1, at: 0 };
  }

  function selectAllCatalog() {
    const next = new Set<string>();
    const map = new Map<string, CatalogEntry>();
    for (const e of visibleCatalogRef.current) {
      if (!e) continue;
      const k = catalogRowKey(e);
      next.add(k);
      map.set(k, e);
    }
    catalogSelectedEntriesRef.current = map;
    setCatalogSelectedKeys(next);
  }

  /** Mismas teclas que el resto de listas; ver `useListSelection`. */
  function handleCatalogKeyDown(ev: ReactKeyboardEvent<HTMLDivElement>) {
    const rows = visibleCatalogRef.current;
    const action = resolveListKeyAction(ev, {
      count: rows.length,
      cursorIndex: catalogCursorIdxRef.current,
      pageSize: CAT_PAGE_STEP,
    });
    if (!action) return;

    switch (action.kind) {
      case "move": {
        ev.preventDefault();
        const idx = action.index;
        catalogApiRef.current?.scrollToIndex(idx);
        const entry = rows[idx];
        /* Fila aún sin cargar: mueve el cursor y espera a que llegue la página. */
        if (!entry) {
          setCatalogCursorIdx(idx);
          return;
        }
        setInfoMode("search");
        setActiveCatalogTitle(entry.title || entry.link);
        if (action.extend) selectCatalogRange(idx);
        else replaceCatalogSelection(entry, idx);
        return;
      }
      case "toggle-cursor": {
        const idx = catalogCursorIdxRef.current;
        const entry = rows[idx];
        if (!entry) return;
        ev.preventDefault();
        toggleCatalogEntry(entry, idx);
        return;
      }
      case "select-all":
        ev.preventDefault();
        selectAllCatalog();
        return;
      case "clear":
        if (!catalogSelectedKeys.size && catalogCursorIdxRef.current < 0) return;
        ev.preventDefault();
        clearCatalogSelection();
        setActiveCatalogTitle("");
        return;
    }
  }

  function setCatalogTotalBoth(n: number) {
    catalogTotalRef.current = n;
    setCatalogTotal(n);
  }

  function resetFillQueues() {
    loadedPagesRef.current = new Set();
    inflightRef.current = new Set();
    wantedPagesRef.current = [];
    fillRunningRef.current = false;
    const waiters = fillWaitersRef.current.splice(0);
    for (const w of waiters) w();
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
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [mangaUrl, setMangaUrl] = useState("");
  const [mangaLoadingUrl, setMangaLoadingUrl] = useState("");
  const [loadBtnDisabled, setLoadBtnDisabled] = useState(false);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [chaptersResetSeq, setChaptersResetSeq] = useState(0);
  const [chDownloaded, setChDownloaded] = useState<Set<string>>(() => new Set());
  const [chQueued, setChQueued] = useState<Set<string>>(() => new Set());
  /** chapter.index -> canonical mark key, resolved by the backend on manga load. */
  const [chMarkKeys, setChMarkKeys] = useState<Map<number, string>>(
    () => new Map(),
  );
  const [infoPanelOpen, setInfoPanelOpen] = useState(false);
  const [infoSidebarCollapsed, setInfoSidebarCollapsed] = useState(false);
  const [sourceToolsOpen, setSourceToolsOpen] = useState(false);
  const [sourceToolsAction, setSourceToolsAction] = useState<
    "update_one" | "fetch_one" | "update_all" | "fetch_all"
  >("update_one");
  const [isFavorite, setIsFavorite] = useState(false);
  const [favoriteId, setFavoriteId] = useState<number | null>(null);
  /** Guards against out-of-order `refreshChapterMarks` responses. */
  const markSeqRef = useRef(0);
  /** Module of the manga currently shown / loading in the info sidebar. */
  const sidebarModuleIdRef = useRef("");
  /** Stable catalog row key for the title open in the sidebar (`module:link`). */
  const sidebarCatalogRowKeyRef = useRef("");
  const [taskStopped, setTaskStopped] = useState(false);
  const [splitPrompt, setSplitPrompt] = useState<{
    chapters: { index: number; name: string; link: string }[];
    count: number;
  } | null>(null);
  const [enqueueBusy, setEnqueueBusy] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const loadCoversRef = useRef(true);

  const [sidebarRows, setSidebarRows] = useState<SidebarRows>(EMPTY_SIDEBAR_ROWS);
  const [altTitles, setAltTitles] = useState("");
  /** Set when GetInfo returned / cache has title N/A — chapters panel shows manual-update hint. */
  const [infoInaccessible, setInfoInaccessible] = useState<{ moduleName: string } | null>(null);

  const mangaLoadSeqRef = useRef(0);
  const coverEnsureSeqRef = useRef(0);
  const favSyncSeqRef = useRef(0);

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

  function setLoadCoversFlag(on: boolean) {
    loadCoversRef.current = on;
  }

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
    // Off = no remote fetch; only show cover-cache / data URLs already on disk.
    const remote =
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("//");
    if (!loadCoversRef.current && remote) {
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
  /** Snapshot used for the list; only updates on Aplicar / Quitar. */
  const [appliedAdvFilter, setAppliedAdvFilter] = useState<AdvFilterState>(() => emptyAdvFilter());
  const [advFilterApplied, setAdvFilterApplied] = useState(false);
  const advFilterAppliedRef = useRef(false);
  const appliedAdvFilterRef = useRef<AdvFilterState>(emptyAdvFilter());
  const [filterNewDays, setFilterNewDays] = useState(1);
  const [liveSearch, setLiveSearch] = useState(true);

  /* ---------------------------------------------------------------------
   * Bootstrap: modules + output dir + initial catalog load
   * ------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [mods, enabled, savedRaw] = await Promise.all([
          refreshModules(),
          refreshEnabledModules(),
          api.settingsGet(SK.UI_SELECTED_MODULE),
        ]);
        if (cancelled) return;
        const enabledList = mods.filter((m) => enabled.has(m.id));
        const saved = (savedRaw ?? "").trim();
        const pick =
          (saved && enabledList.some((m) => m.id === saved) ? saved : null) ??
          enabledList[0]?.id ??
          null;
        setSelectedModuleId(pick);
      } catch {
        /* ignore boot errors; UI falls back to empty/error states */
      } finally {
        if (!cancelled) setSourcesBooted(true);
      }
    })();
    // Warm favorites cache so sidebar heart doesn't flicker on first open.
    void loadFavoritesCached().catch(() => {
      /* ignore */
    });
    if (!outputDir) {
      void (async () => {
        const saved = ((await api.settingsGet("default_output_dir")) ?? "").trim();
        if (saved) setOutputDir(saved);
        else setOutputDir(await api.defaultSaveDir());
      })();
    }
    void api.settingsGet("ui.load_covers").then((v) => {
      setLoadCoversFlag(!(v === "0" || v === "false"));
    });
    void api.settingsGet("ui.new_days").then((v) => {
      const n = Number(v ?? "1");
      if (Number.isFinite(n) && n > 0) setFilterNewDays(n);
    });
    void api.settingsGet("ui.live_search").then((v) => {
      if (v === "0" || v === "false") setLiveSearch(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The DB is the only source of truth: whatever it returns *is* the mark set. No
   * merging with previous state — marks are append-only in the backend, so a chapter
   * missing from the listing simply was never downloaded.
   *
   * `markSeqRef` drops out-of-order responses. Parallel chapter downloads fire
   * `queue-changed` in bursts, so several refreshes overlap; without the guard an
   * older response can land last and clobber newer marks.
   */
  const refreshChapterMarks = useCallback(async () => {
    const m = mangaRef.current;
    const url = (mangaUrl || "").trim();
    const mid = (m?.module_id || sidebarModuleIdRef.current || "").trim();
    if (!m) {
      /* Only a closed manga clears the marks. A momentarily empty url/module id
      during a re-render must not wipe them. */
      markSeqRef.current++;
      setChDownloaded(new Set());
      setChQueued(new Set());
      return;
    }
    if (!url || !mid) return;
    const seq = ++markSeqRef.current;
    try {
      const [done, active] = await Promise.all([
        api.downloadedChaptersList(mid, url),
        api.queueActiveChapterLinks(mid, url),
      ]);
      if (seq !== markSeqRef.current) return; /* stale response */
      setChDownloaded(new Set(done));
      setChQueued(new Set(active));
    } catch {
      /* ignore mark refresh errors — keep previous marks */
    }
  }, [mangaUrl]);

  /* Canonical keys for the loaded chapters, resolved once per manga by the backend
  so the frontend never reimplements the key rules. */
  useEffect(() => {
    const chapters = manga?.chapters;
    if (!chapters?.length) {
      setChMarkKeys(new Map());
      return;
    }
    let cancelled = false;
    void api
      .chapterMarkKeys(chapters.map((c) => c.link))
      .then((keys) => {
        if (cancelled) return;
        const next = new Map<number, string>();
        chapters.forEach((c, i) => {
          const k = keys[i];
          if (k) next.set(c.index, k);
        });
        setChMarkKeys(next);
      })
      .catch((e) => {
        /* Never blank the keys on failure: with no keys every chapter renders as
        "not downloaded", which looks exactly like lost marks. Say so out loud —
        a silent catch here hid a stale-binary mismatch for a whole round. */
        if (cancelled) return;
        log(t("explore.chapterKeysFail", { err: String(e) }), "err");
      });
    return () => {
      cancelled = true;
    };
  }, [manga]);

  useEffect(() => {
    void refreshChapterMarks();
  }, [manga, mangaUrl, refreshChapterMarks]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api.onQueueChanged(() => {
      /* Coalesce bursts: parallel downloads emit this many times per second. */
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void refreshChapterMarks();
      }, MARK_REFRESH_DEBOUNCE_MS);
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      un?.();
    };
  }, [refreshChapterMarks]);

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
    const genresHay = (e.genres || "").toLowerCase();
    const genreList = genresHay
      .split(/[,;]/)
      .map((g) => g.trim())
      .filter(Boolean);
    /** One checkbox / custom token = one criterion; id+label are aliases (OR), not AND. */
    const includeGroups: string[][] = [];
    const excludeAliases: string[] = [];
    const genreTokenHit = (aliases: string[]) => {
      if (f.useRegex) {
        return aliases.some((a) => {
          if (!a) return false;
          try {
            return new RegExp(a, "i").test(genresHay);
          } catch {
            return genresHay.includes(a);
          }
        });
      }
      return aliases.some(
        (a) =>
          !!a &&
          genreList.some((g) => g === a || g.includes(a) || a.includes(g)),
      );
    };
    for (const g of DEFAULT_GENRES) {
      const state = f.genres[g.id] ?? "ignore";
      const aliases = [g.id.toLowerCase(), g.label.toLowerCase()];
      if (state === "include") includeGroups.push(aliases);
      if (state === "exclude") excludeAliases.push(...aliases);
    }
    const custom = f.customGenres.trim();
    if (custom) {
      if (f.useRegex) {
        // FMD2: whole custom field is one REGEXP against genres.
        if (custom.startsWith("!") || custom.startsWith("-")) {
          const a = custom.slice(1).trim();
          if (a) excludeAliases.push(a);
        } else {
          includeGroups.push([custom]);
        }
      } else {
        for (const part of custom.split(",")) {
          const raw = part.trim();
          if (!raw) continue;
          if (raw.startsWith("!") || raw.startsWith("-")) {
            const a = raw.slice(1).trim().toLowerCase();
            if (a) excludeAliases.push(a);
          } else {
            includeGroups.push([raw.toLowerCase()]);
          }
        }
      }
    }
    if (excludeAliases.length && genreTokenHit(excludeAliases)) return false;
    if (includeGroups.length) {
      const hit = includeGroups.map((aliases) => genreTokenHit(aliases));
      if (f.matchMode === "all" ? !hit.every(Boolean) : !hit.some(Boolean)) return false;
    }
    if (f.onlyNew && !isCatalogEntryNew(e.jdn, newDays)) return false;
    return true;
  }

  const visibleCatalog = useMemo((): (CatalogEntry | undefined)[] => {
    if (!advFilterApplied) return catalogRows;
    // All-sites: SQL already applied filters + title query; keep virtualized rows.
    if (appliedAdvFilter.allSites) return catalogRows;
    const needle = catalogText.trim().toLowerCase();
    return catalogRows.filter((e): e is CatalogEntry => {
      if (!e || !entryMatchesFilter(e, appliedAdvFilter, filterNewDays)) return false;
      if (!needle) return true;
      const hay = `${e.title} ${e.alttitles || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [catalogRows, appliedAdvFilter, advFilterApplied, filterNewDays, catalogText]);

  visibleCatalogRef.current = visibleCatalog;

  function setAdvFilterAppliedBoth(on: boolean) {
    advFilterAppliedRef.current = on;
    setAdvFilterApplied(on);
  }

  function enrichModuleNames(rows: CatalogEntry[]): CatalogEntry[] {
    const names = new Map(enabledModules.map((m) => [m.id, m.name]));
    return rows.map((e) => ({
      ...e,
      module_id: e.module_id || "",
      module_name: e.module_name || names.get(e.module_id || "") || "",
    }));
  }

  function allSitesFilterPayload(snapshot?: AdvFilterState) {
    const f = snapshot ?? appliedAdvFilterRef.current;
    return advFilterToPayload(f, filterNewDays);
  }

  function applyAdvFilter() {
    void (async () => {
      clearCatalogSelection();
      setCatalogLoading(true);
      try {
        const snapshot = cloneAdvFilter(advFilter);
        appliedAdvFilterRef.current = snapshot;
        setAppliedAdvFilter(snapshot);
        setAdvFilterAppliedBoth(true);

        if (snapshot.allSites) {
          catalogQueryRef.current = catalogText.trim();
          await loadAllSitesCatalog(true, true, snapshot);
          log(t("explore.filterAppliedAll", { n: catalogTotalRef.current }), "ok");
          return;
        }

        let all = await ensureAllPagesLoaded();
        const mid = selectedModuleId;
        const mname = currentModule?.name || "";
        if (mid) {
          all = all.map((e) => ({
            ...e,
            module_id: e.module_id || mid,
            module_name: e.module_name || mname,
          }));
          setCatalogRows(
            catalogRowsRef.current.map((e) =>
              e
                ? {
                    ...e,
                    module_id: e.module_id || mid,
                    module_name: e.module_name || mname,
                  }
                : e,
            ),
          );
        }
        const needle = catalogText.trim().toLowerCase();
        const n = all.filter((e) => {
          if (!entryMatchesFilter(e, snapshot, filterNewDays)) return false;
          if (!needle) return true;
          return `${e.title} ${e.alttitles || ""}`.toLowerCase().includes(needle);
        }).length;
        setCatalogStatsText(String(n));
        log(t("explore.filterApplied", { n }), "ok");
      } catch (e) {
        log(String(e), "err");
      } finally {
        setCatalogLoading(false);
      }
    })();
  }

  function removeAdvFilter() {
    clearAllFilters();
  }

  useEffect(() => {
    if (!sourcesBooted) return;
    if (enabledModules.length > 0) {
      if (selectedModuleId && enabledModules.some((m) => m.id === selectedModuleId)) {
        setSourcesLoading(false);
      }
      return;
    }
    setSourcesLoading(false);
  }, [sourcesBooted, enabledModules, selectedModuleId]);

  /** Keep combo on an enabled source; empty list → no selection. */
  useEffect(() => {
    if (!sourcesBooted) return;
    if (!enabledModules.length) {
      if (selectedModuleId) setSelectedModuleId(null);
      return;
    }
    if (selectedModuleId && enabledModules.some((m) => m.id === selectedModuleId)) return;
    let cancelled = false;
    void (async () => {
      const saved = ((await api.settingsGet(SK.UI_SELECTED_MODULE)) ?? "").trim();
      if (cancelled) return;
      if (saved && enabledModules.some((m) => m.id === saved)) {
        setSelectedModuleId(saved);
        return;
      }
      setSelectedModuleId(enabledModules[0].id);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesBooted, enabledModules, selectedModuleId]);

  async function refreshCatalogStats() {
    const id = selectedModuleId;
    if (!id || !enabledModuleIds.has(id)) {
      setCatalogStatsText("0");
      return;
    }
    try {
      const n = await api.catalogCount(id, catalogQueryRef.current);
      setCatalogStatsText(String(n));
    } catch {
      setCatalogStatsText("—");
    }
  }

  function nextPageToFetch(totalPages: number): number | null {
    while (wantedPagesRef.current.length) {
      const p = wantedPagesRef.current.shift()!;
      if (p >= 0 && p < totalPages && !loadedPagesRef.current.has(p) && !inflightRef.current.has(p)) {
        return p;
      }
    }
    for (let p = 0; p < totalPages; p++) {
      if (!loadedPagesRef.current.has(p) && !inflightRef.current.has(p)) return p;
    }
    return null;
  }

  function requestRange(start: number, end: number) {
    const total = catalogTotalRef.current;
    if (total <= 0 || end <= start) return;
    const startPage = Math.floor(start / CATALOG_PAGE);
    const endPage = Math.floor(Math.max(start, end - 1) / CATALOG_PAGE);
    const pages: number[] = [];
    for (let p = startPage; p <= endPage; p++) {
      if (!loadedPagesRef.current.has(p) && !inflightRef.current.has(p)) pages.push(p);
    }
    if (!pages.length) return;
    const pageSet = new Set(pages);
    wantedPagesRef.current = [
      ...pages,
      ...wantedPagesRef.current.filter((p) => !pageSet.has(p)),
    ];
    void startFill(catalogLoadGenRef.current);
  }

  async function fetchPage(page: number, gen: number) {
    const allSites =
      advFilterAppliedRef.current && appliedAdvFilterRef.current.allSites;
    const query = catalogQueryRef.current;
    inflightRef.current.add(page);
    try {
      let rows: CatalogEntry[];
      if (allSites) {
        const ids = enabledModules.map((m) => m.id);
        if (!ids.length) return;
        rows = enrichModuleNames(
          await api.catalogSearchAll(
            ids,
            query,
            allSitesFilterPayload(),
            CATALOG_PAGE,
            page * CATALOG_PAGE,
          ),
        );
      } else {
        const id = selectedModuleId;
        if (!id || !enabledModuleIds.has(id)) return;
        rows = await api.catalogSearch(id, query, CATALOG_PAGE, page * CATALOG_PAGE);
      }
      if (gen !== catalogLoadGenRef.current || catalogQueryRef.current !== query) return;
      const next = catalogRowsRef.current.slice();
      const base = page * CATALOG_PAGE;
      const prevLen = next.length;
      for (let i = 0; i < rows.length; i++) next[base + i] = rows[i];
      if (rows.length < CATALOG_PAGE) {
        const newLen = base + rows.length;
        if (newLen < next.length) next.length = newLen;
        setCatalogTotalBoth(newLen);
        setCatalogStatsText(String(newLen));
        const oldPages = Math.ceil(prevLen / CATALOG_PAGE);
        for (let p = page + 1; p < oldPages; p++) loadedPagesRef.current.add(p);
      }
      loadedPagesRef.current.add(page);
      setCatalogRows(next);
    } catch {
      /* skip page to avoid fill loop; leave holes */
      if (gen === catalogLoadGenRef.current) loadedPagesRef.current.add(page);
    } finally {
      inflightRef.current.delete(page);
    }
  }

  async function startFill(gen: number) {
    if (fillRunningRef.current) return;
    fillRunningRef.current = true;
    try {
      for (;;) {
        if (gen !== catalogLoadGenRef.current) return;
        const total = catalogTotalRef.current;
        const totalPages = Math.ceil(total / CATALOG_PAGE);
        if (total === 0 || loadedPagesRef.current.size >= totalPages) break;
        const page = nextPageToFetch(totalPages);
        if (page == null) break;
        await fetchPage(page, gen);
      }
    } finally {
      fillRunningRef.current = false;
      if (gen === catalogLoadGenRef.current) {
        const totalPages = Math.ceil(catalogTotalRef.current / CATALOG_PAGE);
        if (catalogTotalRef.current === 0 || loadedPagesRef.current.size >= totalPages) {
          const waiters = fillWaitersRef.current.splice(0);
          for (const w of waiters) w();
        } else if (wantedPagesRef.current.length > 0) {
          queueMicrotask(() => void startFill(gen));
        }
      }
    }
  }

  function ensureAllPagesLoaded(): Promise<CatalogEntry[]> {
    return new Promise((resolve) => {
      const finish = () => {
        resolve(catalogRowsRef.current.filter((e): e is CatalogEntry => !!e));
      };
      const totalPages = Math.ceil(catalogTotalRef.current / CATALOG_PAGE);
      if (catalogTotalRef.current === 0 || loadedPagesRef.current.size >= totalPages) {
        finish();
        return;
      }
      fillWaitersRef.current.push(finish);
      void startFill(catalogLoadGenRef.current);
    });
  }

  async function loadCatalog(force = false, silent = false) {
    if (advFilterAppliedRef.current && appliedAdvFilterRef.current.allSites) {
      await loadAllSitesCatalog(force, silent);
      return;
    }
    const id = selectedModuleId;
    if (!enabledModules.length) {
      catalogLoadGenRef.current += 1;
      resetFillQueues();
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogError(false);
      setCatalogLoading(false);
      setCatalogFetched(false);
      setCatalogStatsText("0");
      catalogLoadedKeyRef.current = "";
      if (!silent) {
        log(
          t("ctx.noSites"),
          "err",
        );
      }
      return;
    }
    if (!id || !enabledModuleIds.has(id)) {
      catalogLoadGenRef.current += 1;
      resetFillQueues();
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogError(false);
      setCatalogLoading(false);
      setCatalogFetched(false);
      if (!silent) {
        log(t("explore.pickSourceOrEnable"), "err");
      }
      return;
    }
    const key = `${id}||${catalogQueryRef.current}`;
    if (!force && key === catalogLoadedKeyRef.current && loadedPagesRef.current.size > 0) {
      return;
    }
    // Mismo conjunto de resultados (refresco tras ocultar/restaurar, no una
    // búsqueda nueva): conservar la posición del scroll.
    const sameResultSet = key === catalogLoadedKeyRef.current;

    const gen = ++catalogLoadGenRef.current;
    resetFillQueues();
    clearCatalogSelection();
    const preserveUntilData = silent && catalogRowsRef.current.length > 0;

    if (!preserveUntilData) {
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogError(false);
      setCatalogLoading(true);
      setCatalogFetched(false);
    }

    try {
      const query = catalogQueryRef.current;
      const [page0, total] = await Promise.all([
        api.catalogSearch(id, query, CATALOG_PAGE, 0),
        api.catalogCount(id, query),
      ]);
      if (gen !== catalogLoadGenRef.current) return;
      const actualTotal =
        total > 0 && page0.length < CATALOG_PAGE && page0.length < total ? page0.length : total;
      const rows: (CatalogEntry | undefined)[] = Array.from({ length: actualTotal });
      for (let i = 0; i < page0.length && i < actualTotal; i++) rows[i] = page0[i];
      loadedPagesRef.current = new Set(actualTotal > 0 ? [0] : []);
      setCatalogTotalBoth(actualTotal);
      setCatalogStatsText(String(actualTotal));
      setCatalogRows(rows);
      catalogLoadedKeyRef.current = key;
      setCatalogFetched(true);
      if (silent && !sameResultSet) bumpCatalogReset();
      if (!silent && actualTotal > 0) log(t("explore.catalogCount", { n: actualTotal }), "ok");
      // El refresco tira las páginas ya cargadas: pedir primero las de la zona
      // visible, o se ven filas vacías hasta que el relleno secuencial llega.
      // Con filtro avanzado local los índices visibles no son los de las filas.
      if (sameResultSet && !advFilterAppliedRef.current) {
        const r = catalogRangeRef.current;
        requestRange(r.start, Math.min(r.end, actualTotal));
      }
      void startFill(gen);
    } catch (e) {
      if (gen !== catalogLoadGenRef.current) return;
      catalogLoadedKeyRef.current = "";
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogError(true);
      setCatalogFetched(true);
      const msg = String(e);
      if (/deshabilitado|disabled|no activado/i.test(msg)) {
        log(
          t("ctx.noSites"),
          "err",
        );
      } else {
        log(msg, "err");
      }
    } finally {
      if (gen === catalogLoadGenRef.current) {
        setCatalogLoading(false);
      }
    }
  }

  /** Virtualized all-sites catalog (FMD2 FilterAllSites + ATTACH/UNION). */
  async function loadAllSitesCatalog(
    force = false,
    silent = false,
    snapshot?: AdvFilterState,
  ) {
    const ids = enabledModules.map((m) => m.id);
    if (!ids.length) {
      catalogLoadGenRef.current += 1;
      resetFillQueues();
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogStatsText("0");
      setCatalogFetched(false);
      catalogLoadedKeyRef.current = "";
      if (!silent) {
        log(
          t("ctx.noSites"),
          "err",
        );
      }
      return;
    }

    const filter = allSitesFilterPayload(snapshot);
    const query = catalogQueryRef.current;
    const key = `allsites||${query}||${JSON.stringify(filter)}`;
    if (!force && key === catalogLoadedKeyRef.current && loadedPagesRef.current.size > 0) {
      return;
    }
    const sameResultSet = key === catalogLoadedKeyRef.current;

    const gen = ++catalogLoadGenRef.current;
    resetFillQueues();
    clearCatalogSelection();
    const preserveUntilData = silent && catalogRowsRef.current.length > 0;

    if (!preserveUntilData) {
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogError(false);
      setCatalogLoading(true);
      setCatalogFetched(false);
    }

    try {
      const [page0Raw, total] = await Promise.all([
        api.catalogSearchAll(ids, query, filter, CATALOG_PAGE, 0),
        api.catalogCountAll(ids, query, filter),
      ]);
      if (gen !== catalogLoadGenRef.current) return;
      const page0 = enrichModuleNames(page0Raw);
      const actualTotal =
        total > 0 && page0.length < CATALOG_PAGE && page0.length < total ? page0.length : total;
      const rows: (CatalogEntry | undefined)[] = Array.from({ length: actualTotal });
      for (let i = 0; i < page0.length && i < actualTotal; i++) rows[i] = page0[i];
      loadedPagesRef.current = new Set(actualTotal > 0 ? [0] : []);
      setCatalogTotalBoth(actualTotal);
      setCatalogStatsText(String(actualTotal));
      setCatalogRows(rows);
      catalogLoadedKeyRef.current = key;
      setCatalogFetched(true);
      if (!sameResultSet) bumpCatalogReset();
      if (sameResultSet) {
        const r = catalogRangeRef.current;
        requestRange(r.start, Math.min(r.end, actualTotal));
      }
      void startFill(gen);
    } catch (e) {
      if (gen !== catalogLoadGenRef.current) return;
      catalogLoadedKeyRef.current = "";
      setCatalogRows([]);
      setCatalogTotalBoth(0);
      setCatalogError(true);
      setCatalogFetched(true);
      log(String(e), "err");
    } finally {
      if (gen === catalogLoadGenRef.current) {
        setCatalogLoading(false);
      }
    }
  }

  useEffect(() => {
    if (advFilterAppliedRef.current && appliedAdvFilterRef.current.allSites) return;
    if (!selectedModuleId || !enabledModuleIds.has(selectedModuleId)) return;
    const key = selectedModuleId;
    if (catalogAutoLoadKeyRef.current === key) return;
    catalogAutoLoadKeyRef.current = key;
    void refreshCatalogStats();
    void loadCatalog(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModuleId, enabledModuleIds]);

  useEffect(() => {
    if (enabledModules.length) return;
    catalogLoadGenRef.current += 1;
    resetFillQueues();
    setCatalogRows([]);
    setCatalogTotalBoth(0);
    setCatalogError(false);
    setCatalogLoading(false);
    setCatalogFetched(false);
    setCatalogStatsText("0");
    catalogLoadedKeyRef.current = "";
    catalogAutoLoadKeyRef.current = "";
  }, [enabledModules.length]);

  useEffect(() => {
    if (!catalogJobDoneSeq) return;
    if (advFilterAppliedRef.current && appliedAdvFilterRef.current.allSites) {
      void loadAllSitesCatalog(true, true);
      return;
    }
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
    void api.settingsSet(SK.UI_SELECTED_MODULE, m.id);
    setSourceOpen(false);
    setSourceFilter("");
  }

  /* ---------------------------------------------------------------------
   * Catalog search (debounced)
   * ------------------------------------------------------------------- */
  function scheduleCatalogSearch(value: string) {
    window.clearTimeout(catalogSearchTimerRef.current);
    if (advFilterAppliedRef.current) {
      // All-sites: re-query SQL with the bar text; single-module keeps client filter.
      if (!appliedAdvFilterRef.current.allSites) return;
      catalogSearchTimerRef.current = window.setTimeout(() => {
        const next = value.trim();
        catalogQueryRef.current = next;
        void loadAllSitesCatalog(true, true);
      }, 150);
      return;
    }
    catalogSearchTimerRef.current = window.setTimeout(() => {
      const next = value.trim();
      if (next === catalogQueryRef.current && catalogLoadedKeyRef.current.startsWith(`${selectedModuleId}||`)) {
        return;
      }
      catalogQueryRef.current = next;
      void loadCatalog(true, true);
    }, 150);
  }

  function handleCatalogInputChange(value: string) {
    setCatalogText(value);
    if (liveSearch) scheduleCatalogSearch(value);
  }

  function runCatalogSearch() {
    window.clearTimeout(catalogSearchTimerRef.current);
    if (advFilterAppliedRef.current) {
      if (!appliedAdvFilterRef.current.allSites) return;
      catalogQueryRef.current = catalogText.trim();
      void loadAllSitesCatalog(true, true);
      return;
    }
    catalogQueryRef.current = catalogText.trim();
    void loadCatalog(true, true);
  }

  function clearCatalogFilter() {
    window.clearTimeout(catalogSearchTimerRef.current);
    setCatalogText("");
    if (advFilterAppliedRef.current) {
      if (!appliedAdvFilterRef.current.allSites) return;
      catalogQueryRef.current = "";
      void loadAllSitesCatalog(true, true);
      return;
    }
    catalogQueryRef.current = "";
    void loadCatalog(true, true);
  }

  function clearAllFilters() {
    window.clearTimeout(catalogSearchTimerRef.current);
    setCatalogText("");
    catalogQueryRef.current = "";
    setAdvFilter(emptyAdvFilter());
    const empty = emptyAdvFilter();
    setAppliedAdvFilter(empty);
    appliedAdvFilterRef.current = empty;
    setAdvFilterAppliedBoth(false);
    clearCatalogSelection();
    void loadCatalog(true, true);
    log(t("explore.filterRemoved"), "ok");
  }

  /* ---------------------------------------------------------------------
   * Sidebar painting helpers
   * ------------------------------------------------------------------- */
  function paintRows(opts: PaintOpts) {
    setSidebarRows({
      title: opts.title.trim() || t("explore.untitled"),
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

  /** Prefer list/stub title over GetInfo "N/A" so the sidebar never shows N/A as name. */
  function sidebarTitleOnFail(fallback: string): string {
    const pending = pendingSidebarTitleRef.current.trim();
    if (pending && !isNaTitle(pending)) return pending;
    const fromSidebar = sidebarRows.title.trim();
    if (fromSidebar && !isNaTitle(fromSidebar) && fromSidebar !== t("explore.untitled")) {
      return fromSidebar;
    }
    const fromList = activeCatalogTitle.trim();
    if (fromList && !isNaTitle(fromList)) return fromList;
    return fallback.trim() || fallback;
  }

  function resetCoverForLoad() {
    coverEnsureSeqRef.current++;
    setCover("", { localFallback: "" });
  }

  async function applyCachedCover(moduleId: string, link: string) {
    const seq = mangaLoadSeqRef.current;
    const keys = [link.trim()].filter(Boolean);
    const root = currentModule?.root_url || "";
    if (root) {
      const full = maybeFillHost(root, link);
      if (full && !keys.includes(full)) keys.push(full);
    }
    for (const key of keys) {
      try {
        const dataUrl = await api.coverLocalPath(moduleId, key);
        if (seq !== mangaLoadSeqRef.current) return;
        if (!dataUrl) continue;
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
    if (!loadCoversRef.current) return;
    const ensureId = ++coverEnsureSeqRef.current;
    if (!coverUrl.trim()) return;
    try {
      const dataUrl = await api.coverEnsure(moduleId, link, coverUrl, referer || null);
      if (seq !== mangaLoadSeqRef.current || ensureId !== coverEnsureSeqRef.current) return;
      setCover(dataUrl, { localFallback: dataUrl, force: true });
    } catch {
      /* keep remote / default */
    }
  }

  function applyCatalogStub(e: CatalogEntry) {
    const title = e.title || e.link;
    pendingSidebarTitleRef.current = title;
    setInfoPanelOpen(true);
    const mod =
      (e.module_id ? modules.find((m) => m.id === e.module_id) : undefined) || currentModule;
    paintRows({
      title,
      authors: e.authors,
      artists: e.artists,
      genres: e.genres,
      status: e.status,
      summary: e.summary,
      numchapter: e.numchapter,
      moduleName: e.module_name || mod?.name,
      altTitles: e.alttitles || "",
    });
    const root = mod?.root_url || "";
    const hint = resolveCover(e.cover || "", root);
    if (!coverLocalFallbackRef.current && hint) setCover(hint);
  }

  function syncMangaCacheFromInfo(mangaLink: string, info: MangaInfoResult) {
    const failed = isNaTitle(info.title);
    const count = failed ? 0 : info.chapters.length;
    const cover = failed ? "" : resolveCover(info.cover, info.root_url);
    const key = catalogLinkKey(mangaLink);
    const root = currentModule?.root_url || info.root_url || "";
    let touched = false;
    const next = catalogRowsRef.current.map((e) => {
      if (!e) return e;
      const full = maybeFillHost(root, e.link);
      if (catalogLinkKey(e.link) === key || catalogLinkKey(full) === key) {
        touched = true;
        if (failed) {
          return { ...e, info_failed: true };
        }
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
          info_failed: false,
        };
      }
      return e;
    });
    if (touched) setCatalogRows(next);
    const moduleId = info.module_id || selectedModuleId;
    if (moduleId) {
      void api
        .mangaCacheUpsert({
          moduleId,
          link: mangaLink,
          title: failed ? "N/A" : info.title,
          altTitles: failed ? "" : info.alt_titles,
          authors: failed ? "" : info.authors,
          artists: failed ? "" : info.artists,
          genres: failed ? "" : info.genres,
          status: failed ? "" : info.status,
          summary: failed ? "" : info.summary,
          numchapter: count,
          cover,
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }

  function markCatalogInfoFailed(mangaLink: string, moduleId: string | undefined) {
    const key = catalogLinkKey(mangaLink);
    const root = currentModule?.root_url || "";
    let touched = false;
    const next = catalogRowsRef.current.map((e) => {
      if (!e) return e;
      const full = maybeFillHost(root, e.link);
      if (catalogLinkKey(e.link) === key || catalogLinkKey(full) === key) {
        touched = true;
        return { ...e, info_failed: true };
      }
      return e;
    });
    if (touched) setCatalogRows(next);
    if (moduleId) {
      void api
        .mangaCacheUpsert({
          moduleId,
          link: mangaLink,
          title: "N/A",
          altTitles: "",
          authors: "",
          artists: "",
          genres: "",
          status: "",
          summary: "",
          numchapter: 0,
          cover: "",
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }

  async function syncFavoriteState(url: string, moduleId?: string | null) {
    const seq = ++favSyncSeqRef.current;
    const mid = moduleId || sidebarModuleIdRef.current || "";
    const rowKey = sidebarCatalogRowKeyRef.current;
    const rowLink = rowKey.includes(":") ? rowKey.slice(rowKey.indexOf(":") + 1) : "";

    if (!url && !rowKey) {
      applySidebarFavoriteState(false, null);
      return;
    }

    // Apply warm cache immediately — avoids heart off→on flicker while DB opens.
    const cached = matchFavoriteCached(url, mid, rowLink);
    if (cached !== null) {
      applySidebarFavoriteState(!!cached, cached?.id ?? null);
    }

    try {
      const favs = await loadFavoritesCached();
      if (seq !== favSyncSeqRef.current) return;
      const hit = matchFavorite(favs, url, mid, rowLink);
      applySidebarFavoriteState(!!hit, hit?.id ?? null);
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------------
   * Load manga info
   * ------------------------------------------------------------------- */
  function applyPastedMangaUrl(text: string, opts?: { notifyIfEmpty?: boolean }): boolean {
    const url = normalizeMangaUrl(text);
    if (!url) {
      if (opts?.notifyIfEmpty) {
        appToast({
          message: t("explore.clipboardEmpty"),
          kind: "err",
        });
      }
      return false;
    }
    setUrlInput(url);
    void loadMangaInfo(url);
    return true;
  }

  async function pasteUrlFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      applyPastedMangaUrl(text, { notifyIfEmpty: true });
    } catch {
      urlInputRef.current?.focus();
      appToast({ message: t("explore.pasteHint"), kind: "" });
    }
  }

  function handleUrlPaste(ev: ReactClipboardEvent<HTMLInputElement>) {
    const text = ev.clipboardData?.getData("text") ?? "";
    if (!text.trim()) return;
    if (applyPastedMangaUrl(text)) ev.preventDefault();
  }

  async function loadMangaInfo(explicitUrl?: string, preferredModuleId?: string | null) {
    const seq = ++mangaLoadSeqRef.current;
    const raw = (explicitUrl ?? urlInput).trim();
    // URL bar / Enter: don't reuse a previous catalog stub title.
    if (explicitUrl === undefined) {
      pendingSidebarTitleRef.current = "";
      sidebarCatalogRowKeyRef.current = "";
    }
    setInfoPanelOpen(true);
    setInfoInaccessible(null);
    clearLog();

    try {
      const v = await api.settingsGet("ui.load_covers");
      setLoadCoversFlag(!(v === "0" || v === "false"));
    } catch {
      /* keep current */
    }

    const url = normalizeMangaUrl(raw);
    if (!url) {
      log(
        t("explore.invalidUrl"),
        "err",
      );
      return;
    }
    if (url !== raw) setUrlInput(url);

    setMangaUrl(url);
    setMangaLoadingUrl(url);
    resetCoverForLoad();
    log(t("explore.loadingGetInfo"));
    setLoadBtnDisabled(true);
    setChaptersLoading(true);

    // Host of the pasted URL wins over the catalog listing (KuManga + manga-oni.com
    // must run MangaOni.lua). Catalog clicks pass preferredModuleId on the same host.
    let moduleId = preferredModuleId || selectedModuleId || undefined;
    const abortWrongModule = (msg: string) => {
      log(msg, "err");
      setManga(null);
      setChaptersLoading(false);
      setMangaLoadingUrl("");
      setLoadBtnDisabled(false);
    };
    try {
      const matches = await api.modulesMatchUrl(url);
      if (seq !== mangaLoadSeqRef.current) return;
      const enabled = matches.filter((m) => enabledModuleIds.has(m.id));
      const pool = enabled.length > 0 ? enabled : matches;
      if (pool.length > 0) {
        const preferred =
          pool.find((m) => m.id === preferredModuleId) ??
          pool.find((m) => m.id === selectedModuleId) ??
          pool[0];
        if (moduleId && preferred.id !== moduleId) {
          log(t("explore.siteDetected", { name: preferred.name }), "");
        }
        moduleId = preferred.id;
        // Pegar URL: alinear el selector de fuente (y el catálogo) con el host.
        if (preferred.id !== selectedModuleId) {
          setSelectedModuleId(preferred.id);
          void api.settingsSet(SK.UI_SELECTED_MODULE, preferred.id);
        }
        // Activar al pegar/abrir por URL: no hace falta ir a Ajustes solo para GetInfo/descarga.
        if (!enabledModuleIds.has(preferred.id)) {
          const newly = await ensureModuleEnabled(preferred.id);
          if (seq !== mangaLoadSeqRef.current) return;
          if (newly) {
            log(t("explore.siteAutoEnabled", { name: preferred.name }), "ok");
          }
        }
      } else if (!enabledModules.length) {
        abortWrongModule(
          t("explore.noSitesMatchUrl"),
        );
        return;
      } else {
        const listed =
          (moduleId ? modules.find((m) => m.id === moduleId) : undefined) ||
          currentModule;
        const keepListed =
          !!moduleId &&
          !!listed?.root_url &&
          urlMatchesModuleHost(url, listed.root_url);
        if (!keepListed) {
          abortWrongModule(
            t("explore.noModuleMatchUrl"),
          );
          return;
        }
      }
    } catch {
      const listed =
        (moduleId ? modules.find((m) => m.id === moduleId) : undefined) ||
        currentModule;
      if (
        moduleId &&
        listed?.root_url &&
        !urlMatchesModuleHost(url, listed.root_url)
      ) {
        // Backend rematch by host; don't pin the listing's Lua.
        moduleId = undefined;
      }
    }

    if (moduleId) {
      sidebarModuleIdRef.current = moduleId;
      void applyCachedCover(moduleId, url);
      void (async () => {
        try {
          const cached = await api.mangaCacheGet(moduleId, url);
          if (seq !== mangaLoadSeqRef.current || !cached) return;
          if (isNaTitle(cached.title)) return;
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

      if (isNaTitle(result.title)) {
        setManga(null);
        // Mantener URL para poder favoritar / ver en línea desde el stub.
        setMangaUrl(url);
        chSel.clear();
        bumpChaptersReset();
        setChaptersLoading(false);
        const modName = result.module_name || currentModule?.name || "";
        setInfoInaccessible({ moduleName: modName });
        paintRows({
          title: sidebarTitleOnFail(url),
          authors: "",
          artists: "",
          genres: "",
          status: "",
          summary: "",
          numchapter: 0,
          moduleName: modName,
          altTitles: "",
        });
        syncMangaCacheFromInfo(url, result);
        await syncFavoriteState(url, moduleId);
        const msg = inaccessibleInfoMessage(modName);
        log(
          t("explore.updateManual", { msg }),
          "err",
        );
        return;
      }

      setManga(result);
      chSel.clear();
      bumpChaptersReset();
      setChaptersLoading(false);
      setInfoInaccessible(null);
      if (result.module_id) sidebarModuleIdRef.current = result.module_id;
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
      if (loadCoversRef.current && mid && toEnsure && !alreadyLocal) {
        void ensureCoverAsync(seq, mid, url, toEnsure, result.root_url || url);
      }

      await syncFavoriteState(url, result.module_id || moduleId);
      if (seq !== mangaLoadSeqRef.current) return;
      if (!result.title.trim() && result.chapters.length === 0) {
        log(
          t("explore.noData", { mod: result.module_name }),
          "err",
        );
      } else if (result.chapters.length === 0) {
        log(t("explore.okNoChapters", { mod: result.module_name }), "ok");
      } else {
        log(t("explore.okChapters", { n: result.chapters.length, mod: result.module_name }), "ok");
      }
    } catch (e) {
      if (seq !== mangaLoadSeqRef.current) return;
      setManga(null);
      setMangaUrl(url);
      setChaptersLoading(false);
      const modName =
        (moduleId ? modules.find((m) => m.id === moduleId)?.name : undefined) ||
        currentModule?.name ||
        "";
      setInfoInaccessible({ moduleName: modName });
      markCatalogInfoFailed(url, moduleId);
      paintRows({
        title: sidebarTitleOnFail(url),
        authors: "",
        artists: "",
        genres: "",
        status: "",
        summary: "",
        numchapter: 0,
        moduleName: modName,
        altTitles: "",
      });
      await syncFavoriteState(url, moduleId);
      const msg = inaccessibleInfoMessage(modName);
      log(
        t("explore.updateManual", { msg: `${msg} ${String(e)}` }),
        "err",
      );
    } finally {
      if (seq === mangaLoadSeqRef.current) {
        setMangaLoadingUrl("");
        setLoadBtnDisabled(false);
      }
    }
  }

  useEffect(() => {
    if (activeNav !== "info" || !pendingMangaOpen) return;
    const { mangaUrl, moduleId } = pendingMangaOpen;
    setPendingMangaOpen(null);
    setUrlInput(mangaUrl);
    if (moduleId) {
      setSelectedModuleId(moduleId);
      void api.settingsSet(SK.UI_SELECTED_MODULE, moduleId);
    }
    void loadMangaInfo(mangaUrl, moduleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, pendingMangaOpen]);

  async function openCatalogEntry(e: CatalogEntry) {
    const moduleId = e.module_id || selectedModuleId || undefined;
    const mod =
      (moduleId ? modules.find((m) => m.id === moduleId) : undefined) || currentModule;
    const root = mod?.root_url || "";
    const url = maybeFillHost(root, e.link);
    const title = e.title || e.link;
    setActiveCatalogTitle(title);
    pendingSidebarTitleRef.current = title;
    setUrlInput(url);
    setMangaUrl(url);
    if (moduleId) sidebarModuleIdRef.current = moduleId;
    sidebarCatalogRowKeyRef.current = catalogRowKey(e);
    // Marca el corazón en cuanto se abre (antes de GetInfo).
    void syncFavoriteState(url, moduleId);
    if (mangaLoadingUrl === url) {
      log(t("explore.alreadyLoading", { title }));
      setInfoPanelOpen(true);
      applyCatalogStub(e);
      return;
    }
    resetCoverForLoad();
    setInfoPanelOpen(true);
    applyCatalogStub(e);
    if (moduleId) void applyCachedCover(moduleId, e.link);

    // Cache already marked inaccessible: do not hit the invalid URL again.
    if (e.info_failed) {
      setManga(null);
      setMangaUrl(url);
      chSel.clear();
      bumpChaptersReset();
      setChaptersLoading(false);
      const modName = e.module_name || mod?.name || "";
      setInfoInaccessible({ moduleName: modName });
      // Stub already painted real masterlist title; keep it (never show N/A in sidebar).
      const msg = inaccessibleInfoMessage(modName);
      log(
        t("explore.updateManual", { msg }),
        "err",
      );
      return;
    }

    log(t("explore.opening", { title }));
    await loadMangaInfo(url, moduleId);
  }

  function handleCatalogRowClick(
    idx: number,
    entry: CatalogEntry,
    ev: ReactMouseEvent,
  ) {
    setCatalogCtxMenu(null);
    setInfoMode("search");
    /* El foco vive en la lista, no en la fila: evita el anillo del WebView
       (sobre todo con Ctrl) y deja el teclado operativo. */
    (ev.currentTarget as HTMLElement).blur();
    focusCatalogList();

    const title = entry.title || entry.link;
    const mode = resolveRowClick(ev);

    if (mode === "range") {
      setActiveCatalogTitle(title);
      selectCatalogRange(idx);
      return;
    }

    if (mode === "toggle") {
      toggleCatalogEntry(entry, idx);
      return;
    }

    setActiveCatalogTitle(title);
    replaceCatalogSelection(entry, idx);

    const now = performance.now();
    const last = lastCatalogClickRef.current;
    if (last.idx === idx && now - last.at < 450) {
      lastCatalogClickRef.current = { idx: -1, at: 0 };
      void openCatalogEntry(entry);
      return;
    }
    lastCatalogClickRef.current = { idx, at: now };
  }

  function handleCatalogRowContextMenu(
    ev: ReactMouseEvent,
    idx: number,
    entry: CatalogEntry,
  ) {
    ev.preventDefault();
    ev.stopPropagation();
    (ev.currentTarget as HTMLElement).blur();
    focusCatalogList();
    setInfoMode("search");
    setActiveCatalogTitle(entry.title || entry.link);
    lastCatalogClickRef.current = { idx: -1, at: 0 };

    const key = catalogRowKey(entry);
    let isBulk = catalogSelectedKeys.size > 1 && catalogSelectedKeys.has(key);
    if (!catalogSelectedKeys.has(key)) {
      replaceCatalogSelection(entry, idx);
      isBulk = false;
    }

    const pad = 8;
    const menuW = 232;
    /* Single: Ver info + dl + fav + quitar; bulk: título + dl + fav + quitar. */
    const menuH = isBulk ? 156 : 200;
    const x = Math.min(ev.clientX, window.innerWidth - menuW - pad);
    const y = Math.min(ev.clientY, window.innerHeight - menuH - pad);
    const bulkCount = isBulk ? catalogSelectedKeys.size : 1;
    const { mod, moduleId: entryModuleId } = catalogEntryModule(entry);
    const url = maybeFillHost(mod?.root_url || "", entry.link);
    const warmHit =
      !isBulk && url
        ? matchFavoriteCached(url, entryModuleId, entry.link)
        : null;
    const warmFav = warmHit === null ? undefined : warmHit;
    setCatalogCtxMenu({
      x: Math.max(pad, x),
      y: Math.max(pad, y),
      entry,
      isFav: !!warmFav,
      favoriteId: warmFav?.id ?? null,
      isBulk,
      bulkCount,
    });

    if (isBulk) return;

    if (!url) return;
    void loadFavoritesCached()
      .then((favs) => {
        const hit = matchFavorite(favs, url, entryModuleId, entry.link);
        setCatalogCtxMenu((prev) =>
          prev &&
          !prev.isBulk &&
          prev.entry.link === entry.link &&
          prev.entry.module_id === entry.module_id
            ? { ...prev, isFav: !!hit, favoriteId: hit?.id ?? null }
            : prev,
        );
      })
      .catch(() => {
        /* ignore */
      });
  }

  function catalogEntryModule(entry: CatalogEntry) {
    const moduleId = entry.module_id || selectedModuleId || "";
    const mod =
      (moduleId ? modules.find((m) => m.id === moduleId) : undefined) || currentModule;
    return { moduleId, mod };
  }

  function closeCatalogCtxMenu() {
    setCatalogCtxMenu(null);
  }

  async function addFavoriteFromCatalog(entry: CatalogEntry) {
    const menu = catalogCtxMenu;
    setCatalogCtxMenu(null);
    if (menu?.isFav) {
      log(t("explore.alreadyFav"), "ok");
      return;
    }
    const { moduleId, mod } = catalogEntryModule(entry);
    if (!mod || !moduleId) {
      log(t("explore.noSource"), "err");
      return;
    }
    const root = mod.root_url || "";
    const url = maybeFillHost(root, entry.link);
    if (!url) {
      log(t("explore.emptyLinkFav"), "err");
      return;
    }
    const title = entry.title || entry.link;
    const matchesSidebar = catalogEntryMatchesSidebar(entry, url);
    const saveUrl =
      matchesSidebar && (mangaUrl || urlInput).trim()
        ? (mangaUrl || urlInput).trim()
        : url;
    try {
      const favs = await loadFavoritesCached();
      const existing = favs.find(
        (f) =>
          urlsReferToSameManga(f.manga_url, saveUrl) ||
          urlsReferToSameManga(f.manga_url, url) ||
          urlsReferToSameManga(f.manga_url, entry.link),
      );
      if (existing) {
        log(t("explore.alreadyFav"), "ok");
        if (matchesSidebar) applySidebarFavoriteState(true, existing.id);
        return;
      }
    } catch {
      /* continue to add */
    }
    try {
      const fav = await api.favoritesAdd({
        module_id: moduleId,
        module_name: entry.module_name || mod.name || "",
        root_url: root,
        manga_url: saveUrl,
        title,
        chapters: matchesSidebar ? mangaRef.current?.chapters ?? [] : [],
      });
      favoritesCacheUpsert(fav);
      if (matchesSidebar) applySidebarFavoriteState(true, fav.id);
      log(
        t("explore.favSavedNoInfo", { title: fav.title }),
        "ok",
      );
      const gotoFav = await api.settingsGet("ui.goto_favorites_on_add");
      if (gotoFav === "1" || gotoFav === "true") setActiveNav("favorites");
    } catch (e) {
      log(String(e), "err");
    }
  }

  async function addFavoritesFromCatalogBulk() {
    setCatalogCtxMenu(null);
    const entries = [...catalogSelectedEntriesRef.current.values()];
    if (entries.length < 2) {
      if (entries[0]) void addFavoriteFromCatalog(entries[0]);
      return;
    }
    let favs: Awaited<ReturnType<typeof loadFavoritesCached>> = [];
    try {
      favs = await loadFavoritesCached();
    } catch (e) {
      log(String(e), "err");
      return;
    }
    const existing = new Set(
      favs.flatMap((f) => [f.manga_url, catalogLinkKey(f.manga_url)]),
    );
    let added = 0;
    let skipped = 0;
    let errors = 0;
    let sidebarFavId: number | null = null;
    for (const entry of entries) {
      const { moduleId, mod } = catalogEntryModule(entry);
      if (!mod || !moduleId) {
        errors += 1;
        continue;
      }
      const root = mod.root_url || "";
      const url = maybeFillHost(root, entry.link);
      if (!url) {
        errors += 1;
        continue;
      }
      const key = catalogLinkKey(url);
      const matchesSidebar = catalogEntryMatchesSidebar(entry, url);
      const saveUrl =
        matchesSidebar && (mangaUrl || urlInput).trim()
          ? (mangaUrl || urlInput).trim()
          : url;
      if (
        existing.has(saveUrl) ||
        existing.has(url) ||
        existing.has(key) ||
        existing.has(catalogLinkKey(saveUrl))
      ) {
        skipped += 1;
        if (matchesSidebar) {
          const hit = favs.find(
            (f) =>
              f.manga_url === saveUrl ||
              f.manga_url === url ||
              catalogLinkKey(f.manga_url) === key,
          );
          if (hit) sidebarFavId = hit.id;
        }
        continue;
      }
      try {
        const fav = await api.favoritesAdd({
          module_id: moduleId,
          module_name: entry.module_name || mod.name || "",
          root_url: root,
          manga_url: saveUrl,
          title: entry.title || entry.link,
          chapters: matchesSidebar ? mangaRef.current?.chapters ?? [] : [],
        });
        favoritesCacheUpsert(fav);
        existing.add(saveUrl);
        existing.add(url);
        existing.add(key);
        existing.add(catalogLinkKey(saveUrl));
        added += 1;
        if (matchesSidebar) sidebarFavId = fav.id;
      } catch {
        errors += 1;
      }
    }
    if (sidebarFavId != null) applySidebarFavoriteState(true, sidebarFavId);
    else if ((mangaUrl || urlInput).trim()) {
      void syncFavoriteState((mangaUrl || urlInput).trim());
    }
    log(
      `Favoritos en lote: añadidos ${added} · ya estaban ${skipped}${
        errors ? ` · errores ${errors}` : ""
      }`,
      errors && !added ? "err" : "ok",
    );
  }

  async function removeFavoriteFromCatalog(entry: CatalogEntry, favId: number | null) {
    setCatalogCtxMenu(null);
    const title = entry.title || entry.link;
    if (favId == null) {
      log(t("explore.favNotFound"), "err");
      return;
    }
    const { moduleId, mod } = catalogEntryModule(entry);
    if (!mod || !moduleId) {
      log(t("explore.noSource"), "err");
      return;
    }
    const root = mod.root_url || "";
    const url = maybeFillHost(root, entry.link);
    const matchesSidebar = catalogEntryMatchesSidebar(entry, url);
    const snapshot: FavoriteAddRequest = {
      module_id: moduleId,
      module_name: entry.module_name || mod.name || "",
      root_url: root,
      manga_url:
        matchesSidebar && (mangaUrl || urlInput).trim()
          ? (mangaUrl || urlInput).trim()
          : url,
      title,
      chapters: matchesSidebar ? mangaRef.current?.chapters ?? [] : [],
    };
    try {
      await api.favoritesRemove(favId);
      favoritesCacheRemove(favId);
      if (matchesSidebar) applySidebarFavoriteState(false, null);
      log(t("explore.removedFavLog", { title }), "ok");
      showFavoriteRemovedToast(snapshot, matchesSidebar);
    } catch (e) {
      log(String(e), "err");
    }
  }

  async function removeFromCatalog(entries: CatalogEntry[]) {
    setCatalogCtxMenu(null);
    const prepared = entries
      .map((e): CatalogEntry | null => {
        const { moduleId, mod } = catalogEntryModule(e);
        if (!moduleId) return null;
        return {
          ...e,
          module_id: moduleId,
          module_name: e.module_name || mod?.name || "",
        };
      })
      .filter((e): e is CatalogEntry => e != null);
    if (!prepared.length) {
      log(t("explore.selectCatalogTitle"), "err");
      return;
    }
    const n = prepared.length;
    const ok = await confirmIfEnabled(
      SK.CONFIRM_DELETE,
      n === 1
        ? t("explore.removeFromListOne", { title: prepared[0].title || prepared[0].link })
        : t("explore.removeFromListMany", { n }),
      true,
      t("explore.removeFromList"),
    );
    if (!ok) return;
    try {
      const snapshots = await api.catalogHide(prepared);
      if (!snapshots.length) {
        log(t("explore.removeFailed"), "err");
        return;
      }
      clearCatalogSelection();
      await loadCatalog(true, true);
      const label =
        snapshots.length === 1
          ? tPlural("explore.removedFromList", 1)
          : tPlural("explore.removedFromList", snapshots.length);
      appToastUndo({
        message: label,
        durationMs: 6000,
        onUndo: async () => {
          try {
            await api.catalogUnhide(snapshots);
            await loadCatalog(true, true);
            log(
              snapshots.length === 1
                ? `Restaurado: ${snapshots[0].title || snapshots[0].link}`
                : t("explore.restoredTitles", { n: snapshots.length }),
              "ok",
            );
          } catch (e) {
            log(String(e), "err");
          }
        },
      });
      log(label, "ok");
    } catch (e) {
      log(String(e), "err");
    }
  }
  removeFromCatalogRef.current = (entries) => {
    void removeFromCatalog(entries);
  };

  useEffect(() => {
    if (!catalogCtxMenu) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setCatalogCtxMenu(null);
    };
    const onScroll = () => setCatalogCtxMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [catalogCtxMenu]);

  /* ---------------------------------------------------------------------
   * Chapters
   * ------------------------------------------------------------------- */
  const chaptersView = useMemo(
    () => (manga ? [...manga.chapters].reverse() : []),
    [manga],
  );
  const chapterKeys = useMemo(
    () => chaptersView.map((c) => c.index),
    [chaptersView],
  );

  const chaptersApiRef = useRef<VirtualListHandle | null>(null);
  const chSel = useListSelection<number>({
    keys: chapterKeys,
    prune: true,
    pageSize: CH_PAGE_STEP,
    onCursorChange: (_key, index) => chaptersApiRef.current?.scrollToIndex(index),
  });
  const selected = chSel.selected;

  function handleSelectAll() {
    if (!manga) return;
    chSel.toggleAll();
  }

  /* ---------------------------------------------------------------------
   * Output dir / enqueue / favorite / online
   * ------------------------------------------------------------------- */
  async function ensureOutputDir(): Promise<string | null> {
    if (outputDir) return outputDir;
    const saved = ((await api.settingsGet("default_output_dir")) ?? "").trim();
    if (saved) {
      setOutputDir(saved);
      return saved;
    }
    const def = await api.defaultSaveDir();
    setOutputDir(def);
    return def;
  }

  async function handlePickOutputDir() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setOutputDir(dir);
      await api.settingsSet("default_output_dir", dir);
      log(t("explore.defaultFolder", { dir }), "ok");
    }
  }

  /** FMD2 MD_DownloadAll: silent GetInfo → enqueue every chapter. */
  async function downloadAllFromCatalog(entry: CatalogEntry): Promise<number> {
    const { moduleId, mod } = catalogEntryModule(entry);
    if (!mod || !moduleId) {
      log(t("explore.noSource"), "err");
      return 0;
    }
    const root = mod.root_url || "";
    const url = maybeFillHost(root, entry.link);
    if (!url) {
      log(t("explore.emptyLinkDl"), "err");
      return 0;
    }
    const title = entry.title || entry.link;
    const dir = await ensureOutputDir();
    if (!dir) {
      log(t("explore.pickOutput"), "err");
      return 0;
    }
    log(t("explore.gettingInfo", { title }));
    try {
      const info = await api.getMangaInfo(url, moduleId);
      if (!info.chapters?.length) {
        log(t("explore.noChaptersFor", { title: info.title || title, url }), "err");
        return 0;
      }
      const n = await api.queueAdd({
        manga_title: info.title || title,
        root_url: info.root_url || root,
        manga_url: url,
        module_id: info.module_id || moduleId,
        output_dir: dir,
        chapters: info.chapters,
        start: !taskStopped,
        batch_id: `dl-${Date.now().toString(36)}`,
      });
      const msg = taskStopped
        ? `Encolados ${n} de «${info.title || title}» (detenidos).`
        : `Encolados ${n} de «${info.title || title}».`;
      log(msg, "ok");
      if (n > 0) {
        const gotoDlRaw = await api.settingsGet("ui.goto_downloads_on_add");
        const gotoDl = gotoDlRaw !== "0" && gotoDlRaw !== "false";
        appToast({
          message: msg,
          kind: "ok",
          // Ya vamos a Descargas: no hace falta el enlace "Ver descargas".
          ...(gotoDl
            ? {}
            : {
                action: {
                  label: t("explore.viewDownloads"),
                  onClick: () => setActiveNav("downloads"),
                },
              }),
        });
        if (gotoDl) setActiveNav("downloads");
      }
      return n;
    } catch (e) {
      log(`${title}: ${String(e)}`, "err");
      return 0;
    }
  }

  async function downloadAllFromCatalogBulk(entries?: CatalogEntry[]) {
    setCatalogCtxMenu(null);
    const list = entries?.length
      ? entries
      : [...catalogSelectedEntriesRef.current.values()];
    if (!list.length) {
      log(t("explore.noTitlesSelected"), "err");
      return;
    }
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (list.length > 1) {
        log(t("explore.downloadAllItem", { i: i + 1, total: list.length, title: e.title || e.link }));
      }
      total += await downloadAllFromCatalog(e);
    }
    if (list.length > 1) {
      log(t("explore.downloadAllLog", { ch: total, titles: list.length }), "ok");
    }
  }

  downloadAllFromCatalogBulkRef.current = (entries) => {
    void downloadAllFromCatalogBulk(entries);
  };

  useEffect(() => {
    if (activeNav !== "info") return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") {
        ev.preventDefault();
        const selected = [...catalogSelectedEntriesRef.current.values()];
        if (selected.length > 0) {
          downloadAllFromCatalogBulkRef.current(selected);
          return;
        }
        log(t("explore.selectCatalogCtrlD"), "err");
        return;
      }
      if (ev.key === "Delete") {
        const selected = [...catalogSelectedEntriesRef.current.values()];
        if (!selected.length) return;
        ev.preventDefault();
        removeFromCatalogRef.current(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeNav]);

  async function handleEnqueue() {
    if (enqueueBusy) return;
    if (!manga) {
      log(t("explore.loadMangaFirst"), "err");
      appToast({ message: t("explore.loadMangaFirst"), kind: "err" });
      return;
    }
    const chapters = manga.chapters.filter((c) => selected.has(c.index));
    if (!chapters.length) {
      log(t("explore.selectChapterMin"), "err");
      appToast({ message: t("explore.selectChapterMin"), kind: "err" });
      return;
    }
    const dir = await ensureOutputDir();
    if (!dir) {
      log(t("explore.pickOutput"), "err");
      appToast({ message: t("explore.pickOutput"), kind: "err" });
      return;
    }
    setEnqueueBusy(true);
    try {
      const n = await api.queueAdd({
        manga_title: manga.title || "manga",
        root_url: manga.root_url,
        manga_url: mangaUrl,
        module_id: manga.module_id,
        output_dir: dir,
        chapters,
        start: !taskStopped,
        batch_id: `dl-${Date.now().toString(36)}`,
      });
      const msg = taskStopped
        ? `Encolados ${n} (detenidos).`
        : t("explore.queuedChapters", { n });
      log(msg, "ok");
      const gotoDlRaw = await api.settingsGet("ui.goto_downloads_on_add");
      const gotoDl = gotoDlRaw !== "0" && gotoDlRaw !== "false";
      appToast({
        message: msg,
        kind: "ok",
        ...(gotoDl
          ? {}
          : {
              action: {
                label: t("explore.viewDownloads"),
                onClick: () => setActiveNav("downloads"),
              },
            }),
      });
      if (gotoDl) setActiveNav("downloads");
    } catch (e) {
      const msg = String(e);
      log(msg, "err");
      appToast({ message: msg, kind: "err" });
    } finally {
      setEnqueueBusy(false);
    }
  }

  async function handleSplitDownload() {
    if (!manga) return;
    const chapters = manga.chapters.filter((c) => selected.has(c.index));
    if (chapters.length < 2) {
      log(t("explore.selectSplitMin"), "err");
      appToast({
        message: t("explore.selectSplitMin"),
        kind: "err",
      });
      return;
    }
    setSplitPrompt({
      chapters: chapters.map((c) => ({
        index: c.index,
        name: c.name,
        link: c.link,
      })),
      count: 2,
    });
  }

  async function confirmSplitDownload() {
    if (!manga || !splitPrompt || splitBusy) return;
    const chapters = splitPrompt.chapters;
    let n = Math.floor(splitPrompt.count);
    if (!Number.isFinite(n) || n < 2) {
      log(t("explore.minSplit"), "err");
      appToast({ message: t("explore.minSplit"), kind: "err" });
      return;
    }
    n = Math.min(n, chapters.length);
    const dir = await ensureOutputDir();
    if (!dir) {
      log(t("explore.pickOutput"), "err");
      appToast({ message: t("explore.pickOutput"), kind: "err" });
      return;
    }
    // FMD2: base = len div N, remainder get +1 (first rem batches).
    const base = Math.floor(chapters.length / n);
    const rem = chapters.length % n;
    const batches: (typeof chapters)[] = [];
    let offset = 0;
    for (let i = 0; i < n; i++) {
      const size = base + (i < rem ? 1 : 0);
      batches.push(chapters.slice(offset, offset + size));
      offset += size;
    }
    const stamp = Date.now().toString(36);
    setSplitBusy(true);
    try {
      let total = 0;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        if (!batch.length) continue;
        const batchId = `split-${stamp}-${i + 1}of${batches.length}`;
        total += await api.queueAdd({
          manga_title: manga.title || "manga",
          root_url: manga.root_url,
          manga_url: mangaUrl,
          module_id: manga.module_id,
          output_dir: dir,
          chapters: batch,
          start: !taskStopped,
          batch_id: batchId,
        });
      }
      const msg = taskStopped
        ? `Dividido en ${batches.length} tareas (${total} caps, detenidos).`
        : `Dividido en ${batches.length} tareas (${total} caps).`;
      log(msg, "ok");
      const gotoDlRaw = await api.settingsGet("ui.goto_downloads_on_add");
      const gotoDl = gotoDlRaw !== "0" && gotoDlRaw !== "false";
      appToast({
        message: msg,
        kind: "ok",
        ...(gotoDl
          ? {}
          : {
              action: {
                label: t("explore.viewDownloads"),
                onClick: () => setActiveNav("downloads"),
              },
            }),
      });
      setSplitPrompt(null);
      if (gotoDl) setActiveNav("downloads");
    } catch (e) {
      const msg = String(e);
      log(msg, "err");
      appToast({ message: msg, kind: "err" });
    } finally {
      setSplitBusy(false);
    }
  }

  async function handleFavAdd() {
    const live = mangaRef.current || manga;
    const url = (mangaUrl || urlInput || "").trim();
    if (!url) {
      log(t("explore.loadMangaFirst"), "err");
      return;
    }

    if (isFavorite) {
      if (favoriteId == null) {
        await syncFavoriteState(url);
        log(t("explore.favNotFoundRetry"), "err");
        return;
      }
      const title = live?.title || sidebarRows.title || url;
      const moduleId =
        live?.module_id || sidebarModuleIdRef.current || selectedModuleId || "";
      const mod =
        (moduleId ? modules.find((m) => m.id === moduleId) : undefined) || currentModule;
      if (!mod || !moduleId) {
        log(t("explore.noSource"), "err");
        return;
      }
      const snapshot: FavoriteAddRequest = {
        module_id: moduleId,
        module_name: live?.module_name || mod.name || sidebarRows.moduleName || "",
        root_url: live?.root_url || mod.root_url || "",
        manga_url: url,
        title,
        chapters: live?.chapters ?? [],
      };
      try {
        await api.favoritesRemove(favoriteId);
        favoritesCacheRemove(favoriteId);
        setIsFavorite(false);
        setFavoriteId(null);
        log(t("explore.removedFavLog", { title }), "ok");
        showFavoriteRemovedToast(snapshot, true);
      } catch (e) {
        log(String(e), "err");
      }
      return;
    }

    const moduleId =
      live?.module_id || sidebarModuleIdRef.current || selectedModuleId || "";
    const mod =
      (moduleId ? modules.find((m) => m.id === moduleId) : undefined) || currentModule;
    if (!mod || !moduleId) {
      log(t("explore.noSource"), "err");
      return;
    }

    try {
      const favs = await loadFavoritesCached();
      const existing = favs.find(
        (f) =>
          urlsReferToSameManga(f.manga_url, url) ||
          (moduleId &&
            f.module_id === moduleId &&
            urlsReferToSameManga(f.manga_url, url)),
      );
      if (existing) {
        setIsFavorite(true);
        setFavoriteId(existing.id);
        log(t("explore.alreadyFav"), "ok");
        return;
      }
    } catch {
      /* continue to add */
    }

    try {
      const fav = await api.favoritesAdd({
        module_id: moduleId,
        module_name: live?.module_name || mod.name || sidebarRows.moduleName || "",
        root_url: live?.root_url || mod.root_url || "",
        manga_url: url,
        title: live?.title || sidebarRows.title || url,
        chapters: live?.chapters ?? [],
      });
      favoritesCacheUpsert(fav);
      setIsFavorite(true);
      setFavoriteId(fav.id);
      log(
        t("explore.favSavedLast", { title: fav.title, last: fav.last_chapter_name || t("common.dash") }),
        "ok",
      );
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
      log(t("explore.openFailed", { err: String(e) }), "err");
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
    log(t("explore.filterReset"), "ok");
  }

  /* ---------------------------------------------------------------------
   * Derived render values
   * ------------------------------------------------------------------- */
  const sourceLabel = sourcesLoading
    ? t("explore.loadingSources")
    : currentModule && enabledModuleIds.has(currentModule.id)
      ? currentModule.name
      : enabledModules.length
        ? t("explore.selectSource")
        : t("explore.noSources");

  const infoRows: { icon: IconName; label: string; value: string }[] = [];
  if (sidebarRows.authors) infoRows.push({ icon: "user", label: t("explore.author"), value: sidebarRows.authors });
  if (sidebarRows.artists) infoRows.push({ icon: "brush", label: t("explore.artist"), value: sidebarRows.artists });
  if (sidebarRows.genres) infoRows.push({ icon: "about", label: t("explore.genres"), value: sidebarRows.genres });
  if (sidebarRows.status) infoRows.push({ icon: "status", label: t("explore.status"), value: sidebarRows.status });
  const fuente = sidebarRows.moduleName || currentModule?.name || t("common.dash");
  const capsLabel = sidebarRows.numchapter ? t("explore.caps", { n: sidebarRows.numchapter }) : t("explore.capsDash");

  const chaptersHasManga = !!manga;
  const selectAllLabel = chSel.allSelected ? t("explore.deselect") : t("explore.selectAll");

  function renderChaptersBody() {
    if (chaptersLoading) {
      return (
        <div className="chapters-list" id="chapters">
          <div className="panel-loading">
            <span className="spinner" />
            {t("explore.loadingChapters")}
          </div>
        </div>
      );
    }
    if (infoInaccessible) {
      const mod = infoInaccessible.moduleName.trim() || t("explore.theSite");
      return (
        <div className="chapters-list" id="chapters">
          <div className="chapters-empty chapters-inaccessible">
            <div className="chapters-fail-box">
              <div className="chapters-fail">
                <div className="chapters-fail-top">
                  <div className="chapters-fail-ico" aria-hidden>
                    <Icon name="unplug" className="ico ico-lg" />
                  </div>
                  <div className="chapters-fail-copy">
                    <p className="chapters-fail-title">{t("explore.infoFailTitle")}</p>
                    <p className="chapters-fail-desc">
                      {t("explore.failDesc", { mod })}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn chapters-fail-retry"
                  disabled={loadBtnDisabled || !urlInput.trim()}
                  onClick={() => void loadMangaInfo()}
                >
                  <Icon name="refresh" className="ico ico-sm" /> {t("common.retry")}
                </button>
              </div>
            </div>
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
              {t("explore.emptyChapters")}
            </p>
          </div>
        </div>
      );
    }
    if (!manga.chapters.length) {
      return (
        <div className="chapters-list" id="chapters">
          <div className="catalog-empty">{t("explore.noChapters")}</div>
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
        apiRef={chaptersApiRef}
        containerProps={{
          tabIndex: 0,
          role: "listbox",
          "aria-multiselectable": true,
          "aria-label": t("explore.chapters"),
          onKeyDown: chSel.handleKeyDown,
        }}
        renderItem={(c, _i, style: CSSProperties) => {
          const on = selected.has(c.index);
          const cursor = chSel.isCursor(c.index);
          const mark = chMarkKeys.get(c.index) || "";
          const isDl = !!mark && chDownloaded.has(mark);
          const isQ = !!mark && chQueued.has(mark);
          const markCls = isDl ? " is-downloaded" : isQ ? " is-queued" : "";
          return (
            <div
              className={`ch-card${on ? " is-on" : ""}${
                cursor ? " is-cursor" : ""
              }${markCls}`}
              style={style}
              role="option"
              aria-selected={on}
              data-selkey={c.index}
              onMouseDown={(ev) => {
                /* Shift+clic no debe pintar seleccion de texto; el foco tiene
                   que quedarse en la lista para seguir con teclado. */
                if (ev.shiftKey) {
                  ev.preventDefault();
                  chaptersApiRef.current
                    ?.getContainer()
                    ?.focus({ preventScroll: true });
                }
              }}
              onClick={(ev) => chSel.handleRowClick(c.index, ev)}
              title={
                isDl ? t("explore.downloaded") : isQ ? t("explore.queued") : undefined
              }
            >
              <button
                type="button"
                className="ch-box"
                tabIndex={-1}
                aria-label={t("explore.selectChapter")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  chSel.handleCheckboxClick(c.index);
                }}
              >
                {on && <Icon name="check" className="ico ico-sm" style={{ color: "var(--on-accent)" }} />}
              </button>
              <span className="ch-num">{chapterNum(c.index)}</span>
              <span className="ch-title">{c.name || t("explore.chapterN", { n: c.index + 1 })}</span>
            </div>
          );
        }}
      />
    );
  }

  function renderCatalogBody() {
    /* Sin fuentes (solo cuando ya terminó el boot). */
    if (sourcesBooted && !sourcesLoading && !enabledModules.length) {
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="catalog-empty">
            {t("explore.noSitesBody").split("\n")[0]}
            <br />
            {t("explore.noSitesBody").split("\n")[1]}
          </div>
        </div>
      );
    }
    /* Por defecto / cargando: nada. */
    if (!sourcesBooted || sourcesLoading || catalogLoading || !catalogFetched) {
      return <div className="catalog-results" id="catalog-list" />;
    }
    if (catalogError) {
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="catalog-empty">{t("explore.catalogError")}</div>
        </div>
      );
    }
    const isEmpty =
      advFilterApplied && !appliedAdvFilter.allSites
        ? visibleCatalog.length === 0
        : catalogTotal === 0;
    if (isEmpty) {
      const filterMiss =
        advFilterApplied && catalogTotal > 0 && visibleCatalog.length === 0;
      return (
        <div className="catalog-results" id="catalog-list">
          <div className="catalog-empty">
            {filterMiss ? (
              t("explore.filterMiss")
            ) : (
              <>
                {t("explore.noResults")}
                <br />
                {t("explore.updateListHint")}
              </>
            )}
          </div>
        </div>
      );
    }
    const showSite = advFilterApplied && appliedAdvFilter.allSites;
    return (
      <VirtualList
        id="catalog-list"
        className="catalog-results"
        innerClassName="catalog-virtual"
        items={visibleCatalog}
        itemHeight={showSite ? CAT_ROW_H_ALL_SITES : CAT_ROW_H}
        overscan={CAT_OVERSCAN}
        resetKey={catalogResetSeq}
        apiRef={catalogApiRef}
        containerProps={{
          tabIndex: 0,
          role: "listbox",
          "aria-multiselectable": true,
          "aria-label": t("explore.catalogAria"),
          onKeyDown: handleCatalogKeyDown,
        }}
        onRange={(s, e) => {
          catalogRangeRef.current = { start: s, end: e };
          if (!advFilterApplied || appliedAdvFilter.allSites) requestRange(s, e);
        }}
        getKey={(e, i) =>
          e ? `${e.module_id || ""}:${e.link}:${i}` : `ph:${i}`
        }
        renderItem={(e, i, style: CSSProperties) => {
          if (!e) {
            return <div className="catalog-row is-loading" style={style} aria-hidden />;
          }
          const title = e.title || e.link;
          const meta = e.info_failed ? "N/A" : String(e.numchapter ?? 0);
          const isNew = isCatalogEntryNew(e.jdn, filterNewDays);
          const site = e.module_name?.trim();
          const titleLabel = isNew ? `(nuevo) ${title} ` : title;
          const tip = site ? `${titleLabel} · ${site} · ${meta}` : `${titleLabel} · ${meta}`;
          const rowKey = catalogRowKey(e);
          const isSel = catalogSelectedKeys.has(rowKey);
          return (
            <button
              type="button"
              className={`catalog-row${showSite ? " has-site" : ""}${
                title === activeCatalogTitle ? " active" : ""
              }${isSel ? " is-selected" : ""}${
                i === catalogCursorIdx ? " is-cursor" : ""
              }${isNew ? " is-new" : ""}`}
              style={style}
              title={tip}
              role="option"
              aria-selected={isSel}
              onMouseDown={(ev) => {
                if (ev.shiftKey) ev.preventDefault();
              }}
              onClick={(ev) => handleCatalogRowClick(i, e, ev)}
              onContextMenu={(ev) => handleCatalogRowContextMenu(ev, i, e)}
            >
              <div className="catalog-row-body">
                <div className="catalog-row-title">{title}</div>
                {showSite && site ? (
                  <div className="catalog-row-site">{site}</div>
                ) : null}
              </div>
              <span className="catalog-row-meta">{meta}</span>
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
              {t("explore.info")}
            </button>
            <button
              type="button"
              className={`seg-btn${infoMode === "filter" ? " active" : ""}`}
              id="seg-filter"
              onClick={() => setInfoMode("filter")}
            >
              {t("explore.filter")}
            </button>
          </div>
          <div className="field-label">{t("explore.source")}</div>
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
                    placeholder={t("explore.searchSource")}
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
                      {t("explore.noSources")}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="ghost"
              id="source-tools"
              title={t("explore.catalogTools")}
              disabled={!!catalogJob}
              onClick={() => {
                setSourceToolsAction("update_one");
                setSourceToolsOpen(true);
              }}
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
                placeholder={t("explore.searchTitle")}
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
                title={t("common.clear")}
                onClick={clearCatalogFilter}
              >
                <Icon name="x" className="ico ico-sm" />
              </button>
            </div>
          </div>
        </div>
        <div className="search-mode-bar">
          <span>
            {t("explore.mode")}{" "}
            <strong id="catalog-mode-label">
              {advFilterApplied ? t("explore.advancedMode") : t("explore.individualMode")}
            </strong>
          </span>
          <div className="search-mode-right">
            <button
              type="button"
              className="ghost ghost-sm"
              id="catalog-clear-adv"
              title={t("explore.removeFilter")}
              onClick={clearAllFilters}
            >
              <Icon name="filterOff" className="ico ico-sm" />
            </button>
            <span className="result-badge" id="catalog-stats">
              {advFilterApplied && !appliedAdvFilter.allSites
                ? visibleCatalog.length
                : catalogStatsText}
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
                <button
                  type="button"
                  className="url-paste"
                  id="url-paste"
                  title={t("explore.pasteTitle")}
                  onClick={() => void pasteUrlFromClipboard()}
                >
                  <Icon name="clipboard" className="ico ico-sm" />
                </button>
                <input
                  ref={urlInputRef}
                  id="url"
                  type="text"
                  inputMode="url"
                  placeholder={t("explore.pastePh")}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={urlInput}
                  onChange={(ev) => setUrlInput(ev.target.value)}
                  onPaste={handleUrlPaste}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void loadMangaInfo();
                  }}
                />
                <button
                  type="button"
                  className="url-clear"
                  id="url-clear"
                  hidden={!urlInput.trim()}
                  title={t("common.clear")}
                  onClick={() => setUrlInput("")}
                >
                  <Icon name="x" className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className="url-go"
                  id="load"
                  title={t("explore.load")}
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
                  <span className="chapters-label">{t("explore.chapters")}</span>
                  <span className="chapters-meta" id="chapters-available" hidden={!chaptersHasManga}>
                    {manga ? t("explore.available", { n: manga.chapters.length }) : ""}
                  </span>
                </div>
                <div className="chapters-head-right">
                  <span className="sel-count" id="count" hidden={!chaptersHasManga}>
                    {manga ? t("explore.selectedCount", { n: selected.size }) : ""}
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
              title={infoSidebarCollapsed ? t("explore.showPanel") : t("explore.hidePanel")}
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
                    alt={t("explore.coverAlt")}
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
                    {t("explore.noCover")}
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
                    disabled={!mangaUrl || !!infoInaccessible}
                    onClick={() => void handleOnlineClick()}
                  >
                    <Icon name="external" className="ico ico-sm" /> {t("explore.readOnline")}
                  </button>
                  <button
                    type="button"
                    className={`info-action-btn info-action-fav${isFavorite ? " is-on" : ""}`}
                    id="fav-add"
                    disabled={!infoPanelOpen || !(mangaUrl || urlInput).trim()}
                    onClick={() => void handleFavAdd()}
                  >
                    <Icon name={isFavorite ? "heartSolid" : "heart"} className="ico ico-sm" />
                    <span id="fav-label">
                      {isFavorite ? t("explore.removeFav") : t("explore.addFav")}
                    </span>
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
                      <h3 className="info-summary-title">{t("explore.synopsis")}</h3>
                      <div className="info-summary-text">{sidebarRows.summary}</div>
                    </div>
                  ) : null}
                  <div className="info-meta-line">
                    <span className="info-meta-source">{fuente}</span>
                    <span className="info-meta-sep">·</span>
                    <span className="info-meta-caps">{capsLabel}</span>
                  </div>
                </div>
              </div>
            </div>
            </div>
          </aside>

          <div className="filter-panel" id="filter-panel" hidden={infoMode !== "filter"}>
            <header className="filter-head">
              <div>
                <div className="filter-eyebrow">{t("explore.advanced")}</div>
                <h1 className="filter-title">{t("explore.filterTitle")}</h1>
              </div>
              <div className="filter-head-meta">
                <Icon name="filter" className="ico ico-sm" />
                <span>
                  <span className="filter-active-n" id="filter-active-count">
                    {filterActiveCount}
                  </span>{" "}
                  {t("explore.activeFilters")}
                </span>
              </div>
            </header>

            <div className="filter-scroll">
              <div className="filter-grid">
                <section className="filter-card filter-card-genres">
                  <div className="filter-card-head">
                    <div className="filter-card-title">
                      <Icon name="tag" className="ico ico-sm" />
                      <h2>{t("explore.genres")}</h2>
                      <Icon
                        name="about"
                        className="filter-hint ico ico-sm"
                        title={t("filterHint")}
                      />
                    </div>
                    <div className="filter-legend" aria-hidden="true">
                      <span className="filter-legend-item">
                        <span className="filter-legend-dot inc" />
                        {t("explore.include")}
                      </span>
                      <span className="filter-legend-item">
                        <span className="filter-legend-dot exc" />
                        {t("explore.exclude")}
                      </span>
                    </div>
                  </div>
                  <div className="filter-genres" id="filter-genres" role="group" aria-label={t("explore.genres")}>
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
                              ? t("explore.include")
                              : state === "exclude"
                                ? t("explore.exclude")
                                : t("explore.genreIgnore")
                          }
                          onClick={() => cycleGenre(g.id)}
                        >
                          <span className="dot" aria-hidden="true" />
                          {genreLabel(g.id)}
                        </button>
                      );
                    })}
                  </div>
                  <div className="filter-extra">
                    <label className="filter-extra-label" id="filter-custom-label" htmlFor="filter-custom">
                      {t("explore.extraGenres")}
                    </label>
                    <input
                      id="filter-custom"
                      className="st-field"
                      type="text"
                      placeholder={t("explore.extraPh")}
                      autoComplete="off"
                      spellCheck={false}
                      value={advFilter.customGenres}
                      onChange={(ev) => updateFilterField("customGenres", ev.target.value)}
                    />
                    <div className="filter-extra-hint">
                      {t("explore.extraHint")}
                    </div>
                  </div>
                </section>

                <section className="filter-card filter-card-details">
                  <div className="filter-card-head">
                    <div className="filter-card-title">
                      <Icon name="text" className="ico ico-sm" />
                      <h2>{t("explore.details")}</h2>
                    </div>
                  </div>
                  <div className="filter-details">
                    <label htmlFor="filter-title">{t("explore.titleField")}</label>
                    <div className="fl-row">
                      <input
                        id="filter-title"
                        className="st-field"
                        type="text"
                        placeholder={t("explore.titlePh")}
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.title}
                        onChange={(ev) => updateFilterField("title", ev.target.value)}
                      />
                    </div>
                    <label htmlFor="filter-authors">{t("explore.author")}</label>
                    <div className="fl-row">
                      <input
                        id="filter-authors"
                        className="st-field"
                        type="text"
                        placeholder={t("explore.authorPh")}
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.authors}
                        onChange={(ev) => updateFilterField("authors", ev.target.value)}
                      />
                    </div>
                    <label htmlFor="filter-artists">{t("explore.artist")}</label>
                    <div className="fl-row">
                      <input
                        id="filter-artists"
                        className="st-field"
                        type="text"
                        placeholder={t("explore.artistPh")}
                        autoComplete="off"
                        spellCheck={false}
                        value={advFilter.artists}
                        onChange={(ev) => updateFilterField("artists", ev.target.value)}
                      />
                    </div>
                    <label htmlFor="filter-status">{t("explore.status")}</label>
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
                          <option value={0}>{t("mangaStatus.completed")}</option>
                          <option value={1}>{t("mangaStatus.ongoing")}</option>
                          <option value={2}>{t("mangaStatus.paused")}</option>
                          <option value={3}>{t("mangaStatus.cancelled")}</option>
                          <option value={4}>{t("mangaStatus.unfiltered")}</option>
                        </select>
                      </div>
                    </div>
                    <label htmlFor="filter-summary">{t("explore.summary")}</label>
                    <div className="fl-row">
                      <input
                        id="filter-summary"
                        className="st-field"
                        type="text"
                        placeholder={t("explore.summaryPh")}
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
                    <h2 className="filter-card-label">{t("explore.genreMatch")}</h2>
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
                        <div className="opt-row-title">{t("explore.anyMarked")}</div>
                        <div className="opt-row-desc">{t("explore.anyMarkedDesc")}</div>
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
                        <div className="opt-row-title">{t("explore.allMarked")}</div>
                        <div className="opt-row-desc">{t("explore.allMarkedDesc")}</div>
                      </div>
                    </label>
                  </section>

                  <section className="filter-card">
                    <h2 className="filter-card-label">{t("explore.options")}</h2>
                    <label className="opt-row opt-row-switch">
                      <div>
                        <div className="opt-row-title">{t("explore.onlyNew")}</div>
                        <div className="opt-row-desc">{t("explore.onlyNewDesc")}</div>
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
                    <label className="opt-row opt-row-switch">
                      <div>
                        <div className="opt-row-title">{t("explore.allSources")}</div>
                        <div className="opt-row-desc">{t("explore.allSourcesDesc")}</div>
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
                        <div className="opt-row-title">{t("explore.regex")}</div>
                        <div className="opt-row-desc">{t("explore.regexDesc")}</div>
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
                <Icon name="filter" className="ico ico-sm" /> {t("explore.applyFilter")}
              </button>
              <button type="button" className="secondary" id="filter-remove" onClick={removeAdvFilter}>
                {t("explore.removeFilter")}
              </button>
              <button type="button" className="secondary" id="filter-reset" onClick={resetAdvFilterForm}>
                {t("explore.reset")}
              </button>
              <div className="filter-actions-spacer" />
              <button
                type="button"
                className="secondary"
                id="filter-back"
                onClick={() => setInfoMode("search")}
              >
                <Icon name="arrowLeft" className="ico ico-sm" /> {t("explore.back")}
              </button>
            </div>
          </div>
        </div>

        <div className="action-bar">
          <div className="action-path">
            <span className="action-path-label">{t("explore.saveTo")}</span>
            <div className="path-field">
              <input
                id="path-input"
                type="text"
                readOnly
                placeholder={t("explore.noOutput")}
                autoComplete="off"
                value={outputDir}
              />
              <button
                type="button"
                className="path-browse"
                id="pick"
                title={t("explore.browseEllipsis")}
                onClick={() => void handlePickOutputDir()}
              >
                <Icon name="folder" className="ico ico-sm" />
              </button>
            </div>
          </div>
          <label className="action-check" title={t("explore.queueWithoutStart")}>
            <input
              type="checkbox"
              id="task-stopped"
              checked={taskStopped}
              onChange={(e) => setTaskStopped(e.target.checked)}
            />{" "}
            {t("explore.taskStopped")}
          </label>
          <div className="action-btns">
            <button
              type="button"
              className="btn-split"
              id="btn-split"
              disabled={!manga || selected.size < 2 || enqueueBusy || splitBusy}
              title={t("explore.splitN")}
              onClick={() => void handleSplitDownload()}
            >
              <Icon name="split" className="ico ico-sm" /> {t("explore.splitDownload")}
            </button>
            <button
              type="button"
              className="btn-download"
              id="enqueue"
              disabled={!manga || selected.size === 0 || enqueueBusy || splitBusy}
              aria-busy={enqueueBusy}
              onClick={() => void handleEnqueue()}
            >
              {enqueueBusy ? (
                <>
                  <span className="spinner spinner-sm" aria-hidden /> {t("explore.enqueueing")}
                </>
              ) : (
                <>
                  <Icon name="download" className="ico ico-sm" /> {t("explore.download")}
                </>
              )}
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
                {t("explore.catalogTitle")}
              </h2>
              <button
                type="button"
                className="ghost"
                title={t("common.close")}
                onClick={() => setSourceToolsOpen(false)}
              >
                <Icon name="x" className="ico" />
              </button>
            </header>
            <div className="info-modal-body">
              <div className="catalog-tools-radios" role="radiogroup" aria-label={t("explore.catalogAction")}>
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
                    <span>{t("explore.updateList")}</span>
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
                    <span>{t("explore.fetchOne")}</span>
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
                    <span>{t("explore.updateAll")}</span>
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
                    <span>{t("explore.fetchAll")}</span>
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
                {t("common.close")}
              </button>
              <button
                type="button"
                className="info-modal-btn info-modal-btn-primary"
                disabled={!!catalogJob}
                onClick={() => {
                  void (async () => {
                    const scope =
                      sourceToolsAction === "update_all" || sourceToolsAction === "fetch_all"
                        ? "all"
                        : "one";
                    const mode =
                      sourceToolsAction === "fetch_one" || sourceToolsAction === "fetch_all"
                        ? "fetch"
                        : "update";
                    if (mode === "fetch") {
                      const name =
                        scope === "one"
                          ? currentModule?.name || t("explore.thisSource")
                          : t("explore.allActiveSites");
                      const msg =
                        scope === "one"
                          ? t("explore.replaceOne", { name })
                          : t("explore.replaceAll", { name });
                      const ok = await appConfirm({
                        title: t("explore.fetchCatalog"),
                        message: msg,
                        okLabel: t("common.continue"),
                        cancelLabel: t("common.cancel"),
                      });
                      if (!ok) return;
                    }
                    setSourceToolsOpen(false);
                    void startCatalogJob({
                      mode,
                      scope,
                      moduleId: selectedModuleId,
                    });
                  })();
                }}
              >
                {t("explore.apply")}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      {catalogCtxMenu ? (
        <div className="catalog-ctx-layer" ref={catalogCtxMenuRef}>
          <div
            className="catalog-ctx-backdrop"
            onClick={closeCatalogCtxMenu}
            onContextMenu={(ev) => {
              ev.preventDefault();
              closeCatalogCtxMenu();
            }}
          />
          <div
            className="catalog-ctx-menu"
            style={{ left: catalogCtxMenu.x, top: catalogCtxMenu.y }}
            role="menu"
          >
            {catalogCtxMenu.isBulk ? (
              <div className="catalog-ctx-title">
                {t("explore.selectedTitles", { n: catalogCtxMenu.bulkCount })}
              </div>
            ) : null}
            {(catalogCtxMenu.isBulk
              ? [
                  {
                    id: "dl-all",
                    icon: "download" as IconName,
                    label: t("explore.downloadAllN", { n: catalogCtxMenu.bulkCount }),
                    hint: "Ctrl+D",
                    onClick: () =>
                      void downloadAllFromCatalogBulk([
                        ...catalogSelectedEntriesRef.current.values(),
                      ]),
                  },
                  {
                    id: "fav",
                    icon: "heart" as IconName,
                    label: t("explore.addFavN", { n: catalogCtxMenu.bulkCount }),
                    onClick: () => void addFavoritesFromCatalogBulk(),
                  },
                  {
                    id: "remove",
                    icon: "x" as IconName,
                    label: t("explore.removeFromListN", { n: catalogCtxMenu.bulkCount }),
                    hint: "Supr",
                    sep: true,
                    danger: true,
                    onClick: () =>
                      void removeFromCatalog([
                        ...catalogSelectedEntriesRef.current.values(),
                      ]),
                  },
                ]
              : [
                  {
                    id: "view",
                    icon: "about" as IconName,
                    label: t("explore.viewInfo"),
                    onClick: () => {
                      const entry = catalogCtxMenu.entry;
                      setCatalogCtxMenu(null);
                      void openCatalogEntry(entry);
                    },
                  },
                  {
                    id: "dl-all",
                    icon: "download" as IconName,
                    label: t("explore.downloadAll"),
                    hint: "Ctrl+D",
                    sep: true,
                    onClick: () => {
                      const entry = catalogCtxMenu.entry;
                      setCatalogCtxMenu(null);
                      void downloadAllFromCatalog(entry);
                    },
                  },
                  {
                    id: "fav",
                    icon: (catalogCtxMenu.isFav ? "heartSolid" : "heart") as IconName,
                    label: catalogCtxMenu.isFav
                      ? t("explore.removeFav")
                      : t("explore.addToFav"),
                    onClick: () => {
                      if (catalogCtxMenu.isFav) {
                        void removeFavoriteFromCatalog(
                          catalogCtxMenu.entry,
                          catalogCtxMenu.favoriteId,
                        );
                      } else {
                        void addFavoriteFromCatalog(catalogCtxMenu.entry);
                      }
                    },
                  },
                  {
                    id: "remove",
                    icon: "x" as IconName,
                    label: t("explore.removeFromList"),
                    hint: "Supr",
                    sep: true,
                    danger: true,
                    onClick: () => void removeFromCatalog([catalogCtxMenu.entry]),
                  },
                ]
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitem"
                className={`catalog-ctx-item${"sep" in m && m.sep ? " is-sep" : ""}${
                  "danger" in m && m.danger ? " is-danger" : ""
                }${"off" in m && m.off ? " is-off" : ""}${
                  m.id === "fav" && catalogCtxMenu.isFav && !catalogCtxMenu.isBulk
                    ? " is-fav"
                    : ""
                }`}
                disabled={"off" in m && !!m.off}
                onClick={() => {
                  if ("off" in m && m.off) return;
                  if ("onClick" in m && m.onClick) m.onClick();
                  else closeCatalogCtxMenu();
                }}
              >
                <Icon name={m.icon} className="ico ico-sm" />
                <span className="catalog-ctx-label">{m.label}</span>
                {"hint" in m && m.hint ? (
                  <span className="catalog-ctx-hint">{m.hint}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {splitPrompt ? (
        <div
          className="info-modal-backdrop info-modal-backdrop-confirm"
          role="presentation"
          onClick={() => {
            if (!splitBusy) setSplitPrompt(null);
          }}
        >
          <div
            className="info-modal info-modal-confirm info-split-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="split-dl-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="info-split-head">
              <h2 id="split-dl-title" className="info-modal-title">
                {t("explore.splitInto")}
              </h2>
              <p className="info-split-sub">
                {t("explore.splitSelected", { n: splitPrompt.chapters.length })}
                {manga?.title ? t("explore.splitOf", { title: manga.title }) : ""}
              </p>
            </header>
            <div className="info-modal-body info-split-body">
              <div className="info-split-row">
                <label className="info-split-label" htmlFor="split-dl-count">
                  {t("explore.splitTasks")}
                </label>
                <div className="info-split-stepper st-num-wrap">
                  <div className="st-stepper">
                    <button
                      type="button"
                      className="st-stepper-btn"
                      aria-label={t("explore.less")}
                      disabled={splitBusy || splitPrompt.count <= 2}
                      onClick={() =>
                        setSplitPrompt((prev) =>
                          prev
                            ? {
                                ...prev,
                                count: Math.max(2, prev.count - 1),
                              }
                            : prev,
                        )
                      }
                    >
                      −
                    </button>
                    <input
                      id="split-dl-count"
                      className="st-stepper-input"
                      type="number"
                      min={2}
                      max={splitPrompt.chapters.length}
                      value={splitPrompt.count}
                      autoFocus
                      autoComplete="off"
                      disabled={splitBusy}
                      onChange={(e) => {
                        const max = splitPrompt.chapters.length;
                        const raw = Number(e.target.value);
                        const v = Number.isFinite(raw)
                          ? Math.min(max, Math.max(2, Math.floor(raw)))
                          : 2;
                        setSplitPrompt((prev) =>
                          prev ? { ...prev, count: v } : prev,
                        );
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmSplitDownload();
                        if (e.key === "Escape" && !splitBusy) setSplitPrompt(null);
                      }}
                    />
                    <button
                      type="button"
                      className="st-stepper-btn"
                      aria-label={t("explore.more")}
                      disabled={
                        splitBusy ||
                        splitPrompt.count >= splitPrompt.chapters.length
                      }
                      onClick={() =>
                        setSplitPrompt((prev) =>
                          prev
                            ? {
                                ...prev,
                                count: Math.min(
                                  prev.chapters.length,
                                  prev.count + 1,
                                ),
                              }
                            : prev,
                        )
                      }
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
              <p className="info-split-hint">
                {t("explore.splitHint2")}
              </p>
            </div>
            <footer className="info-modal-foot">
              <button
                type="button"
                className="info-modal-btn"
                disabled={splitBusy}
                onClick={() => setSplitPrompt(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="info-modal-btn info-modal-btn-primary"
                disabled={splitBusy}
                aria-busy={splitBusy}
                onClick={() => void confirmSplitDownload()}
              >
                {splitBusy ? (
                  <>
                    <span className="spinner spinner-sm" aria-hidden /> {t("explore.splitting")}
                  </>
                ) : (
                  t("explore.split")
                )}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
