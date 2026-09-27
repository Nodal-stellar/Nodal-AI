import Link from "next/link";
import type { Transaction } from "@/lib/types";
import { truncateAddress, formatXLM } from "@/lib/formatters";
import TimeAgo from "./TimeAgo";
import WatchIndicator from "./WatchIndicator";
import { TableCell, TableRow } from "./Table";

export default function TransactionRow({ tx }: { tx: Transaction }) {
  const fee = (parseInt(tx.feeCharged) / 1e7).toFixed(7);
  return (
    <TableRow>
      <TableCell>
        <span className={`w-2 h-2 rounded-full inline-block ${tx.successful ? "bg-[#16a34a]" : "bg-[#dc2626]"}`} />
      </TableCell>
      <TableCell>
        <a
          href={`https://stellar.expert/explorer/public/tx/${tx.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mono text-xs text-[#7c3aed] hover:text-[#6d28d9] hover:underline transition-colors"
          title={tx.hash}
        >
          {truncateAddress(tx.hash, 6)}
        </a>
      </TableCell>
      <TableCell className="mono text-xs text-[#6b6975]">{tx.ledger.toLocaleString()}</TableCell>
      <TableCell className="mono text-xs text-[#6b6975]">
        <span className="inline-flex items-center gap-1">
          <Link href={`/accounts/${tx.sourceAccount}`} className="hover:text-[#7c3aed] hover:underline transition-colors">
            {truncateAddress(tx.sourceAccount)}
          </Link>
          <WatchIndicator address={tx.sourceAccount} />
        </span>
      </TableCell>
      <TableCell>
        <span className="text-[11px] bg-[#f6f5f8] text-[#6b6975] px-1.5 py-0.5 rounded">{tx.operationCount}</span>
      </TableCell>
      <TableCell className="mono text-xs text-[#a6a3b0]">{formatXLM(fee)} XLM</TableCell>
      <TableCell className="text-xs text-[#c3c1cb]"><TimeAgo isoString={tx.createdAt} /></TableCell>
    </TableRow>
  );
}
