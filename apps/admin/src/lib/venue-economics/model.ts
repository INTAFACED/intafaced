/**
 * Pure model of the venue unit-economics room (RC-cex-spot-07): the cost categories, the entry form's checks and the CSV.
 * No Node-only imports, so the form in the browser and the page on the server read the same words.
 *
 * The category list repeats `OPS_COST_CATEGORIES` in packages/contracts because the contracts root is not a browser entry;
 * `model.test.ts` pins the two together.
 */

export const COST_CATEGORIES = [
  'liquidity',
  'insurance_default_capital',
  'custody',
  'data',
  'support',
  'compliance',
  'infrastructure',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const CATEGORY_LABEL: Readonly<Record<CostCategory, string>> = {
  liquidity: 'Liquidity',
  insurance_default_capital: 'Insurance and default capital',
  custody: 'Custody',
  data: 'Data',
  support: 'Support',
  compliance: 'Compliance',
  infrastructure: 'Infrastructure',
};

export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const COST_AMOUNT = /^\d+(\.\d{1,18})?$/;
export const COST_ASSET = /^[A-Z0-9]{2,12}$/;

/** The wire form svc-ops stores and hashes: trailing zeros after the point are dropped (`12.50` is `12.5`, `0.0` is `0`). */
export function normaliseCostAmount(amount: string): string {
  if (!amount.includes('.')) return amount;
  const trimmed = amount.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

export function isCategory(value: unknown): value is CostCategory {
  return typeof value === 'string' && (COST_CATEGORIES as readonly string[]).includes(value);
}

/** The month a page opens on when none is asked for: the one the clock is in (UTC). */
export function currentPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `?period=` as a valid month, or null. Nothing else is passed to the service. */
export function periodFromQuery(raw: string | string[] | undefined): string | null {
  return typeof raw === 'string' && PERIOD.test(raw) ? raw : null;
}

export interface EntryDraft {
  readonly period: string;
  readonly category: string;
  readonly amount: string;
  readonly asset: string;
}

/** Why the entry form cannot send, in words, or null. The service checks again and refuses with its own code. */
export function entryProblem(draft: EntryDraft): string | null {
  if (!PERIOD.test(draft.period)) return 'Choose a month, like 2026-10.';
  if (!isCategory(draft.category)) return 'Choose one of the seven cost lines.';
  if (draft.amount.trim() === '') return 'Enter the amount as a number, for example 1250.50.';
  if (!COST_AMOUNT.test(draft.amount.trim()))
    return 'The amount is a plain number with up to 18 decimals and no minus sign, comma or currency symbol.';
  if (!COST_ASSET.test(draft.asset.trim())) return 'Enter the currency or asset code in capitals, for example USD.';
  return null;
}

export interface CostEntryView {
  readonly key: string;
  readonly version: number;
  readonly amount: string;
  readonly asset: string;
  readonly sourceNote: string;
  readonly enteredBy: string;
  readonly approverId: string;
  readonly enteredAt: string;
}

export interface CostLineView {
  readonly status: 'entered' | 'not_entered';
  readonly category: CostCategory;
  readonly current?: CostEntryView;
  readonly history?: readonly CostEntryView[];
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell as text: a leading = + - @ is guarded so a spreadsheet does not run it, and edge characters are quoted. */
export function csvCell(text: string): string {
  const guarded = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) || guarded !== guarded.trim() ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const CSV_HEADER = [
  'period',
  'category',
  'status',
  'version',
  'amount',
  'asset',
  'source_note',
  'entered_by',
  'approved_by',
  'entered_at',
  'is_current',
] as const;

/**
 * Every version of every line for the month, one row each, oldest first within a category. A line nobody entered is one row
 * with status not_entered and empty cells, never a zero, so the file cannot be read as a complete month when it is not.
 */
export function venueCostsCsv(period: string, lines: readonly CostLineView[]): string {
  const rows: string[][] = [];
  for (const line of lines) {
    if (line.status === 'not_entered' || !line.history || line.history.length === 0) {
      rows.push([period, line.category, 'not_entered', '', '', '', '', '', '', '', '']);
      continue;
    }
    for (const e of line.history) {
      rows.push([
        period,
        line.category,
        'entered',
        String(e.version),
        e.amount,
        e.asset,
        e.sourceNote,
        e.enteredBy,
        e.approverId,
        e.enteredAt,
        e.version === line.current?.version ? 'yes' : 'no',
      ]);
    }
  }
  return [CSV_HEADER.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

export function venueCostsFilename(period: string, asOf: string): string {
  const ms = Date.parse(asOf);
  const when = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z' : 'time-unknown';
  return `venue-costs_${period}_as-of_${when}.csv`;
}
