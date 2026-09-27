"use client";

/**
 * An account's transactions, paginated.
 *
 * The account's nested `transactions` field is limit-only — the API has no
 * cursor for account-scoped transactions — so "load more" widens the limit
 * rather than following a cursor: each fetch re-reads the newest N and keeps
 * the tail beyond what is already shown. It reuses the explorer's pagination
 * *approach* — an explicit Load more, an honest truncation label, and an
 * end-of-results state — on the one read shape offered here.
 */
import { useCallback, useState } from 'react';
import { AccountTransactionsDocument as ACCOUNT_TRANSACTIONS_QUERY } from '@/lib/generated/graphql';
import { gqlFetch, PUBLIC_GRAPHQL_URL } from '@/lib/graphql';
import type { Transaction } from '@/lib/types';
import { truncateAddress } from '@/lib/formatters';
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

/** The seed the server component renders; the first client fetch widens past it. */
export const SEED_LIMIT = 10;
/** Each load more widens the window: 10 → 25 → 60 → 150 → 375. */
const LIMIT_STEPS = [10, 25, 60, 150, 375];

const COLUMNS = 4;

export default function AccountTransactionList({
  address,
  initial,
}: {
  address: string;
  initial: Transaction[];
}) {
  const [rows, setRows] = useState(initial);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limit = LIMIT_STEPS[step];
  // A full page means there may be more behind it; a short page means the
  // account has nothing older — the same `items.length === limit` signal the
  // explorer reads pageInfo for.
  const hasMore = rows.length >= limit && step < LIMIT_STEPS.length - 1;

  const loadMore = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await gqlFetch(
        PUBLIC_GRAPHQL_URL,
        ACCOUNT_TRANSACTIONS_QUERY,
        { address, limit: LIMIT_STEPS[step + 1] },
      );
      const fetched = data.account?.transactions;
      if (!fetched) throw new Error("Account transactions unavailable");
      setRows((prev) => {
        // The re-read overlaps what is shown (and new transactions may have
        // shifted it); a hash already shown is never rendered twice.
        const seen = new Set(prev.map((tx) => tx.hash));
        return [...prev, ...fetched.filter((tx) => !seen.has(tx.hash))];
      });
      setStep((s) => s + 1);
    } catch {
      setError("Could not load more transactions.");
    } finally {
      setLoading(false);
    }
  }, [address, step, loading]);

  if (rows.length === 0) {
    return <TableEmptyState>No transactions yet.</TableEmptyState>;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3 text-[13px] text-[#6b6975]">
        <span data-testid="transaction-count">
          {hasMore
            ? `Showing the ${rows.length} most recent transactions`
            : `All ${rows.length} transactions`}
        </span>
      </div>

      <Table
        caption="Account transactions"
        columnCount={COLUMNS}
        busy={loading}
      >
        <TableHead>
          {/* A plain row: `TableRow`'s border belongs to body rows, and the
              header cells already draw their own. */}
          <tr>
            <TableHeaderCell>Hash</TableHeaderCell>
            <TableHeaderCell>Ledger</TableHeaderCell>
            <TableHeaderCell>Ops</TableHeaderCell>
            <TableHeaderCell>Time</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {rows.map((tx) => (
            <TableRow key={tx.hash}>
              <TableCell>
                <a
                  href={`https://stellar.expert/explorer/public/tx/${tx.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-xs text-[#7c3aed] hover:text-[#6d28d9] hover:underline transition-colors"
                >
                  {truncateAddress(tx.hash, 6)}
                </a>
              </TableCell>
              <TableCell className="mono text-xs">
                {tx.ledger.toLocaleString()}
              </TableCell>
              <TableCell className="text-xs">{tx.operationCount}</TableCell>
              <TableCell className="text-xs text-[#c3c1cb]">
                <TimeAgo isoString={tx.createdAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <LoadMoreFooter
        loading={loading}
        error={error}
        hasMore={hasMore}
        endLabel="End of results"
        onLoadMore={loadMore}
      />
    </>
  );
}
