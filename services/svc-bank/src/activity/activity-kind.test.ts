import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  KIND_BY_MODULE_REASON,
  KIND_BY_REASON,
  classify,
  directionOf,
  type ActivityKind,
} from './activity-kind.js';

/** One row per `module/reason` the ledger posts today. The kind is what a person sees. */
const ROWS: Array<[string, string, ActivityKind]> = [
  ['ledger', 'deposit.credited', 'deposit'],
  ['ledger', 'withdraw.held', 'withdrawal'],
  ['ledger', 'withdraw.settled', 'withdrawal'],
  ['ledger', 'withdraw.reversed', 'withdrawal'],
  ['identity', 'identity.sub_account.transfer', 'space_move'],
  ['trade', 'trade.fill', 'trade'],
  ['trade', 'trade.fill.mm_maker', 'trade'],
  ['trade', 'trade.fill.buyback', 'trade'],
  ['trade', 'futures.margin.lock', 'trade'],
  ['trade', 'futures.margin.add', 'trade'],
  ['trade', 'futures.margin.release', 'trade'],
  ['trade', 'futures.loss.realized', 'trade'],
  ['trade', 'futures.profit.realized', 'trade'],
  ['trade', 'futures.funding.paid', 'trade'],
  ['trade', 'order.hold', 'order_hold'],
  ['trade', 'order.hold.amend', 'order_hold'],
  ['trade', 'order.hold.released', 'order_release'],
  ['trade', 'order.hold.mm', 'other'],
  ['trade', 'order.hold.mm.released', 'other'],
  ['trade', 'order.hold.buyback', 'other'],
  ['trade', 'order.hold.buyback.released', 'other'],
  ['trade', 'mm.seed.funded', 'other'],
  ['trade', 'futures.insurance.topup', 'other'],
  ['p2p', 'p2p.escrow.lock', 'trade'],
  ['p2p', 'p2p.escrow.release', 'trade'],
  ['p2p', 'p2p.escrow.refund', 'trade'],
  ['pay', 'payment.captured', 'payment'],
  ['pay', 'pay.settled', 'payment'],
  ['pay', 'payment.refunded', 'payment'],
  ['pay', 'payment.refund.reversed', 'payment'],
  ['pay', 'pay.chargeback.opened', 'payment'],
  ['pay', 'pay.chargeback.shortfall.covered', 'payment'],
  ['pay', 'pay.chargeback.won', 'payment'],
  ['pay', 'pay.chargeback.shortfall.recovered', 'payment'],
  ['market', 'market.purchase', 'payment'],
  ['market', 'market.listing_fee', 'fee'],
  ['market', 'market.premium_placement', 'fee'],
  ['bank', 'bank.business.approval.settled', 'payment'],
  ['bank', 'bank.business.payroll.settled', 'payment'],
  ['bank', 'bank.business.approval.held', 'other'],
  ['bank', 'bank.business.approval.released', 'other'],
  ['bank', 'bank.earn.deposited', 'earn'],
  ['bank', 'bank.earn.withdrawn', 'earn'],
  ['bank', 'bank.earn.interest', 'earn'],
  ['bank', 'bank.earn.pool.funded', 'other'],
  ['bank', 'loan.collateral.locked', 'other'],
  ['bank', 'loan.collateral.released', 'other'],
  ['bank', 'loan.drawn', 'other'],
  ['bank', 'loan.repaid', 'other'],
  ['bank', 'loan.liquidated', 'other'],
  ['bank', 'loan.bad_debt.covered', 'other'],
  ['bank', 'loan.reserve.funded', 'other'],
  ['token', 'token.stake', 'staking'],
  ['token', 'token.unstake', 'staking'],
  ['token', 'token.emission', 'other'],
  ['token', 'token.burn', 'other'],
  ['token', 'token.fee.swept', 'other'],
  ['token', 'token.yield.distributed', 'reward'],
  ['token', 'bank.card.cashback', 'reward'],
];

