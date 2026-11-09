// Model picker logic — pure, no Ink/React. Unit-testable in isolation.
// The component (ModelPicker.tsx) only renders what these functions
// return; grouping, navigation and windowing live here.

import type { Catalog, CatalogEntry } from "../models.js";

export interface PickerGroup {
  title: "FREE" | "PAID";
  entries: CatalogEntry[];
}

/**
 * Group the live catalog: FREE first, then PAID sorted by input price
 * (cheapest first; entries without a price go last). Paid models are
 * shown, never hidden — a free user just sees the price label.
 */
export function groupCatalog(catalog: Catalog): PickerGroup[] {
  const free = catalog.entries.filter((e) => e.free);
  const paid = catalog.entries
    .filter((e) => !e.free)
    .sort((a, b) => {
      const pa = a.price?.input ?? Number.POSITIVE_INFINITY;
      const pb = b.price?.input ?? Number.POSITIVE_INFINITY;
      return pa - pb;
    });
  const groups: PickerGroup[] = [];
  if (free.length > 0) groups.push({ title: "FREE", entries: free });
  if (paid.length > 0) groups.push({ title: "PAID", entries: paid });
  return groups;
}

/** Flatten grouped entries back into one list (the picker's nav order). */
export function flattenGroups(groups: PickerGroup[]): CatalogEntry[] {
  return groups.flatMap((g) => g.entries);
}

/** Next selection, wrapping around the combined list. -1 when empty. */
export function pickerNext(selected: number, total: number): number {
  if (total <= 0) return -1;
  return (selected + 1) % total;
}

/** Previous selection, wrapping around the combined list. -1 when empty. */
export function pickerPrev(selected: number, total: number): number {
  if (total <= 0) return -1;
  return (selected - 1 + total) % total;
}

export interface VisibleWindow {
  /** First visible index (inclusive). */
  start: number;
  /** One past the last visible index (exclusive). */
  end: number;
}

/**
 * A paid model is LOCKED while the balance is exactly $0 (Freebuff
 * model selector: paid rows without a plan are LOCKED; the first Enter
 * explains, the second opens the plans page). `balanceUsd === null`
 * means unknown — never lock on an unknown balance. Free models are
 * never locked.
 */
export function isLocked(entry: CatalogEntry, balanceUsd: number | null): boolean {
  return !entry.free && balanceUsd !== null && balanceUsd <= 0;
}

/** Explanation shown on the first Enter on a LOCKED row. */
export function lockedExplanation(entry: CatalogEntry): string {
  const price = entry.price
    ? `$${entry.price.input.toFixed(2)} / $${entry.price.output.toFixed(2)} per 1M`
    : "paid model";
  return (
    `${entry.id} is a paid model (${price}) and your balance is $0.00. ` +
    `Top up first to use it — press Enter again to open the top-up page, or Esc to pick another model.`
  );
}

/**
 * Scrolling window so the selected row is always visible.
 * Window size is min(maxRows, total). Stateless page anchoring: the
 * window only moves when the selection crosses a page boundary, so the
 * list stays stable while moving inside one page.
 */
export function visibleWindow(total: number, selected: number, maxRows: number): VisibleWindow {
  if (total <= 0 || maxRows <= 0) return { start: 0, end: 0 };
  const size = Math.min(maxRows, total);
  const sel = Math.max(0, Math.min(selected, total - 1));
  const start = Math.min(Math.floor(sel / size) * size, total - size);
  return { start, end: start + size };
}
