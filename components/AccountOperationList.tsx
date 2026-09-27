"use client";

/**
 * An account's operations, cursor-paginated.
 *
 * The root `operations` query filters by account and returns pageInfo, so this
 * is the explorer's pagination approach exactly: follow the cursor, accumulate
 * pages, dedupe by id, and say so when the list is truncated.
 */
import { useCallback, useState } from 'react';
import { AccountOperationsDocument as ACCOUNT_OPERATIONS_QUERY } from '@/lib/generated/graphql';
import { gqlFetch, PUBLIC_GRAPHQL_URL } from '@/lib/graphql';
import type { Operation } from '@/lib/types';
import { formatOperationType, truncateAddress } from '@/lib/formatters';
import TimeAgo from './TimeAgo';
import LoadMoreFooter from './LoadMoreFooter';
import {
  Table,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHead,
  TableHeaderCell,
  TableRow,
} from './Table';

const PAGE_SIZE = 25;
/** Matches the seed the server component renders. */
const SEED_LIMIT = 10;

const COLUMNS = 4;

export default function AccountOperationList({
  address,
  initial,
}: {
  address: string;
  initial: Operation[];
}) {
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(initial.length >= SEED_LIMIT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await gqlFetch(
        PUBLIC_GRAPHQL_URL,
        ACCOUNT_OPERATIONS_QUERY,
        { address, limit: PAGE_SIZE, cursor },
      );
      const page = data.operations;

      setRows((prev) => {
        const seen = new Set(prev.map((op) => op.id));
        // A cursor page can overlap the previous one when operations are
        // indexed between requests; an id already shown is never rendered twice.
        return [...prev, ...page.items.filter((op) => !seen.has(op.id))];
      });
      setCursor(page.pageInfo.cursor);
      setHasNextPage(
        page.pageInfo.hasNextPage && page.pageInfo.cursor !== null,
      );
    } catch {
      setError("Could not load more operations.");
      // Stop the button from immediately retrying in a tight loop; the
      // footer's Retry puts the user back in control.
      setHasNextPage(false);
    } finally {
      setLoading(false);
    }
  }, [address, cursor, loading]);

  if (rows.length === 0) {
    return <TableEmptyState>No operations yet.</TableEmptyState>;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3 text-[13px] text-[#6b6975]">
        <span data-testid="operation-count">
          {hasNextPage
            ? `Showing ${rows.length} of your recent operations`
            : `All ${rows.length} operations`}
        </span>
      </div>

      <Table caption="Account operations" columnCount={COLUMNS} busy={loading}>
        <TableHead>
          {/* A plain row: `TableRow`'s border belongs to body rows, and the
              header cells already draw their own. */}
          <tr>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Transaction</TableHeaderCell>
            <TableHeaderCell>Detail</TableHeaderCell>
            <TableHeaderCell>Time</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {rows.map((op) => (
            <TableRow key={op.id}>
              <TableCell>
                <span className="text-[10px] font-bold rounded-full bg-[#f3effe] text-[#6d28d9] px-2 py-0.5">
                  {formatOperationType(op.type.toLowerCase())}
                </span>
              </TableCell>
              <TableCell>
                <a
                  href={`https://stellar.expert/explorer/public/tx/${op.transactionHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-xs text-[#7c3aed] hover:text-[#6d28d9] hover:underline transition-colors"
                >
                  {truncateAddress(op.transactionHash, 6)}
                </a>
              </TableCell>
              <TableCell className="text-xs text-[#0e0e12]">
                {op.amount ? (
                  <span className="mono">
                    {op.amount} {op.asset ?? "XLM"}
                  </span>
                ) : op.from && op.to ? (
                  <span className="mono text-[#6b6975]">
                    {truncateAddress(op.from, 4)} →{" "}
                    {truncateAddress(op.to, 4)}
                  </span>
                ) : op.from || op.to ? (
                  <span className="mono text-[#6b6975]">
                    {truncateAddress(op.from ?? op.to ?? "", 4)}
                  </span>
                ) : (
                  <span className="text-[#a6a3b0]">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-[#c3c1cb]">
                <TimeAgo isoString={op.createdAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <LoadMoreFooter
        loading={loading}
        error={error}
        hasMore={hasNextPage}
        endLabel="End of results"
        onLoadMore={loadMore}
      />
    </>
  );
}
