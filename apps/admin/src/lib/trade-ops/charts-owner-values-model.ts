/**
 * Charts module owner values (C-ops-04, LD-14): what the founder page shows and what it may send. Client-safe.
 *
 * No number is held here. A count that is not set reads as "Not set"; the page sends what was typed and shows the
 * service's own refusal, so the bounds stay in svc-trade, the one place that enforces them. A blank field clears a
 * value back to not set. The data class is the one value that needs a second founder.
 */

export const CHART_SCALAR_KEYS = [
  'compareCap',
  'chartCountLimit',
  'drawingCap',
  'brushPointCap',
  'delayedBoundarySeconds',
  'renderBudgetMs',
] as const;
export type ChartScalarKey = (typeof CHART_SCALAR_KEYS)[number];

export interface ChartScalarInfo {
  readonly key: ChartScalarKey;
  readonly label: string;
  /** What the owner is setting, in one line. */
  readonly meaning: string;
}

export const CHART_SCALARS: readonly ChartScalarInfo[] = [
  { key: 'compareCap', label: 'Compare cap', meaning: 'Symbols a person can add to one chart.' },
  { key: 'chartCountLimit', label: 'Chart count limit', meaning: 'Charts on one workbench grid.' },
  { key: 'drawingCap', label: 'Drawing cap', meaning: 'Drawings per workbench and symbol.' },
  { key: 'brushPointCap', label: 'Brush point cap', meaning: 'Points in one brush stroke.' },
  {
    key: 'delayedBoundarySeconds',
    label: 'Delayed boundary (seconds)',
    meaning: 'Age of the newest candle after which a stream reads "delayed".',
  },
  {
    key: 'renderBudgetMs',
    label: 'Render budget (ms)',
    meaning: 'Longest single main-thread task the chart may hold while ticks stream.',
  },
];

export const CHART_DATA_CLASSES = ['real_time', 'delayed', 'end_of_day'] as const;
export type ChartDataClass = (typeof CHART_DATA_CLASSES)[number];

export const DATA_CLASS_LABEL: Readonly<Record<ChartDataClass, string>> = {
  real_time: 'Real time',
  delayed: 'Delayed',
  end_of_day: 'End of day',
};

export const CHART_DATA_CLASS_ACTION_TYPE = 'trade.chart_data_class_set';
export const CHART_DATA_CLASS_TARGET_SERVICE = 'svc-trade';
export const CHART_DATA_CLASS_POLICY_VERSION = 'trade-chart-data-class-v1';

export interface ChartScalarsView {
  /** Null until the first write. */
  readonly version: string | null;
  readonly values: Readonly<Record<ChartScalarKey, number | null>>;
  readonly operatorId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export interface ChartDataClassRow {
  readonly symbol: string;
  readonly version: string | null;
  readonly dataClass: ChartDataClass | null;
  readonly operatorId: string | null;
  readonly approverId: string | null;
  readonly updatedAt: string | null;
}

export interface ChartOwnerValuesView {
  /** The caller's own admin:write scope, as svc-trade verified it. False renders the page read-only. */
  readonly canWrite: boolean;
  readonly scalars: ChartScalarsView;
  readonly dataClasses: readonly ChartDataClassRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined);
const isDataClass = (v: unknown): v is ChartDataClass => typeof v === 'string' && (CHART_DATA_CLASSES as readonly string[]).includes(v);

/** The wire shape svc-trade returns from `admin.chartOwnerValues.get` and `.set`. Null when it is not that shape. */
export function parseChartOwnerValuesView(raw: unknown): ChartOwnerValuesView | null {
  if (!isRecord(raw) || typeof raw.canWrite !== 'boolean') return null;
  const scalars = isRecord(raw.scalars) ? raw.scalars : null;
  const values = scalars && isRecord(scalars.values) ? scalars.values : null;
  if (!scalars || !values) return null;
  const version = nullableString(scalars.version);
  const operatorId = nullableString(scalars.operatorId);
  const reason = nullableString(scalars.reason);
  const updatedAt = nullableString(scalars.updatedAt);
  if (version === undefined || operatorId === undefined || reason === undefined || updatedAt === undefined) return null;
  const parsedValues = {} as Record<ChartScalarKey, number | null>;
  for (const key of CHART_SCALAR_KEYS) {
    const v = values[key];
    if (v !== null && (typeof v !== 'number' || !Number.isSafeInteger(v))) return null;
    parsedValues[key] = v;
  }
  if (!Array.isArray(raw.dataClasses)) return null;
  const dataClasses: ChartDataClassRow[] = [];
  for (const row of raw.dataClasses) {
    if (!isRecord(row) || typeof row.symbol !== 'string') return null;
    const rowVersion = nullableString(row.version);
    const rowOperator = nullableString(row.operatorId);
    const rowApprover = nullableString(row.approverId);
    const rowUpdated = nullableString(row.updatedAt);
    if (rowVersion === undefined || rowOperator === undefined || rowApprover === undefined || rowUpdated === undefined) return null;
    if (row.dataClass !== null && !isDataClass(row.dataClass)) return null;
    dataClasses.push({
      symbol: row.symbol,
      version: rowVersion,
      dataClass: row.dataClass,
      operatorId: rowOperator,
      approverId: rowApprover,
      updatedAt: rowUpdated,
    });
  }
  return {
    canWrite: raw.canWrite,
    scalars: { version, values: parsedValues, operatorId, reason, updatedAt },
    dataClasses,
  };
}

export type WholeNumberText = { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly message: string };

/**
 * A typed count. Blank clears the value (null). Anything else must be digits only; the service decides the bound and
 * refuses 0 or an over-large count by its own schema, so this check is only about the characters typed.
 */
export function parseWholeNumberText(text: string): WholeNumberText {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: 'Enter a whole number, or leave it blank to clear the value.' };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, message: 'That number is too large to store.' };
  return { ok: true, value };
}

/** A reason is the audit's sentence. The page asks for this many characters before it enables a write. */
export const CHART_REASON_MIN = 12;

export function reasonReady(reason: string): boolean {
  return reason.trim().length >= CHART_REASON_MIN;
}

export function scalarText(value: number | null): string {
  return value === null ? 'Not set' : String(value);
}

/** Why a write is not offered to a caller who may only read. Shown on the disabled control, never as a silent gap. */
export const READ_ONLY_TEXT = 'Read only: this account can see these values but cannot change them.';

/** The text the form starts from: a set count as its digits, a blank count as an empty field. */
export function typedText(values: Readonly<Record<ChartScalarKey, number | null>>): Record<ChartScalarKey, string> {
  const out = {} as Record<ChartScalarKey, string>;
  for (const key of CHART_SCALAR_KEYS) out[key] = values[key] === null ? '' : String(values[key]);
  return out;
}

export function dataClassText(dataClass: ChartDataClass | null): string {
  return dataClass === null ? 'Not set' : DATA_CLASS_LABEL[dataClass];
}
