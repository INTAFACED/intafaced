/**
 * Limit convert (J-cex-spot-11 #8, SP-convert-buy-01): convert an amount once a target rate is reached.
 *
 * Money, in order:
 *   1. place: the row is written `placing`, then the whole source amount is held on the ledger
 *      (`recipes.orderHold`, key `order.hold:<id>`), then the row is `waiting`. A refused hold (not enough) ends the
 *      row and holds nothing. A crash between the row and the hold is finished by the sweep with the same key.
 *   2. the sweep, each tick: a firm convert quote is priced for the amount (book plus spread, as Convert prices). Only
 *      when that quote's own rate reaches the target (a buy pays at most the target per coin, a sell receives at least
 *      it) is the quote stored and the row claimed `waiting -> triggered` with that quote id: one worker wins.
 *   3. triggered: the hold is given back whole (`recipes.orderHoldRelease`, key `order.release:<id>:0`), then that one
 *      quote settles through the ordinary convert path (its ledger keys are the quote's, so it fills once). What the
 *      fill did not use stays free: nothing is held after. A crash anywhere here replays the same release and the same
 *      quote: a settled quote answers its fill, an expired one ends the row with its code and the source free.
 *   4. cancel: `waiting -> cancelling` (one claim), the hold released once, then `cancelled`.
 *
 * Whose funds are stranded if this crashes here? None: before the release they are held under the row and the sweep
 * finishes the step; after it they are the customer's free balance, and the quote settles or refuses on its own keys.
 *
 * The settle is a delegated child of the limit's own `strategy.start` admission (as a grid level is of its bot), so a
 * sweep acts with the authority the customer granted when placing, never a credential minted from a user id.
 */
import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { formatAmount, LedgerError, parseAmount, recipes, SCALE, type Amount } from '@intafaced/ledger-client';
import { TradingControlError } from '../controls/trading-controls.js';
import { checkMaxOrderNotional, resolveAdmissionLimits } from '../futures/pretrade-limits.js';
import { TradeError, type TradeErrorCode } from '../spot/types.js';
import type { TradeServiceInternal } from '../spot/trade-service.js';
import type { FirmConvertQuote } from './quote.js';

export type LimitConvertStatus = 'placing' | 'waiting' | 'triggered' | 'filled' | 'cancelling' | 'cancelled' | 'ended';

