/**
 * Feed source and symbol control for the chart (C-ops-03 (b)(c); J-charts-desk-19 #2 #3 #4).
 *
 *   admin.chartFeedControls.list     every spot market's chart feed: its source and chart state, and the control journal (admin:read)
 *   admin.chartFeedControls.prepare  check one change and answer the payload hash a second operator approves (admin:write, writes nothing)
 *   admin.chartFeedControls.run      apply one approved change (admin:write)                         `trade.chart_feed_control`
 *   admin.chartFeedControls.export   every applied change in a window, for the audit file (admin:read; audited)
 *
 * A market's chart feed has a source (`primary`, INTAFACED's own trade tape, or a name from the owner's fallback source
 * list) and one chart state: `on`, `disabled` or `delisted_with_history`. A change is one of four actions. Each consumes
 * identity's two-person approval (the proposer cannot approve their own), bound to the market, the version the operators
 * saw and the hash of exactly this change and its reason. The state, the journal row and the audit row are written in one
 * transaction: if any of them cannot be written, nothing changes. The approval id is the business key: a retry of an
 * applied change writes nothing new and answers the row it wrote.
 *
 * What a state does, and only that (floor 8): `disabled` refuses the market's candle read; `delisted_with_history` serves
 * candles from before the delisting and none after; a fallback source refuses the candle read while no adapter for it is
 * connected, because our own fills are never served under another source's name. The owner's fallback list and export
 * row limit are owner values: blank refuses by name, never a default.
 *
 * Money: none. No ledger recipe is imported here.
 */
import type { PendingQuery, Row, Sql } from 'postgres';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import {
  consumeApproval,
  OPERATOR_WRITE_PERMISSION,
  payloadHash,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';

export const CHART_FEED_CONTROL_ACTION = 'trade.chart_feed_control' as const;
export const CHART_FEED_AUDIT_KIND = 'chart_feed.control' as const;
export const CHART_FEED_EXPORT_AUDIT_KIND = 'chart_feed.export' as const;

/** INTAFACED's own trade tape: the candle stream `spot/candles.ts` aggregates. Every market starts here. */
export const PRIMARY_SOURCE = 'primary' as const;

export const CHART_FEED_STATES = ['on', 'disabled', 'delisted_with_history'] as const;
export type ChartFeedState = (typeof CHART_FEED_STATES)[number];

export const CHART_FEED_ACTION_KINDS = ['switch_source', 'disable', 'enable', 'delist_with_history'] as const;
export type ChartFeedActionKind = (typeof CHART_FEED_ACTION_KINDS)[number];

export type ChartFeedAction =
  | { readonly kind: 'switch_source'; readonly to: string }
  | { readonly kind: 'disable' }
  | { readonly kind: 'enable' }
  | { readonly kind: 'delist_with_history' };

/** A source name, as the owner's list and the database both hold it. */
export const SOURCE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const CHART_FEED_FALLBACK_UNSET = 'trade.chart_feed.fallback_sources_unset' as const;
export const CHART_FEED_SOURCE_UNKNOWN = 'trade.chart_feed.source_unknown' as const;
export const CHART_FEED_NO_CHANGE = 'trade.chart_feed.no_change' as const;
export const CHART_FEED_DELISTED = 'trade.chart_feed.delisted' as const;
export const CHART_FEED_STALE = 'trade.chart_feed.stale' as const;
export const CHART_FEED_NOT_WRITTEN = 'trade.chart_feed.not_written' as const;
export const CHART_FEED_APPROVAL_SPENT = 'trade.chart_feed.approval_spent' as const;
export const CHART_FEED_EXPORT_LIMIT_UNSET = 'trade.chart_feed.export_row_limit_unset' as const;
export const CHART_FEED_EXPORT_OVER_LIMIT = 'trade.chart_feed.export_over_limit' as const;
/** The candle read's two refusals. */
export const CHART_FEED_DISABLED = 'trade.chart_feed.disabled' as const;
export const CHART_FEED_SOURCE_NOT_CONNECTED = 'trade.chart_feed.source_not_connected' as const;

/** Most journal rows the list answers, newest first. A bound on the answer, not an owner value. */
const JOURNAL_LIST_MAX = 200;
const MAX_MARKETS = 500;

/** The owner values this desk enforces; null is not set. */
export interface ChartFeedOwnerValues {
  /** TRADE_CHART_FEED_FALLBACK_SOURCES, parsed. Null (blank or malformed): every switch to a fallback refuses. */
  readonly fallbackSources: readonly string[] | null;
  /** TRADE_CHART_CONTROL_EXPORT_ROW_LIMIT, parsed. Null: every export refuses. */
  readonly exportRowLimit: number | null;
}

/** A comma list of source names. Blank, a malformed name, a duplicate or `primary` itself: null, not set. */
export function parseFallbackSources(raw: string | undefined): readonly string[] | null {
  const text = raw?.trim() ?? '';
  if (text === '') return null;
  const names = text.split(',').map((n) => n.trim());
  if (names.some((n) => !SOURCE_NAME.test(n) || n === PRIMARY_SOURCE)) return null;
  if (new Set(names).size !== names.length) return null;
  return Object.freeze(names);
}

/** A whole number from 1 to 1,000,000; anything else is not set. */
export function parseExportRowLimit(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^[1-9]\d{0,6}$/.test(text)) return null;
  const n = Number(text);
  return n <= 1_000_000 ? n : null;
}

