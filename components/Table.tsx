"use client";

import {
  createContext,
  forwardRef,
  useContext,
  type HTMLAttributes,
  type ReactNode,
  type ThHTMLAttributes,
  type TdHTMLAttributes,
  type UIEventHandler,
} from "react";

/**
 * The table primitive every list in the app renders through.
 *
 * Transaction, operation and event tables each carried their own copy of the
 * header string, their own empty state and their own scroll wrapper, so an
 * accessibility fix to one never reached the others. The shared pieces live
 * here instead:
 *
 * - The wrapper scrolls horizontally instead of clipping (`overflow-x-auto`),
 *   and is a focusable, named region so the overflow is reachable by keyboard —
 *   a scroll container that cannot be focused cannot be scrolled without a
 *   pointer (WCAG 2.1.1).
 * - Every `<th>` gets `scope="col"`, so header cells are associated with the
 *   column they describe rather than being inferred (WCAG 1.3.1).
 * - Every table gets a `<caption>` as its accessible name, which is what a
 *   screen reader announces before the headers.
 * - `busy` publishes `aria-busy` while rows are being replaced.
 * - `emptyMessage` and `TableEmptyState` give every list one empty state.
 *
 * Row cells keep their own content and classes; the primitive owns the header
 * styling, the border/rounding, the semantics and the states.
 */

const HEADER_CELL =
  "text-left text-[11px] tracking-[0.06em] uppercase text-[#a6a3b0] px-3 py-2.5 border-b border-[#e5e3ea] bg-[#fafafa]";

const BODY_ROW = "border-b border-[#f0eff3] last:border-0";

const BODY_CELL = "py-2.5 px-3";

const DEFAULT_CONTAINER =
  "rounded-xl border border-[#e5e3ea] overflow-x-auto";

const STATUS_CELL = "p-8 text-center text-sm text-[#a6a3b0]";

/** Lets `TableHead` pick up the `stickyHeader` flag without a second prop. */
const StickyHeader = createContext(false);

export interface TableProps {
  /**
   * Accessible name for the table. Rendered as a visually hidden `<caption>`
   * and reused as the scroll region's label.
   */
  caption: string;
  /** Column count, so a status row can span the whole table. */
  columnCount: number;
  /** `TableHead` and `TableBody`. */
  children: ReactNode;
  /**
   * Extra content placed inside the scroll container after the table — e.g. the
   * infinite-scroll sentinel, which has to observe the scrolling element.
   */
  afterTable?: ReactNode;
  /**
   * Rendered as one spanned row when there are no data rows. Callers that omit
   * the table entirely instead use `TableEmptyState`.
   */
  emptyMessage?: ReactNode;
  /**
   * Marks the region busy while its rows are being replaced. This is a state,
   * not an announcement — a footer's live region still owns the "Loading…"
   * message, so the two do not talk over each other.
   */
  busy?: boolean;
  /** Pins the header row while the body scrolls. */
  stickyHeader?: boolean;
  /** Overrides the scroll container's classes (e.g. to cap its height). */
  containerClassName?: string;
  onScroll?: UIEventHandler<HTMLDivElement>;
  "data-testid"?: string;
}

export const Table = forwardRef<HTMLDivElement, TableProps>(function Table(
  {
    caption,
    columnCount,
    children,
    afterTable,
    emptyMessage,
    busy = false,
    stickyHeader = false,
    containerClassName = DEFAULT_CONTAINER,
    onScroll,
    "data-testid": testId,
  },
  ref,
) {
  return (
    <StickyHeader.Provider value={stickyHeader}>
      <div
        ref={ref}
        role="region"
        aria-label={caption}
        aria-busy={busy || undefined}
        // A scrollable region has to be reachable by keyboard to be scrollable
        // at all without a pointer.
        tabIndex={0}
        onScroll={onScroll}
        data-testid={testId}
        className={containerClassName}
      >
        <table className="w-full text-sm border-collapse">
          <caption className="sr-only">{caption}</caption>
          {children}
          {emptyMessage ? (
            <tbody>
              <tr>
                <td colSpan={columnCount} className={STATUS_CELL}>
                  {emptyMessage}
                </td>
              </tr>
            </tbody>
          ) : null}
        </table>
        {afterTable}
      </div>
    </StickyHeader.Provider>
  );
});

export function TableHead({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const sticky = useContext(StickyHeader);
  const classes = [sticky ? "sticky top-0 z-10" : null, className]
    .filter(Boolean)
    .join(" ");

  return <thead className={classes || undefined}>{children}</thead>;
}

export function TableBody({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return <tbody className={className || undefined}>{children}</tbody>;
}

export function TableRow({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={className ? `${BODY_ROW} ${className}` : BODY_ROW} {...rest}>
      {children}
    </tr>
  );
}

export function TableHeaderCell({
  children,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      // The association the three hand-written headers never declared.
      scope="col"
      className={className ? `${HEADER_CELL} ${className}` : HEADER_CELL}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TableCell({
  children,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={className ? `${BODY_CELL} ${className}` : BODY_CELL} {...rest}>
      {children}
    </td>
  );
}

/**
 * The empty state for a list with nothing to show at all. It renders no table,
 * so a reader is given the reason rather than an empty grid.
 */
export function TableEmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[#a6a3b0]">{children}</p>;
}

export default Table;