describe('classify: one test per module/reason row', () => {
  it.each(ROWS)('%s / %s -> %s', (module, reason, kind) => {
    expect(classify({ module, reason, direction: 'debit' })).toBe(kind);
    expect(classify({ module, reason, direction: 'credit' })).toBe(kind);
  });

  it.each([
    ['bank.transfer.manual', 'debit', 'transfer_in'],
    ['bank.transfer.manual', 'credit', 'transfer_out'],
    ['bank.transfer.scheduled', 'debit', 'transfer_in'],
    ['bank.transfer.scheduled', 'credit', 'transfer_out'],
  ] as const)('bank / %s %s -> %s (direction decides)', (reason, direction, kind) => {
    expect(classify({ module: 'bank', reason, direction })).toBe(kind);
  });

  it('fee.charged is a fee under ANY caller module (feeCharge takes the module)', () => {
    for (const module of ['trade', 'agents', 'p2p', 'pay', 'something-new']) {
      expect(classify({ module, reason: 'fee.charged', direction: 'credit' })).toBe('fee');
    }
  });

  it('an unknown module/reason is `other`, never dropped or thrown', () => {
    expect(classify({ module: 'brand-new', reason: 'brand.new.reason', direction: 'debit' })).toBe('other');
    expect(classify({ module: '', reason: '', direction: 'credit' })).toBe('other');
  });

  it('a hold is order_hold, a release is order_release, fills stay trade, other stays other', () => {
    expect(classify({ module: 'trade', reason: 'order.hold', direction: 'credit' })).toBe('order_hold');
    expect(classify({ module: 'trade', reason: 'order.hold.released', direction: 'debit' })).toBe('order_release');
    expect(classify({ module: 'trade', reason: 'trade.fill', direction: 'credit' })).toBe('trade');
    expect(classify({ module: 'trade', reason: 'trade.fill', direction: 'debit' })).toBe('trade');
    expect(classify({ module: 'bank', reason: 'bank.earn.deposited', direction: 'credit' })).toBe('earn');
    // The module matters: the same reason words from another module are not a trade hold.
    expect(classify({ module: 'bank', reason: 'order.hold', direction: 'credit' })).toBe('other');
  });

  it('earn, staking and rewards are named; a reward reason the table has not met yet is still a reward', () => {
    expect(classify({ module: 'bank', reason: 'bank.earn.interest', direction: 'debit' })).toBe('earn');
    expect(classify({ module: 'token', reason: 'token.stake', direction: 'credit' })).toBe('staking');
    expect(classify({ module: 'anything', reason: 'reward.referral', direction: 'debit' })).toBe('reward');
    expect(classify({ module: 'token', reason: 'token.yield.boost', direction: 'debit' })).toBe('reward');
    // The pool reserve and the token house postings stay unnamed.
    expect(classify({ module: 'bank', reason: 'bank.earn.pool.funded', direction: 'debit' })).toBe('other');
    expect(classify({ module: 'token', reason: 'token.emission', direction: 'debit' })).toBe('other');
  });

  it('a deposit is `deposit`; `welcome_funds` only on the local-test rail', () => {
    const d = { module: 'ledger', reason: 'deposit.credited', direction: 'debit' } as const;
    expect(classify(d)).toBe('deposit');
    expect(classify({ ...d, rail: null })).toBe('deposit');
    expect(classify({ ...d, rail: 'anything' })).toBe('deposit');
    expect(classify({ ...d, rail: 'crypto-native' })).toBe('deposit');
    expect(classify({ ...d, rail: 'local-test' })).toBe('welcome_funds');
    // The rail only matters for a deposit.
    expect(classify({ module: 'trade', reason: 'trade.fill', direction: 'debit', rail: 'local-test' })).toBe('trade');
  });

  it('every kind has a label, and welcome funds reads "Welcome test funds"', () => {
    for (const k of ACTIVITY_KINDS) expect(ACTIVITY_KIND_LABELS[k].length).toBeGreaterThan(0);
    expect(ACTIVITY_KIND_LABELS.welcome_funds).toBe('Welcome test funds');
  });

  it('direction: debit increases the account (in), credit decreases it (out)', () => {
    expect(directionOf('debit')).toBe('in');
    expect(directionOf('credit')).toBe('out');
  });

  it('every table row resolves to a declared kind, and every row above is in the table', () => {
    const declared = new Set<string>([...ACTIVITY_KINDS, 'transfer']);
    for (const v of [...Object.values(KIND_BY_MODULE_REASON), ...Object.values(KIND_BY_REASON)]) expect(declared.has(v)).toBe(true);
    const tested = new Set(ROWS.map(([m, r]) => `${m}/${r}`));
    const untested = Object.keys(KIND_BY_MODULE_REASON).filter((k) => !tested.has(k) && !k.startsWith('bank/bank.transfer.'));
    expect(untested).toEqual([]);
  });
});
