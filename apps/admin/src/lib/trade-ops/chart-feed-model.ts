/**
 * Feed source and symbol control for the chart (C-ops-03 (b)(c), J-charts-desk-19 #2 #3 #4): what svc-trade
 * `admin.chartFeedControls.*` answers, parsed, and the words the page uses. Client-safe, no network.
 *
 * svc-trade decides every change and its effect; this file only reads it. A value the service did not send is never
 * filled in: a blank fallback list reads "not set", and the page says what each state really does.
 */

export const CHART_FEED_STATES = ['on', 'disabled', 'delisted_with_history'] as const;
export type ChartFeedState = (typeof CHART_FEED_STATES)[number];

export const CHART_FEED_ACTION_KINDS = ['switch_source', 'disable', 'enable', 'delist_with_history'] as const;
export type ChartFeedActionKind = (typeof CHART_FEED_ACTION_KINDS)[number];

export type ChartFeedAction =
  | { readonly kind: 'switch_source'; readonly to: string }
  | { readonly kind: 'disable' }
  | { readonly kind: 'enable' }
  | { readonly kind: 'delist_with_history' };

export const PRIMARY_SOURCE = 'primary';
export const CHART_FEED_ACTION_TYPE = 'trade.chart_feed_control';
export const CHART_FEED_TARGET_SERVICE = 'svc-trade';
/** Identity stores the policy version and does not check it; svc-trade binds the hash, the target and the version. */
export const CHART_FEED_POLICY_VERSION = 'trade-chart-feed-control-v1';

export interface ChartFeedMarket {
  readonly symbol: string;
  readonly test: boolean;
  readonly source: string;
  readonly state: ChartFeedState;
  readonly version: string;
  readonly delistedAt: string | null;
  readonly updatedAt: string | null;
}

export interface ChartFeedControlRow {
  readonly id: string;
  readonly symbol: string;
  readonly action: ChartFeedActionKind;
  readonly fromSource: string;
  readonly toSource: string;
  readonly fromState: ChartFeedState;
  readonly toState: ChartFeedState;
  readonly version: string;
  readonly reason: string;
  readonly proposerId: string;
  readonly approverId: string;
  readonly executorId: string;
  readonly approvalId: string;
  readonly at: string;
}

export interface ChartFeedControlsView {
  readonly asOf: string;
  readonly fallbackSources: readonly string[] | null;
  readonly exportRowLimit: number | null;
  readonly canWrite: boolean;
  readonly markets: readonly ChartFeedMarket[];
  readonly journal: readonly ChartFeedControlRow[];
}

export interface ChartFeedPrepared {
  readonly symbol: string;
  readonly action: ChartFeedAction;
  readonly expectedVersion: string;
  readonly reason: string;
  readonly from: { readonly source: string; readonly state: ChartFeedState };
  readonly to: { readonly source: string; readonly state: ChartFeedState };
  readonly payloadHash: string;
}

export interface ChartFeedApplied {
  readonly market: ChartFeedMarket;
  readonly control: ChartFeedControlRow;
}

export interface ChartFeedExport {
  readonly asOf: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly rowLimit: number;
  readonly rows: readonly ChartFeedControlRow[];
}

export const STATE_LABEL: Readonly<Record<ChartFeedState, string>> = {
  on: 'On',
  disabled: 'Disabled',
  delisted_with_history: 'Delisted, history kept',
};

/** What each state really does to the chart's candle read, in svc-trade (`candleGateOf`). Nothing more is claimed. */
export const STATE_EFFECT: Readonly<Record<ChartFeedState, string>> = {
  on: 'The chart reads candles from its source.',
  disabled: 'The candle read for this market refuses (trade.chart_feed.disabled). Trading is not touched.',
  delisted_with_history: 'The chart keeps the candles that opened before the delisting and gets none after it. Trading is not touched.',
};

export const ACTION_LABEL: Readonly<Record<ChartFeedActionKind, string>> = {
  switch_source: 'Switch the feed source',
  disable: 'Disable the chart feed',
  enable: 'Enable the chart feed',
  delist_with_history: 'Mark delisted, keep history',
};

export function sourceLabel(source: string): string {
  return source === PRIMARY_SOURCE ? 'primary (INTAFACED trade tape)' : source;
}

export const FALLBACK_NOT_SET =
  "The owner's fallback source list is not set, so no chart feed can be switched to a fallback. Switching back to primary still works.";

export const FALLBACK_NOT_CONNECTED =
  'No adapter for a fallback source is connected on this deployment: a chart switched to one refuses its candle read rather than show INTAFACED trades under another name.';

