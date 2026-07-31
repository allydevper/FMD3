import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Icon } from "../components/Icon";
import { appToast, appToastUndo } from "../components/AppToast";
import { ICO } from "../icons";
import { DL_HIST, DL_ST, SK } from "../constants";
import * as api from "../api/tauri";
import { useApp } from "../context/AppContext";
import { confirmIfEnabled, settingBool, settingNumber } from "../utils/settings";
import { catalogLinkKey, mangaPathKey } from "../utils/url";
import type {
  ChapterInfo,
  LiveProgress,
  ModuleMeta,
  QueueAddRequest,
  QueueItem,
} from "../types";

type SortKey = "queue" | "title" | "status" | "pct" | "speed" | "site" | "path" | "added";

const STATUS_NODES: { id: string; label: string; color: string }[] = [
  { id: "done", label: "Completado", color: "var(--ok)" },
  { id: "active", label: "En progreso", color: "var(--accent)" },
  { id: "queued", label: "En cola", color: "var(--muted)" },
  { id: "paused", label: "Detenido", color: "var(--warn)" },
  { id: "failed", label: "Falló", color: "var(--bad)" },
];

const SORT_COLUMNS: { key: SortKey; label: string; style?: CSSProperties }[] = [
  { key: "title", label: "Grupo · obra" },
  { key: "status", label: "Estado" },
  { key: "pct", label: "Progreso del grupo" },
  { key: "speed", label: "Ratio", style: { justifyContent: "flex-end" } },
  { key: "site", label: "Sitio · agregado" },
];

function dlStatusMeta(status: string) {
  return (
    DL_ST[status] || {
      id: status,
      label: status,
      color: "var(--muted)",
      bg: "transparent",
      bar: "var(--muted)",
    }
  );
}

function dlSiteName(item: QueueItem, modules: ModuleMeta[]): string {
  const mod = modules.find((m) => m.id === item.module_id);
  if (mod?.name) return mod.name;
  try {
    return new URL(item.root_url).hostname.replace(/^www\./, "") || item.module_id;
  } catch {
    return item.module_id || "—";
  }
}

function dlItemAgeHours(item: QueueItem): number {
  const t = Date.parse(item.created_at || item.updated_at);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 3600000);
}

function dlBucketId(item: QueueItem): string {
  const h = dlItemAgeHours(item);
  return (DL_HIST.find((b) => h < b.maxH) || DL_HIST[DL_HIST.length - 1]).id;
}