export interface ChartFeedSetting {
  readonly source: string;
  readonly state: ChartFeedState;
  /** `0` while no change was ever applied. */
  readonly version: string;
  readonly delistedAt: string | null;
  readonly updatedAt: string | null;
}

export const DEFAULT_SETTING: ChartFeedSetting = { source: PRIMARY_SOURCE, state: 'on', version: '0', delistedAt: null, updatedAt: null };

export interface ChartFeedMarket extends ChartFeedSetting {
  readonly symbol: string;
  readonly test: boolean;
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
  /** The caller's own `admin:write`, as svc-trade verified it. The service refuses a write without it regardless. */
  readonly canWrite: boolean;
  readonly markets: readonly ChartFeedMarket[];
  /** Newest first, up to JOURNAL_LIST_MAX. */
  readonly journal: readonly ChartFeedControlRow[];
}

export interface ChartFeedChangeInput {
  readonly symbol: string;
  readonly action: ChartFeedAction;
  readonly expectedVersion: string;
  readonly reason: string;
}

export interface ChartFeedPrepared {
  readonly actionType: typeof CHART_FEED_CONTROL_ACTION;
  readonly targetService: 'svc-trade';
  readonly targetId: string;
  readonly symbol: string;
  readonly action: ChartFeedAction;
  readonly expectedVersion: string;
  readonly reason: string;
  readonly from: { readonly source: string; readonly state: ChartFeedState };
  readonly to: { readonly source: string; readonly state: ChartFeedState };
  readonly payloadHash: string;
}

export interface ChartFeedApplyInput extends ChartFeedChangeInput {
  readonly approvalId: string;
  /** The approval's own operation id, which identity minted at propose: the consume is accepted only with it. */
  readonly operationId: string;
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
  /** Oldest first. */
  readonly rows: readonly ChartFeedControlRow[];
}

export interface ChartFeedControlsDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly owner: ChartFeedOwnerValues;
  readonly now: () => Date;
}

/** The hash identity's approval is bound to: exactly this change, on this market, at this version, for this reason. */
export function chartFeedPayloadHash(input: ChartFeedChangeInput): string {
  return payloadHash({
    actionType: CHART_FEED_CONTROL_ACTION,
    symbol: input.symbol,
    action: input.action,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
  });
}

/**
 * The setting one action leaves, or a typed refusal. Pure. A delisted chart takes only `enable`; a switch to a fallback
 * needs the owner's list and a name on it; a switch back to primary needs no list.
 */
