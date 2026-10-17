/**
 * CSV export of the visible merchant list. Amounts stay decimal strings.
 * A cell that starts with = + - @ tab or CR is prefixed with an apostrophe, so
 * a spreadsheet never runs a merchant-supplied value as a formula.
 */

export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

export interface CsvExportInput {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly generatedAt: string;
  readonly asOf: string | null;
  readonly note?: string;
}

/** Leading comment lines carry the generated-at and as-of time (spec B15). */
export function buildCsv(input: CsvExportInput): string {
  const lines = [
    `# Generated at ${input.generatedAt}`,
    `# Data as of ${input.asOf ?? 'unknown'}`,
    ...(input.note ? [`# ${input.note.replace(/[\r\n]+/g, ' ')}`] : []),
    csvRow(input.header),
    ...input.rows.map(csvRow),
  ];
  return `${lines.join('\r\n')}\r\n`;
}
