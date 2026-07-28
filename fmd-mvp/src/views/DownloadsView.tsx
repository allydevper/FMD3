import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "../components/Icon";
import { ICO } from "../icons";
import { DL_HIST, DL_ST } from "../constants";
import * as api from "../api/tauri";
import { useApp } from "../context/AppContext";
import { confirmIfEnabled, settingBool, SK } from "../utils/settings";
import type { LiveProgress, ModuleMeta, QueueItem } from "../types";

type SortKey = "queue" | "title" | "status" | "pct" | "speed" | "site" | "path" | "added";

const STATUS_NODES: { id: string; label: string; color: string }[] = [
  { id: "done", label: "Completado", color: "var(--ok)" },
  { id: "active", label: "En progreso", color: "var(--accent)" },
  { id: "queued", label: "En cola", color: "var(--muted)" },
  { id: "paused", label: "Detenido", color: "var(--warn)" },
  { id: "failed", label: "Falló", color: "var(--bad)" },
];

const SORT_COLUMNS: { key: SortKey; label: string; style?: CSSProperties }[] = [
  { key: "title", label: "Manga" },
  { key: "status", label: "Estado" },
  { key: "pct", label: "Progreso" },
  { key: "speed", label: "Ratio", style: { justifyContent: "flex-end" } },
  { key: "site", label: "Sitio" },
  { key: "path", label: "Guardado en" },
  { key: "added", label: "Agregado" },
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
  const live = liveProgress.get(item.id);
  if (item.status === "done") return { pct: 100, pages: "", label: "100%" };
  if (live && live.page_total > 0) {
    const pct = Math.min(100, Math.round((live.page_current / live.page_total) * 100));
    return {
      pct,
      pages: `${live.page_current}/${live.page_total} pág`,
      label: `${pct}%`,
    };
  }
  if (item.status === "running") return { pct: 8, pages: "", label: "…" };
  if (item.status === "pending" || item.status === "cancelled") {
    return { pct: 0, pages: "", label: "—" };
  }
  if (item.status === "failed") return { pct: 0, pages: "", label: "—" };
  return { pct: 0, pages: "", label: "—" };
}

function dlItemSpeed(item: QueueItem, liveProgress: Map<number, LiveProgress>): string {
  if (item.status !== "running") return "—";
  const live = liveProgress.get(item.id);
  return formatBytesPerSec(live?.bytes_per_sec) || "…";
}

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

function filteredQueueItems(
  items: QueueItem[],
  order: number[],
  query: string,
  cat: string,
  sortKey: SortKey,
  sortDir: 1 | -1,
  modules: ModuleMeta[],
  liveProgress: Map<number, LiveProgress>,
): QueueItem[] {
  const q = query.trim().toLowerCase();
  let list = orderedQueueItems(items, order).filter((it) => {
    const site = dlSiteName(it, modules);
    if (
      q &&
      !(it.manga_title + " " + it.chapter_name + " " + site).toLowerCase().includes(q)
    ) {
      return false;
    }
    if (cat === "all") return true;
    if (cat === "hist") return it.status === "done";
    if (DL_HIST.some((b) => b.id === cat)) return dlBucketId(it) === cat;
    const meta = dlStatusMeta(it.status);
    return meta.id === cat;
  });

  if (sortKey !== "queue") {
    const dir = sortDir;
    const val = (it: QueueItem): string | number => {
      if (sortKey === "title") return it.manga_title.toLowerCase();
      if (sortKey === "status") return dlStatusMeta(it.status).label;
      if (sortKey === "pct") return dlItemPct(it, liveProgress).pct;
      if (sortKey === "speed") return liveProgress.get(it.id)?.bytes_per_sec ?? (it.status === "running" ? 1 : 0);
      if (sortKey === "site") return dlSiteName(it, modules).toLowerCase();
      if (sortKey === "path") return it.output_dir.toLowerCase();
      return Date.parse(it.created_at) || 0;
    };
    list = [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va > vb) return dir;
      if (va < vb) return -dir;
      return 0;
    });
  }
  return list;
}

function mangaGroupKey(it: QueueItem): string {
  const url = (it.manga_url || "").trim();
  return `${it.module_id}|${url || it.manga_title}`;
}

type MangaGroup = { key: string; title: string; items: QueueItem[] };

function groupByManga(list: QueueItem[]): MangaGroup[] {
  const map = new Map<string, MangaGroup>();
  const keys: string[] = [];
  for (const it of list) {
    const key = mangaGroupKey(it);
    let g = map.get(key);
    if (!g) {
      g = { key, title: it.manga_title, items: [] };
      map.set(key, g);
      keys.push(key);
    }
    g.items.push(it);
  }
  return keys.map((k) => map.get(k)!);
}

