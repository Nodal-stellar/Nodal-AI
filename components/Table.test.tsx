// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import {
  Table,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "./Table";

afterEach(cleanup);

/** The shape all three real call sites use: a head row and one body row. */
const sample = (
  <>
    <TableHead>
      <tr>
        <TableHeaderCell>Hash</TableHeaderCell>
        <TableHeaderCell>Ledger</TableHeaderCell>
      </tr>
    </TableHead>
    <TableBody>
      <TableRow>
        <TableCell>abc</TableCell>
        <TableCell className="mono">1</TableCell>
      </TableRow>
    </TableBody>
  </>
);

const headOnly = (
  <TableHead>
    <tr>
      <TableHeaderCell>Hash</TableHeaderCell>
      <TableHeaderCell>Ledger</TableHeaderCell>
    </tr>
  </TableHead>
);

describe("Table", () => {
  it("names the table after its caption, so the headers are announced in context", () => {
    render(
      <Table caption="Account transactions" columnCount={2}>
        {sample}
      </Table>,
    );

    expect(
      screen.getByRole("table", { name: "Account transactions" }),
    ).toBeTruthy();
  });

  it("associates every header cell with the column it describes", () => {
    render(
      <Table caption="Account transactions" columnCount={2}>
        {sample}
      </Table>,
    );

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.getAttribute("scope")).toBe("col");
    }
  });

  it("makes the overflow area a named region that the keyboard can scroll", () => {
    const { container } = render(
      <Table caption="Account transactions" columnCount={2}>
        {sample}
      </Table>,
    );

    const region = screen.getByRole("region", { name: "Account transactions" });
    expect(region).toBe(container.querySelector('[role="region"]'));
    // Without a tab stop the horizontal overflow is pointer-only.
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toContain("overflow-x-auto");
    expect(region.querySelector("table")).not.toBeNull();
  });

  it("publishes aria-busy only while the rows are being replaced", () => {
    const { rerender } = render(
      <Table caption="Account transactions" columnCount={2} busy>
        {sample}
      </Table>,
    );
    expect(screen.getByRole("region").getAttribute("aria-busy")).toBe("true");

    rerender(
      <Table caption="Account transactions" columnCount={2}>
        {sample}
      </Table>,
    );
    expect(screen.getByRole("region").getAttribute("aria-busy")).toBeNull();
  });

  it("reports an empty list as a spanned row rather than an empty grid", () => {
    render(
      <Table
        caption="Account transactions"
        columnCount={2}
        emptyMessage="No transactions yet."
      >
        {headOnly}
      </Table>,
    );

    // The header row plus the one status row.
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(2);
    const statusCell = within(rows[1]).getByRole("cell");
    expect(statusCell.getAttribute("colspan")).toBe("2");
    expect(screen.getByText("No transactions yet.")).toBeTruthy();
  });

  it("keeps the shared row and cell styling in one place", () => {
    render(
      <Table caption="Account transactions" columnCount={2}>
        {sample}
      </Table>,
    );

    const [, body] = screen.getAllByRole("rowgroup");
    const row = within(body).getByRole("row");
    expect(row.className).toContain("last:border-0");

    const cells = within(row).getAllByRole("cell");
    expect(cells[0].className).toContain("py-2.5");
    // Caller classes are additive, not a replacement.
    expect(cells[1].className).toContain("mono");
    expect(cells[1].className).toContain("py-2.5");
  });

  it("pins the header only when asked", () => {
    const { rerender } = render(
      <Table caption="Transactions" columnCount={2} stickyHeader>
        {sample}
      </Table>,
    );
    expect(screen.getAllByRole("rowgroup")[0].className).toContain("sticky");

    rerender(
      <Table caption="Transactions" columnCount={2}>
        {sample}
      </Table>,
    );
    expect(screen.getAllByRole("rowgroup")[0].className).not.toContain(
      "sticky",
    );
  });

  it("lets a caller cap the scroll area without losing the region semantics", () => {
    render(
      <Table
        caption="Transactions"
        columnCount={2}
        containerClassName="rounded-xl overflow-auto max-h-[70vh]"
        data-testid="transaction-scroll"
      >
        {sample}
      </Table>,
    );

    const region = screen.getByTestId("transaction-scroll");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.className).toBe("rounded-xl overflow-auto max-h-[70vh]");
  });

  it("keeps trailing content inside the scrolling region", () => {
    render(
      <Table
        caption="Transactions"
        columnCount={2}
        afterTable={<div data-testid="scroll-sentinel" />}
      >
        {sample}
      </Table>,
    );

    expect(
      within(screen.getByRole("region")).getByTestId("scroll-sentinel"),
    ).toBeTruthy();
  });

  it("gives a list with nothing at all a reason instead of a table", () => {
    render(<TableEmptyState>No transactions yet.</TableEmptyState>);

    expect(screen.getByText("No transactions yet.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
