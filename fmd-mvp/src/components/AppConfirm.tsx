import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { VirtualList } from "./VirtualList";

export type AppConfirmOptions = {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Only show OK (informational). */
  alert?: boolean;
  /** Optional scrollable detail lines (virtualized). */
  items?: string[];
  /** Right-side label in the header (e.g. "18 archivos"). */
  meta?: string;
  /** Label above the items list (e.g. "Archivos afectados"). */
  listTitle?: string;
  /** Right-side meta for the list header (e.g. "15 actualizados · 3 nuevos"). */
  listMeta?: string;
  /** Left-side footer hint (e.g. "Copia de seguridad automática"). */
  footerHint?: string;
};

type ConfirmFn = (opts: AppConfirmOptions) => Promise<boolean>;

type Pending = AppConfirmOptions & {
  resolve: (ok: boolean) => void;
};

type ParsedItem = {
  tag: string | null;
  tagKind: "new" | "upd" | "del" | null;
  path: string;
  raw: string;
};

const AppConfirmContext = createContext<ConfirmFn | null>(null);

const LIST_ROW_H = 30;
const TAG_RE = /^\[(NUEVO|ACTUALIZA|ELIMINA)\]\s*(.*)$/i;
const EMPTY_ITEMS: string[] = [];
const EMPTY_PARSED: ParsedItem[] = [];

function parseItem(line: string): ParsedItem {
  const m = line.match(TAG_RE);
  if (!m) return { tag: null, tagKind: null, path: line, raw: line };
  const tag = m[1].toUpperCase();
  const tagKind = tag === "NUEVO" ? "new" : tag === "ELIMINA" ? "del" : "upd";
  return { tag, tagKind, path: m[2] || line, raw: line };
}

/** Imperative bridge for non-hook callers (settings helpers, etc.). */
let bridge: ConfirmFn | null = null;

export function appConfirm(opts: AppConfirmOptions): Promise<boolean> {
  if (bridge) return bridge(opts);
  const extra = opts.items?.length ? `\n\n${opts.items.join("\n")}` : "";
  return Promise.resolve(window.confirm(opts.message + extra));
}

export function AppConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setPending((cur) => {
        cur?.resolve(false);
        return { ...opts, resolve };
      });
    });
  }, []);

  useEffect(() => {
    bridge = confirm;
    return () => {
      if (bridge === confirm) bridge = null;
    };
  }, [confirm]);

  const finish = useCallback((ok: boolean) => {
    setPending((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);
  const rawItems = pending?.items;
  const items = rawItems ?? EMPTY_ITEMS;
  const hasList = items.length > 0;
  const richList = hasList && !!(pending?.listTitle || pending?.listMeta || pending?.meta);
  const parsed = useMemo(
    () => (richList ? items.map(parseItem) : EMPTY_PARSED),
    [items, richList],
  );
  const meta = pending?.meta?.trim() || "";
  const listTitle = pending?.listTitle?.trim() || "";
  const listMeta = pending?.listMeta?.trim() || "";
  const footerHint = pending?.footerHint?.trim() || "";

  return (
    <AppConfirmContext.Provider value={value}>
      {children}
      {pending ? (
        <div
          className="info-modal-backdrop info-modal-backdrop-confirm"
          role="presentation"
          onClick={() => finish(false)}
        >
          <div
            className={[
              "info-modal",
              "info-modal-confirm",
              hasList ? "info-modal-confirm-list" : "",
              richList ? "info-modal-confirm-files" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="app-confirm-title"
            aria-describedby="app-confirm-msg"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="info-modal-head">
              <h2 id="app-confirm-title" className="info-modal-title">
                {pending.title?.trim() || "Confirmar"}
              </h2>
              {meta ? <span className="info-modal-meta">{meta}</span> : null}
            </header>
            <div className="info-modal-body">
              <p id="app-confirm-msg" className="info-modal-confirm-msg">
                {pending.message}
              </p>
              {hasList ? (
                richList ? (
                  <div className="info-modal-files">
                    <div className="info-modal-files-head">
                      <span className="info-modal-files-title">
                        {listTitle || "Detalle"}
                      </span>
                      {listMeta ? (
                        <span className="info-modal-files-meta">{listMeta}</span>
                      ) : null}
                    </div>
                    <VirtualList
                      className="info-modal-confirm-vlist info-modal-files-list"
                      innerClassName="info-modal-confirm-vlist-inner"
                      items={parsed}
                      itemHeight={LIST_ROW_H}
                      overscan={8}
                      resetKey={pending.title}
                      getKey={(row, i) => `${i}:${row.raw}`}
                      renderItem={(row, i, style) => (
                        <div
                          className={`info-modal-confirm-row info-modal-files-row${i % 2 === 1 ? " is-zebra" : ""}`}
                          style={style}
                          title={row.raw}
                        >
                          {row.tag ? (
                            <span
                              className={`info-modal-files-tag is-${row.tagKind ?? "upd"}`}
                            >
                              {row.tag}
                            </span>
                          ) : null}
                          <span className="info-modal-files-path">{row.path}</span>
                        </div>
                      )}
                    />
                  </div>
                ) : (
                  <VirtualList
                    className="info-modal-confirm-vlist"
                    innerClassName="info-modal-confirm-vlist-inner"
                    items={items}
                    itemHeight={LIST_ROW_H}
                    overscan={8}
                    resetKey={pending.title}
                    getKey={(line, i) => `${i}:${line}`}
                    renderItem={(line, _i, style) => (
                      <div className="info-modal-confirm-row" style={style} title={line}>
                        {line}
                      </div>
                    )}
                  />
                )
              ) : null}
            </div>
            <footer className={`info-modal-foot${footerHint ? " has-hint" : ""}`}>
              {footerHint ? (
                <span className="info-modal-foot-hint">{footerHint}</span>
              ) : null}
              {!pending.alert ? (
                <button
                  type="button"
                  className="info-modal-btn"
                  onClick={() => finish(false)}
                >
                  {pending.cancelLabel?.trim() || "Cancelar"}
                </button>
              ) : null}
              <button
                type="button"
                className="info-modal-btn info-modal-btn-primary"
                autoFocus
                onClick={() => finish(true)}
              >
                {pending.okLabel?.trim() || (pending.alert ? "Entendido" : "Continuar")}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </AppConfirmContext.Provider>
  );
}

export function useAppConfirm(): ConfirmFn {
  const ctx = useContext(AppConfirmContext);
  if (!ctx) throw new Error("useAppConfirm must be used within AppConfirmProvider");
  return ctx;
}
