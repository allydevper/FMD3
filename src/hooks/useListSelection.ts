import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

/**
 * Selección de listas al estilo del explorador de archivos, compartida por
 * Descargas, Favoritos, Capítulos y Catálogo.
 *
 * Reglas de ratón:
 *  - clic en la fila            -> selecciona SOLO esa fila y fija el ancla
 *  - Ctrl/Cmd + clic            -> alterna esa fila sin tocar el resto
 *  - Shift + clic               -> rango desde el ancla hasta la fila
 *  - clic en el checkbox        -> alterna esa fila (aditivo, como Ctrl+clic)
 *
 * Reglas de teclado (ver `resolveListKeyAction`):
 *  - ArrowUp/ArrowDown, Home/End, PageUp/PageDown mueven el cursor y seleccionan
 *  - Shift + las anteriores extienden el rango desde el ancla
 *  - Espacio alterna la fila del cursor, Ctrl/Cmd+A selecciona todo, Esc limpia
 */

export type SelectionKey = string | number;

/** Lo que necesitamos de un evento de ratón (React o nativo). */
export type SelectionMouseEvent = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/** Lo que necesitamos de un evento de teclado (React o nativo). */
export type SelectionKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
};

/** Acción de teclado ya resuelta, independiente de cómo guarde la selección quien llama. */
export type ListKeyAction =
  | { kind: "move"; index: number; extend: boolean }
  | { kind: "toggle-cursor" }
  | { kind: "select-all" }
  | { kind: "clear" };

/** True si el foco está en un campo de texto y no debemos capturar la tecla. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * Traduce una tecla a la acción de lista correspondiente, o `null` si la tecla
 * no nos incumbe. `cursorIndex` es -1 cuando aún no hay cursor.
 */
export function resolveListKeyAction(
  ev: SelectionKeyEvent,
  opts: { count: number; cursorIndex: number; pageSize?: number },
): ListKeyAction | null {
  const { count, cursorIndex } = opts;
  const pageSize = opts.pageSize ?? 10;
  if (count <= 0) return null;
  if (isTypingTarget(ev.target)) return null;

  const last = count - 1;
  const clamp = (i: number) => Math.max(0, Math.min(last, i));
  const move = (index: number): ListKeyAction => ({
    kind: "move",
    index: clamp(index),
    extend: ev.shiftKey,
  });

  switch (ev.key) {
    case "ArrowDown":
      return move(cursorIndex < 0 ? 0 : cursorIndex + 1);
    case "ArrowUp":
      return move(cursorIndex < 0 ? last : cursorIndex - 1);
    case "Home":
      return move(0);
    case "End":
      return move(last);
    case "PageDown":
      return move(cursorIndex < 0 ? 0 : cursorIndex + pageSize);
    case "PageUp":
      return move(cursorIndex < 0 ? last : cursorIndex - pageSize);
    case " ":
    case "Spacebar":
      return cursorIndex < 0 ? null : { kind: "toggle-cursor" };
    case "a":
    case "A":
      return ev.ctrlKey || ev.metaKey ? { kind: "select-all" } : null;
    case "Escape":
      return { kind: "clear" };
    default:
      return null;
  }
}

/** Qué hacer con un clic de fila, según los modificadores. */
export function resolveRowClick(
  ev: SelectionMouseEvent,
): "range" | "toggle" | "only" {
  if (ev.shiftKey) return "range";
  if (ev.ctrlKey || ev.metaKey) return "toggle";
  return "only";
}

/**
 * Lleva la fila `key` a la vista dentro de `container`. Las filas deben llevar
 * `data-selkey` con la misma clave. Para listas virtualizadas usa en su lugar
 * `VirtualListHandle.scrollToIndex`.
 */