export function nextChartFeed(
  current: { readonly source: string; readonly state: ChartFeedState },
  action: ChartFeedAction,
  fallbackSources: readonly string[] | null,
): { source: string; state: ChartFeedState } {
  const same = () => new TradeOpsError(CHART_FEED_NO_CHANGE, `the chart feed is already ${describe(current)}; nothing would change`);
  const delisted = () =>
    new TradeOpsError(CHART_FEED_DELISTED, 'the chart is marked delisted with history; enable it first to change its source or state');
  switch (action.kind) {
    case 'switch_source': {
      if (current.state === 'delisted_with_history') throw delisted();
      if (action.to === current.source) throw same();
      if (action.to !== PRIMARY_SOURCE) {
        if (fallbackSources === null) {
          throw new TradeOpsError(
            CHART_FEED_FALLBACK_UNSET,
            "the owner's fallback source list is not set (TRADE_CHART_FEED_FALLBACK_SOURCES), so no chart feed can switch to a fallback",
          );
        }
        if (!fallbackSources.includes(action.to)) {
          throw new TradeOpsError(CHART_FEED_SOURCE_UNKNOWN, `${action.to} is not on the owner's fallback source list`);
        }
      }
      return { source: action.to, state: current.state };
    }
    case 'disable':
      if (current.state === 'delisted_with_history') throw delisted();
      if (current.state === 'disabled') throw same();
      return { source: current.source, state: 'disabled' };
    case 'enable':
      if (current.state === 'on') throw same();
      return { source: current.source, state: 'on' };
    case 'delist_with_history':
      if (current.state === 'delisted_with_history') throw same();
      return { source: current.source, state: 'delisted_with_history' };
  }
}

function describe(s: { source: string; state: ChartFeedState }): string {
  return `${s.state.replaceAll('_', ' ')} on source ${s.source}`;
}

/** A change as the router hands it: a known action, and a source name only on a switch. */
export function parseChartFeedAction(raw: { kind: string; to?: string | null | undefined }): ChartFeedAction {
  if (raw.kind === 'switch_source') {
    const to = raw.to?.trim() ?? '';
    if (!SOURCE_NAME.test(to)) throw new TradeOpsError(CHART_FEED_SOURCE_UNKNOWN, 'choose the source to switch to');
    return { kind: 'switch_source', to };
  }
  if (raw.kind === 'disable' || raw.kind === 'enable' || raw.kind === 'delist_with_history') return { kind: raw.kind };
  throw new TradeOpsError('trade.chart_feed.action_unknown', 'the action must be switch_source, disable, enable or delist_with_history');
}

const StateRow = z.object({
  source: z.string(),
  state: z.enum(CHART_FEED_STATES),
  version: z.string(),
  delisted_at: z.date().nullable(),
  updated_at: z.date(),
});
type StateRow = z.infer<typeof StateRow>;

function settingOf(row: StateRow | undefined): ChartFeedSetting {
  if (!row) return DEFAULT_SETTING;
  return {
    source: row.source,
    state: row.state,
    version: row.version,
    delistedAt: row.delisted_at ? row.delisted_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One market's chart feed setting; a market never changed reads primary, on, version 0. */
export async function readChartFeedSetting(sql: Sql, symbol: string): Promise<ChartFeedSetting> {
  const [row] = StateRow.array().parse(
    await sql`SELECT source, state, version::text AS version, delisted_at, updated_at FROM trade.chart_feed_state WHERE symbol = ${symbol}`,
  );
  return settingOf(row);
}

const ControlRow = z.object({
  id: z.string(),
  symbol: z.string(),
  action: z.enum(CHART_FEED_ACTION_KINDS),
  from_source: z.string(),
  to_source: z.string(),
  from_state: z.enum(CHART_FEED_STATES),
  to_state: z.enum(CHART_FEED_STATES),
  version: z.string(),
  reason: z.string(),
  proposer_id: z.string(),
  approver_id: z.string(),
  executor_id: z.string(),
  approval_id: z.string(),
  at: z.date(),
});
type ControlRow = z.infer<typeof ControlRow>;

function controlView(r: ControlRow): ChartFeedControlRow {
  return {
    id: r.id,
    symbol: r.symbol,
    action: r.action,
    fromSource: r.from_source,
    toSource: r.to_source,
    fromState: r.from_state,
    toState: r.to_state,
    version: r.version,
    reason: r.reason,
    proposerId: r.proposer_id,
    approverId: r.approver_id,
    executorId: r.executor_id,
    approvalId: r.approval_id,
    at: r.at.toISOString(),
  };
}

/** Journal rows matching `where` (a fragment of `sql`), in `order`, parsed. */
async function readControls(sql: Sql, where: PendingQuery<Row[]>, order: PendingQuery<Row[]>): Promise<ChartFeedControlRow[]> {
  const rows = await sql`
    SELECT id::text AS id, symbol, action, from_source, to_source, from_state, to_state, version::text AS version,
           reason, proposer_id, approver_id, executor_id, approval_id, at
      FROM trade.chart_feed_controls ${where} ${order}`;
  return ControlRow.array().parse(rows).map(controlView);
}

const MarketRow = z.object({
  symbol: z.string(),
  test: z.boolean(),
  source: z.string().nullable(),
  state: z.enum(CHART_FEED_STATES).nullable(),
  version: z.string().nullable(),
  delisted_at: z.date().nullable(),
  updated_at: z.date().nullable(),
});

const CountRow = z.object({ n: z.string() });
const SymbolRow = z.object({ symbol: z.string(), test: z.boolean() });

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function requireSymbol(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64)
    throw new TradeOpsError('trade.chart_feed.symbol_invalid', 'symbol is required (1-64 chars)');
  return trimmed;
}

function requireVersion(value: string): string {
  if (!/^(?:0|[1-9]\d{0,17})$/.test(value)) throw new TradeOpsError(CHART_FEED_STALE, 'expectedVersion must be a whole number');
  return value;
}

function requireApprovalId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new TradeOpsError('approval_required', 'approvalId is required: a chart feed change needs a second operator');
  }
  return trimmed;
}