export function DownloadsView() {
  const { activeNav, modules, log } = useApp();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [liveProgress, setLiveProgress] = useState<Map<number, LiveProgress>>(
    () => new Map(),
  );
  const [cat, setCat] = useState("all");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<Record<number, true>>({});
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [order, setOrder] = useState<number[]>([]);
  const [showToolbar, setShowToolbar] = useState(true);
  const [showClearBtn, setShowClearBtn] = useState(true);
  const [showLeftBar, setShowLeftBar] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const collapseInitRef = useRef<Set<string>>(new Set());
  const [dlCtxMenu, setDlCtxMenu] = useState<{
    x: number;
    y: number;
    ids: number[];
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
      setShowToolbar(await settingBool(SK.UI_DL_TOOLBAR, true));
      setShowClearBtn(await settingBool(SK.UI_DL_CLEAR_BTN, true));
      setShowLeftBar(await settingBool(SK.UI_DL_LEFT_BAR, true));
    })();
  }, [activeNav]);

  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    setOrder((prev) => {
      const kept = prev.filter((id) => ids.has(id));
      const missing = items.filter((it) => !kept.includes(it.id)).map((it) => it.id);
      return kept.concat(missing);
    });
    setSel((prev) => {
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
    if (activeNav === "downloads") void refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav]);

  useEffect(() => {
    let unChanged: (() => void) | undefined;
    let unProgress: (() => void) | undefined;
    let cancelled = false;
    void api.onQueueChanged(() => {
      void refreshQueue();
    }).then((u) => {
      if (cancelled) u();
      else unChanged = u;
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
            bytes_per_sec: p.bytes_per_sec,
          });
          return next;
        });
        /* Skip noisy per-page ticks in the log; keep phase lines. */
        if (
          p.message.startsWith("Obteniendo") ||
          p.message.startsWith("Downloading") ||
          p.message.startsWith("Completed") ||
          p.message.startsWith("[")
        ) {
          /* Still log [n/m] sparsely: only first, every 5th, and last */
          const m = /^\[(\d+)\/(\d+)\]/.exec(p.message);
          if (m) {
            const cur = Number(m[1]);
            const tot = Number(m[2]);
            if (cur !== 0 && cur !== tot && cur % 5 !== 0) return;
          }
          log(p.message);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unProgress = u;
      });
    return () => {
      cancelled = true;
      unChanged?.();
      unProgress?.();
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

  useEffect(() => {
    const listNow = filteredQueueItems(
      items,
      order,
      query,
      cat,
      sortKey,
      sortDir,
      modules,
      liveProgress,
    );
    const groupsNow = groupByManga(listNow);
    setCollapsedGroups((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const g of groupsNow) {
        if (collapseInitRef.current.has(g.key)) continue;
        collapseInitRef.current.add(g.key);
        const hasRunning = g.items.some((i) => i.status === "running");
        if (!hasRunning && g.items.length > 3) {
          next.add(g.key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items, order, query, cat, sortKey, sortDir, modules, liveProgress]);

  function dlMoveSelected(dir: -1 | 1, edge: boolean) {
    const ids = Object.keys(sel)
      .filter((k) => sel[Number(k)])
      .map(Number);
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

  function toggleSel(id: number) {
    setSel((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }

  function toggleSelectAll(list: QueueItem[]) {
    const allSelected = list.length > 0 && list.every((it) => sel[it.id]);
    setSel((prev) => {
      const next = { ...prev };
      if (allSelected) {
        for (const it of list) delete next[it.id];
      } else {
        for (const it of list) next[it.id] = true;
      }
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

  async function handleRowToggle(it: QueueItem) {
    if (it.status === "running" || it.status === "pending") {
      await api.queueCancel(it.id);
    } else if (it.status === "cancelled" || it.status === "failed") {
      await api.queueRetry(it.id);
      await api.queueStart();
    }
    await refreshQueue();
  }

  async function handleRowRemove(id: number) {
    await api.queueRemove(id);
    await refreshQueue();
  }

  async function handleOpenFolder(it: QueueItem) {
    const dir = (it.output_dir || "").trim();
    if (!dir) {
      log("Sin carpeta de salida.", "err");
      return;
    }
    try {
      await api.openExternal(dir);
    } catch (e) {
      log(String(e), "err");
    }
  }

  function handleRowContextMenu(ev: ReactMouseEvent, it: QueueItem) {
    ev.preventDefault();
    ev.stopPropagation();
    let ids = Object.keys(sel)
      .filter((k) => sel[Number(k)])
      .map(Number);
    if (!ids.includes(it.id)) {
      setSel({ [it.id]: true });
      ids = [it.id];
    }
    const pad = 8;
    const menuW = 220;
    const menuH = 180;
    const x = Math.min(ev.clientX, window.innerWidth - menuW - pad);
    const y = Math.min(ev.clientY, window.innerHeight - menuH - pad);
    setDlCtxMenu({ x: Math.max(pad, x), y: Math.max(pad, y), ids });
  }

  async function handleSelResume() {
    const ids = Object.keys(sel).map(Number);
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (!it) continue;
      if (it.status === "cancelled" || it.status === "failed") {
        await api.queueRetry(id);
      }
    }
    await api.queueStart();
    await refreshQueue();
  }

  async function handleSelPause() {
    const ids = Object.keys(sel).map(Number);
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (it && (it.status === "running" || it.status === "pending")) {
        await api.queueCancel(id);
      }
    }
    await refreshQueue();
  }

  async function handleSelDelete() {
    const ids = Object.keys(sel).map(Number);
    if (!ids.length) return;
    const ok = await confirmIfEnabled(
      SK.CONFIRM_DELETE,
      `¿Eliminar ${ids.length} elemento(s) de la cola?`,
    );
    if (!ok) return;
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      if (it?.status === "running") await api.queueCancel(id);
      await api.queueRemove(id);
    }
    await refreshQueue();
  }

  async function handleResumeAll() {
    for (const it of items) {
      if (it.status === "cancelled" || it.status === "failed") {
        await api.queueRetry(it.id);
      }
    }
    await api.queueStart();
    log("Cola reanudada", "ok");
    await refreshQueue();
  }

  async function handleStopAll() {
    for (const it of items) {
      if (it.status === "running" || it.status === "pending") {
        await api.queueCancel(it.id);
      }
    }
    await refreshQueue();
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

  const list = filteredQueueItems(
    items,
    order,
    query,
    cat,
    sortKey,
    sortDir,
    modules,
    liveProgress,
  );
  const groups = groupByManga(list);

  function toggleGroupCollapsed(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const activeN = items.filter((i) => i.status === "running").length;
  const queuedN = items.filter((i) => i.status === "pending").length;
  const doneN = items.filter((i) => i.status === "done").length;
  const clearableN = items.filter(
    (i) => i.status === "done" || i.status === "failed" || i.status === "cancelled",
  ).length;
  const canResumeAll = items.some((i) => i.status === "cancelled" || i.status === "failed");
  const canStopAll = items.some((i) => i.status === "running" || i.status === "pending");
  const totalBps = items
    .filter((i) => i.status === "running")
    .reduce((sum, i) => sum + (liveProgress.get(i.id)?.bytes_per_sec ?? 0), 0);
  const transferLabel = activeN
    ? formatBytesPerSec(totalBps) || "…"
    : "0 KB/s";
  const selIds = Object.keys(sel)
    .filter((k) => sel[Number(k)])
    .map(Number);
  const hasSel = selIds.length > 0;
  const selItems = selIds
    .map((id) => items.find((x) => x.id === id))
    .filter((x): x is QueueItem => !!x);
  const canResumeSel = selItems.some((i) => i.status === "cancelled" || i.status === "failed");
  const canStopSel = selItems.some((i) => i.status === "running" || i.status === "pending");
  const canDeleteSel = selItems.some((i) => i.status !== "running");
  const allOn = list.length > 0 && list.every((it) => sel[it.id]);
  const someOn = list.some((it) => sel[it.id]);
  const count = (f: (i: QueueItem) => boolean) => items.filter(f).length;

  const ctxItems = dlCtxMenu
    ? dlCtxMenu.ids
        .map((id) => items.find((x) => x.id === id))
        .filter((x): x is QueueItem => !!x)
    : [];
  const ctxCanResume = ctxItems.some((i) => i.status === "cancelled" || i.status === "failed");
  const ctxCanStop = ctxItems.some((i) => i.status === "running" || i.status === "pending");
  const ctxCanDelete = ctxItems.some((i) => i.status !== "running");
  const ctxOpenTarget = ctxItems[0];

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
              <Icon ico={ICO.play} className="ico ico-sm" />Reanudar todo
            </button>
            <button
              type="button"
              className="dl-btn-ghost"
              disabled={!canStopAll}
              onClick={() => void handleStopAll()}
            >
              <Icon ico={ICO.pause} className="ico ico-sm" />Detener todo
            </button>
            {showClearBtn ? (
              <button
                type="button"
                className="dl-btn-ghost"
                disabled={clearableN === 0}
                title="Quitar completadas, detenidas y fallidas"
                onClick={() => void handleClearDone()}
              >
                <Icon ico={ICO.broom} className="ico ico-sm" />Limpiar completadas
              </button>
            ) : null}
          </div>
        </header>
        <div className="dl-body">
          <aside className="dl-tree" aria-label="Filtros de descargas" hidden={!showLeftBar}>
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
                {items.length}
              </span>
            </button>
            {STATUS_NODES.map((s) => {
              const on = cat === s.id;
              const n = count((i) => dlStatusMeta(i.status).id === s.id);
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
              const n = count((i) => dlBucketId(i) === b.id);
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
          </aside>
          <div className="dl-main">
            <div className="dl-toolbar" hidden={!showToolbar}>
              <div className="dl-search-wrap">
                <Icon ico={ICO.search} className="ico ico-sm dl-search-ico" />
                <input
                  ref={searchInputRef}
                  className="st-field"
                  type="text"
                  placeholder="Buscar descargas..."
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
                  onClick={() => void handleSelResume()}
                >
                  <Icon ico={ICO.play} className="ico ico-sm" />Reanudar
                </button>
                <button
                  type="button"
                  className={`dl-tbtn${canStopSel ? "" : " off"}`}
                  disabled={!canStopSel}
                  onClick={() => void handleSelPause()}
                >
                  <Icon ico={ICO.pause} className="ico ico-sm" />Detener
                </button>
                <button
                  type="button"
                  className={`dl-tbtn${hasSel && canDeleteSel ? "" : " off"}`}
                  disabled={!hasSel || !canDeleteSel}
                  onClick={() => void handleSelDelete()}
                >
                  <Icon ico={ICO.trash} className="ico ico-sm" />Quitar
                </button>
              </div>
              <div className="dl-toolbar-spacer" />
              <span className="dl-sel-label">
                {hasSel ? `${selIds.length} seleccionadas` : `${list.length} de ${items.length} tareas`}
              </span>
            </div>
            <div className="dl-scroll">
              <div className="dl-grid dl-head">
                <button
                  type="button"
                  className={`sites-cb${allOn ? " on" : ""}${someOn && !allOn ? " some" : ""}`}
                  style={{ ["--ico" as string]: allOn || someOn ? (allOn ? ICO.check : ICO.dash) : ICO.check }}
                  aria-label="Seleccionar todo"
                  onClick={() => toggleSelectAll(list)}
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
              {list.length ? (
                <div>
                  {groups.map((g) => {
                    const collapsed = collapsedGroups.has(g.key);
                    const doneG = g.items.filter((i) => i.status === "done").length;
                    const runG = g.items.filter((i) => i.status === "running").length;
                    const stopG = g.items.filter((i) => i.status === "cancelled").length;
                    const metaBits = [
                      `${doneG}/${g.items.length} listos`,
                      runG ? `${runG} activos` : "",
                      stopG ? `${stopG} detenidos` : "",
                    ].filter(Boolean);
                    return (
                      <div key={g.key} className="dl-group">
                        <button
                          type="button"
                          className={`dl-group-head${collapsed ? " is-collapsed" : ""}`}
                          onClick={() => toggleGroupCollapsed(g.key)}
                        >
                          <Icon
                            ico={ICO.chevron}
                            className="ico ico-sm dl-group-chevron"
                          />
                          <span className="ell dl-group-title">{g.title}</span>
                          <span className="mono dl-group-meta">{metaBits.join(" · ")}</span>
                        </button>
                        {collapsed
                          ? null
                          : g.items.map((it) => {
                              const st = dlStatusMeta(it.status);
                              const on = !!sel[it.id];
                              const prog = dlItemPct(it, liveProgress);
                              const canStop =
                                it.status === "running" || it.status === "pending";
                              const canResume =
                                it.status === "cancelled" || it.status === "failed";
                              const site = dlSiteName(it, modules);
                              return (
                                <div
                                  key={it.id}
                                  className={`dl-grid dl-row${on ? " sel" : ""}`}
                                  style={{ height: "46px" }}
                                  onClick={() => toggleSel(it.id)}
                                  onContextMenu={(ev) => handleRowContextMenu(ev, it)}
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
                                  <div className="dl-cell-title">
                                    <span className="ell dl-manga">{it.manga_title}</span>
                                    <span className="ell dl-chapter">
                                      {it.chapter_name || it.error || ""}
                                    </span>
                                  </div>
                                  <span
                                    className="dl-badge"
                                    style={{ color: st.color, background: st.bg }}
                                  >
                                    {st.label}
                                  </span>
                                  <div className="dl-prog">
                                    <div className="dl-bar">
                                      <i
                                        style={{
                                          width: `${prog.pct}%`,
                                          background: st.bar,
                                        }}
                                      />
                                    </div>
                                    <div className="dl-prog-meta">
                                      <span className="mono">{prog.label}</span>
                                      <span className="mono">{prog.pages}</span>
                                    </div>
                                  </div>
                                  <span
                                    className="mono dl-ratio"
                                    style={{
                                      color:
                                        it.status === "running"
                                          ? "var(--text)"
                                          : "var(--muted)",
                                    }}
                                  >
                                    {dlItemSpeed(it, liveProgress)}
                                  </span>
                                  <span className="ell dl-site">{site}</span>
                                  <span className="ell mono dl-path" title={it.output_dir}>
                                    {it.output_dir}
                                  </span>
                                  <span className="mono dl-added">{dlFmtAdded(it)}</span>
                                  <div className="dl-act">
                                    {canStop || canResume ? (
                                      <button
                                        type="button"
                                        className="dl-ibtn dl-row-toggle"
                                        title={canStop ? "Detener" : "Reanudar"}
                                        style={{
                                          borderColor: "transparent",
                                          width: "24px",
                                          height: "24px",
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void handleRowToggle(it);
                                        }}
                                      >
                                        <Icon
                                          ico={canStop ? ICO.pause : ICO.play}
                                          className="ico ico-sm"
                                        />
                                      </button>
                                    ) : (
                                      <span style={{ width: "24px" }} />
                                    )}
                                    <button
                                      type="button"
                                      className="dl-ibtn dl-row-remove"
                                      title="Quitar"
                                      style={{
                                        borderColor: "transparent",
                                        width: "24px",
                                        height: "24px",
                                      }}
                                      disabled={it.status === "running"}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleRowRemove(it.id);
                                      }}
                                    >
                                      <Icon ico={ICO.trash} className="ico ico-sm" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="dl-empty">
                  <Icon
                    ico={ICO.download}
                    className="ico"
                    style={{ width: "26px", height: "26px", color: "var(--muted)", opacity: 0.55 }}
                  />
                  <div className="dl-empty-title">
                    {query.trim() ? "Sin coincidencias" : "Nada por aquí"}
                  </div>
                  <div className="dl-empty-desc">
                    {query.trim()
                      ? `Ninguna tarea coincide con “${query.trim()}”.`
                      : "Esta vista no tiene descargas en este momento."}
                  </div>
                </div>
              )}
            </div>
            <footer className="dl-footer">
              <span className="dl-footer-stat">
                <span className="dl-dot" style={{ background: "var(--accent)" }} />
                <span>{activeN === 1 ? "1 descarga activa" : `${activeN} descargas activas`}</span>
              </span>
              <span className="dl-footer-muted">{`${queuedN} en cola`}</span>
              <span className="dl-footer-muted">{`${doneN} completadas`}</span>
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
                void (async () => {
                  for (const id of ids) {
                    const it = items.find((x) => x.id === id);
                    if (it && (it.status === "cancelled" || it.status === "failed")) {
                      await api.queueRetry(id);
                    }
                  }
                  await api.queueStart();
                  await refreshQueue();
                })();
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
                void (async () => {
                  for (const id of ids) {
                    const it = items.find((x) => x.id === id);
                    if (it && (it.status === "running" || it.status === "pending")) {
                      await api.queueCancel(id);
                    }
                  }
                  await refreshQueue();
                })();
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
                setDlCtxMenu(null);
                if (ctxOpenTarget) void handleOpenFolder(ctxOpenTarget);
              }}
            >
              <Icon ico={ICO.folder} className="ico ico-sm" />
              <span>Abrir ubicación</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dl-ctx-item is-danger is-sep"
              disabled={!ctxCanDelete}
              onClick={() => {
                const ids = dlCtxMenu.ids;
                setDlCtxMenu(null);
                void (async () => {
                  const ok = await confirmIfEnabled(
                    SK.CONFIRM_DELETE,
                    `¿Eliminar ${ids.length} elemento(s) de la cola?`,
                  );
                  if (!ok) return;
                  for (const id of ids) {
                    const it = items.find((x) => x.id === id);
                    if (it?.status === "running") await api.queueCancel(id);
                    await api.queueRemove(id);
                  }
                  await refreshQueue();
                })();
              }}
            >
              <Icon ico={ICO.trash} className="ico ico-sm" />
              <span>Eliminar</span>
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
