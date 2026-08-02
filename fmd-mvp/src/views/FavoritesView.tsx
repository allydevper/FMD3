import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon } from "../components/Icon";
import { appToastUndo } from "../components/AppToast";
import { ICO } from "../icons";
import * as api from "../api/tauri";
import { useApp } from "../context/AppContext";
import type { Favorite, FavoriteAddRequest, FavoriteCheckResult } from "../types";
import {
  favoritesCacheRemove,
  favoritesCacheUpsert,
  loadFavoritesCached,
} from "../utils/favoritesCache";
import { maybeFillHost } from "../utils/url";

function pendingLinkCount(text: string | undefined): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => l.trim()).length;
}

function favoriteSnapshot(fav: Favorite): FavoriteAddRequest {
  return {
    module_id: fav.module_id,
    module_name: fav.module_name,
    root_url: fav.root_url,
    manga_url: fav.manga_url,
    title: fav.title,
    chapters: [],
    seen_chapter_links: fav.seen_chapter_links || "",
  };
}

function seriesStatusLabel(status: string | undefined): string {
  const s = (status || "").trim();
  if (!s) return "—";
  const low = s.toLowerCase();
  if (low === "0" || low.includes("complet") || low.includes("finished")) return "Completado";
  if (low === "1" || low.includes("ongo") || low.includes("en curso")) return "En curso";
  if (low === "2" || low.includes("hiatus")) return "Hiatus";
  if (low === "3" || low.includes("cancel")) return "Cancelado";
  return s;
}

type FavFilter = "Todo" | "Habilitado" | "Deshabilitado";
type SortKey = "new" | "title" | "cur" | "status" | "added" | "checked";

const SORT_COLS: { key: SortKey; label: string }[] = [
  { key: "new", label: "#" },
  { key: "title", label: "Título" },
  { key: "cur", label: "Capítulo actual" },
  { key: "status", label: "Estado" },
  { key: "added", label: "Agregado" },
  { key: "checked", label: "Última rev." },
];

function pruneMap<T>(map: Map<number, T>, ids: Set<number>): Map<number, T> {
  const next = new Map(map);
  for (const id of next.keys()) {
    if (!ids.has(id)) next.delete(id);
  }
  return next;
}