function isoOrNull(value: string | null | undefined, label: string): string | null {
  const text = value?.trim() ?? '';
  if (text === '') return null;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) throw new TradeOpsError('trade.chart_feed.window_invalid', `${label} is not a time`);
  return at.toISOString();
}

export class ChartFeedControlsAdmin {
  constructor(private readonly deps: ChartFeedControlsDeps) {}

  async list(principal: Principal): Promise<ChartFeedControlsView> {
    requireOperator(principal);
    const { sql } = this.deps;
    const markets = MarketRow.array().parse(
      await sql`
        SELECT m.symbol, m.test, s.source, s.state, s.version::text AS version, s.delisted_at, s.updated_at
          FROM trade.markets m
          LEFT JOIN trade.chart_feed_state s ON s.symbol = m.symbol
         WHERE m.kind = 'spot' AND m.paper = false
         ORDER BY m.symbol
         LIMIT ${MAX_MARKETS}`,
    );
    const journal = await readControls(sql, sql``, sql`ORDER BY chart_feed_controls.id DESC LIMIT ${JOURNAL_LIST_MAX}`);
    return {
      asOf: this.deps.now().toISOString(),
      fallbackSources: this.deps.owner.fallbackSources,
      exportRowLimit: this.deps.owner.exportRowLimit,
      canWrite: principal.scopes.includes(OPERATOR_WRITE_PERMISSION),
      markets: markets.map((m) => {
        const { source, state, version, updated_at } = m;
        const row =
          source !== null && state !== null && version !== null && updated_at !== null
            ? { source, state, version, updated_at, delisted_at: m.delisted_at }
            : undefined;
        return { symbol: m.symbol, test: m.test, ...settingOf(row) };
      }),
      journal,
    };
  }

  /** Check a change against the market's current setting and the owner's list, before any approval is filed. */
  async prepare(principal: Principal, input: ChartFeedChangeInput): Promise<ChartFeedPrepared> {
    requireOperatorWrite(principal);
    const { symbol, action, expectedVersion, reason, current } = await this.check(input);
    const to = nextChartFeed(current, action, this.deps.owner.fallbackSources);
    const body = { symbol, action, expectedVersion, reason };
    return {
      actionType: CHART_FEED_CONTROL_ACTION,
      targetService: 'svc-trade',
      targetId: symbol,
      ...body,
      from: { source: current.source, state: current.state },
      to,
      payloadHash: chartFeedPayloadHash(body),
    };
  }

