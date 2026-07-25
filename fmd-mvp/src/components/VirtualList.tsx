import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Key,
  type ReactNode,
  type UIEvent,
} from "react";

const DEFAULT_VIEW_HEIGHT = 400;

export type VirtualListProps<T> = {
  /** Full (already filtered/sorted) list of items to virtualize. */
  items: T[];
  /** Fixed row height in px (excluding gap). */
  itemHeight: number;
  /** Extra vertical gap between rows, in px. Defaults to 0. */
  gap?: number;
  /** Extra rows rendered above/below the viewport. */
  overscan?: number;
  /** id of the scrollable container element. */
  id?: string;
  /** className of the scrollable container element. */
  className?: string;
  /** className of the absolutely-positioned inner spacer element. */
  innerClassName?: string;
  /** Stable key for a row. */
  getKey: (item: T, index: number) => Key;
  /**
   * Renders one row. `style` only carries `top`; the row element itself is
   * expected to be `position: absolute; left/right: 0` via CSS (matching the
   * `.catalog-row` / `.ch-card` classes already defined in styles.css).
   */
  renderItem: (item: T, index: number, style: CSSProperties) => ReactNode;
  /** When this value changes, the scroll position resets to the top. */
  resetKey?: unknown;
};

/**
 * Minimal fixed-row-height virtual list. Mirrors the hand-rolled
 * `paintVirtualChapters` / `paintVirtualCatalog` logic from `main.ts`:
 * only rows within `[scrollTop - overscan, scrollTop + viewport + overscan]`
 * are mounted, everything else is represented purely by the spacer height.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  gap = 0,
  overscan = 6,
  id,
  className,
  innerClassName,
  getKey,
  renderItem,
  resetKey,
}: VirtualListProps<T>) {
  const stride = itemHeight + gap;
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(DEFAULT_VIEW_HEIGHT);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewH(el.clientHeight || DEFAULT_VIEW_HEIGHT);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight || DEFAULT_VIEW_HEIGHT);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
    // Only ever needs to run when the caller signals a reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const n = items.length;
  const totalHeight = n > 0 ? n * stride - gap : 0;

  let start = Math.floor(scrollTop / stride) - overscan;
  let end = Math.ceil((scrollTop + viewH) / stride) + overscan;
  start = Math.max(0, start);
  end = Math.min(n, end);

  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    rows.push(
      <Fragment key={getKey(item, i)}>{renderItem(item, i, { top: i * stride })}</Fragment>,
    );
  }

  function handleScroll(e: UIEvent<HTMLDivElement>) {
    setScrollTop(e.currentTarget.scrollTop);
  }

  return (
    <div id={id} className={className} ref={containerRef} onScroll={handleScroll}>
      <div className={innerClassName} style={{ height: totalHeight }}>
        {rows}
      </div>
    </div>
  );
}
