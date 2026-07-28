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

export type AppToastUndoOptions = {
  message: string;
  onUndo: () => void | Promise<void>;
  durationMs?: number;
};

type ToastUndoFn = (opts: AppToastUndoOptions) => void;

type Pending = {
  id: number;
  message: string;
  onUndo: () => void | Promise<void>;
  durationMs: number;
};

const AppToastContext = createContext<ToastUndoFn | null>(null);

/** Imperative bridge for non-hook callers. */
let bridge: ToastUndoFn | null = null;

export function appToastUndo(opts: AppToastUndoOptions): void {
  if (bridge) {
    bridge(opts);
    return;
  }
  /* Fallback when provider is missing: no UI. */
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

  const showUndo = useCallback<ToastUndoFn>(
    (opts) => {
      clearTimer();
      const id = ++seqRef.current;
      const durationMs = opts.durationMs ?? 6000;
      setPending({
        id,
        message: opts.message,
        onUndo: opts.onUndo,
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
    bridge = showUndo;
    return () => {
      if (bridge === showUndo) bridge = null;
      clearTimer();
    };
  }, [showUndo, clearTimer]);

  const handleUndo = useCallback(() => {
    const action = pending?.onUndo;
    dismiss();
    if (action) void Promise.resolve(action()).catch(() => {
      /* caller logs errors */
    });
  }, [pending, dismiss]);

  const value = useMemo(() => showUndo, [showUndo]);

  return (
    <AppToastContext.Provider value={value}>
      {children}
      {pending ? (
        <div className="app-toast" role="status" aria-live="polite">
          <span className="app-toast-text">{pending.message}</span>
          <button type="button" className="app-toast-undo" onClick={handleUndo}>
            Deshacer
          </button>
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

export function useAppToastUndo(): ToastUndoFn {
  const ctx = useContext(AppToastContext);
  if (!ctx) throw new Error("useAppToastUndo must be used within AppToastProvider");
  return ctx;
}
