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
};

type ConfirmFn = (opts: AppConfirmOptions) => Promise<boolean>;

type Pending = AppConfirmOptions & {
  resolve: (ok: boolean) => void;
};

const AppConfirmContext = createContext<ConfirmFn | null>(null);

const LIST_ROW_H = 28;

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
  const items = pending?.items ?? [];
  const hasList = items.length > 0;

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
            className={`info-modal info-modal-confirm${hasList ? " info-modal-confirm-list" : ""}`}
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
            </header>
            <div className="info-modal-body">
              <p id="app-confirm-msg" className="info-modal-confirm-msg">
                {pending.message}
              </p>
              {hasList ? (
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
              ) : null}
            </div>
            <footer className="info-modal-foot">
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
