import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { poolAvailable, poolRedeemPayable, poolTradingAccount, userAvailable } from '../accounts.js';

/**
 * POOLED STRATEGY RECIPES (LG-pool-recipes-01).
 *
 * Money only. Share counts, FIFO lots, NAV, fees, limits, lock-ups, minimums
 * and windows are svc-trade's (owner-decision values). These recipes compute
 * none of them: every amount is supplied by the caller, and no recipe has a
 * fee, revenue or profit-share leg (pnlFeeForbidden, svc-trade copy-policy.ts).
 *
 * Debit convention matches `subAccountTransfer`: credit the source (value
 * leaves), debit the destination (value arrives).
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

/** Ids that go into an idempotency key are one segment, so two operations can never share a key. */
const ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

function requireId(name: string, value: string): void {
  if (!value || !ID_SEGMENT.test(value)) {
    throw new InvalidEntryError(`${name} is required and must be one segment ([A-Za-z0-9._-]+)`);
  }
}

function requireAsset(assetId: string): void {
  if (!assetId) throw new InvalidEntryError('assetId is required');
}

export interface PoolSubscribeInput {
  poolId: string;
  userId: string;
  assetId: string;
  /** Computed by svc-trade (NAV × shares). The recipe never prices. */
  amount: Amount;
  subscriptionId: string;
}

/** An investor (or the seed round, pro-share-07) puts money into the pool. */
export function poolSubscribe(input: PoolSubscribeInput): PostRequest {
  requirePositive('pool subscription amount', input.amount);
  requireId('poolId', input.poolId);
  requireId('subscriptionId', input.subscriptionId);
  requireAsset(input.assetId);
  if (!input.userId) throw new InvalidEntryError('userId is required');
  return {
    idempotencyKey: `pool.sub:${input.poolId}:${input.subscriptionId}`,
    module: 'trade',
    reason: 'trade.pool.subscribed',
    meta: { poolId: input.poolId, subscriptionId: input.subscriptionId, userId: input.userId },
    entries: [
      credit(userAvailable(input.userId, input.assetId), input.amount),
      debit(poolAvailable(input.poolId, input.assetId), input.amount),
    ],
  };
}

export interface PoolRedeemInput {
  poolId: string;
  userId: string;
  assetId: string;
  /** Computed by svc-trade from FIFO lots × NAV at the request. The recipe never computes NAV. */
  amount: Amount;
  redemptionId: string;
  /** `request` reserves the amount in this redemption's payable; `pay` sends it to the investor. */
  leg: 'request' | 'pay';
}

/**
 * Redemption, in two legs (pro-share-08):
 *   - request: poolAvailable → poolRedeemPayable(redemptionId)
 *   - pay:     poolRedeemPayable(redemptionId) → userAvailable
 *
 * The payable is one hold per redemption, so `pay` can never exceed what its
 * own `request` reserved (the ledger refuses a negative hold), and a replay of
 * either leg under its key posts nothing.
 */
export function poolRedeem(input: PoolRedeemInput): PostRequest {
  requirePositive('pool redemption amount', input.amount);
  requireId('poolId', input.poolId);
  requireId('redemptionId', input.redemptionId);
  requireAsset(input.assetId);
  if (!input.userId) throw new InvalidEntryError('userId is required');
  const payable = poolRedeemPayable(input.poolId, input.assetId, input.redemptionId);
  const meta = { poolId: input.poolId, redemptionId: input.redemptionId, userId: input.userId };
  if (input.leg === 'request') {
    return {
      idempotencyKey: `pool.red:${input.poolId}:${input.redemptionId}:req`,
      module: 'trade',
      reason: 'trade.pool.redeem.requested',
      meta,
      entries: [credit(poolAvailable(input.poolId, input.assetId), input.amount), debit(payable, input.amount)],
    };
  }
  if (input.leg === 'pay') {
    return {
      idempotencyKey: `pool.red:${input.poolId}:${input.redemptionId}:pay`,
      module: 'trade',
      reason: 'trade.pool.redeem.paid',
      meta,
      entries: [credit(payable, input.amount), debit(userAvailable(input.userId, input.assetId), input.amount)],
    };
  }
  throw new InvalidEntryError(`poolRedeem leg must be 'request' or 'pay'`);
}

export interface PoolProfitInput {
  poolId: string;
  assetId: string;
  /** Realised P&L for the period, as a positive magnitude. */
  amount: Amount;
  direction: 'gain' | 'loss';
  periodId: string;
}

/**
 * Book the pool's realised trading P&L between its own trading account and
 * poolAvailable. Not a fee: no leg touches a fee, revenue or house account.
 *   - gain: poolTradingAccount → poolAvailable
 *   - loss: poolAvailable → poolTradingAccount
 * Both are non-negative module accounts, so a gain the trading account does
 * not hold, or a loss bigger than the pool, is refused, never minted.
 */
export function poolProfit(input: PoolProfitInput): PostRequest {
  requirePositive('pool profit amount', input.amount);
  requireId('poolId', input.poolId);
  requireId('periodId', input.periodId);
  requireId('assetId', input.assetId);
  const pool = poolAvailable(input.poolId, input.assetId);
  const trading = poolTradingAccount(input.poolId, input.assetId);
  let entries: EntryInput[];
  if (input.direction === 'gain') entries = [credit(trading, input.amount), debit(pool, input.amount)];
  else if (input.direction === 'loss') entries = [credit(pool, input.amount), debit(trading, input.amount)];
  else throw new InvalidEntryError(`poolProfit direction must be 'gain' or 'loss'`);
  return {
    idempotencyKey: `pool.pnl:${input.poolId}:${input.periodId}:${input.assetId}`,
    module: 'trade',
    reason: 'trade.pool.pnl',
    meta: { poolId: input.poolId, periodId: input.periodId, direction: input.direction },
    entries,
  };
}

export interface PoolRaiseInput {
  poolId: string;
  masterUserId: string;
  assetId: string;
  amount: Amount;
  raiseId: string;
}

/** The master adds balance to raise share capacity (pro-share-09). */
export function poolRaise(input: PoolRaiseInput): PostRequest {
  requirePositive('pool raise amount', input.amount);
  requireId('poolId', input.poolId);
  requireId('raiseId', input.raiseId);
  requireAsset(input.assetId);
  if (!input.masterUserId) throw new InvalidEntryError('masterUserId is required');
  return {
    idempotencyKey: `pool.raise:${input.poolId}:${input.raiseId}`,
    module: 'trade',
    reason: 'trade.pool.raised',
    meta: { poolId: input.poolId, raiseId: input.raiseId, masterUserId: input.masterUserId },
    entries: [
      credit(userAvailable(input.masterUserId, input.assetId), input.amount),
      debit(poolAvailable(input.poolId, input.assetId), input.amount),
    ],
  };
}
