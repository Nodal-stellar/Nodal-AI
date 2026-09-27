"use client";

import { useRef, useEffect, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Transaction } from "@/lib/types";
import TransactionRow from "./TransactionRow";
import { Table, TableBody, TableHead, TableHeaderCell } from "./Table";

const ROW_HEIGHT = 41;
const OVERSCAN = 12;
/** Status dot, hash, ledger, source, ops, fee, time. */
const COLUMNS = 7;

export default function VirtualizedTransactionTable({
  transactions,
  emptyMessage,
  children,
  initialScrollTop = 0,
  onScrollTopChange,
}: {
  transactions: Transaction[];
  emptyMessage: string | null;
  children: ReactNode;
  /**
   * Offset to restore once the rows are laid out. The virtualizer only renders
   * the visible window, so restoring the offset before the spacer rows exist
   * would be clamped to the top of a one-row list.
   */
  initialScrollTop?: number;
  /** Reports the scroll offset so the parent can remember it. */
  onScrollTopChange?: (scrollTop: number) => void;
}) {
  // TanStack Virtual exposes mutable instance methods that cannot be memoized.
  // Keep that boundary here so filtering, fetching and presets remain eligible.
  "use no memo";

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ── Virtualization ──────────────────────────────────────────────────────

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable API is confined to this uncompiled component
  const virtualizer = useVirtualizer({
    count: transactions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // Spacer rows stand in for everything above and below the rendered window,
  // so the scrollbar reflects the whole list without the DOM holding it.
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1].end
      : 0;

  // Restore the reader's offset once, after the rows that give the container its
  // full height are on screen. The ref keeps a scroll from re-applying an old
  // offset on every re-render.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    const element = scrollRef.current;
    if (!element || initialScrollTop <= 0 || virtualRows.length === 0) return;
    restoredRef.current = true;
    element.scrollTop = initialScrollTop;
  }, [initialScrollTop, virtualRows.length]);

  if (isMobile && transactions.length > 0) {
    return (
      <div className="space-y-3">
        {transactions.map((tx) => (
          <div
            key={tx.hash}
            className="rounded-lg border border-[#e5e3ea] p-4 bg-[#fafafa]"
          >
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-semibold text-[#a6a3b0]">Hash</span>
              <span className="mono text-xs text-[#0e0e12] font-semibold truncate ml-2">{tx.hash.slice(0, 12)}…</span>
            </div>
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-semibold text-[#a6a3b0]">Ledger</span>
              <span className="mono text-xs text-[#0e0e12]">{tx.ledger}</span>
            </div>
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-semibold text-[#a6a3b0]">Source</span>
              <span className="mono text-xs text-[#0e0e12] truncate ml-2">{tx.sourceAccount.slice(0, 12)}…</span>
            </div>
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-semibold text-[#a6a3b0]">Operations</span>
              <span className="mono text-xs text-[#0e0e12]">{tx.operationCount}</span>
            </div>
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-semibold text-[#a6a3b0]">Fee</span>
              <span className="mono text-xs text-[#0e0e12]">{tx.feeCharged}</span>
            </div>
            <div className="flex justify-between items-start">
              <span className="text-xs font-semibold text-[#a6a3b0]">Time</span>
              <span className="text-xs text-[#0e0e12]">{new Date(tx.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
        {children}
      </div>
    );
  }

  return (
    <Table
      ref={scrollRef}
      caption="Transactions"
      columnCount={COLUMNS}
      stickyHeader
      containerClassName="rounded-xl border border-[#e5e3ea] overflow-auto max-h-[70vh]"
      data-testid="transaction-scroll"
      onScroll={
        onScrollTopChange
          ? (event) => onScrollTopChange(event.currentTarget.scrollTop)
          : undefined
      }
      emptyMessage={transactions.length === 0 ? emptyMessage : undefined}
      afterTable={children}
    >
      <TableHead>
        {/* A plain row: `TableRow`'s border belongs to body rows, and the
            header cells already draw their own. */}
        <tr>
          <TableHeaderCell className="w-6" />
          <TableHeaderCell>Hash</TableHeaderCell>
          <TableHeaderCell>Ledger</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Ops</TableHeaderCell>
          <TableHeaderCell>Fee</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </tr>
      </TableHead>
      <TableBody>
        {paddingTop > 0 && (
          // Layout, not data: kept as a bare cell so the inline height the
          // virtualizer measures is not padded out by the shared cell styles.
          <tr aria-hidden="true">
            <td colSpan={COLUMNS} style={{ height: paddingTop }} />
          </tr>
        )}
        {virtualRows.map((virtualRow) => (
          <TransactionRow
            key={transactions[virtualRow.index].hash}
            tx={transactions[virtualRow.index]}
          />
        ))}
        {paddingBottom > 0 && (
          <tr aria-hidden="true">
            <td colSpan={COLUMNS} style={{ height: paddingBottom }} />
          </tr>
        )}
      </TableBody>
    </Table>
  );
}