  async apply(principal: Principal, input: ChartFeedApplyInput): Promise<ChartFeedApplied> {
    requireOperatorWrite(principal);
    const { sql } = this.deps;
    const approvalId = requireApprovalId(input.approvalId);
    const operationId = requireClientRequestId(input.operationId);
    const replay = await this.replay(approvalId, input);
    if (replay) return replay;

    const { symbol, action, expectedVersion, reason, current } = await this.check(input);
    const to = nextChartFeed(current, action, this.deps.owner.fallbackSources);
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: CHART_FEED_CONTROL_ACTION,
      targetId: symbol,
      expectedVersion,
      payloadHash: chartFeedPayloadHash({ symbol, action, expectedVersion, reason }),
      operationId,
    });
    const at = this.deps.now();
    const next = (BigInt(expectedVersion) + 1n).toString();
    const delistedAt = to.state === 'delisted_with_history' ? at : null;
    try {
      await sql.begin(async (tx) => {
        const written = await tx`
          INSERT INTO trade.chart_feed_state AS s (symbol, source, state, version, delisted_at, updated_at)
          VALUES (${symbol}, ${to.source}, ${to.state}, ${next}::bigint, ${delistedAt}, ${at})
          ON CONFLICT (symbol) DO UPDATE
             SET source = EXCLUDED.source, state = EXCLUDED.state, version = EXCLUDED.version,
                 delisted_at = EXCLUDED.delisted_at, updated_at = EXCLUDED.updated_at
           WHERE s.version = ${expectedVersion}::bigint`;
        if (written.count !== 1) throw new TradeOpsError(CHART_FEED_STALE, 'another change was applied to this chart feed first');
        await tx`
          INSERT INTO trade.chart_feed_controls (
            symbol, action, from_source, to_source, from_state, to_state, version, reason,
            proposer_id, approver_id, executor_id, approval_id, at
          ) VALUES (
            ${symbol}, ${action.kind}, ${current.source}, ${to.source}, ${current.state}, ${to.state}, ${next}::bigint, ${reason},
            ${consumed.requesterId}, ${consumed.approverId}, ${principal.userId}, ${approvalId}, ${at}
          )`;
        await writeOperatorAudit(
          tx,
          {
            kind: CHART_FEED_AUDIT_KIND,
            operatorId: principal.userId,
            accountId: null,
            objectId: symbol,
            approverId: consumed.approverId,
            reason,
            detail: {
              action,
              from: { source: current.source, state: current.state },
              to,
              version: next,
              approvalId,
              proposerId: consumed.requesterId,
            },
          },
          at,
        );
      });
    } catch (error) {
      const spent = ' The approval was spent by this attempt: a new approval is needed before the change can be applied.';
      if (error instanceof TradeOpsError) throw new TradeOpsError(error.code, `${error.message}.${spent}`);
      if (isUniqueViolation(error))
        throw new TradeOpsError(CHART_FEED_STALE, `another change was applied to this chart feed first.${spent}`);
      throw new TradeOpsError(
        CHART_FEED_NOT_WRITTEN,
        `the change, its journal row and its audit row could not all be written, so nothing changed.${spent}`,
      );
    }
    const applied = await this.replay(approvalId, input);
    if (!applied) throw new TradeOpsError(CHART_FEED_NOT_WRITTEN, 'the change was written but could not be read back');
    return applied;
  }

  /** Every applied change in [from, to), oldest first, refused whole when more rows match than the owner's row limit. */
  async export(principal: Principal, input: { from?: string | null; to?: string | null }): Promise<ChartFeedExport> {
    requireOperator(principal);
    const { sql } = this.deps;
    const limit = this.deps.owner.exportRowLimit;
    if (limit === null) {
      throw new TradeOpsError(
        CHART_FEED_EXPORT_LIMIT_UNSET,
        "the owner's export row limit is not set (TRADE_CHART_CONTROL_EXPORT_ROW_LIMIT), so no chart control audit file is built",
      );
    }
    const from = isoOrNull(input.from, 'from');
    const to = isoOrNull(input.to, 'to');
    const where = sql`WHERE true ${from ? sql`AND at >= ${from}` : sql``} ${to ? sql`AND at < ${to}` : sql``}`;
    const [count] = CountRow.array().parse(await sql`SELECT count(*)::text AS n FROM trade.chart_feed_controls ${where}`);
    const n = Number(count?.n ?? '0');
    if (n > limit) {
      throw new TradeOpsError(
        CHART_FEED_EXPORT_OVER_LIMIT,
        `${n} chart control changes match, over the owner's export row limit of ${limit}; narrow the window`,
      );
    }
    const rows = await readControls(sql, where, sql`ORDER BY at ASC, chart_feed_controls.id ASC`);
    const at = this.deps.now();
    await writeOperatorAudit(
      sql,
      {
        kind: CHART_FEED_EXPORT_AUDIT_KIND,
        operatorId: principal.userId,
        accountId: null,
        objectId: 'chart_feed_controls',
        approverId: null,
        reason: null,
        detail: { from, to, rowCount: rows.length, rowLimit: limit },
      },
      at,
    );
    return { asOf: at.toISOString(), from, to, rowLimit: limit, rows };
  }

  /** The inputs in their one canonical form, with the market's current setting at the version the operators saw. */
  private async check(input: ChartFeedChangeInput) {
    const symbol = requireSymbol(input.symbol);
    const reason = requireReason(input.reason);
    const expectedVersion = requireVersion(input.expectedVersion);
    const action = parseChartFeedAction(input.action);
    const [market] = SymbolRow.array().parse(
      await this.deps.sql`SELECT symbol, test FROM trade.markets WHERE symbol = ${symbol} AND kind = 'spot' AND paper = false`,
    );
    if (!market) throw new TradeOpsError('market_not_found', `no spot market ${symbol}`);
    const current = await readChartFeedSetting(this.deps.sql, symbol);
    if (current.version !== expectedVersion) {
      throw new TradeOpsError(
        CHART_FEED_STALE,
        `expectedVersion ${expectedVersion} is stale; the chart feed is at version ${current.version}`,
      );
    }
    return { symbol, action, expectedVersion, reason, current };
  }

  /** The change an approval already applied: the same change answers it again; a different one is refused. */
  private async replay(approvalId: string, input: ChartFeedChangeInput): Promise<ChartFeedApplied | null> {
    const { sql } = this.deps;
    const [row] = await readControls(sql, sql`WHERE approval_id = ${approvalId}`, sql``);
    if (!row) return null;
    const action = parseChartFeedAction(input.action);
    const sameChange =
      row.symbol === input.symbol.trim() &&
      row.action === action.kind &&
      (action.kind !== 'switch_source' || row.toSource === action.to) &&
      (BigInt(row.version) - 1n).toString() === input.expectedVersion;
    if (!sameChange) throw new TradeOpsError(CHART_FEED_APPROVAL_SPENT, 'this approval was already spent on a different chart feed change');
    const [m] = SymbolRow.array().parse(await sql`SELECT symbol, test FROM trade.markets WHERE symbol = ${row.symbol}`);
    const setting = await readChartFeedSetting(sql, row.symbol);
    return { market: { symbol: row.symbol, test: m?.test ?? false, ...setting }, control: row };
  }
}