function favAgeHours(iso: string | undefined, fallbackMs?: number): number {
  const t = fallbackMs ?? Date.parse(iso || "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 3600000);
}

function favFmtAgo(iso: string | undefined, checkedMs?: number): string {
  const h = favAgeHours(iso, checkedMs);
  if (!iso && checkedMs == null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.round(h)} h`;
  if (h < 24 * 30) return `${Math.round(h / 24)} d`;
  if (h < 24 * 365) return `${Math.round(h / 730)} mes`;
  return `${(h / 8760).toFixed(1)} a`;
}

export function FavoritesView() {
  const {
    activeNav,
    log,
    outputDir,
    setOutputDir,
    favAutoCheckSeq,
    lastFavAutoCheck,
    favAutoChecking,
    favAutoCheckSource,
    catalogJob,
    setAppJob,
    isAppJobCancelRequested,
    clearAppJobCancel,
    cancelCatalogJob,
    setActiveNav,
    setPendingMangaOpen,
    modules,
  } = useApp();

  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [newCounts, setNewCounts] = useState<Map<number, number>>(new Map());
  const [enabledMap, setEnabledMap] = useState<Map<number, boolean>>(new Map());
  const [checkedAt, setCheckedAt] = useState<Map<number, number>>(new Map());
  const [favCtxMenu, setFavCtxMenu] = useState<{ x: number; y: number; ids: number[] } | null>(
    null,
  );

  const [cat, setCat] = useState("all");
  const [filter, setFilter] = useState<FavFilter>("Todo");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<Record<number, true>>({});
  const [sortKey, setSortKey] = useState<SortKey>("new");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [treeCollapsed, setTreeCollapsed] = useState(false);

  const queryInputRef = useRef<HTMLInputElement>(null);
  const favScanning = catalogJob?.mode === "favorites";
  const scanningFavId = favScanning ? Number(catalogJob.moduleId) : NaN;
  const checkBusy = favScanning || favAutoChecking;

  const favNewOf = useCallback((id: number) => newCounts.get(id) || 0, [newCounts]);
  const favIsEnabled = useCallback(
    (id: number) => {
      if (enabledMap.has(id)) return enabledMap.get(id) !== false;
      const fav = favorites.find((f) => f.id === id);
      return fav?.enabled !== false;
    },
    [enabledMap, favorites],
  );

  const refreshFavorites = useCallback(async () => {
    try {
      const favs = await loadFavoritesCached(true);
      const ids = new Set(favs.map((f) => f.id));
      setNewCounts(() => {
        const next = new Map<number, number>();
        for (const f of favs) {
          const n = pendingLinkCount(f.pending_new_links);
          if (n > 0) next.set(f.id, n);
        }
        return next;
      });
      setCheckedAt((prev) => {
        const next = pruneMap(prev, ids);
        for (const f of favs) {
          if (f.last_checked_at) {
            const t = Date.parse(f.last_checked_at);
            if (Number.isFinite(t)) next.set(f.id, t);
          }
        }
        return next;
      });
      setEnabledMap((prev) => {
        const next = pruneMap(prev, ids);
        for (const f of favs) {
          next.set(f.id, f.enabled !== false);
        }
        return next;
      });
      setSel((prev) => {
        const next: Record<number, true> = {};
        for (const key of Object.keys(prev)) {
          const id = Number(key);
          if (prev[id] && ids.has(id)) next[id] = true;
        }
        return next;
      });
      setFavorites(favs);
    } catch (e) {
      log(String(e), "err");
    }
  }, [log]);

  useEffect(() => {
    if (activeNav === "favorites") void refreshFavorites();
  }, [activeNav, refreshFavorites]);

  useEffect(() => {
    if (favAutoCheckSeq === 0 || !lastFavAutoCheck) return;
    setNewCounts((prev) => {
      const next = new Map(prev);
      for (const r of lastFavAutoCheck) {
        next.set(r.favorite.id, r.new_chapters.length);
      }
      return next;
    });
    setCheckedAt((prev) => {
      const next = new Map(prev);
      const now = Date.now();
      for (const r of lastFavAutoCheck) {
        next.set(r.favorite.id, now);
      }
      return next;
    });
    void refreshFavorites();
  }, [favAutoCheckSeq, lastFavAutoCheck, refreshFavorites]);

  const ensureOutputDir = useCallback(async (): Promise<string | null> => {
    if (outputDir) return outputDir;
    const saved = ((await api.settingsGet("default_output_dir")) ?? "").trim();
    if (saved) {
      setOutputDir(saved);
      return saved;
    }
    const def = await api.defaultSaveDir();
    setOutputDir(def);
    return def;
  }, [outputDir, setOutputDir]);

  const removeFavorite = useCallback(
    async (id: number) => {
      const fav = favorites.find((f) => f.id === id);
      if (!fav) return;
      const snapshot = favoriteSnapshot(fav);
      await api.favoritesRemove(id);
      favoritesCacheRemove(id);
      setSel((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await refreshFavorites();
      appToastUndo({
        message: "Se quitó de favoritos",
        durationMs: 6000,
        onUndo: async () => {
          try {
            const fav = await api.favoritesAdd(snapshot);
            favoritesCacheUpsert(fav);
            await refreshFavorites();
            log(`Favorito restaurado: ${snapshot.title}`, "ok");
          } catch (e) {
            log(String(e), "err");
          }
        },
      });
    },
    [favorites, refreshFavorites, log],
  );

  const runFavChecks = useCallback(
    async (ids: number[], enqueue: boolean) => {
      if (!ids.length || favScanning) return;
      if (catalogJob) {
        log("Ya hay una tarea en curso.", "err");
        return;
      }
      if (enqueue) {
        const dir = await ensureOutputDir();
        if (!dir) {
          log("Elige carpeta de salida primero.", "err");
          return;
        }
      }
      clearAppJobCancel();
      const results: FavoriteCheckResult[] = [];
      let cancelled = false;
      try {
        for (let i = 0; i < ids.length; i++) {
          if (isAppJobCancelRequested()) {
            cancelled = true;
            break;
          }
          const id = ids[i];
          const fav = favorites.find((f) => f.id === id);
          const title = fav?.title || `Favorito #${id}`;
          const site = fav ? fav.module_name || fav.module_id : "";
          setAppJob({
            mode: "favorites",
            scope: "all",
            moduleId: String(id),
            moduleName: title,
            index: i + 1,
            total: ids.length,
            page: i,
            pageTotal: ids.length,
            bytesDone: 0,
            bytesTotal: 0,
            message: site,
            phase: "check",
            cancelling: false,
          });
          try {
            const r = await api.favoritesCheck(id, enqueue);
            results.push(r);
            const pending = enqueue
              ? 0
              : r.new_chapters.length || pendingLinkCount(r.favorite.pending_new_links);
            setNewCounts((prev) => new Map(prev).set(r.favorite.id, pending));
            setCheckedAt((prev) => new Map(prev).set(r.favorite.id, Date.now()));
          } catch (e) {
            log(String(e), "err");
          }
        }
        const news = results.reduce((a, r) => a + r.new_chapters.length, 0);
        const enq = results.reduce((a, r) => a + r.enqueued, 0);
        if (cancelled) {
          log(
            enqueue
              ? `Revisión cancelada · ${enq} capítulos encolados`
              : `Revisión cancelada · ${news} capítulos nuevos en ${results.length} favoritos`,
            "",
          );
        } else if (enqueue) {
          log(`Encolados ${enq} capítulos nuevos`, "ok");
        } else {
          log(`Revisión: ${news} capítulos nuevos en ${results.length} favoritos`, "ok");
        }
        await refreshFavorites();
      } finally {
        setAppJob(null);
        clearAppJobCancel();
      }
    },
    [
      favScanning,
      catalogJob,
      favorites,
      log,
      ensureOutputDir,
      refreshFavorites,
      setAppJob,
      isAppJobCancelRequested,
      clearAppJobCancel,
    ],
  );

  /** Enqueue from persisted pending_new_links (Revisar → Descargar). */
  const runFavEnqueuePending = useCallback(
    async (ids: number[]) => {
      if (!ids.length || favScanning) return;
      if (catalogJob) {
        log("Ya hay una tarea en curso.", "err");
        return;
      }
      const dir = await ensureOutputDir();
      if (!dir) {
        log("Elige carpeta de salida primero.", "err");
        return;
      }
      clearAppJobCancel();
      const results: FavoriteCheckResult[] = [];
      let cancelled = false;
      try {
        for (let i = 0; i < ids.length; i++) {
          if (isAppJobCancelRequested()) {
            cancelled = true;
            break;
          }
          const id = ids[i];
          const fav = favorites.find((f) => f.id === id);
          const title = fav?.title || `Favorito #${id}`;
          const site = fav ? fav.module_name || fav.module_id : "";
          setAppJob({
            mode: "favorites",
            scope: "all",
            moduleId: String(id),
            moduleName: title,
            index: i + 1,
            total: ids.length,
            page: i,
            pageTotal: ids.length,
            bytesDone: 0,
            bytesTotal: 0,
            message: site,
            phase: "check",
            cancelling: false,
          });
          try {
            const r = await api.favoritesEnqueuePending(id);
            results.push(r);
            setNewCounts((prev) => new Map(prev).set(r.favorite.id, 0));
            setCheckedAt((prev) => new Map(prev).set(r.favorite.id, Date.now()));
          } catch (e) {
            log(String(e), "err");
          }
        }
        const enq = results.reduce((a, r) => a + r.enqueued, 0);
        log(
          cancelled
            ? `Encolado cancelado · ${enq} capítulos encolados`
            : `Encolados ${enq} capítulos nuevos`,
          cancelled ? "" : "ok",
        );
        await refreshFavorites();
      } finally {
        setAppJob(null);
        clearAppJobCancel();
      }
    },
    [
      favScanning,
      catalogJob,
      favorites,
      log,
      ensureOutputDir,
      refreshFavorites,
      setAppJob,
      isAppJobCancelRequested,
      clearAppJobCancel,
    ],
  );

  const openFavoriteInInfo = useCallback(
    (fav: Favorite) => {
      setPendingMangaOpen({
        mangaUrl: fav.manga_url,
        moduleId: fav.module_id || null,
      });
      setActiveNav("info");
    },
    [setPendingMangaOpen, setActiveNav],
  );

  const runFavDownloadAll = useCallback(
    async (ids: number[]) => {
      if (!ids.length || favScanning) return;
      if (catalogJob) {
        log("Ya hay una tarea en curso.", "err");
        return;
      }
      const dir = await ensureOutputDir();
      if (!dir) {
        log("Elige carpeta de salida primero.", "err");
        return;
      }
      clearAppJobCancel();
      let enqTotal = 0;
      let cancelled = false;
      try {
        for (let i = 0; i < ids.length; i++) {
          if (isAppJobCancelRequested()) {
            cancelled = true;
            break;
          }
          const id = ids[i];
          const fav = favorites.find((f) => f.id === id);
          const title = fav?.title || `Favorito #${id}`;
          const site = fav ? fav.module_name || fav.module_id : "";
          setAppJob({
            mode: "favorites",
            scope: "all",
            moduleId: String(id),
            moduleName: title,
            index: i + 1,
            total: ids.length,
            page: i,
            pageTotal: ids.length,
            bytesDone: 0,
            bytesTotal: 0,
            message: site,
            phase: "check",
            cancelling: false,
          });
          try {
            const r = await api.favoritesDownloadAll(id);
            enqTotal += r.enqueued;
            setNewCounts((prev) => new Map(prev).set(r.favorite.id, 0));
            setCheckedAt((prev) => new Map(prev).set(r.favorite.id, Date.now()));
          } catch (e) {
            log(String(e), "err");
          }
        }
        log(
          cancelled
            ? `Descarga cancelada · ${enqTotal} capítulos encolados`
            : `Encolados ${enqTotal} capítulos`,
          cancelled ? "" : "ok",
        );
        await refreshFavorites();
      } finally {
        setAppJob(null);
        clearAppJobCancel();
      }
    },
    [
      favScanning,
      catalogJob,
      favorites,
      log,
      ensureOutputDir,
      refreshFavorites,
      setAppJob,
      isAppJobCancelRequested,
      clearAppJobCancel,
    ],
  );

  const openFavCtx = useCallback((ev: ReactMouseEvent, id: number) => {
    ev.preventDefault();
    ev.stopPropagation();
    let ids: number[];
    if (sel[id]) {
      ids = Object.keys(sel)
        .filter((k) => sel[Number(k)])
        .map(Number);
    } else {
      ids = [id];
      setSel({ [id]: true });
    }
    const pad = 8;
    const menuW = 220;
    const menuH = 420;
    const x = Math.min(ev.clientX, window.innerWidth - menuW - pad);
    const y = Math.min(ev.clientY, window.innerHeight - menuH - pad);
    setFavCtxMenu({ x: Math.max(pad, x), y: Math.max(pad, y), ids });
  }, [sel]);

  useEffect(() => {
    if (!favCtxMenu) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setFavCtxMenu(null);
    };
    const onScroll = () => setFavCtxMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [favCtxMenu]);

  const ctxFavs = useMemo(() => {
    if (!favCtxMenu) return [] as Favorite[];
    return favCtxMenu.ids
      .map((id) => favorites.find((f) => f.id === id))
      .filter((f): f is Favorite => !!f);
  }, [favCtxMenu, favorites]);

  const ctxSingle = ctxFavs.length === 1 ? ctxFavs[0] : null;
  const ctxPendingSum = ctxFavs.reduce((a, f) => a + favNewOf(f.id), 0);
  const ctxAllDisabled = ctxFavs.length > 0 && ctxFavs.every((f) => !favIsEnabled(f.id));
  const ctxEnableLabel = ctxAllDisabled ? "Habilitar" : "Deshabilitar";
  const ctxCanStop = favScanning && !!catalogJob;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = favorites.filter((it) => {
      const site = it.module_name || it.module_id;
      if (
        q &&
        !(it.title + " " + site + " " + (it.last_chapter_name || "")).toLowerCase().includes(q)
      ) {
        return false;
      }
      if (filter === "Habilitado" && !favIsEnabled(it.id)) return false;
      if (filter === "Deshabilitado" && favIsEnabled(it.id)) return false;
      if (cat === "all") return true;
      if (cat === "new") return favNewOf(it.id) > 0;
      if (cat === "upto") return favNewOf(it.id) === 0 && favIsEnabled(it.id);
      if (cat === "stale") {
        const checkedMs = checkedAt.get(it.id) ?? (Date.parse(it.last_checked_at || "") || 0);
        return favAgeHours(it.last_checked_at, checkedMs) > 168;
      }
      if (cat === "off") return !favIsEnabled(it.id);
      if (cat.startsWith("site:")) return site === cat.slice(5);
      return true;
    });

    const val = (it: Favorite): string | number => {
      if (sortKey === "title") return it.title.toLowerCase();
      if (sortKey === "cur") return it.chapter_count || 0;
      if (sortKey === "status") {
        if (!favIsEnabled(it.id)) return 2;
        return favNewOf(it.id) > 0 ? 0 : 1;
      }
      if (sortKey === "added") return Date.parse(it.date_added || it.updated_at) || 0;
      if (sortKey === "checked")
        return checkedAt.get(it.id) ?? (Date.parse(it.last_checked_at || it.updated_at) || 0);
      return favNewOf(it.id);
    };
    arr = [...arr].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va > vb) return sortDir;
      if (va < vb) return -sortDir;
      return a.title.localeCompare(b.title);
    });
    return arr;
  }, [favorites, query, filter, cat, sortKey, sortDir, favIsEnabled, favNewOf, checkedAt]);

  const treeEntries = useMemo(() => {
    const countBy = (fn: (i: Favorite) => boolean) => favorites.filter(fn).length;
    const sites = [...new Set(favorites.map((i) => i.module_name || i.module_id))].sort((a, b) =>
      a.localeCompare(b),
    );
    type TreeEntry = {
      id: string;
      label: string;
      count: number;
      group?: boolean;
      color?: string;
      icon?: string;
    };
    const entries: TreeEntry[] = [
      { id: "all", label: "Todos los favoritos", count: favorites.length, group: true, icon: ICO.heart },
      { id: "new", label: "Con capítulos nuevos", count: countBy((i) => favNewOf(i.id) > 0), color: "var(--accent)" },
      {
        id: "upto",
        label: "Al día",
        count: countBy((i) => favNewOf(i.id) === 0 && favIsEnabled(i.id)),
        color: "var(--ok)",
      },
      {
        id: "stale",
        label: "Sin revisar (7 d+)",
        count: countBy((i) => {
          const checkedMs = checkedAt.get(i.id) ?? (Date.parse(i.last_checked_at || "") || 0);
          return favAgeHours(i.last_checked_at, checkedMs) > 168;
        }),
        color: "var(--warn)",
      },
      { id: "off", label: "Deshabilitados", count: countBy((i) => !favIsEnabled(i.id)), color: "var(--border-2)" },
      { id: "sites", label: "Sitios web", count: sites.length, group: true, icon: ICO.globe },
      ...sites.map((s) => ({
        id: `site:${s}`,
        label: s,
        count: countBy((i) => (i.module_name || i.module_id) === s),
      })),
    ];
    return entries;
  }, [favorites, favNewOf, favIsEnabled, checkedAt]);

  const stats = useMemo(() => {
    const newSum = favorites.reduce((a, i) => a + favNewOf(i.id), 0);
    const enabledN = favorites.filter((i) => favIsEnabled(i.id)).length;
    const disabledN = favorites.length - enabledN;
    let latestChecked = 0;
    for (const it of favorites) {
      const t = checkedAt.get(it.id) ?? (Date.parse(it.last_checked_at || "") || 0);
      if (t > latestChecked) latestChecked = t;
    }
    return { newSum, enabledN, disabledN, latestChecked };
  }, [favorites, favNewOf, favIsEnabled, checkedAt]);

  const selectedIds = useMemo(
    () =>
      Object.keys(sel)
        .filter((k) => sel[Number(k)])
        .map(Number),
    [sel],
  );
  const hasSel = selectedIds.length > 0;
  const selDisabled = !hasSel || checkBusy;

  const allOn = list.length > 0 && list.every((it) => sel[it.id]);
  const someOn = list.some((it) => sel[it.id]);
  const selectAllIco = someOn && !allOn ? ICO.dash : ICO.check;

  const toggleSel = (id: number) => {
    setSel((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  };

  const handleSelectAll = () => {
    setSel((prev) => {
      const next = { ...prev };
      if (allOn) {
        for (const it of list) delete next[it.id];
      } else {
        for (const it of list) next[it.id] = true;
      }
      return next;
    });
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "title" ? 1 : -1);
    }
  };

  const handleClearQuery = () => {
    setQuery("");
    queryInputRef.current?.focus();
  };

  const handleCheckAllTop = () => {
    const ids = hasSel ? selectedIds : favorites.filter((f) => favIsEnabled(f.id)).map((f) => f.id);
    void runFavChecks(ids, false);
  };

  const handleToggleSelected = () => {
    const ids = selectedIds;
    void (async () => {
      try {
        for (const id of ids) {
          const next = !favIsEnabled(id);
          await api.favoritesSetEnabled(id, next);
          setEnabledMap((prev) => new Map(prev).set(id, next));
        }
        await refreshFavorites();
      } catch (e) {
        log(String(e), "err");
      }
    })();
  };

  const handleImportList = () => {
    void (async () => {
      try {
        const picked = await open({
          multiple: false,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!picked || Array.isArray(picked)) {
          const json = window.prompt(
            "Pega el JSON de favoritos (sin capítulos, el primer check marca todos como nuevos):",
          );
          if (json == null || !json.trim()) return;
          const n = await api.favoritesImportList(json.trim());
          log(`Importados ${n} favoritos`, "ok");
        } else {
          const n = await api.favoritesImportFromPath(picked);
          log(`Importados ${n} favoritos`, "ok");
        }
        await refreshFavorites();
      } catch (e) {
        log(String(e), "err");
      }
    })();
  };

  const handleExportList = () => {
    void (async () => {
      try {
        const dest = await save({
          defaultPath: "favorites.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!dest) return;
        await api.favoritesExportToPath(dest);
        log("Lista de favoritos exportada", "ok");
      } catch (e) {
        log(String(e), "err");
      }
    })();
  };

  const handleDeleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const snapshots: FavoriteAddRequest[] = [];
    for (const id of ids) {
      const fav = favorites.find((f) => f.id === id);
      if (!fav) continue;
      snapshots.push(favoriteSnapshot(fav));
      await api.favoritesRemove(id);
      favoritesCacheRemove(id);
    }
    if (!snapshots.length) return;
    setSel((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    await refreshFavorites();
    const n = snapshots.length;
    appToastUndo({
      message: n === 1 ? "Se quitó de favoritos" : `Se quitaron ${n} favoritos`,
      durationMs: 6000,
      onUndo: async () => {
        try {
          for (const snapshot of snapshots) {
            const fav = await api.favoritesAdd(snapshot);
            favoritesCacheUpsert(fav);
          }
          await refreshFavorites();
          log(
            n === 1
              ? `Favorito restaurado: ${snapshots[0].title}`
              : `Restaurados ${n} favoritos`,
            "ok",
          );
        } catch (e) {
          log(String(e), "err");
        }
      },
    });
  };

  const handleQueueAll = () => {
    const ids = favorites.filter((f) => favNewOf(f.id) > 0 && favIsEnabled(f.id)).map((f) => f.id);
    if (!ids.length) {
      log("No hay capítulos nuevos para encolar", "ok");
      return;
    }
    void runFavEnqueuePending(ids);
  };

  const selLabel = hasSel
    ? `${selectedIds.length} ${selectedIds.length === 1 ? "obra seleccionada" : "obras seleccionadas"}`
    : `${list.length} ${list.length === 1 ? "obra" : "obras"}`;

  const newLabel = stats.newSum
    ? `${stats.newSum} ${stats.newSum === 1 ? "capítulo nuevo" : "capítulos nuevos"}`
    : "Todo al día";

  const lastScanLabel = favAutoChecking
    ? favAutoCheckSource === "inicio"
      ? "Revisando al iniciar…"
      : "Revisión periódica…"
    : stats.latestChecked
      ? `Última revisión hace ${favFmtAgo(undefined, stats.latestChecked)}`
      : "Última revisión —";
  return (
    <section id="view-favorites" className="view" hidden={activeNav !== "favorites"}>
      <div className="fav-shell">
        <header className="fav-header">
          <div>
            <div className="fav-eyebrow">Biblioteca seguida</div>
            <h1 className="fav-title">Favoritos</h1>
          </div>
          <div className="fav-header-actions">
            <div className="fav-stat-block">
              <div className="fav-stat-value mono">{stats.newSum}</div>
              <div className="fav-stat-label">Capítulos nuevos</div>
            </div>
            <div className="fav-header-sep" />
            <button
              type="button"
              className="fav-btn-p"
              disabled={checkBusy || !!catalogJob}
              onClick={handleCheckAllTop}
            >
              <Icon
                name="refresh"
                className="ico ico-sm"
                style={{ animation: checkBusy ? "spin 1s linear infinite" : "none" }}
              />
              <span>{checkBusy ? "Revisando…" : "Revisar capítulos nuevos"}</span>
            </button>
            <button
              type="button"
              className="fav-btn-ghost"
              title="Importar lista JSON"
              onClick={handleImportList}
            >
              <Icon name="import" className="ico ico-sm" />
              Importar
            </button>
            <button
              type="button"
              className="fav-btn-ghost"
              title="Exportar lista JSON"
              onClick={handleExportList}
            >
              <Icon name="download" className="ico ico-sm" />
              Exportar
            </button>
          </div>
        </header>

        <div className="fav-body">
          <aside
            className={`fav-tree${treeCollapsed ? " is-collapsed" : ""}`}
            aria-label="Filtros de favoritos"
          >
            <button
              type="button"
              className="fav-tree-notch"
              title={treeCollapsed ? "Mostrar filtros" : "Ocultar filtros"}
              aria-expanded={!treeCollapsed}
              onClick={() => setTreeCollapsed((v) => !v)}
            >
              <Icon
                ico={ICO.chevron}
                className={`ico ico-sm fav-tree-notch-ico${treeCollapsed ? " is-collapsed" : ""}`}
              />
            </button>
            <div className="fav-tree-body">
              {treeEntries.map((entry) => {
                const on = cat === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`fav-trow${on ? " on" : ""}`}
                    style={{ paddingLeft: entry.group ? "14px" : "34px" }}
                    onClick={() => setCat(entry.id)}
                  >
                    {entry.group ? (
                      <Icon ico={entry.icon} className="ico ico-sm" style={{ color: "var(--muted)" }} />
                    ) : (
                      <span className="fav-dot" style={{ background: entry.color || "var(--muted)" }} />
                    )}
                    <span
                      className="ell"
                      style={{
                        fontSize: "12.5px",
                        fontWeight: on ? 600 : entry.group ? 600 : 500,
                        color: on ? "var(--text)" : entry.group ? "var(--text)" : "var(--muted)",
                      }}
                    >
                      {entry.label}
                    </span>
                    <div className="fav-toolbar-spacer" />
                    <span className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                      {entry.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="fav-main">
            <div className="fav-toolbar">
              <div className="fav-search-wrap">
                <Icon name="search" className="ico ico-sm fav-search-ico" />
                <input
                  ref={queryInputRef}
                  className="st-field"
                  type="text"
                  placeholder="Buscar favoritos..."
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  type="button"
                  className="sites-clear"
                  hidden={!query.trim()}
                  title="Limpiar"
                  onClick={handleClearQuery}
                >
                  <Icon name="x" className="ico ico-sm" />
                </button>
              </div>
              <div className="fav-seg" role="group" aria-label="Filtro de estado">
                {(["Todo", "Habilitado", "Deshabilitado"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={filter === f ? "on" : ""}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="fav-toolbar-sep" />
              <div className="fav-sel-actions">
                <button
                  type="button"
                  className={`fav-tbtn${selDisabled ? " off" : ""}`}
                  disabled={selDisabled}
                  onClick={() => void runFavChecks(selectedIds, false)}
                >
                  <Icon name="refresh" className="ico ico-sm" />
                  Revisar
                </button>
                <button
                  type="button"
                  className={`fav-tbtn${selDisabled ? " off" : ""}`}
                  disabled={selDisabled}
                  onClick={() => void runFavEnqueuePending(selectedIds)}
                >
                  <Icon name="download" className="ico ico-sm" />
                  Descargar nuevos
                </button>
                <button
                  type="button"
                  className={`fav-tbtn${selDisabled ? " off" : ""}`}
                  disabled={selDisabled}
                  onClick={handleToggleSelected}
                >
                  <Icon name="power" className="ico ico-sm" />
                  Habilitar / deshabilitar
                </button>
                <button
                  type="button"
                  className={`fav-tbtn${selDisabled ? " off" : ""}`}
                  disabled={selDisabled}
                  onClick={() => void handleDeleteSelected()}
                >
                  <Icon name="trash" className="ico ico-sm" />
                  Quitar
                </button>
              </div>
              <div className="fav-toolbar-spacer" />
              <span className="fav-sel-label">{selLabel}</span>
            </div>

            <div className="fav-scroll">
              <div className="fav-grid fav-head">
                <button
                  type="button"
                  className={`sites-cb${allOn ? " on" : ""}${someOn && !allOn ? " some" : ""}`}
                  style={{ ["--ico" as string]: selectAllIco }}
                  aria-label="Seleccionar todo"
                  onClick={handleSelectAll}
                >
                  <span className="sites-cb-mk" />
                </button>
                {SORT_COLS.map((c) => {
                  const on = sortKey === c.key;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className={`fav-hc${on ? " on" : ""}`}
                      onClick={() => handleSort(c.key)}
                    >
                      {c.label}
                      <Icon
                        name="chevron"
                        className="ico fav-sort-ico"
                        style={{ opacity: on ? 1 : 0, transform: on && sortDir < 0 ? "rotate(180deg)" : "none" }}
                      />
                    </button>
                  );
                })}
                <div />
              </div>

              {list.length === 0 ? (
                <div className="fav-empty">
                  <Icon
                    name="heart"
                    className="ico"
                    style={{ width: "26px", height: "26px", color: "var(--muted)", opacity: 0.55 }}
                  />
                  <div className="fav-empty-title">
                    {query.trim() ? "Sin coincidencias" : "Nada por aquí"}
                  </div>
                  <div className="fav-empty-desc">
                    {query.trim()
                      ? `Ningún favorito coincide con “${query.trim()}”.`
                      : "Esta vista no tiene favoritos en este momento."}
                  </div>
                </div>
              ) : (
                <div id="fav-rows">
                  {list.map((it, idx) => {
                    const n = favNewOf(it.id);
                    const on = !!sel[it.id];
                    const enabled = favIsEnabled(it.id);
                    const st = !enabled
                      ? { label: "Deshabilitado", color: "var(--muted)", bg: "var(--nest)" }
                      : n
                        ? { label: "Nuevo", color: "var(--warn)", bg: "var(--warn-bg)" }
                        : { label: "Al día", color: "var(--ok)", bg: "var(--ok-bg)" };
                    const current = it.last_chapter_name || "—";
                    const latest =
                      it.id === scanningFavId
                        ? "revisando…"
                        : n
                          ? `+${n} nuevos`
                          : "sin novedades";
                    const checkedMs = checkedAt.get(it.id);
                    return (
                      <div
                        key={it.id}
                        className={`fav-grid fav-row${on ? " sel" : ""}`}
                        style={{ height: "46px" }}
                        onClick={() => toggleSel(it.id)}
                        onContextMenu={(ev) => openFavCtx(ev, it.id)}
                      >
                        <button
                          type="button"
                          className={`sites-cb${on ? " on" : ""}`}
                          style={{ ["--ico" as string]: ICO.check }}
                          aria-label="Seleccionar"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSel(it.id);
                          }}
                        >
                          <span className="sites-cb-mk" />
                        </button>
                        <span className="mono fav-num">{idx + 1}</span>
                        <div className="fav-cell-title">
                          <div className="fav-title-stack">
                            <button
                              type="button"
                              className="ell fav-manga fav-manga-link"
                              style={{ color: enabled ? "var(--text)" : "var(--muted)" }}
                              title="Abrir en Explorar"
                              onClick={(e) => {
                                e.stopPropagation();
                                openFavoriteInInfo(it);
                              }}
                            >
                              {it.title}
                            </button>
                            <span className="ell fav-sub">
                              {it.module_name || it.module_id}
                              {it.status ? ` · ${seriesStatusLabel(it.status)}` : ""}
                              {!modules.some((m) => m.id === it.module_id)
                                ? " · módulo ausente"
                                : ""}
                            </span>
                          </div>
                          {n ? <span className="fav-badge mono fav-new-badge">+{n}</span> : null}
                        </div>
                        <div className="fav-cell-ch">
                          <span className="ell mono fav-cur">{current}</span>
                          <span
                            className="ell mono fav-latest"
                            style={{ color: n ? "var(--warn)" : "var(--muted)" }}
                          >
                            {latest}
                          </span>
                        </div>
                        <span className="fav-badge" style={{ color: st.color, background: st.bg }}>
                          {st.label}
                        </span>
                        <span className="mono fav-added">{favFmtAgo(it.date_added || it.updated_at)}</span>
                        <span className="mono fav-checked">
                          {favFmtAgo(it.last_checked_at || it.updated_at, checkedMs)}
                        </span>
                        <div className="fav-act">
                          <button
                            type="button"
                            className={`fav-ibtn${n ? "" : " off"}`}
                            title="Descargar nuevos"
                            disabled={!n}
                            style={{ borderColor: "transparent", width: "24px", height: "24px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (n > 0) void runFavEnqueuePending([it.id]);
                            }}
                          >
                            <Icon name="download" className="ico ico-sm" />
                          </button>
                          <button
                            type="button"
                            className="fav-ibtn"
                            title="Quitar de favoritos"
                            style={{ borderColor: "transparent", width: "24px", height: "24px" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeFavorite(it.id);
                            }}
                          >
                            <Icon name="trash" className="ico ico-sm" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <footer className="fav-footer">
              <span className="fav-footer-stat">
                <span className="fav-dot" style={{ background: "var(--accent)" }} />
                <span>{newLabel}</span>
              </span>
              <span className="fav-footer-muted">
                {stats.enabledN} habilitados · {stats.disabledN} deshabilitados
              </span>
              <span className="fav-footer-muted">{lastScanLabel}</span>
              <div className="fav-toolbar-spacer" />
              <button type="button" className="lnk" onClick={handleQueueAll}>
                Encolar todos los nuevos
              </button>
            </footer>
          </div>
        </div>
      </div>

      {favCtxMenu ? (
        <div className="dl-ctx-layer">
          <div
            className="dl-ctx-backdrop"
            onClick={() => setFavCtxMenu(null)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setFavCtxMenu(null);
            }}
          />
          <div
            className="dl-ctx-menu"
            style={{ left: favCtxMenu.x, top: favCtxMenu.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={!ctxSingle}
              onClick={() => {
                const fav = ctxSingle;
                setFavCtxMenu(null);
                if (fav) openFavoriteInInfo(fav);
              }}
            >
              <Icon ico={ICO.info} className="ico ico-sm" />
              <span>Ver información</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={checkBusy || !favCtxMenu.ids.length}
              onClick={() => {
                const ids = favCtxMenu.ids;
                setFavCtxMenu(null);
                void runFavChecks(ids, false);
              }}
            >
              <Icon ico={ICO.refresh} className="ico ico-sm" />
              <span>Revisar capítulos nuevos</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={checkBusy || ctxPendingSum === 0}
              onClick={() => {
                const ids = favCtxMenu.ids;
                setFavCtxMenu(null);
                void runFavEnqueuePending(ids);
              }}
            >
              <Icon ico={ICO.download} className="ico ico-sm" />
              <span>Descargar nuevos</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={checkBusy || !favCtxMenu.ids.length}
              onClick={() => {
                const ids = favCtxMenu.ids;
                setFavCtxMenu(null);
                void runFavDownloadAll(ids);
              }}
            >
              <Icon ico={ICO.layers} className="ico ico-sm" />
              <span>Descargar todos</span>
            </button>
            {ctxCanStop ? (
              <button
                type="button"
                role="menuitem"
                className="dl-ctx-item"
                onClick={() => {
                  setFavCtxMenu(null);
                  void cancelCatalogJob();
                }}
              >
                <Icon ico={ICO.x} className="ico ico-sm" />
                <span>Detener revisión</span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item is-sep"
              disabled={!ctxFavs.length || checkBusy}
              onClick={() => {
                const ids = favCtxMenu.ids;
                const next = ctxAllDisabled;
                setFavCtxMenu(null);
                void (async () => {
                  try {
                    for (const id of ids) {
                      await api.favoritesSetEnabled(id, next);
                      setEnabledMap((prev) => new Map(prev).set(id, next));
                    }
                    await refreshFavorites();
                  } catch (e) {
                    log(String(e), "err");
                  }
                })();
              }}
            >
              <Icon ico={ICO.power} className="ico ico-sm" />
              <span>{ctxEnableLabel}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item is-sep"
              disabled={!ctxSingle}
              onClick={() => {
                const fav = ctxSingle;
                setFavCtxMenu(null);
                if (!fav) return;
                const url = maybeFillHost(fav.root_url, fav.manga_url);
                void api.openExternal(url).catch((e) => log(String(e), "err"));
              }}
            >
              <Icon ico={ICO.external} className="ico ico-sm" />
              <span>Abrir en el navegador</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={!ctxSingle}
              onClick={() => {
                const fav = ctxSingle;
                setFavCtxMenu(null);
                if (!fav) return;
                const url = maybeFillHost(fav.root_url, fav.manga_url);
                void navigator.clipboard.writeText(url).then(
                  () => log("URL copiada", "ok"),
                  (e) => log(String(e), "err"),
                );
              }}
            >
              <Icon ico={ICO.link} className="ico ico-sm" />
              <span>Copiar URL</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={!ctxFavs.length}
              onClick={() => {
                const titles = ctxFavs.map((f) => f.title).join("\n");
                setFavCtxMenu(null);
                void navigator.clipboard.writeText(titles).then(
                  () => log(ctxFavs.length === 1 ? "Título copiado" : "Títulos copiados", "ok"),
                  (e) => log(String(e), "err"),
                );
              }}
            >
              <Icon ico={ICO.copy} className="ico ico-sm" />
              <span>Copiar título</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item is-sep is-danger"
              disabled={!ctxFavs.length || checkBusy}
              onClick={() => {
                setFavCtxMenu(null);
                void handleDeleteSelected();
              }}
            >
              <Icon ico={ICO.trash} className="ico ico-sm" />
              <span>Quitar de favoritos</span>
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
