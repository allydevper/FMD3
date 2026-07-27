import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type AppConfirmOptions = {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
};

type ConfirmFn = (opts: AppConfirmOptions) => Promise<boolean>;

type Pending = AppConfirmOptions & {
  resolve: (ok: boolean) => void;
};

const AppConfirmContext = createContext<ConfirmFn | null>(null);

/** Imperative bridge for non-hook callers (settings helpers, etc.). */
let bridge: ConfirmFn | null = null;

export function appConfirm(opts: AppConfirmOptions): Promise<boolean> {
  if (bridge) return bridge(opts);
  return Promise.resolve(window.confirm(opts.message));
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
            className="info-modal info-modal-confirm"
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
            </div>
            <footer className="info-modal-foot">
              <button
                type="button"
                className="info-modal-btn"
                onClick={() => finish(false)}
              >
                {pending.cancelLabel?.trim() || "Cancelar"}
              </button>
              <button
                type="button"
                className="info-modal-btn info-modal-btn-primary"
                autoFocus
                onClick={() => finish(true)}
              >
                {pending.okLabel?.trim() || "Continuar"}
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
