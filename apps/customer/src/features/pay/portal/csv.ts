/**
 * CSV for the lists a merchant is looking at (B15). Only the rows on screen go in, and every row carries the time the
 * file was made and the time the data was read, so a file kept for months still says how old its numbers are.
 * Cells that a spreadsheet would run as a formula are neutralised with a leading quote.
 */
const FORMULA_START = /^[=+@\t\r-]/;
export function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  const safe = FORMULA_START.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function buildCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  meta: { generatedAt: string; asOf: string },
) {
  const all = [[...headers, 'generated_at', 'as_of'], ...rows.map((r) => [...r, meta.generatedAt, meta.asOf])];
  return all.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
/** Hands the text to the browser as a file. Nothing is uploaded anywhere. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