function dlFmtAdded(item: QueueItem): string {
  const h = dlItemAgeHours(item);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.round(h)} h`;
  if (h < 24 * 30) return `${Math.round(h / 24)} d`;
  if (h < 24 * 365) return `${Math.round(h / 730)} mes`;
  return `${(h / 8760).toFixed(1)} a`;
}

function dlContentFormatLabel(fmt: string | undefined | null): string | null {
  if (!fmt) return null;
  switch (fmt.toLowerCase()) {
    case "pdf":
      return "PDF";
    case "cbz":
      return "CBZ";
    case "zip":
      return "ZIP";
    case "epub":
      return "EPUB";
    case "folder":
    case "none":
      return "carpeta";
    default:
      return fmt.toUpperCase();
  }
}

function formatBytesPerSec(bps: number | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return "";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

function dlItemPct(
  item: QueueItem,
  liveProgress: Map<number, LiveProgress>,
): { pct: number; pages: string; label: string } {
  if (item.status === "done") return { pct: 100, pages: "", label: "100%" };
  const live = liveProgress.get(item.id);
  if (live?.phase === "processing") {
    // La descarga sí terminó, así que la barra se queda al 100% y no retrocede;
    // el conteo de páginas empaquetadas es lo que muestra que sigue avanzando.
    const done = Math.min(live.page_current, live.page_total);
    const packing = live.page_total > 0 && done < live.page_total;
    return {
      pct: 100,
      pages: live.page_total > 0 ? `${done}/${live.page_total} pág` : "",
      // El badge es estrecho: aquí solo la palabra, el conteo va en `pages`.
      label: packing ? "Empaquetando" : "Procesando",
    };
  }
  if (live && live.page_total > 0) {
    const pct = Math.min(100, Math.round((live.page_current / live.page_total) * 100));
    return {
      pct,
      pages: `${live.page_current}/${live.page_total} pág`,
      label: `${pct}%`,
    };
  }
  if (item.status === "running") return { pct: 8, pages: "", label: "…" };
  return { pct: 0, pages: "", label: "—" };
}

function mangaGroupKey(it: QueueItem): string {
  const batch = (it.batch_id || "").trim();
  if (batch) return `batch:${batch}`;
  const url = (it.manga_url || "").trim();
  // Stabilize absolute vs relative / trailing-slash variants so sequential
  // single-chapter downloads of the same work merge into one group.
  const normalized =
    (url && (catalogLinkKey(url) || mangaPathKey(url))) || url || it.manga_title;
  return `${it.module_id}|${normalized}`;
}

/** Parse `…-kofN` suffix from split batch ids. */
function batchTaskLabel(batchId: string): string | null {
  const m = /-(\d+)of(\d+)$/.exec(batchId.trim());
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

type MangaGroup = {
  key: string;
  title: string;
  /** Split-batch label e.g. "1/2", shown as tag after chapter count. */
  taskLabel: string | null;
  moduleId: string;
  mangaUrl: string;
  rootUrl: string;
  outputDir: string;
  site: string;
  items: QueueItem[];
  oldest: QueueItem;
};

function orderedQueueItems(items: QueueItem[], order: number[]): QueueItem[] {
  const map = new Map(items.map((i) => [i.id, i]));
  const out: QueueItem[] = [];
  for (const id of order) {
    const it = map.get(id);
    if (it) out.push(it);
  }
  for (const it of items) {
    if (!out.includes(it)) out.push(it);
  }
  return out;
}

function groupByManga(list: QueueItem[], modules: ModuleMeta[]): MangaGroup[] {
  const map = new Map<string, MangaGroup>();
  const keys: string[] = [];
  for (const it of list) {
    const key = mangaGroupKey(it);
    let g = map.get(key);
    if (!g) {
      const batch = (it.batch_id || "").trim();
      g = {
        key,
        title: it.manga_title,
        taskLabel: batch ? batchTaskLabel(batch) : null,
        moduleId: it.module_id,
        mangaUrl: (it.manga_url || "").trim(),
        rootUrl: it.root_url,
        outputDir: it.output_dir,
        site: dlSiteName(it, modules),
        items: [],
        oldest: it,
      };
      map.set(key, g);
      keys.push(key);
    }
    g.items.push(it);
    const tNew = Date.parse(it.created_at || it.updated_at);
    const tOld = Date.parse(g.oldest.created_at || g.oldest.updated_at);
    if (Number.isFinite(tNew) && (!Number.isFinite(tOld) || tNew < tOld)) {
      g.oldest = it;
    }
  }
  return keys.map((k) => map.get(k)!);
}

type GroupAgg = {
  status: string;
  st: ReturnType<typeof dlStatusMeta>;
  /** Etiqueta a mostrar: `st.label`, o "Empaquetando" si todo lo activo lo está. */
  stLabel: string;
  done: number;
  active: number;
  queued: number;
  paused: number;
  failed: number;
  /** Subconjunto de `active` que ya terminó de bajar y está empaquetando. */
  processing: number;
  pct: number;
  wDone: number;
  wActive: number;
  speed: number;
  summary: string;
};

function aggregateGroup(
  g: MangaGroup,
  liveProgress: Map<number, LiveProgress>,
): GroupAgg {
  const cs = g.items;
  let done = 0;
  let active = 0;
  let queued = 0;
  let paused = 0;
  let failed = 0;
  let processing = 0;
  let pctSum = 0;
  let speed = 0;
  for (const it of cs) {
    const p = dlItemPct(it, liveProgress);
    pctSum += p.pct;
    if (it.status === "done") done++;
    else if (it.status === "running") {
      active++;
      if (liveProgress.get(it.id)?.phase === "processing") processing++;
      speed += liveProgress.get(it.id)?.bytes_per_sec ?? 0;
    } else if (it.status === "pending") queued++;
    else if (it.status === "cancelled") paused++;
    else if (it.status === "failed") failed++;
  }
  const n = cs.length || 1;
  const pct = pctSum / n;
  const wDone = (done / n) * 100;
  const wActive = Math.max(0, pct - wDone);
  let status = "done";
  if (active > 0) status = "running";
  else if (failed > 0) status = "failed";
  else if (paused > 0) status = "cancelled";
  else if (queued > 0) status = "pending";
  const parts: string[] = [];
  if (done) parts.push(`${done} listos`);
  const downloading = active - processing;
  if (downloading)
    parts.push(downloading === 1 ? "1 descargando" : `${downloading} descargando`);
  if (processing) parts.push(`${processing} empaquetando`);
  if (queued) parts.push(`${queued} en cola`);
  if (paused) parts.push(`${paused} detenidos`);
  if (failed) parts.push(`${failed} con error`);
  const st = dlStatusMeta(status);
  return {
    status,
    st,
    stLabel:
      active > 0 && processing === active ? "Empaquetando" : st.label,
    done,
    active,
    queued,
    paused,
    failed,
    processing,
    pct,
    wDone,
    wActive,
    speed,
    summary: parts.join(" · ") || `${cs.length} cap.`,
  };
}

function groupMatchesCat(g: MangaGroup, cat: string): boolean {
  if (cat === "all") return true;
  if (cat === "hist") return g.items.some((i) => i.status === "done");
  if (DL_HIST.some((b) => b.id === cat)) {
    return g.items.some((i) => i.status === "done" && dlBucketId(i) === cat);
  }
  return g.items.some((i) => dlStatusMeta(i.status).id === cat);
}

function filterAndSortGroups(
  items: QueueItem[],
  order: number[],
  query: string,
  cat: string,
  sortKey: SortKey,
  sortDir: 1 | -1,
  modules: ModuleMeta[],
  liveProgress: Map<number, LiveProgress>,
): MangaGroup[] {
  const ordered = orderedQueueItems(items, order);
  let groups = groupByManga(ordered, modules);
  const q = query.trim().toLowerCase();
  groups = groups.filter((g) => {
    if (
      q &&
      !(
        g.title +
        " " +
        g.site +
        " " +
        g.items.map((c) => c.chapter_name).join(" ")
      )
        .toLowerCase()
        .includes(q)
    ) {
      return false;
    }
    return groupMatchesCat(g, cat);
  });

  if (sortKey !== "queue") {
    const dir = sortDir;
    const val = (g: MangaGroup): string | number => {
      const a = aggregateGroup(g, liveProgress);
      if (sortKey === "title") return g.title.toLowerCase();
      if (sortKey === "status") return a.st.label;
      if (sortKey === "pct") return a.pct;
      if (sortKey === "speed") return a.speed;
      if (sortKey === "site") return g.site.toLowerCase();
      if (sortKey === "path") return (g.outputDir || "").toLowerCase();
      return Date.parse(g.oldest.created_at || g.oldest.updated_at) || 0;
    };
    groups = [...groups].sort((x, y) => {
      const vx = val(x);
      const vy = val(y);
      if (vx === vy) return 0;
      return (vx > vy ? 1 : -1) * dir;
    });
  }
  return groups;
}

function snapshotItemsForUndo(removed: QueueItem[]): {
  reqs: QueueAddRequest[];
  shouldStart: boolean;
  expectedChapters: number;
} {
  const byGroup = new Map<string, QueueItem[]>();
  for (const it of removed) {
    const key = mangaGroupKey(it);
    const arr = byGroup.get(key) || [];
    arr.push(it);
    byGroup.set(key, arr);
  }
  const reqs: QueueAddRequest[] = [];
  let shouldStart = false;
  let expectedChapters = 0;
  for (const arr of byGroup.values()) {
    const first = arr[0];
    const chapters: ChapterInfo[] = arr.map((it) => ({
      index: it.chapter_index,
      name: it.chapter_name,
      link: it.chapter_link,
      manga_path: (it.manga_path || "").trim() || undefined,
      chapter_path: (it.chapter_path || "").trim() || undefined,
    }));
    expectedChapters += chapters.length;
    if (arr.some((it) => it.status === "pending" || it.status === "running")) {
      shouldStart = true;
    }
    reqs.push({
      manga_title: first.manga_title,
      root_url: first.root_url,
      manga_url: first.manga_url,
      module_id: first.module_id,
      output_dir: first.output_dir,
      chapters,
      start: false,
      batch_id: (first.batch_id || "").trim() || undefined,
    });
  }
  return { reqs, shouldStart, expectedChapters };
}

export function DownloadsView() {
  const { activeNav, modules, log, setActiveNav, setPendingMangaOpen } = useApp();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [liveProgress, setLiveProgress] = useState<Map<number, LiveProgress>>(
    () => new Map(),
  );
  const [cat, setCat] = useState("all");
  const [query, setQuery] = useState("");
  const [selG, setSelG] = useState<Record<string, true>>({});
  const [selC, setSelC] = useState<Record<number, true>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [panelMin, setPanelMin] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("queue");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [order, setOrder] = useState<number[]>([]);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [parallelTasks, setParallelTasks] = useState(1);
  const [dlCtxMenu, setDlCtxMenu] = useState<{
    x: number;
    y: number;
    ids: number[];
  } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{
    items: QueueItem[];
    label: string;
  } | null>(null);
  const [removeDeleteFiles, setRemoveDeleteFiles] = useState(false);
  const [contentFmt, setContentFmt] = useState<Record<number, string>>({});
  const [packFmt, setPackFmt] = useState("none");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastProgressLogRef = useRef<{ itemId: number; message: string } | null>(null);

  async function refreshQueue() {
    try {
      const list = await api.queueList();
      setItems(list);
    } catch (e) {
      log(String(e), "err");
    }
  }

  useEffect(() => {
    void (async () => {
      // Reuse legacy key: true = panel visible (expanded).
      setLeftCollapsed(!(await settingBool(SK.UI_DL_LEFT_BAR, true)));
      setParallelTasks(await settingNumber(SK.PARALLEL_TASKS, 1));
      const pack = ((await api.settingsGet(SK.PACK)) ?? "none").trim().toLowerCase();
      setPackFmt(pack || "none");
    })();
  }, [activeNav]);

  function toggleLeftCollapsed() {
    setLeftCollapsed((c) => {
      const next = !c;
      void api.settingsSet(SK.UI_DL_LEFT_BAR, next ? "0" : "1");
      return next;
    });
  }

  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.has(id));
      const missing = items.filter((it) => !kept.includes(it.id)).map((it) => it.id);
      return kept.concat(missing);
    });
    setSelC((prev) => {
      let changed = false;
      const next: Record<number, true> = {};
      for (const k of Object.keys(prev)) {
        const id = Number(k);
        if (ids.has(id)) next[id] = true;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

  useEffect(() => {
    void refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeNav === "downloads") {
      void refreshQueue();
      void settingNumber(SK.PARALLEL_TASKS, 1).then(setParallelTasks);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav]);

  useEffect(() => {
    let unChanged: (() => void) | undefined;
    let unProgress: (() => void) | undefined;
    let cancelled = false;
    void api.onQueueChanged(() => {
      void refreshQueue();
    }).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      unChanged = u;
    });
    void api
      .onQueueProgress((p) => {
        setLiveProgress((prev) => {
          const next = new Map(prev);
          next.set(p.item_id, {
            page_current: p.page_current,
            page_total: p.page_total,
            message: p.message,
            chapter_name: p.chapter_name,
            phase: p.phase,
            bytes_per_sec: p.bytes_per_sec,
          });
          return next;
        });
        if (
          p.message.startsWith("Obteniendo") ||
          p.message.startsWith("Downloading") ||
          p.message.startsWith("Procesando") ||
          p.message.startsWith("Empaquetando") ||
          p.message.startsWith("Completed") ||
          p.message.startsWith("[")
        ) {
          const m = /^\[(\d+)\/(\d+)\]/.exec(p.message);
          if (m) {
            const cur = Number(m[1]);
            const tot = Number(m[2]);
            if (cur !== 0 && cur !== tot && cur % 5 !== 0) return;
          }
          const prev = lastProgressLogRef.current;
          if (prev && prev.itemId === p.item_id && prev.message === p.message) {
            return;
          }
          lastProgressLogRef.current = { itemId: p.item_id, message: p.message };
          log(p.message);
        }
      })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unProgress = u;
      });
    return () => {
      cancelled = true;
      unChanged?.();
      unProgress?.();
      unChanged = undefined;
      unProgress = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dlCtxMenu) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setDlCtxMenu(null);
    };
    const onScroll = () => setDlCtxMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [dlCtxMenu]);

  const allGroups = useMemo(
    () => groupByManga(orderedQueueItems(items, order), modules),
    [items, order, modules],
  );

  const groups = useMemo(
    () =>
      filterAndSortGroups(
        items,
        order,
        query,
        cat,
        sortKey,
        sortDir,
        modules,
        liveProgress,
      ),
    [items, order, query, cat, sortKey, sortDir, modules, liveProgress],
  );

  useEffect(() => {
    const keys = new Set(allGroups.map((g) => g.key));
    setSelG((prev) => {
      let changed = false;
      const next: Record<string, true> = {};
      for (const k of Object.keys(prev)) {
        if (keys.has(k)) next[k] = true;
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (focusKey && !keys.has(focusKey)) setFocusKey(null);
  }, [allGroups, focusKey]);

  const focusGroup = focusKey
    ? allGroups.find((g) => g.key === focusKey) || null
    : null;

  const focusFmtKey = focusGroup
    ? focusGroup.items.map((i) => `${i.id}:${i.status}`).join("|")
    : "";

  useEffect(() => {
    if (!focusGroup) {
      setContentFmt({});
      return;
    }
    const ids = focusGroup.items.map((i) => i.id);
    let cancelled = false;
    void api.queueItemsContentFormat(ids).then((rows) => {
      if (cancelled) return;
      const next: Record<number, string> = {};
      for (const row of rows) next[row.id] = row.format;
      setContentFmt(next);
    });
    return () => {
      cancelled = true;
    };
    // focusFmtKey tracks status changes so we re-probe when chapters finish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusFmtKey]);

  function chapterFormatLabel(c: QueueItem): string | null {
    const detected = dlContentFormatLabel(contentFmt[c.id]);
    if (detected) return detected;
    if (c.status === "done") return null;
    return dlContentFormatLabel(packFmt === "none" ? "folder" : packFmt);
  }

  function chapterIdsOfGroups(keys: string[]): number[] {
    return allGroups
      .filter((g) => keys.includes(g.key))
      .flatMap((g) => g.items.map((i) => i.id));
  }

  function selectedGroupKeys(): string[] {
    return Object.keys(selG).filter((k) => selG[k]);
  }

  function dlMoveSelected(dir: -1 | 1, edge: boolean) {
    const keys = selectedGroupKeys();
    if (!keys.length) return;
    const ids = chapterIdsOfGroups(keys);
    if (!ids.length) return;
    setOrder((prev) => {
      const ord = [...prev];
      let next: number[];
      if (edge) {
        const picked = ord.filter((id) => ids.includes(id));
        const rest = ord.filter((id) => !ids.includes(id));
        next = dir < 0 ? picked.concat(rest) : rest.concat(picked);
      } else {
        const idxs = dir < 0 ? [...ord.keys()] : [...ord.keys()].reverse();
        for (const i of idxs) {
          const j = i + dir;
          if (j < 0 || j >= ord.length) continue;
          if (ids.includes(ord[i]) && !ids.includes(ord[j])) {
            const t = ord[i];
            ord[i] = ord[j];
            ord[j] = t;
          }
        }
        next = ord;
      }
      void api.queueReorder(next).catch((e) => log(String(e), "err"));
      return next;
    });
    setSortKey("queue");
  }

  function toggleSelG(key: string) {
    setSelG((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function toggleSelectAllGroups() {
    const allSelected = groups.length > 0 && groups.every((g) => selG[g.key]);
    setSelG((prev) => {
      const next = { ...prev };
      if (allSelected) {
        for (const g of groups) delete next[g.key];
      } else {
        for (const g of groups) next[g.key] = true;
      }
      return next;
    });
  }

  function toggleSelC(id: number) {
    setSelC((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "added" ? -1 : 1);
    }
  }

  async function resumeIds(ids: number[]) {
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (it && (it.status === "cancelled" || it.status === "failed")) {
        await api.queueRetry(id);
      }
    }
    await api.queueStart();
    await refreshQueue();
  }

  async function pauseIds(ids: number[]) {
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (it && (it.status === "running" || it.status === "pending")) {
        await api.queueCancel(id);
      }
    }
    await refreshQueue();
  }

  async function retryFailedIds(ids: number[]) {
    let n = 0;
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (it?.status === "failed") {
        await api.queueRetry(id);
        n++;
      }
    }
    if (n) await api.queueStart();
    await refreshQueue();
  }

  async function removeItemsWithUndo(
    toRemove: QueueItem[],
    label: string,
    deleteFiles: boolean,
  ) {
    for (const it of toRemove) {
      if (it.status === "running") await api.queueCancel(it.id);
    }
    const { reqs: snapshots, shouldStart, expectedChapters } =
      snapshotItemsForUndo(toRemove);
    for (const it of toRemove) {
      if (deleteFiles) {
        try {
          await api.queueDeleteChapterFiles(it.id, dlSiteName(it, modules));
        } catch (e) {
          log(String(e), "err");
        }
      }
      try {
        await api.queueRemove(it.id);
      } catch {
        /* running may still block; ignore */
      }
    }
    await refreshQueue();
    if (!snapshots.length) return;
    if (deleteFiles) {
      appToast({
        message: `${label}`,
        kind: "ok",
        durationMs: 4000,
      });
      return;
    }
    appToastUndo({
      message: label,
      durationMs: 6000,
      onUndo: async () => {
        try {
          let inserted = 0;
          for (const req of snapshots) {
            inserted += await api.queueAdd({
              ...req,
              start: false,
            });
          }
          if (shouldStart) {
            await api.queueStart();
          }
          setCat("all");
          await refreshQueue();
          if (inserted < expectedChapters) {
            log(
              `Restaurados ${inserted}/${expectedChapters} (algunos ya estaban en cola)`,
              inserted ? "ok" : "err",
            );
          } else {
            log("Elementos restaurados en la cola", "ok");
          }
        } catch (e) {
          log(String(e), "err");
        }
      },
    });
  }

  function askRemoveItems(toRemove: QueueItem[], label: string) {
    if (!toRemove.length) return;
    setRemoveDeleteFiles(false);
    setRemoveConfirm({ items: toRemove, label });
  }

  async function handleOpenFolder(itemId: number, preferChapter = false) {
    try {
      await api.queueOpenItemFolder(itemId, preferChapter);
    } catch (e) {
      log(String(e), "err");
    }
  }

  async function handleOpenContent(itemId: number) {
    try {
      await api.queueOpenItemContent(itemId);
    } catch (e) {
      log(String(e), "err");
    }
  }

  function openCtx(ev: ReactMouseEvent, ids: number[]) {
    ev.preventDefault();
    ev.stopPropagation();
    const pad = 8;
    const menuW = 220;
    const menuH = 180;
    const x = Math.min(ev.clientX, window.innerWidth - menuW - pad);
    const y = Math.min(ev.clientY, window.innerHeight - menuH - pad);
    setDlCtxMenu({ x: Math.max(pad, x), y: Math.max(pad, y), ids });
  }

  async function handleResumeAll() {
    await resumeIds(items.map((i) => i.id));
    log("Cola reanudada", "ok");
  }

  async function handleStopAll() {
    await pauseIds(items.map((i) => i.id));
  }

  async function handleClearDone() {
    const ok = await confirmIfEnabled(
      SK.CONFIRM_EMPTY_LIST,
      "¿Eliminar todos los elementos terminados de la cola?",
    );
    if (!ok) return;
    const n = await api.queueClearFinished();
    log(`Eliminados ${n} terminados`, "ok");
    await refreshQueue();
  }

  function handleAddMore(g: MangaGroup) {
    const url = (g.mangaUrl || g.rootUrl || "").trim();
    if (!url) {
      log("Este grupo no tiene URL de manga para abrir en Información.", "err");
      return;
    }
    setPendingMangaOpen({ mangaUrl: url, moduleId: g.moduleId });
    setActiveNav("info");
  }

  const activeN = items.filter((i) => i.status === "running").length;
  const queuedN = items.filter((i) => i.status === "pending").length;
  const doneN = items.filter((i) => i.status === "done").length;
  const clearableN = items.filter((i) => i.status === "done").length;
  const canResumeAll = items.some(
    (i) => i.status === "cancelled" || i.status === "failed",
  );
  const canStopAll = items.some(
    (i) => i.status === "running" || i.status === "pending",
  );
  const totalBps = items
    .filter((i) => i.status === "running")
    .reduce((sum, i) => sum + (liveProgress.get(i.id)?.bytes_per_sec ?? 0), 0);
  const transferLabel = activeN ? formatBytesPerSec(totalBps) || "…" : "0 KB/s";

  const selKeys = selectedGroupKeys();
  const hasSel = selKeys.length > 0;
  const selChapterIds = chapterIdsOfGroups(selKeys);
  const selItems = selChapterIds
    .map((id) => items.find((x) => x.id === id))
    .filter((x): x is QueueItem => !!x);
  const canResumeSel = selItems.some(
    (i) => i.status === "cancelled" || i.status === "failed",
  );
  const canStopSel = selItems.some(
    (i) => i.status === "running" || i.status === "pending",
  );
  const canDeleteSel = selItems.some((i) => i.status !== "running");
  const canRetrySel = selItems.some((i) => i.status === "failed");
  const canFolderSel = selItems.some((i) => !!(i.output_dir || "").trim());
  const allOn = groups.length > 0 && groups.every((g) => selG[g.key]);
  const someOn = groups.some((g) => selG[g.key]);
  const count = (f: (i: QueueItem) => boolean) => items.filter(f).length;
  const countGroupsMatching = (pred: (g: MangaGroup) => boolean) =>
    allGroups.filter(pred).length;

  const ctxItems = dlCtxMenu
    ? dlCtxMenu.ids
        .map((id) => items.find((x) => x.id === id))
        .filter((x): x is QueueItem => !!x)
    : [];
  const ctxCanResume = ctxItems.some(
    (i) => i.status === "cancelled" || i.status === "failed",
  );
  const ctxCanStop = ctxItems.some(
    (i) => i.status === "running" || i.status === "pending",
  );
  const ctxCanDelete = ctxItems.some((i) => i.status !== "running");
  const ctxOpenTarget = ctxItems[0];

  const selLabel = hasSel
    ? `${selKeys.length} ${selKeys.length === 1 ? "grupo" : "grupos"} · ${selChapterIds.length} cap.`
    : `${groups.length} ${groups.length === 1 ? "grupo" : "grupos"} · ${groups.reduce((a, g) => a + g.items.length, 0)} capítulos`;

  const focusAgg = focusGroup
    ? aggregateGroup(focusGroup, liveProgress)
    : null;
  const fSelIds = focusGroup
    ? focusGroup.items.filter((c) => selC[c.id]).map((c) => c.id)
    : [];
  const fAll =
    !!focusGroup &&
    focusGroup.items.length > 0 &&
    focusGroup.items.every((c) => selC[c.id]);
  const fSome = !!focusGroup && focusGroup.items.some((c) => selC[c.id]);
  const fRunning = (focusAgg?.active ?? 0) > 0;
  const fCanResume =
    !!focusGroup &&
    focusGroup.items.some(
      (i) => i.status === "cancelled" || i.status === "failed" || i.status === "pending",
    );
  const concurrencyLabel = `${Math.min(activeN || 0, parallelTasks)}/${parallelTasks} tareas en paralelo`;

  return (
    <section id="view-downloads" className="view" hidden={activeNav !== "downloads"}>
      <div className="dl-shell">
        <header className="dl-header">
          <div>
            <div className="dl-eyebrow">Cola de trabajo</div>
            <h1 className="dl-title">Descargas</h1>
          </div>
          <div className="dl-header-actions">
            <div className="dl-speed-block">
              <div className="dl-speed-value mono">{transferLabel}</div>
              <div className="dl-speed-label">Transferencia</div>
            </div>
            <div className="dl-header-sep" />
            <button
              type="button"
              className="dl-btn-p"
              disabled={!canResumeAll}
              onClick={() => void handleResumeAll()}
            >
              <Icon ico={ICO.play} className="ico ico-sm" />
              Reanudar todo
            </button>
            <button
              type="button"
              className="dl-btn-ghost"
              disabled={!canStopAll}
              onClick={() => void handleStopAll()}
            >
              <Icon ico={ICO.pause} className="ico ico-sm" />
              Detener todo
            </button>
          </div>
        </header>

        <div className="dl-body">
          <aside
            className={`dl-tree${leftCollapsed ? " is-collapsed" : ""}`}
            aria-label="Filtros de descargas"
          >
            <button
              type="button"
              className="dl-tree-notch"
              title={leftCollapsed ? "Mostrar filtros" : "Ocultar filtros"}
              aria-expanded={!leftCollapsed}
              onClick={toggleLeftCollapsed}
            >
              <Icon
                ico={ICO.chevron}
                className={`ico ico-sm dl-tree-notch-ico${leftCollapsed ? " is-collapsed" : ""}`}
              />
            </button>
            <div className="dl-tree-body">
            <button
              type="button"
              className={`dl-trow${cat === "all" ? " on" : ""}`}
              style={{ paddingLeft: "14px" }}
              onClick={() => setCat("all")}
            >
              <Icon ico={ICO.download} className="ico ico-sm" style={{ color: "var(--muted)" }} />
              <span
                className="ell"
                style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text)" }}
              >
                Todas las descargas
              </span>
              <div className="dl-toolbar-spacer" />
              <span className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                {allGroups.length}
              </span>
            </button>
            {STATUS_NODES.map((s) => {
              const on = cat === s.id;
              const n = countGroupsMatching((g) =>
                g.items.some((i) => dlStatusMeta(i.status).id === s.id),
              );
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`dl-trow${on ? " on" : ""}`}
                  style={{ paddingLeft: "34px" }}
                  onClick={() => setCat(s.id)}
                >
                  <span className="dl-dot" style={{ background: s.color }} />
                  <span
                    className="ell"
                    style={{
                      fontSize: "12.5px",
                      fontWeight: on ? 600 : 500,
                      color: on ? "var(--text)" : "var(--muted)",
                    }}
                  >
                    {s.label}
                  </span>
                  <div className="dl-toolbar-spacer" />
                  <span className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                    {n}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={`dl-trow${cat === "hist" ? " on" : ""}`}
              style={{ paddingLeft: "14px" }}
              onClick={() => setCat("hist")}
            >
              <Icon ico={ICO.clock} className="ico ico-sm" style={{ color: "var(--muted)" }} />
              <span
                className="ell"
                style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text)" }}
              >
                Historial
              </span>
              <div className="dl-toolbar-spacer" />
              <span className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                {count((i) => i.status === "done")}
              </span>
            </button>
            {DL_HIST.map((b) => {
              const on = cat === b.id;
              const n = count((i) => i.status === "done" && dlBucketId(i) === b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`dl-trow${on ? " on" : ""}`}
                  style={{ paddingLeft: "34px" }}
                  onClick={() => setCat(b.id)}
                >
                  <span className="dl-dot" style={{ background: "var(--muted)" }} />
                  <span
                    className="ell"
                    style={{
                      fontSize: "12.5px",
                      fontWeight: on ? 600 : 500,
                      color: on ? "var(--text)" : "var(--muted)",
                    }}
                  >
                    {b.label}
                  </span>
                  <div className="dl-toolbar-spacer" />
                  <span className="mono" style={{ fontSize: "11px", color: "var(--muted)" }}>
                    {n}
                  </span>
                </button>
              );
            })}
            </div>
          </aside>

          <div className="dl-main">
            <div className="dl-toolbar">
              <div className="dl-search-wrap">
                <Icon ico={ICO.search} className="ico ico-sm dl-search-ico" />
                <input
                  ref={searchInputRef}
                  className="st-field"
                  type="text"
                  placeholder="Buscar obra o sitio..."
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
                  onClick={() => {
                    setQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <Icon ico={ICO.x} className="ico ico-sm" />
                </button>
              </div>
              <div className="dl-move-btns">
                <button
                  type="button"
                  className={`dl-ibtn${hasSel ? "" : " off"}`}
                  title="Mover al inicio"
                  disabled={!hasSel}
                  onClick={() => dlMoveSelected(-1, true)}
                >
                  <Icon ico={ICO.arrowTop} className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className={`dl-ibtn${hasSel ? "" : " off"}`}
                  title="Subir"
                  disabled={!hasSel}
                  onClick={() => dlMoveSelected(-1, false)}
                >
                  <Icon ico={ICO.arrowUp} className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className={`dl-ibtn${hasSel ? "" : " off"}`}
                  title="Bajar"
                  disabled={!hasSel}
                  onClick={() => dlMoveSelected(1, false)}
                >
                  <Icon ico={ICO.arrowDown} className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className={`dl-ibtn${hasSel ? "" : " off"}`}
                  title="Mover al final"
                  disabled={!hasSel}
                  onClick={() => dlMoveSelected(1, true)}
                >
                  <Icon ico={ICO.arrowBottom} className="ico ico-sm" />
                </button>
              </div>
              <div className="dl-toolbar-sep" />
              <div className="dl-sel-actions">
                <button
                  type="button"
                  className={`dl-tbtn${canResumeSel ? "" : " off"}`}
                  disabled={!canResumeSel}
                  onClick={() => void resumeIds(selChapterIds)}
                >
                  <Icon ico={ICO.play} className="ico ico-sm" />
                  Reanudar
                </button>
                <button
                  type="button"
                  className={`dl-tbtn${canStopSel ? "" : " off"}`}
                  disabled={!canStopSel}
                  onClick={() => void pauseIds(selChapterIds)}
                >
                  <Icon ico={ICO.pause} className="ico ico-sm" />
                  Detener
                </button>
                <button
                  type="button"
                  className={`dl-tbtn${canDeleteSel ? "" : " off"}`}
                  disabled={!canDeleteSel}
                  onClick={() =>
                    askRemoveItems(
                      selItems,
                      selItems.length === 1
                        ? "Se quitó de la cola"
                        : `Se quitaron ${selItems.length} de la cola`,
                    )
                  }
                >
                  <Icon ico={ICO.trash} className="ico ico-sm" />
                  Quitar
                </button>
                <button
                  type="button"
                  className={`dl-ibtn${canRetrySel ? "" : " off"}`}
                  style={{ borderColor: "transparent" }}
                  title="Reintentar fallidos"
                  disabled={!canRetrySel}
                  onClick={() => void retryFailedIds(selChapterIds)}
                >
                  <Icon ico={ICO.retry} className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className={`dl-ibtn${canFolderSel ? "" : " off"}`}
                  style={{ borderColor: "transparent" }}
                  title="Abrir carpeta"
                  disabled={!canFolderSel}
                  onClick={() => {
                    const it = selItems.find((i) => (i.output_dir || "").trim()) ?? selItems[0];
                    if (!it) return;
                    void handleOpenFolder(it.id);
                  }}
                >
                  <Icon ico={ICO.folderOpen} className="ico ico-sm" />
                </button>
              </div>
              <div className="dl-toolbar-spacer" />
              <span className="ell dl-sel-label">{selLabel}</span>
            </div>

            <div className="dl-scroll">
              <div className="dl-grid dl-head">
                <button
                  type="button"
                  className={`sites-cb${allOn ? " on" : ""}${someOn && !allOn ? " some" : ""}`}
                  style={{
                    ["--ico" as string]:
                      allOn || someOn ? (allOn ? ICO.check : ICO.dash) : ICO.check,
                  }}
                  aria-label="Seleccionar todo"
                  onClick={() => toggleSelectAllGroups()}
                >
                  <span className="sites-cb-mk" />
                </button>
                {SORT_COLUMNS.map((col) => {
                  const on = col.key === sortKey;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      className={`dl-hc${on ? " on" : ""}`}
                      style={col.style}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                      <Icon
                        ico={ICO.chevron}
                        className="ico dl-sort-ico"
                        style={{
                          opacity: on ? 1 : 0,
                          transform: on && sortDir < 0 ? "rotate(180deg)" : "none",
                        }}
                      />
                    </button>
                  );
                })}
                <div />
              </div>

              {groups.length ? (
                groups.map((g) => {
                  const a = aggregateGroup(g, liveProgress);
                  const on = !!selG[g.key];
                  const focused = focusKey === g.key;
                  const running = a.active > 0;
                  return (
                    <div
                      key={g.key}
                      className={`dl-grid dl-row${on ? " sel" : ""}${focused ? " focus" : ""}`}
                      onClick={() => {
                        setFocusKey(g.key);
                        setPanelMin(false);
                        toggleSelG(g.key);
                      }}
                      onContextMenu={(ev) => {
                        if (!selG[g.key]) setSelG({ [g.key]: true });
                        openCtx(ev, g.items.map((i) => i.id));
                      }}
                    >
                      <button
                        type="button"
                        className={`sites-cb${on ? " on" : ""}`}
                        style={{ ["--ico" as string]: ICO.check }}
                        aria-label="Seleccionar grupo"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelG(g.key);
                        }}
                      >
                        <span className="sites-cb-mk" />
                      </button>
                      <div className="dl-cell-title">
                        <div className="dl-cell-title-text">
                          <span className="ell dl-manga">{g.title}</span>
                          <span className="ell dl-chapter">{a.summary}</span>
                        </div>
                        <span className="dl-cell-tags">
                          <span className="mono dl-tag">{g.items.length} cap.</span>
                          {g.taskLabel ? (
                            <span className="mono dl-tag">{g.taskLabel}</span>
                          ) : null}
                        </span>
                      </div>
                      <span
                        className="dl-badge"
                        style={{ color: a.st.color, background: a.st.bg }}
                      >
                        {a.stLabel}
                      </span>
                      <div className="dl-prog">
                        <div className="dl-seg">
                          <i
                            style={{
                              width: `${a.wDone.toFixed(1)}%`,
                              background: "var(--ok)",
                            }}
                          />
                          <i
                            style={{
                              width: `${a.wActive.toFixed(1)}%`,
                              background: a.st.bar,
                            }}
                          />
                        </div>
                        <div className="dl-prog-meta">
                          <span className="mono">{Math.round(a.pct)}%</span>
                          <span className="mono">
                            {a.done}/{g.items.length} cap
                          </span>
                        </div>
                      </div>
                      <span
                        className="mono dl-ratio"
                        style={{
                          color: a.speed ? "var(--text)" : "var(--muted)",
                        }}
                      >
                        {formatBytesPerSec(a.speed) || "—"}
                      </span>
                      <div className="dl-site-added" title={g.outputDir}>
                        <span className="ell dl-site">{g.site}</span>
                        <span className="ell mono dl-added">{dlFmtAdded(g.oldest)}</span>
                      </div>
                      <div className="dl-act">
                        <button
                          type="button"
                          className="dl-ibtn"
                          title={running ? "Detener grupo" : "Reanudar grupo"}
                          style={{
                            borderColor: "transparent",
                            width: "24px",
                            height: "24px",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (running) void pauseIds(g.items.map((i) => i.id));
                            else {
                              const ids = g.items
                                .filter((i) => i.status !== "done")
                                .map((i) => i.id);
                              void resumeIds(ids);
                            }
                          }}
                        >
                          <Icon
                            ico={running ? ICO.pause : ICO.play}
                            className="ico ico-sm"
                          />
                        </button>
                        <button
                          type="button"
                          className="dl-ibtn"
                          title="Quitar grupo"
                          style={{
                            borderColor: "transparent",
                            width: "24px",
                            height: "24px",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            askRemoveItems(
                              g.items,
                              `Se quitó «${g.title}» de la cola`,
                            );
                          }}
                        >
                          <Icon ico={ICO.trash} className="ico ico-sm" />
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="dl-empty">
                  <Icon
                    ico={ICO.download}
                    className="ico"
                    style={{
                      width: "26px",
                      height: "26px",
                      color: "var(--muted)",
                      opacity: 0.55,
                    }}
                  />
                  <div className="dl-empty-title">
                    {query.trim() ? "Sin coincidencias" : "Nada por aquí"}
                  </div>
                  <div className="dl-empty-desc">
                    {query.trim()
                      ? `Ningún grupo coincide con “${query.trim()}”.`
                      : "Esta vista no tiene descargas en este momento."}
                  </div>
                </div>
              )}
            </div>

            {focusGroup && focusAgg && !panelMin ? (
              <div className="dl-panel">
                <div className="dl-panel-side">
                  <div className="dl-panel-side-inner">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        marginBottom: "5px",
                      }}
                    >
                      <div className="dl-panel-label">Grupo</div>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <button
                          type="button"
                          className="dl-ibtn"
                          title="Minimizar panel"
                          style={{
                            width: "22px",
                            height: "22px",
                            borderColor: "transparent",
                          }}
                          onClick={() => setPanelMin(true)}
                        >
                          <Icon ico={ICO.minimize} className="ico ico-sm" />
                        </button>
                        <button
                          type="button"
                          className="dl-ibtn"
                          title="Cerrar panel"
                          style={{
                            width: "22px",
                            height: "22px",
                            borderColor: "transparent",
                          }}
                          onClick={() => setFocusKey(null)}
                        >
                          <Icon ico={ICO.x} className="ico ico-sm" />
                        </button>
                      </div>
                    </div>
                    <div className="dl-panel-title">{focusGroup.title}</div>
                    <div className="dl-panel-meta">
                      <span
                        className="dl-badge"
                        style={{
                          color: focusAgg.st.color,
                          background: focusAgg.st.bg,
                        }}
                      >
                        {focusAgg.stLabel}
                      </span>
                      {focusGroup.taskLabel ? (
                        <span className="mono dl-tag">{focusGroup.taskLabel}</span>
                      ) : null}
                      <span style={{ fontSize: "11.5px", color: "var(--muted)" }}>
                        {focusGroup.site}
                      </span>
                    </div>
                    <div className="ell mono dl-panel-path" title={focusGroup.outputDir}>
                      {focusGroup.outputDir || "—"}
                    </div>
                    <div className="dl-panel-actions">
                      <button
                        type="button"
                        className="dl-gbtn"
                        style={{ flex: "1 1 auto" }}
                        disabled={fRunning ? false : !fCanResume}
                        onClick={() => {
                          if (fRunning) {
                            void pauseIds(focusGroup.items.map((i) => i.id));
                          } else {
                            void resumeIds(
                              focusGroup.items
                                .filter((i) => i.status !== "done")
                                .map((i) => i.id),
                            );
                          }
                        }}
                      >
                        <Icon
                          ico={fRunning ? ICO.pause : ICO.play}
                          className="ico ico-sm"
                        />
                        {fRunning ? "Detener" : "Reanudar"}
                      </button>
                      <button
                        type="button"
                        className="dl-gbtn is-icon"
                        title="Reintentar fallidos"
                        disabled={!focusGroup.items.some((i) => i.status === "failed")}
                        onClick={() =>
                          void retryFailedIds(focusGroup.items.map((i) => i.id))
                        }
                      >
                        <Icon ico={ICO.retry} className="ico ico-sm" />
                      </button>
                      <button
                        type="button"
                        className="dl-gbtn is-icon"
                        title="Abrir carpeta"
                        onClick={() => {
                          const id = focusGroup.items[0]?.id;
                          if (id != null) void handleOpenFolder(id, false);
                        }}
                      >
                        <Icon ico={ICO.folderOpen} className="ico ico-sm" />
                      </button>
                      <button
                        type="button"
                        className="dl-gbtn is-icon"
                        title="Agregar más capítulos"
                        onClick={() => handleAddMore(focusGroup)}
                      >
                        <Icon ico={ICO.plus} className="ico ico-sm" />
                      </button>
                    </div>
                  </div>
                </div>
                <div className="dl-panel-list">
                  <div className="dl-panel-list-bar">
                    <button
                      type="button"
                      className={`sites-cb${fAll ? " on" : ""}${fSome && !fAll ? " some" : ""}`}
                      style={{
                        ["--ico" as string]:
                          fAll || fSome ? (fAll ? ICO.check : ICO.dash) : ICO.check,
                      }}
                      aria-label="Seleccionar capítulos"
                      onClick={() => {
                        if (!focusGroup) return;
                        setSelC((prev) => {
                          const next = { ...prev };
                          if (fAll) {
                            for (const c of focusGroup.items) delete next[c.id];
                          } else {
                            for (const c of focusGroup.items) next[c.id] = true;
                          }
                          return next;
                        });
                      }}
                    >
                      <span className="sites-cb-mk" />
                    </button>
                    <span style={{ fontSize: "11.5px", color: "var(--muted)" }}>
                      {fSelIds.length
                        ? `${fSelIds.length} de ${focusGroup.items.length} capítulos`
                        : `${focusGroup.items.length} capítulos · ${focusAgg.done} listos`}
                    </span>
                    <div className="dl-toolbar-spacer" />
                    <button
                      type="button"
                      className={`dl-ibtn${fSelIds.length ? "" : " off"}`}
                      style={{ width: "24px", height: "24px" }}
                      title="Reanudar seleccionados"
                      disabled={!fSelIds.length}
                      onClick={() => void resumeIds(fSelIds)}
                    >
                      <Icon ico={ICO.play} className="ico ico-sm" />
                    </button>
                    <button
                      type="button"
                      className={`dl-ibtn${fSelIds.length ? "" : " off"}`}
                      style={{ width: "24px", height: "24px" }}
                      title="Detener seleccionados"
                      disabled={!fSelIds.length}
                      onClick={() => void pauseIds(fSelIds)}
                    >
                      <Icon ico={ICO.pause} className="ico ico-sm" />
                    </button>
                    <button
                      type="button"
                      className={`dl-ibtn${fSelIds.length ? "" : " off"}`}
                      style={{ width: "24px", height: "24px" }}
                      title="Quitar seleccionados"
                      disabled={!fSelIds.length}
                      onClick={() => {
                        const list = focusGroup.items.filter((c) => selC[c.id]);
                        askRemoveItems(
                          list,
                          list.length === 1
                            ? "Se quitó de la cola"
                            : `Se quitaron ${list.length} de la cola`,
                        );
                      }}
                    >
                      <Icon ico={ICO.trash} className="ico ico-sm" />
                    </button>
                  </div>
                  <div className="dl-panel-list-scroll">
                    {focusGroup.items.map((c) => {
                      const st = dlStatusMeta(c.status);
                      const prog = dlItemPct(c, liveProgress);
                      const on = !!selC[c.id];
                      const canStop =
                        c.status === "running" || c.status === "pending";
                      const canResume =
                        c.status === "cancelled" || c.status === "failed";
                      const isProcessing =
                        c.status === "running" &&
                        liveProgress.get(c.id)?.phase === "processing";
                      const meta = isProcessing
                        ? prog.pages || "…"
                        : c.status === "running"
                          ? formatBytesPerSec(
                              liveProgress.get(c.id)?.bytes_per_sec,
                            ) || "…"
                          : prog.pages || "—";
                      const fmtLabel = chapterFormatLabel(c);
                      return (
                        <div
                          key={c.id}
                          className={`dl-crow${on ? " sel" : ""}`}
                          onClick={() => toggleSelC(c.id)}
                          onDoubleClick={(ev) => {
                            ev.stopPropagation();
                            void handleOpenContent(c.id);
                          }}
                          onContextMenu={(ev) => {
                            if (!selC[c.id]) setSelC({ [c.id]: true });
                            openCtx(ev, [c.id]);
                          }}
                        >
                          <button
                            type="button"
                            className={`sites-cb${on ? " on" : ""}`}
                            style={{
                              ["--ico" as string]: ICO.check,
                              marginTop: "2px",
                            }}
                            aria-label="Seleccionar capítulo"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSelC(c.id);
                            }}
                          >
                            <span className="sites-cb-mk" />
                          </button>
                          <div className="dl-crow-body">
                            <span className="ell dl-crow-label">
                              {c.chapter_name || `Capítulo ${c.chapter_index + 1}`}
                            </span>
                            <div className="dl-seg" style={{ height: "3px" }}>
                              <i
                                style={{
                                  width: `${prog.pct}%`,
                                  background: st.bar,
                                }}
                              />
                            </div>
                            <div className="dl-crow-meta">
                              <span
                                className="dl-badge"
                                style={{
                                  padding: "1px 6px",
                                  color: st.color,
                                  background: st.bg,
                                }}
                              >
                                {isProcessing ? prog.label : st.label}
                              </span>
                              {fmtLabel ? (
                                <span className="mono dl-tag" title="Formato">
                                  {fmtLabel}
                                </span>
                              ) : null}
                              <span className="mono" style={{ fontSize: "10.5px", color: "var(--muted)" }}>
                                {meta}
                              </span>
                            </div>
                          </div>
                          <div className="dl-cact">
                            {canStop || canResume ? (
                              <button
                                type="button"
                                className="dl-ibtn"
                                title={canStop ? "Detener" : "Reanudar"}
                                style={{
                                  width: "22px",
                                  height: "22px",
                                  borderColor: "transparent",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (canStop) void pauseIds([c.id]);
                                  else void resumeIds([c.id]);
                                }}
                              >
                                <Icon
                                  ico={canStop ? ICO.pause : ICO.play}
                                  className="ico ico-sm"
                                />
                              </button>
                            ) : (
                              <span style={{ width: "22px" }} />
                            )}
                            <button
                              type="button"
                              className="dl-ibtn"
                              title="Abrir carpeta del capítulo"
                              style={{
                                width: "22px",
                                height: "22px",
                                borderColor: "transparent",
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleOpenFolder(c.id, true);
                              }}
                            >
                              <Icon ico={ICO.folderOpen} className="ico ico-sm" />
                            </button>
                            <button
                              type="button"
                              className="dl-ibtn"
                              title="Quitar"
                              style={{
                                width: "22px",
                                height: "22px",
                                borderColor: "transparent",
                              }}
                              disabled={c.status === "running"}
                              onClick={(e) => {
                                e.stopPropagation();
                                askRemoveItems([c], "Se quitó de la cola");
                              }}
                            >
                              <Icon ico={ICO.trash} className="ico ico-sm" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            {focusGroup && focusAgg && panelMin ? (
              <button
                type="button"
                className="dl-panel-mini"
                title="Expandir panel"
                onClick={() => setPanelMin(false)}
              >
                <Icon
                  ico={ICO.layers}
                  className="ico ico-sm"
                  style={{ color: "var(--muted)" }}
                />
                <span className="ell" style={{ fontSize: "12.5px", fontWeight: 600 }}>
                  {focusGroup.title}
                </span>
                <span
                  className="dl-badge"
                  style={{
                    color: focusAgg.st.color,
                    background: focusAgg.st.bg,
                  }}
                >
                  {focusAgg.stLabel}
                </span>
                <span className="ell" style={{ minWidth: 0, fontSize: "11.5px", color: "var(--muted)" }}>
                  {`${focusGroup.items.length} cap · ${focusAgg.done} listos${
                    focusAgg.active ? " · 1 descargando" : ""
                  }${focusAgg.queued ? ` · ${focusAgg.queued} en cola` : ""}`}
                </span>
                <div className="dl-toolbar-spacer" />
                <button
                  type="button"
                  className="dl-ibtn"
                  style={{ width: "24px", height: "24px", borderColor: "transparent" }}
                  title={fRunning ? "Detener" : "Reanudar"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (fRunning) void pauseIds(focusGroup.items.map((i) => i.id));
                    else {
                      void resumeIds(
                        focusGroup.items
                          .filter((i) => i.status !== "done")
                          .map((i) => i.id),
                      );
                    }
                  }}
                >
                  <Icon ico={fRunning ? ICO.pause : ICO.play} className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className="dl-ibtn"
                  style={{ width: "24px", height: "24px", borderColor: "transparent" }}
                  title="Expandir panel"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPanelMin(false);
                  }}
                >
                  <Icon ico={ICO.maximize} className="ico ico-sm" />
                </button>
                <button
                  type="button"
                  className="dl-ibtn"
                  style={{ width: "24px", height: "24px", borderColor: "transparent" }}
                  title="Cerrar panel"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocusKey(null);
                  }}
                >
                  <Icon ico={ICO.x} className="ico ico-sm" />
                </button>
              </button>
            ) : null}

            <footer className="dl-footer">
              <span className="dl-footer-stat">
                <span className="dl-dot" style={{ background: "var(--accent)" }} />
                {activeN === 1 ? "1 descarga activa" : `${activeN} descargas activas`}
              </span>
              <span className="dl-footer-muted">{`${queuedN} en cola`}</span>
              <span className="ell dl-footer-muted" style={{ flex: "0 1 auto" }}>
                {`${doneN} completados`}
              </span>
              <div className="dl-footer-spacer" />
              <span className="mono ell dl-footer-conc">{concurrencyLabel}</span>
              <button
                type="button"
                className="dl-lnk"
                disabled={clearableN === 0}
                onClick={() => void handleClearDone()}
              >
                Limpiar completadas
              </button>
            </footer>
          </div>
        </div>
      </div>

      {dlCtxMenu ? (
        <div className="dl-ctx-layer">
          <div
            className="dl-ctx-backdrop"
            onClick={() => setDlCtxMenu(null)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setDlCtxMenu(null);
            }}
          />
          <div
            className="dl-ctx-menu"
            style={{ left: dlCtxMenu.x, top: dlCtxMenu.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={!ctxCanResume}
              onClick={() => {
                const ids = dlCtxMenu.ids;
                setDlCtxMenu(null);
                void resumeIds(ids);
              }}
            >
              <Icon ico={ICO.play} className="ico ico-sm" />
              <span>Reanudar</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={!ctxCanStop}
              onClick={() => {
                const ids = dlCtxMenu.ids;
                setDlCtxMenu(null);
                void pauseIds(ids);
              }}
            >
              <Icon ico={ICO.pause} className="ico ico-sm" />
              <span>Detener</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item"
              disabled={!ctxOpenTarget?.output_dir}
              onClick={() => {
                const it = ctxOpenTarget;
                setDlCtxMenu(null);
                if (!it) return;
                // Fila de capítulo (panel) → carpeta del cap; grupo (lista) → carpeta de la obra
                void handleOpenFolder(it.id, ctxItems.length === 1);
              }}
            >
              <Icon ico={ICO.folderOpen} className="ico ico-sm" />
              <span>Abrir ubicación</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item is-sep is-danger"
              disabled={!ctxCanDelete}
              onClick={() => {
                const list = ctxItems;
                setDlCtxMenu(null);
                askRemoveItems(
                  list,
                  list.length === 1
                    ? "Se quitó de la cola"
                    : `Se quitaron ${list.length} de la cola`,
                );
              }}
            >
              <Icon ico={ICO.trash} className="ico ico-sm" />
              <span>Eliminar</span>
            </button>
          </div>
        </div>
      ) : null}

      {removeConfirm ? (
        <div
          className="info-modal-backdrop info-modal-backdrop-confirm"
          role="presentation"
          onClick={() => setRemoveConfirm(null)}
        >
          <div
            className="info-modal info-modal-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dl-remove-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="info-modal-head">
              <h2 id="dl-remove-title" className="info-modal-title">
                Quitar de la cola
              </h2>
            </header>
            <div className="info-modal-body">
              <p className="info-modal-confirm-msg">
                {removeConfirm.items.length === 1
                  ? "¿Quitar este ítem de la cola?"
                  : `¿Quitar ${removeConfirm.items.length} ítems de la cola?`}
              </p>
              <label className="action-check" style={{ marginTop: 14, color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={removeDeleteFiles}
                  onChange={(e) => setRemoveDeleteFiles(e.target.checked)}
                />
                <span>Borrar también los archivos del disco</span>
              </label>
            </div>
            <footer className="info-modal-foot">
              <button
                type="button"
                className="info-modal-btn"
                onClick={() => setRemoveConfirm(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="info-modal-btn info-modal-btn-primary"
                autoFocus
                onClick={() => {
                  const { items, label } = removeConfirm;
                  const deleteFiles = removeDeleteFiles;
                  setRemoveConfirm(null);
                  void removeItemsWithUndo(items, label, deleteFiles);
                }}
              >
                Quitar
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