/**
 * The candle read's gate. `serve` with an optional `until` (a delisted chart keeps only its history), or a typed refusal
 * that says what is true: the chart feed is disabled, or it is switched to a source no adapter connects here.
 */
export type CandleGate =
  | { readonly kind: 'serve'; readonly until: Date | null }
  | {
      readonly kind: 'refuse';
      readonly code: typeof CHART_FEED_DISABLED | typeof CHART_FEED_SOURCE_NOT_CONNECTED;
      readonly message: string;
    };

/** Pure: what a market's setting lets its candle read serve. Only the primary source is connected on this service. */
export function candleGateOf(symbol: string, setting: ChartFeedSetting): CandleGate {
  if (setting.state === 'disabled') {
    return { kind: 'refuse', code: CHART_FEED_DISABLED, message: `the chart feed of ${symbol} is disabled by an operator` };
  }
  if (setting.source !== PRIMARY_SOURCE) {
    return {
      kind: 'refuse',
      code: CHART_FEED_SOURCE_NOT_CONNECTED,
      message: `the chart feed of ${symbol} is switched to the fallback source ${setting.source}, and no adapter for it is connected here, so no candles are served`,
    };
  }
  return { kind: 'serve', until: setting.state === 'delisted_with_history' && setting.delistedAt ? new Date(setting.delistedAt) : null };
}

export function chartFeedCandleGate(sql: Sql): (symbol: string) => Promise<CandleGate> {
  return async (symbol) => candleGateOf(symbol, await readChartFeedSetting(sql, symbol));
}