/** A reason the service keeps in the journal and the audit: 12 to 500 characters here, svc-trade's own floor is 3. */
export const reasonReady = (reason: string): boolean => {
  const n = reason.trim().length;
  return n >= 12 && n <= 500;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isState = (v: unknown): v is ChartFeedState => (CHART_FEED_STATES as readonly unknown[]).includes(v);
const isKind = (v: unknown): v is ChartFeedActionKind => (CHART_FEED_ACTION_KINDS as readonly unknown[]).includes(v);

function parseMarket(raw: unknown): ChartFeedMarket | null {
  if (!isObj(raw) || !str(raw.symbol) || typeof raw.test !== 'boolean' || !str(raw.source) || !isState(raw.state)) return null;
  if (!str(raw.version) || !strOrNull(raw.delistedAt) || !strOrNull(raw.updatedAt)) return null;
  return {
    symbol: raw.symbol,
    test: raw.test,
    source: raw.source,
    state: raw.state,
    version: raw.version,
    delistedAt: raw.delistedAt,
    updatedAt: raw.updatedAt,
  };
}

function parseControl(raw: unknown): ChartFeedControlRow | null {
  if (!isObj(raw) || !isKind(raw.action) || !isState(raw.fromState) || !isState(raw.toState)) return null;
  const texts = [
    'id',
    'symbol',
    'fromSource',
    'toSource',
    'version',
    'reason',
    'proposerId',
    'approverId',
    'executorId',
    'approvalId',
    'at',
  ];
  if (!texts.every((k) => str(raw[k]))) return null;
  return {
    id: raw.id as string,
    symbol: raw.symbol as string,
    action: raw.action,
    fromSource: raw.fromSource as string,
    toSource: raw.toSource as string,
    fromState: raw.fromState,
    toState: raw.toState,
    version: raw.version as string,
    reason: raw.reason as string,
    proposerId: raw.proposerId as string,
    approverId: raw.approverId as string,
    executorId: raw.executorId as string,
    approvalId: raw.approvalId as string,
    at: raw.at as string,
  };
}

function all<T>(raw: unknown, parse: (r: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(parse);
  return out.some((r) => r === null) ? null : (out as T[]);
}

export function parseChartFeedControlsView(raw: unknown): ChartFeedControlsView | null {
  if (!isObj(raw) || !str(raw.asOf) || typeof raw.canWrite !== 'boolean') return null;
  const fallback = raw.fallbackSources;
  if (!(fallback === null || (Array.isArray(fallback) && fallback.every(str)))) return null;
  if (!(raw.exportRowLimit === null || (typeof raw.exportRowLimit === 'number' && Number.isInteger(raw.exportRowLimit)))) return null;
  const markets = all(raw.markets, parseMarket);
  const journal = all(raw.journal, parseControl);
  if (!markets || !journal) return null;
  return {
    asOf: raw.asOf,
    fallbackSources: fallback as string[] | null,
    exportRowLimit: raw.exportRowLimit as number | null,
    canWrite: raw.canWrite,
    markets,
    journal,
  };
}

function parseAction(raw: unknown): ChartFeedAction | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'switch_source') return str(raw.to) ? { kind: 'switch_source', to: raw.to } : null;
  if (raw.kind === 'disable' || raw.kind === 'enable' || raw.kind === 'delist_with_history') return { kind: raw.kind };
  return null;
}

const parseSide = (raw: unknown) => (isObj(raw) && str(raw.source) && isState(raw.state) ? { source: raw.source, state: raw.state } : null);

export function parseChartFeedPrepared(raw: unknown): ChartFeedPrepared | null {
  if (!isObj(raw) || !str(raw.symbol) || !str(raw.expectedVersion) || !str(raw.reason) || !str(raw.payloadHash)) return null;
  const action = parseAction(raw.action);
  const from = parseSide(raw.from);
  const to = parseSide(raw.to);
  if (!action || !from || !to || !/^sha256:[0-9a-f]{64}$/.test(raw.payloadHash)) return null;
  return { symbol: raw.symbol, action, expectedVersion: raw.expectedVersion, reason: raw.reason, from, to, payloadHash: raw.payloadHash };
}

export function parseChartFeedApplied(raw: unknown): ChartFeedApplied | null {
  if (!isObj(raw)) return null;
  const market = parseMarket(raw.market);
  const control = parseControl(raw.control);
  return market && control ? { market, control } : null;
}

export function parseChartFeedExport(raw: unknown): ChartFeedExport | null {
  if (!isObj(raw) || !str(raw.asOf) || !strOrNull(raw.from) || !strOrNull(raw.to) || typeof raw.rowLimit !== 'number') return null;
  const rows = all(raw.rows, parseControl);
  return rows ? { asOf: raw.asOf, from: raw.from, to: raw.to, rowLimit: raw.rowLimit, rows } : null;
}

/** An action from the page's form: a known kind, and a source name only on a switch. */
export function actionOf(kind: unknown, to: unknown): ChartFeedAction | null {
  if (kind === 'switch_source') {
    return typeof to === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(to.trim()) ? { kind, to: to.trim() } : null;
  }
  if (kind === 'disable' || kind === 'enable' || kind === 'delist_with_history') return { kind };
  return null;
}

/** One line for a journal row: "primary, On → test-backup, On". */
export function changeText(r: Pick<ChartFeedControlRow, 'fromSource' | 'fromState' | 'toSource' | 'toState'>): string {
  return `${r.fromSource}, ${STATE_LABEL[r.fromState]} → ${r.toSource}, ${STATE_LABEL[r.toState]}`;
}

// ── The audit file ────────────────────────────────────────────────────────────

export const CHART_CONTROL_COLUMNS = [
  'time',
  'symbol',
  'action',
  'from_source',
  'to_source',
  'from_state',
  'to_state',
  'reason',
  'proposed_by',
  'approved_by',
  'applied_by',
  'approval_id',
  'version',
] as const;

/** Each applied change as a file row: who proposed, approved and applied it, and when (UTC ISO). */
export function chartControlRows(rows: readonly ChartFeedControlRow[]): string[][] {
  return rows.map((r) => [
    r.at,
    r.symbol,
    r.action,
    r.fromSource,
    r.toSource,
    r.fromState,
    r.toState,
    r.reason,
    r.proposerId,
    r.approverId,
    r.executorId,
    r.approvalId,
    r.version,
  ]);
}