export function scrollSelKeyIntoView(
  container: HTMLElement | null | undefined,
  key: SelectionKey,
): void {
  if (!container) return;
  const esc =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(String(key))
      : String(key).replace(/["\\]/g, "\\$&");
  const row = container.querySelector(`[data-selkey="${esc}"]`);
  if (row) (row as HTMLElement).scrollIntoView({ block: "nearest" });
}

export type UseListSelectionOptions<K extends SelectionKey> = {
  /** Claves de las filas visibles, en orden. Memoriza el array o el pruning correrá de más. */
  keys: K[];
  /** Filas que saltan PageUp/PageDown. Por defecto 10. */
  pageSize?: number;
  /** Quita de la selección las claves que desaparecen de `keys`. Por defecto false. */
  prune?: boolean;
  /** Se llama cuando el cursor aterriza en una fila; úsalo para hacer scroll. */
  onCursorChange?: (key: K, index: number) => void;
};

export type ListSelection<K extends SelectionKey> = {
  selected: Set<K>;
  /** Selección actual sin pasar por el render; útil dentro de efectos. */
  selectedRef: MutableRefObject<Set<K>>;
  /** Claves seleccionadas en el orden de `keys` (las que ya no están, al final). */
  selectedKeys: K[];
  count: number;
  isSelected: (key: K) => boolean;
  /** Fila del cursor de teclado; también es la última tocada con el ratón. */
  cursor: K | null;
  isCursor: (key: K) => boolean;
  allSelected: boolean;
  someSelected: boolean;
  handleRowClick: (key: K, ev: SelectionMouseEvent) => void;
  handleCheckboxClick: (key: K) => void;
  handleKeyDown: (ev: SelectionKeyEvent) => void;
  /** Deja seleccionada solo esta fila (usado por el menú contextual). */
  selectOnly: (key: K) => void;
  toggle: (key: K) => void;
  selectAll: () => void;
  clear: () => void;
  toggleAll: () => void;
  /** Reemplaza la selección entera; no mueve el cursor. */
  replace: (keys: Iterable<K>) => void;
  setCursor: (key: K | null) => void;
};

export function useListSelection<K extends SelectionKey>(
  opts: UseListSelectionOptions<K>,
): ListSelection<K> {
  const { keys, pageSize = 10, prune = false, onCursorChange } = opts;

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const cursorCbRef = useRef(onCursorChange);
  cursorCbRef.current = onCursorChange;

  const [selected, setSelected] = useState<Set<K>>(() => new Set());
  const [cursor, setCursorState] = useState<K | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** Extremo fijo del rango de Shift. */
  const anchorRef = useRef<K | null>(null);

  useEffect(() => {
    if (!prune) return;
    const valid = new Set<K>(keys);
    setSelected((prev) => {
      let changed = false;
      const next = new Set<K>();
      for (const k of prev) {
        if (valid.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setCursorState((prev) => (prev !== null && !valid.has(prev) ? null : prev));
  }, [keys, prune]);

  const moveCursor = useCallback((key: K | null) => {
    cursorRef.current = key;
    setCursorState(key);
    if (key === null) return;
    const i = keysRef.current.indexOf(key);
    if (i >= 0) cursorCbRef.current?.(key, i);
  }, []);

  const selectOnly = useCallback(
    (key: K) => {
      anchorRef.current = key;
      setSelected(new Set<K>([key]));
      moveCursor(key);
    },
    [moveCursor],
  );

  const toggle = useCallback(
    (key: K) => {
      anchorRef.current = key;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      moveCursor(key);
    },
    [moveCursor],
  );

  /** Rango ancla->key. No mueve el ancla: Shift repetido reencuadra el mismo rango. */
  const selectRangeTo = useCallback(
    (key: K) => {
      const rows = keysRef.current;
      const to = rows.indexOf(key);
      if (to < 0) return;
      const anchor = anchorRef.current ?? cursorRef.current;
      const from = anchor === null ? to : rows.indexOf(anchor);
      if (from < 0) {
        selectOnly(key);
        return;
      }
      anchorRef.current = rows[from] ?? key;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const next = new Set<K>();
      for (let i = lo; i <= hi; i++) {
        const k = rows[i];
        if (k !== undefined) next.add(k);
      }
      setSelected(next);
      moveCursor(key);
    },
    [moveCursor, selectOnly],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(keysRef.current));
  }, []);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelected(new Set<K>());
    moveCursor(null);
  }, [moveCursor]);

  const toggleAll = useCallback(() => {
    const rows = keysRef.current;
    const all = rows.length > 0 && rows.every((k) => selectedRef.current.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of rows) {
        if (all) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }, []);

  const replace = useCallback((next: Iterable<K>) => {
    setSelected(new Set(next));
  }, []);

  const handleRowClick = useCallback(
    (key: K, ev: SelectionMouseEvent) => {
      const mode = resolveRowClick(ev);
      if (mode === "range") selectRangeTo(key);
      else if (mode === "toggle") toggle(key);
      else selectOnly(key);
    },
    [selectOnly, selectRangeTo, toggle],
  );

  const handleKeyDown = useCallback(
    (ev: SelectionKeyEvent) => {
      const rows = keysRef.current;
      const cur = cursorRef.current;
      const action = resolveListKeyAction(ev, {
        count: rows.length,
        cursorIndex: cur === null ? -1 : rows.indexOf(cur),
        pageSize,
      });
      if (!action) return;
      switch (action.kind) {
        case "move": {
          const key = rows[action.index];
          if (key === undefined) return;
          ev.preventDefault();
          if (action.extend) selectRangeTo(key);
          else selectOnly(key);
          return;
        }
        case "toggle-cursor":
          if (cur === null) return;
          ev.preventDefault();
          toggle(cur);
          return;
        case "select-all":
          ev.preventDefault();
          selectAll();
          return;
        case "clear":
          if (selectedRef.current.size === 0 && cur === null) return;
          ev.preventDefault();
          clear();
          return;
      }
    },
    [clear, pageSize, selectAll, selectOnly, selectRangeTo, toggle],
  );

  const selectedKeys: K[] = [];
  const seen = new Set<K>();
  for (const k of keys) {
    if (selected.has(k)) {
      selectedKeys.push(k);
      seen.add(k);
    }
  }
  for (const k of selected) if (!seen.has(k)) selectedKeys.push(k);

  const allSelected = keys.length > 0 && keys.every((k) => selected.has(k));
  const someSelected = keys.some((k) => selected.has(k));

  return {
    selected,
    selectedRef,
    selectedKeys,
    count: selected.size,
    isSelected: (key: K) => selected.has(key),
    cursor,
    isCursor: (key: K) => cursor === key,
    allSelected,
    someSelected,
    handleRowClick,
    handleCheckboxClick: toggle,
    handleKeyDown,
    selectOnly,
    toggle,
    selectAll,
    clear,
    toggleAll,
    replace,
    setCursor: moveCursor,
  };
}
