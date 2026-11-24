import type { CellValue, Row } from '@/lib/ops-desk';

/**
 * The value of one cell in a desk row, by its column key, or undefined when the row has no such cell. Pure, so browser code
 * (the protocol desk's blockers) reads rows with it as well as the ops desk's own model; it lives outside both features
 * because the ops desk's entry is server-only.
 */
export function cellOfRow(row: Row, key: string): CellValue | undefined {
  return row.cells.find((c) => c.key === key)?.value;
}
