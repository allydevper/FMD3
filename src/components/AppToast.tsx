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
import { Icon } from "./Icon";

export type AppToastKind = "ok" | "err" | "";

export type AppToastAction = {
  label: string;
  onClick: () => void;
};

export type AppToastOptions = {
  message: string;
  kind?: AppToastKind;
  durationMs?: number;
  /** When set, shows a Deshacer action. */
  onUndo?: () => void | Promise<void>;
  /** Secondary link-style action (e.g. Ver descargas). */
  action?: AppToastAction;
};

/** @deprecated Prefer `appToast({ message, onUndo })`. */
export type AppToastUndoOptions = {
  message: string;
  onUndo: () => void | Promise<void>;
  durationMs?: number;
};

type ToastFn = (opts: AppToastOptions) => void;

type Pending = {
  id: number;
  message: string;
  kind: AppToastKind;
  onUndo?: () => void | Promise<void>;
  action?: AppToastAction;
  durationMs: number;
};

const AppToastContext = createContext<ToastFn | null>(null);

/** Imperative bridge for non-hook callers. */
let bridge: ToastFn | null = null;

export function appToast(opts: AppToastOptions): void {
  if (bridge) {
    bridge(opts);
    return;
  }
}

/** Undo-capable toast (favorites / queue delete). */
export function appToastUndo(opts: AppToastUndoOptions): void {
  appToast({
    message: opts.message,
    durationMs: opts.durationMs,
    onUndo: opts.onUndo,
  });
}

export function AppToastProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setPending(null);
  }, [clearTimer]);

  const show = useCallback<ToastFn>(
    (opts) => {
      clearTimer();
      const id = ++seqRef.current;
      const durationMs =
        opts.durationMs ?? (opts.onUndo || opts.action ? 6000 : 3200);
      setPending({
        id,
        message: opts.message,
        kind: opts.kind ?? "",
        onUndo: opts.onUndo,
        action: opts.action,
        durationMs,
      });
      timerRef.current = window.setTimeout(() => {
        setPending((cur) => (cur?.id === id ? null : cur));
        timerRef.current = undefined;
      }, durationMs);
    },
    [clearTimer],
  );

  useEffect(() => {
    bridge = show;
    return () => {
      if (bridge === show) bridge = null;
      clearTimer();
    };
  }, [show, clearTimer]);

  const handleUndo = useCallback(() => {
    const action = pending?.onUndo;
    dismiss();
    if (action) {
      void Promise.resolve(action()).catch(() => {
        /* caller logs errors */
      });
    }
  }, [pending, dismiss]);

  const handleAction = useCallback(() => {
    const action = pending?.action;
    dismiss();
    if (action) action.onClick();
  }, [pending, dismiss]);

  const value = useMemo(() => show, [show]);
  const kindClass =
    pending?.kind === "ok"
      ? " is-ok"
      : pending?.kind === "err"
        ? " is-err"
        : "";

  return (
    <AppToastContext.Provider value={value}>
      {children}
      {pending ? (
        <div
          className={`app-toast${kindClass}`}
          role="status"
          aria-live="polite"
        >
          <span className="app-toast-text">{pending.message}</span>
          {pending.action ? (
            <button
              type="button"
              className="app-toast-undo"
              onClick={handleAction}
            >
              {pending.action.label}
            </button>
          ) : null}
          {pending.onUndo ? (
            <button type="button" className="app-toast-undo" onClick={handleUndo}>
              Deshacer
            </button>
          ) : null}
          <button
            type="button"
            className="app-toast-close"
            title="Cerrar"
            aria-label="Cerrar"
            onClick={dismiss}
          >
            <Icon name="x" className="ico ico-sm" />
          </button>
        </div>
      ) : null}
    </AppToastContext.Provider>
  );
}

export function useAppToast(): ToastFn {
  const ctx = useContext(AppToastContext);
  if (!ctx) throw new Error("useAppToast must be used within AppToastProvider");
  return ctx;
}

/** @deprecated Prefer `useAppToast`. */
export function useAppToastUndo(): ToastFn {
  return useAppToast();
}