export interface LimitConvertWire {
  readonly id: string;
  readonly clientLimitId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly fromAsset: string;
  readonly toAsset: string;
  readonly amount: string;
  readonly targetRate: string;
  readonly status: LimitConvertStatus;
  readonly quoteId: string | null;
  readonly fillId: string | null;
  readonly paid: string | null;
  readonly received: string | null;
  readonly endCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlaceLimitConvertInput {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  /** The source amount: the spend in the quote asset for a buy, the coin amount for a sell. */
  readonly amount: Amount;
  /** Quote asset per one base coin. */
  readonly targetRate: Amount;
  readonly clientLimitId: string;
}

interface Row {
  id: string;
  user_id: string;
  client_limit_id: string;
  symbol: string;
  market_id: string;
  side: 'buy' | 'sell';
  from_asset: string;
  to_asset: string;
  amount: string;
  target_rate: string;
  status: LimitConvertStatus;
  quote_id: string | null;
  fill_id: string | null;
  paid: string | null;
  received: string | null;
  end_code: string | null;
  created_at: Date;
  updated_at: Date;
}

/** At most this many rows per list: the waiting ones and the latest ended ones. A page size, not a money figure. */
export const LIMIT_CONVERT_LIST_SIZE = 50;

const businessIdOf = (id: string) => `convert-limit:${id}`;

/** `numeric` text from Postgres to scaled bigint, exactly. */
const amountOf = (text: string): Amount => parseAmount(text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

function present(row: Row): LimitConvertWire {
  const dec = (v: string | null) => (v === null ? null : formatAmount(amountOf(v)));
  return {
    id: row.id,
    clientLimitId: row.client_limit_id,
    symbol: row.symbol,
    side: row.side,
    fromAsset: row.from_asset,
    toAsset: row.to_asset,
    amount: formatAmount(amountOf(row.amount)),
    targetRate: formatAmount(amountOf(row.target_rate)),
    status: row.status,
    quoteId: row.quote_id,
    fillId: row.fill_id,
    paid: dec(row.paid),
    received: dec(row.received),
    endCode: row.end_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * True when a quote's own rate reaches the target. A buy pays `inAmount` (quote asset) for `outAmount` coins: its rate
 * is at most the target. A sell receives `outAmount` for `inAmount` coins: at least the target. Exact, in bigint.
 */
export function rateReached(side: 'buy' | 'sell', target: Amount, inAmount: Amount, outAmount: Amount): boolean {
  if (side === 'buy') return outAmount > 0n && inAmount * SCALE <= target * outAmount;
  return inAmount > 0n && outAmount * SCALE >= target * inAmount;
}

function holdOf(row: Row) {
  return { orderId: row.id, userId: row.user_id, assetId: row.from_asset, amount: amountOf(row.amount) };
}

/** A refusal that leaves nothing in flight: the row may end and the source is free. Anything else is retried. */
function definite(err: unknown): string | null {
  if (err instanceof TradeError) return err.code;
  if (err instanceof LedgerError && err.code === 'ledger.insufficient_funds') return err.code;
  if (err instanceof TradingControlError && err.code !== 'authority.unavailable') return err.code;
  return null;
}

function requireSweep(svc: TradeServiceInternal): void {
  if (!svc.convertEnabled) throw new TradeError('convert is disabled by the operator kill-switch', 'trade.convert_disabled');
  if (svc.convertLimitSweepMs === null) {
    throw new TradeError(
      'no sweep watches limit converts (TRADE_CONVERT_LIMIT_SWEEP_INTERVAL_MS is blank), so none can be placed',
      'trade.convert_limit_unset',
    );
  }
}

export async function placeLimitConvert(
  svc: TradeServiceInternal,
  principal: Principal,
  input: PlaceLimitConvertInput,
): Promise<LimitConvertWire> {
  requireSweep(svc);
  const userId = principal.userId;
  const [existing] = await svc.sql<Row[]>`SELECT * FROM trade.convert_limits
    WHERE user_id = ${userId} AND client_limit_id = ${input.clientLimitId}`;
  if (existing) {
    const same =
      existing.symbol === input.symbol &&
      existing.side === input.side &&
      amountOf(existing.amount) === input.amount &&
      amountOf(existing.target_rate) === input.targetRate;
    if (!same) throw new TradeError('this request id already placed a different limit convert', 'trade.convert_limit_conflict');
    return present(existing.status === 'placing' ? await finishPlacing(svc, existing) : existing);
  }
  if (input.amount <= 0n || input.targetRate <= 0n) {
    throw new TradeError('a limit convert needs an amount and a target rate above zero', 'trade.convert_invalid_qty');
  }
  // The same gates a quote for this amount meets now (market open, minimum, lot, depth); the price itself is not used.
  const probe = await svc.buildConvertQuote(
    userId,
    input.side === 'buy'
      ? { symbol: input.symbol, side: 'buy', quoteQty: input.amount }
      : { symbol: input.symbol, side: 'sell', qty: input.amount },
  );
  // The owner's max-order limit, as the accept checks it, at the target rate for a sell.
  const resolved = resolveAdmissionLimits();
  if ('refusal' in resolved) throw new TradeError(resolved.refusal.message, resolved.refusal.code as TradeErrorCode);
  const notional = input.side === 'buy' ? input.amount : (input.amount * input.targetRate) / SCALE;
  const refusal = checkMaxOrderNotional({ limits: resolved.limits, quoteAsset: probe.quoteAsset, notional, what: 'limit convert' });
  if (refusal) throw new TradeError(refusal.message, refusal.code as TradeErrorCode);

  const id = randomUUID();
  // The customer's own grant, given now, is the authority the sweep settles under later.
  await svc.admitAccountOperation(principal, 'strategy.start', businessIdOf(id), {
    kind: 'convert.limit',
    symbol: probe.symbol,
    side: input.side,
    amount: formatAmount(input.amount),
    targetRate: formatAmount(input.targetRate),
    clientLimitId: input.clientLimitId,
  });
  const [row] = await svc.sql<Row[]>`INSERT INTO trade.convert_limits
      (id, user_id, client_limit_id, symbol, market_id, side, from_asset, to_asset, amount, target_rate, status)
    VALUES (${id}, ${userId}, ${input.clientLimitId}, ${probe.symbol}, ${probe.marketId}, ${input.side},
      ${probe.inAsset}, ${probe.outAsset}, ${formatAmount(input.amount)}, ${formatAmount(input.targetRate)}, 'placing')
    ON CONFLICT (user_id, client_limit_id) DO NOTHING
    RETURNING *`;
  if (!row) return placeLimitConvert(svc, principal, input);
  return present(await finishPlacing(svc, row, true));
}

/** Holds the source for a `placing` row and makes it `waiting`; a refused hold ends it with nothing held. */
async function finishPlacing(svc: TradeServiceInternal, row: Row, rethrow = false): Promise<Row> {
  try {
    await svc.ledger.post(recipes.orderHold(holdOf(row)));
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'ledger.insufficient_funds') {
      const [ended] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'ended', end_code = ${err.code}, updated_at = now()
        WHERE id = ${row.id} AND status = 'placing' RETURNING *`;
      if (rethrow) throw err;
      return ended ?? row;
    }
    throw err;
  }
  const [waiting] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'waiting', updated_at = now()
    WHERE id = ${row.id} AND status = 'placing' RETURNING *`;
  return waiting ?? (await load(svc, row.id));
}

async function load(svc: TradeServiceInternal, id: string): Promise<Row> {
  const [row] = await svc.sql<Row[]>`SELECT * FROM trade.convert_limits WHERE id = ${id}`;
  if (!row) throw new TradeError('limit convert not found', 'trade.convert_limit_not_found');
  return row;
}

export async function listLimitConverts(svc: TradeServiceInternal, principal: Principal): Promise<LimitConvertWire[]> {
  const rows = await svc.sql<Row[]>`SELECT * FROM trade.convert_limits WHERE user_id = ${principal.userId}
    ORDER BY created_at DESC LIMIT ${LIMIT_CONVERT_LIST_SIZE}`;
  return rows.map(present);
}

export async function cancelLimitConvert(svc: TradeServiceInternal, principal: Principal, id: string): Promise<LimitConvertWire> {
  const row = await load(svc, id);
  if (row.user_id !== principal.userId) throw new TradeError('limit convert not found', 'trade.convert_limit_not_found');
  if (row.status === 'cancelled') return present(row);
  if (row.status !== 'waiting' && row.status !== 'cancelling') {
    throw new TradeError(`this limit convert is ${row.status} and can no longer be cancelled`, 'trade.convert_limit_not_waiting');
  }
  const [claimed] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'cancelling', updated_at = now()
    WHERE id = ${id} AND status IN ('waiting', 'cancelling') RETURNING *`;
  if (!claimed) return cancelLimitConvert(svc, principal, id);
  return present(await finishCancel(svc, claimed));
}

async function finishCancel(svc: TradeServiceInternal, row: Row): Promise<Row> {
  await svc.ledger.post(recipes.orderHoldRelease({ ...holdOf(row), sequence: 0 }));
  const [done] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'cancelled', updated_at = now()
    WHERE id = ${row.id} AND status = 'cancelling' RETURNING *`;
  return done ?? (await load(svc, row.id));
}

export interface LimitSweepResult {
  readonly examined: number;
  readonly filled: number;
  readonly ended: number;
  readonly failed: number;
}

/** One sweep tick: finish any interrupted step, then price each waiting limit and settle those that reached the target. */
export async function sweepLimitConverts(
  svc: TradeServiceInternal,
  opts: { onFailed?: (id: string, err: unknown) => void } = {},
): Promise<LimitSweepResult> {
  if (!svc.convertEnabled || svc.convertLimitSweepMs === null) return { examined: 0, filled: 0, ended: 0, failed: 0 };
  const rows = await svc.sql<Row[]>`SELECT * FROM trade.convert_limits
    WHERE status IN ('placing', 'waiting', 'triggered', 'cancelling') ORDER BY created_at LIMIT 500`;
  let filled = 0;
  let ended = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      let current = row;
      if (current.status === 'placing') current = await finishPlacing(svc, current);
      if (current.status === 'cancelling') {
        await finishCancel(svc, current);
        continue;
      }
      if (current.status === 'waiting') {
        const claimed = await tryTrigger(svc, current);
        if (!claimed) continue;
        current = claimed;
      }
      if (current.status === 'triggered') {
        const done = await settleTriggered(svc, current);
        if (done.status === 'filled') filled += 1;
        else if (done.status === 'ended') ended += 1;
      }
    } catch (err) {
      failed += 1;
      opts.onFailed?.(row.id, err);
    }
  }
  return { examined: rows.length, filled, ended, failed };
}

/** Prices the amount now; only a quote at or better than the target is stored and claims the row. */
async function tryTrigger(svc: TradeServiceInternal, row: Row): Promise<Row | null> {
  let quote: FirmConvertQuote;
  try {
    quote = await svc.buildConvertQuote(
      row.user_id,
      row.side === 'buy'
        ? { symbol: row.symbol, side: 'buy', quoteQty: amountOf(row.amount) }
        : { symbol: row.symbol, side: 'sell', qty: amountOf(row.amount) },
    );
  } catch (err) {
    // No price now (thin book, market shut): the limit keeps waiting, its source still held.
    if (err instanceof TradeError) return null;
    throw err;
  }
  if (!rateReached(row.side, amountOf(row.target_rate), quote.inAmount, quote.outAmount)) return null;
  await svc.convertStore.saveOpen(quote);
  const [claimed] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'triggered', quote_id = ${quote.quoteId},
      updated_at = now()
    WHERE id = ${row.id} AND status = 'waiting' RETURNING *`;
  return claimed ?? null;
}

/** Gives the hold back, then settles the claimed quote once; a definite refusal ends the row with the source free. */
async function settleTriggered(svc: TradeServiceInternal, row: Row): Promise<Row> {
  await svc.ledger.post(recipes.orderHoldRelease({ ...holdOf(row), sequence: 0 }));
  const quoteId = row.quote_id as string;
  try {
    const fill = await svc.convertExecuteFor(row.user_id, { quoteId }, (businessId, payload) => admitChild(svc, row, businessId, payload));
    const [done] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'filled', fill_id = ${fill.fillId},
        paid = ${fill.inAmount}, received = ${fill.outAmount}, updated_at = now()
      WHERE id = ${row.id} AND status = 'triggered' RETURNING *`;
    return done ?? (await load(svc, row.id));
  } catch (err) {
    const code = definite(err);
    if (code === null) throw err;
    const [over] = await svc.sql<Row[]>`UPDATE trade.convert_limits SET status = 'ended', end_code = ${code}, updated_at = now()
      WHERE id = ${row.id} AND status = 'triggered' RETURNING *`;
    return over ?? (await load(svc, row.id));
  }
}

/**
 * The settle's admission: a delegated child of this limit's `strategy.start`. The principal carries the user id only
 * and no scope, so it can never pass as a credential; the parent grant is the authority.
 */
async function admitChild(svc: TradeServiceInternal, row: Row, businessId: string, payload: unknown): Promise<unknown> {
  if (!svc.accountAdmission) throw new TradingControlError('authority.unavailable');
  const parentBusinessId = businessIdOf(row.id);
  const parent = await svc.accountAdmission.original(row.user_id, parentBusinessId);
  if (!parent?.admission || !parent.grantId) throw new TradingControlError('auth.credential_denied');
  const owner = { userId: row.user_id, sub: row.user_id, scopes: [] } as unknown as Principal;
  return svc.accountAdmission.admit(owner, 'algo.child', businessId, payload, { parentBusinessId, parentGrantId: parent.grantId });
}
