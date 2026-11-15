import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { OperatorSeedTarget } from '../mm/seed-jobs.js';
import {
  consumeApproval,
  loadRequest,
  payloadHash,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';

/**
 * The internal book seeding configuration, operator-written (J-cex-spot-20 #5, RC-cex-spot-17).
 *
 * Each market's seed row (trade.operator_mm_seed, append-only, latest version wins) carries the whole configuration the
 * seed job places from: on or off, half spread, step, levels, quantity per level and where the mid comes from. A version
 * is written only under a second operator's approval, bound to a hash of exactly that configuration. A blank value
 * refuses `mm.seed_unset` naming it, before any approval is spent; the job refuses the same way on a row that has one (a
 * row written by the older on/off switch), and places nothing for that market. Turning a market off needs nothing but
 * the switch, so stopping the seed is never harder than starting it.
 */

export const MM_SEED_UNSET = 'mm.seed_unset';
export const MM_SEED_ACTION_TYPE = 'trade.mm_seed';

export type MidSource = 'configured' | 'venue';

/** Exactly what an operator writes. Decimal and integer values travel as strings; null is blank. */
export interface SeedConfigInput {
  readonly enabled: boolean;
  readonly halfSpreadBps: string | null;
  readonly stepBps: string | null;
  readonly levels: string | null;
  readonly qtyPerLevel: string | null;
  readonly midSource: MidSource | null;
  readonly configuredMid: string | null;
}

/** A configuration the job can place from. */
export interface CompleteSeedConfig {
  readonly halfSpreadBps: number;
  readonly stepBps: number;
  readonly levels: number;
  readonly qtyPerLevel: string;
  readonly midSource: MidSource;
  readonly configuredMid: string | null;
}

const POSITIVE_INT = /^[1-9]\d{0,5}$/;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;
const blank = (v: string | null | undefined): boolean => v == null || v.trim() === '';

/** The first blank value of an enabled configuration, named as the console names it; null when none is blank. */
export function firstUnset(c: SeedConfigInput): string | null {
  if (!c.enabled) return null;
  if (blank(c.halfSpreadBps)) return 'half spread';
  if (blank(c.stepBps)) return 'step';
  if (blank(c.levels)) return 'levels';
  if (blank(c.qtyPerLevel)) return 'quantity per level';
  if (c.midSource == null) return 'mid source';
  if (c.midSource === 'configured' && blank(c.configuredMid)) return 'configured mid';
  return null;
}

/** The configuration as it is bound and stored: trimmed, checked, blanks refused by name. */
export function normaliseSeedConfig(c: SeedConfigInput): SeedConfigInput {
  const unset = firstUnset(c);
  if (unset) throw new TradeOpsError(MM_SEED_UNSET, `${unset} is not set; the seed places nothing until it is`);
  const t = (v: string | null) => (blank(v) ? null : v!.trim());
  const out: SeedConfigInput = {
    enabled: c.enabled,
    halfSpreadBps: t(c.halfSpreadBps),
    stepBps: t(c.stepBps),
    levels: t(c.levels),
    qtyPerLevel: t(c.qtyPerLevel),
    midSource: c.midSource,
    configuredMid: c.midSource === 'configured' ? t(c.configuredMid) : null,
  };
  for (const [label, v] of [
    ['half spread', out.halfSpreadBps],
    ['step', out.stepBps],
  ] as const) {
    if (v !== null && !POSITIVE_INT.test(v)) throw new TradeOpsError('mm.seed_invalid', `${label} is a whole number of bps above 0`);
  }
  if (out.levels !== null && (!POSITIVE_INT.test(out.levels) || Number(out.levels) > 20)) {
    throw new TradeOpsError('mm.seed_invalid', 'levels is a whole number from 1 to 20');
  }
  for (const [label, v] of [
    ['quantity per level', out.qtyPerLevel],
    ['configured mid', out.configuredMid],
  ] as const) {
    if (v !== null && (!POSITIVE_DECIMAL.test(v) || /^0(?:\.0+)?$/.test(v))) {
      throw new TradeOpsError('mm.seed_invalid', `${label} is a decimal above 0`);
    }
  }
  return out;
}

/** A stored row's configuration complete enough to place from, or the blank that stops it. */
export function completeConfig(c: SeedConfigInput): { ok: true; config: CompleteSeedConfig } | { ok: false; unset: string } {
  const unset = firstUnset({ ...c, enabled: true });
  if (unset) return { ok: false, unset };
  return {
    ok: true,
    config: {
      halfSpreadBps: Number(c.halfSpreadBps),
      stepBps: Number(c.stepBps),
      levels: Number(c.levels),
      qtyPerLevel: c.qtyPerLevel!,
      midSource: c.midSource!,
      configuredMid: c.midSource === 'configured' ? c.configuredMid : null,
    },
  };
}

/** The approval body: the console hashes exactly this (apps/admin `seed-config-hash.ts`). */
export function seedConfigApprovalBody(market: string, expectedVersion: string, config: SeedConfigInput) {
  return { actionType: MM_SEED_ACTION_TYPE, market, expectedVersion, config };
}

export interface SeedConfigRow extends SeedConfigInput {
  readonly market: string;
  readonly symbol: string;
  readonly version: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly approvalId: string;
  readonly writtenAt: string;
}

interface DbRow {
  market_id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  version: string;
  enabled: boolean;
  half_spread_bps: number | null;
  step_bps: number | null;
  levels: number | null;
  qty_per_level: string | null;
  mid_source: MidSource | null;
  configured_mid: string | null;
  operator_id: string;
  approver_id: string;
  approval_id: string;
  created_at: Date;
}

const trimDecimal = (v: string | null): string | null => (v === null ? null : v.includes('.') ? v.replace(/\.?0+$/, '') : v);

function rowOf(r: DbRow): SeedConfigRow {
  return {
    market: r.market_id,
    symbol: r.symbol,
    version: r.version,
    enabled: r.enabled,
    halfSpreadBps: r.half_spread_bps === null ? null : String(r.half_spread_bps),
    stepBps: r.step_bps === null ? null : String(r.step_bps),
    levels: r.levels === null ? null : String(r.levels),
    qtyPerLevel: trimDecimal(r.qty_per_level),
    midSource: r.mid_source,
    configuredMid: trimDecimal(r.configured_mid),
    operatorId: r.operator_id,
    approverId: r.approver_id,
    approvalId: r.approval_id,
    writtenAt: r.created_at.toISOString(),
  };
}

/** The latest version of every market that has one. */
export async function latestSeedConfigs(sql: Sql): Promise<SeedConfigRow[]> {
  return (await latestRows(sql)).map(rowOf).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function latestRows(sql: Sql): Promise<DbRow[]> {
  return sql<DbRow[]>`
    SELECT DISTINCT ON (s.market_id)
           s.market_id::text, m.symbol, m.base_asset, m.quote_asset, s.version::text, s.enabled, s.half_spread_bps, s.step_bps, s.levels,
           s.qty_per_level::text, s.mid_source, s.configured_mid::text, s.operator_id, s.approver_id, s.approval_id, s.created_at
      FROM trade.operator_mm_seed s
      JOIN trade.markets m ON m.id = s.market_id
     ORDER BY s.market_id, s.version DESC`;
}

/** Every version of one market, newest first. */
async function history(sql: Sql, market: string): Promise<SeedConfigRow[]> {
  const rows = await sql<DbRow[]>`
    SELECT s.market_id::text, m.symbol, m.base_asset, m.quote_asset, s.version::text, s.enabled, s.half_spread_bps, s.step_bps, s.levels,
           s.qty_per_level::text, s.mid_source, s.configured_mid::text, s.operator_id, s.approver_id, s.approval_id, s.created_at
      FROM trade.operator_mm_seed s
      JOIN trade.markets m ON m.id = s.market_id
     WHERE s.market_id = ${market}
     ORDER BY s.version DESC`;
  return rows.map(rowOf);
}

export class SeedConfigAdmin {
  constructor(private readonly deps: { sql: Sql; approvals: ApprovalBook }) {}

  async list(principal: Principal): Promise<{ configs: SeedConfigRow[] }> {
    requireOperator(principal);
    return { configs: await latestSeedConfigs(this.deps.sql) };
  }

  async history(principal: Principal, market: string): Promise<{ versions: SeedConfigRow[] }> {
    requireOperator(principal);
    return { versions: await history(this.deps.sql, market) };
  }

  /** The version a new proposal is bound to: the market's latest, or "0" when it has none. */
  async currentVersion(market: string): Promise<string> {
    const [row] = await this.deps.sql<Array<{ version: string }>>`
      SELECT version::text FROM trade.operator_mm_seed WHERE market_id = ${market} ORDER BY version DESC LIMIT 1`;
    return row?.version ?? '0';
  }

  async set(
    principal: Principal,
    input: { market: string; config: SeedConfigInput; expectedVersion: string; approvalId: string; clientRequestId: string },
  ): Promise<SeedConfigRow> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const config = normaliseSeedConfig(input.config);
    const body = seedConfigApprovalBody(input.market, input.expectedVersion, config);
    const fingerprint = payloadHash({ kind: 'mm_seed_config', ...body });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'mm_seed_config', fingerprint);
    if (prior) return prior as SeedConfigRow;
    const written = await this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      // One writer per market at a time: the market row is locked, so a second write bound to the same version waits
      // here and is then refused as stale, before its approval is spent.
      const [market] = await q<Array<{ id: string; symbol: string }>>`
        SELECT id::text, symbol FROM trade.markets WHERE id = ${input.market} FOR UPDATE`;
      if (!market) throw new TradeOpsError('market_not_found', 'no such market');
      const [latest] = await q<Array<{ version: string }>>`
        SELECT version::text FROM trade.operator_mm_seed WHERE market_id = ${input.market} ORDER BY version DESC LIMIT 1`;
      const version = latest?.version ?? '0';
      if (version !== input.expectedVersion) {
        throw new TradeOpsError('mm.seed_stale', `the seed configuration moved to v${version} since this was proposed; propose again`);
      }
      const consumed = await consumeApproval(this.deps.approvals, {
        approvalId: input.approvalId,
        actionType: MM_SEED_ACTION_TYPE,
        targetId: input.market,
        expectedVersion: version,
        payloadHash: payloadHash(body),
        operationId: clientRequestId,
      });
      const next = (BigInt(version) + 1n).toString();
      const writtenAt = new Date();
      const row: SeedConfigRow = {
        ...config,
        market: input.market,
        symbol: market.symbol,
        version: next,
        operatorId: principal.userId,
        approverId: consumed.approverId,
        approvalId: input.approvalId,
        writtenAt: writtenAt.toISOString(),
      };
      // The version, its audit row and the answer to this request id commit together: a retry after a lost reply finds
      // the answer, never a second version and never a stale refusal of its own write.
      await q`INSERT INTO trade.operator_mm_seed (
        id, market_id, version, enabled, operator_id, approver_id, approval_id, created_at,
        half_spread_bps, step_bps, levels, qty_per_level, mid_source, configured_mid
      ) VALUES (
        ${randomUUID()}, ${input.market}, ${next}::bigint, ${config.enabled}, ${principal.userId}, ${consumed.approverId},
        ${input.approvalId}, ${writtenAt}, ${config.halfSpreadBps}::integer, ${config.stepBps}::integer, ${config.levels}::integer,
        ${config.qtyPerLevel}::numeric, ${config.midSource}, ${config.configuredMid}::numeric
      )`;
      await writeOperatorAudit(q, {
        kind: 'market_maker.config',
        operatorId: principal.userId,
        accountId: null,
        objectId: input.market,
        approverId: consumed.approverId,
        reason: config.enabled ? 'seed configuration on' : 'seed configuration off',
        detail: { version: next, config },
      });
      await storeRequest(q, clientRequestId, 'mm_seed_config', fingerprint, row);
      return row;
    });
    return written;
  }
}

/** What the seed job reads each tick: every market's latest row with its assets, complete or naming its first blank. */
export async function operatorSeedTargets(sql: Sql): Promise<OperatorSeedTarget[]> {
  return (await latestRows(sql)).map((r) => {
    const done = completeConfig(rowOf(r));
    const config: OperatorSeedTarget['config'] = done.ok ? { ok: true, ...done.config } : done;
    return { marketId: r.market_id, baseAsset: r.base_asset, quoteAsset: r.quote_asset, enabled: r.enabled, version: r.version, config };
  });
}
