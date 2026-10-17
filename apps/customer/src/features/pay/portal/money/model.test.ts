import { describe, expect, it } from 'vitest';
import { askCaps } from './Limits';
import { referenceProblem } from './Destinations';
import {
  approvalsBySettlement,
  defaultStatementRange,
  expiresToday,
  hasHiddenDigits,
  orderTrail,
  payoutBlock,
  payoutHeadroom,
  payoutRowState,
  refundableAmount,
  refundAmountProblem,
  refundRate,
  roundedDecimal,
  runningView,
  statementRangeTooWide,
  sumByAsset,
  tieView,
  waitingFrom,
  type TrailEvent,
} from './model';
import type { Approval } from '../schemas';
import type { StatementPage } from './schemas';

// TEST DATA written for these tests. None of it is a real merchant, customer or amount.
const line = (patch: Partial<Parameters<typeof runningView>[0][number]> = {}) => ({
  runningOrder: 'clear' as const,
  runningReason: null,
  runningClearing: '10',
  runningProceeds: null,
  ...patch,
});

describe('statement running balance', () => {
  it('shows the column only when every line followed ledger order', () => {
    expect(runningView([line(), line()])).toEqual({ shown: true });
  });
  it('hides it with the reason when an opening is missing', () => {
    expect(runningView([line(), line({ runningOrder: 'clear', runningReason: 'no_opening', runningClearing: null })])).toEqual({
      shown: false,
      reason: 'no_opening',
    });
  });
  it('hides it with the reason when the order is ambiguous', () => {
    expect(runningView([line({ runningOrder: 'order_ambiguous', runningReason: 'order_ambiguous' })])).toEqual({
      shown: false,
      reason: 'order_ambiguous',
    });
  });
  it('has nothing to show for no lines', () => {
    expect(runningView([])).toEqual({ shown: false, reason: 'none' });
  });
});

describe('statement tie-out', () => {
  const tie = (clearing: boolean | null, proceeds: boolean | null): StatementPage['tieOut'] => ({
    accounts: [
      {
        assetId: 'USDT',
        clearing: { statement: '1', ledger: '1', matches: clearing },
        proceeds: { statement: '1', ledger: '1', matches: proceeds },
      },
    ],
  });
  it('matches only when every side matches', () => expect(tieView(tie(true, true), 'USDT')).toBe('matches'));
  it('differs as soon as one side differs', () => expect(tieView(tie(true, false), 'USDT')).toBe('differs'));
  it('cannot confirm when a side is unknown or the asset is absent', () => {
    expect(tieView(tie(true, null), 'USDT')).toBe('unknown');
    expect(tieView(tie(true, true), 'USD')).toBe('unknown');
    expect(tieView(undefined, '')).toBe('unknown');
  });
  it('asks for a window of at most 92 days', () => {
    const r = defaultStatementRange(Date.parse('2026-10-17T12:00:00Z'));
    expect(statementRangeTooWide(r)).toBe(false);
    expect(statementRangeTooWide({ from: '2026-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })).toBe(true);
  });
});

describe('refund amounts', () => {
  const left = refundableAmount('100.000001', '40.5');
  it('works the refundable amount out exactly', () => expect(left).toBe('59.500001'));
  it('never goes below zero', () => expect(refundableAmount('10', '12')).toBe('0'));
  it('accepts the exact refundable amount and a six-decimal part of it', () => {
    expect(refundAmountProblem('59.500001', left)).toBeNull();
    expect(refundAmountProblem('12.345678', left)).toBeNull();
  });
  it('refuses more than is left, zero, a blank and a bad format', () => {
    expect(refundAmountProblem('59.500002', left)).toBe('over');
    expect(refundAmountProblem('0', left)).toBe('zero');
    expect(refundAmountProblem('  ', left)).toBe('empty');
    expect(refundAmountProblem('1,5', left)).toBe('format');
    expect(refundAmountProblem('-1', left)).toBe('format');
  });
  it('works the refund rate with integer arithmetic', () => {
    expect(refundRate('10', '200')).toBe('5.00%');
    expect(refundRate('0.000001', '1000000')).toBe('0.00%');
    expect(refundRate('1', '0')).toBeNull();
  });
});

describe('headline figures', () => {
  it('rounds half up by integer arithmetic and flags hidden digits', () => {
    expect(roundedDecimal('9007199254740993.005', 2)).toBe('9007199254740993.01');
    expect(hasHiddenDigits('12.345678', 2)).toBe(true);
    expect(hasHiddenDigits('12.30', 2)).toBe(false);
  });
  it('never adds two assets together', () => {
    expect(
      sumByAsset([
        { assetCode: 'USDT', amount: '1.5' },
        { assetCode: 'USD', amount: '2' },
        { assetCode: 'USDT', amount: '0.25' },
      ]),
    ).toEqual([
      { assetCode: 'USD', amount: '2' },
      { assetCode: 'USDT', amount: '1.75' },
    ]);
  });
});

describe('payout form refusals', () => {
  const ok = { settlement: { net: '100', assetId: 'USDT' }, paused: false, kybApproved: true, destinationCount: 1, remaining: '200' };
  it('lets a good payout through', () => expect(payoutBlock(ok)).toBeNull());
  it('explains each refusal in the order a merchant would fix it', () => {
    expect(payoutBlock({ ...ok, settlement: null })).toBe('nothing');
    expect(payoutBlock({ ...ok, paused: true })).toBe('paused');
    expect(payoutBlock({ ...ok, kybApproved: false })).toBe('kyb');
    expect(payoutBlock({ ...ok, destinationCount: 0 })).toBe('noDestination');
    expect(payoutBlock({ ...ok, remaining: '99.999999' })).toBe('overCap');
  });
  it('does not guess when the destinations or the limit could not be read', () => {
    expect(payoutBlock({ ...ok, destinationCount: null, remaining: null, kybApproved: null })).toBeNull();
  });
  it('reads the daily payout headroom for one asset', () => {
    const usage = {
      rows: [
        { kind: 'daily_payout' as const, assetCode: 'USDT', limit: '10000', used: '9800', remaining: '200', resetsAt: null },
        { kind: 'daily_payout' as const, assetCode: 'USD', limit: '5', used: null, remaining: null, resetsAt: null },
      ],
    };
    expect(payoutHeadroom(usage, 'USDT')).toEqual({ limit: '10000', remaining: '200' });
    expect(payoutHeadroom(usage, 'EUR')).toBeNull();
  });
});

describe('payout timeline order', () => {
  const e = (key: string, at: string | null, kind: string, terminal = false): TrailEvent => ({ key, at, kind, terminal });
  it('puts every attempt in time order and ends on the final state', () => {
    const trail = orderTrail(
      [
        e('paid', '2026-10-05T10:00:00.000Z', 'rail.confirmed', true),
        e('req2', '2026-10-03T10:00:00.000Z', 'approval.requested'),
        e('rej', '2026-10-02T11:00:00.000Z', 'approval.rejected'),
        e('req1', '2026-10-02T10:00:00.000Z', 'approval.requested'),
        e('ok', '2026-10-04T10:00:00.000Z', 'approval.approved'),
      ],
      'paid_out',
    );
    expect(trail.map((x) => x.key)).toEqual(['req1', 'rej', 'req2', 'ok', 'paid']);
    expect(trail.at(-1)?.kind).toBe('rail.confirmed');
  });
  it('keeps the order given for events without a time', () => {
    const trail = orderTrail([e('a', null, 'settlement.opened'), e('b', null, 'settlement.posted')], 'other');
    expect(trail.map((x) => x.key)).toEqual(['a', 'b']);
  });
  it('keeps a terminal event last even when a later note shares its moment', () => {
    const trail = orderTrail(
      [e('done', '2026-10-05T10:00:00.000Z', 'rail.confirmed', true), e('note', '2026-10-05T10:00:00.000Z', 'approval.consumed')],
      'paid_out',
    );
    expect(trail.at(-1)?.key).toBe('done');
  });
});

describe('approvals', () => {
  const a = (patch: Partial<Approval>): Approval => ({
    approvalId: 'cc000001-0000-4000-8000-000000000001',
    merchantId: 'm',
    settlementId: 'bb000001-0000-4000-8000-000000000001',
    amount: '1',
    assetCode: 'USDT',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    status: 'pending',
    makerUserId: 'u1',
    checkerUserId: null,
    createdAt: '2026-10-15T09:00:00.000Z',
    decidedAt: null,
    expiresAt: '2026-10-15T20:00:00.000Z',
    ...patch,
  });
  it('knows who a pending request waits for', () => {
    expect(waitingFrom(a({}))).toBe('team');
    expect(waitingFrom(a({ checkerUserId: 'u2' }))).toBe('intafaced');
    expect(waitingFrom(a({ status: 'approved' }))).toBeNull();
  });
  it('flags a request ending within a day, and only a pending one', () => {
    const now = Date.parse('2026-10-15T12:00:00.000Z');
    expect(expiresToday(a({}), now)).toBe(true);
    expect(expiresToday(a({ status: 'expired' }), now)).toBe(false);
    expect(expiresToday(a({ expiresAt: '2026-10-20T12:00:00.000Z' }), now)).toBe(false);
  });
  it('names a payout waiting for approval from the newest request', () => {
    const map = approvalsBySettlement([a({ createdAt: '2026-10-14T00:00:00.000Z', status: 'rejected' }), a({})]);
    expect(payoutRowState({ id: 'bb000001-0000-4000-8000-000000000001', status: 'posted' }, map)).toBe('awaiting_approval');
    expect(payoutRowState({ id: 'bb000001-0000-4000-8000-000000000001', status: 'posted' }, null)).toBe('unknown');
    expect(payoutRowState({ id: 'bb000001-0000-4000-8000-000000000001', status: 'paid_out' }, map)).toBe('paid_out');
  });
});

describe('forms', () => {
  it('checks the shape of a destination before the review', () => {
    expect(referenceProblem('crypto', '0x7a3f00000000000000000000000000000000abcd')).toBeNull();
    expect(referenceProblem('crypto', 'GB82WEST12345698765432')).toBe('crypto');
    expect(referenceProblem('bank', 'GB82 WEST 1234 5698 7654 32')).toBeNull();
    expect(referenceProblem('bank', '0x7a3f')).toBe('bank');
    expect(referenceProblem('bank', ' ')).toBe('empty');
  });
  const rows = [
    {
      kind: 'daily_payout' as const,
      configured: true,
      assetCode: 'USDT',
      limit: '10000',
      used: '1',
      remaining: '9999',
      resetsAt: null,
      pct: 0,
    },
    {
      kind: 'beneficiaries_per_day' as const,
      configured: true,
      assetCode: null,
      limit: '5',
      used: null,
      remaining: null,
      resetsAt: null,
      pct: null,
    },
  ];
  it('builds a limit ask only from lines that are higher than today', () => {
    const r = askCaps(rows, { 'daily_payout:USDT': '12000.000001', 'beneficiaries_per_day:': '8' });
    expect(r.problem).toBeNull();
    expect(r.caps).toEqual([
      { kind: 'daily_payout', assetCode: 'USDT', limit: '12000.000001' },
      { kind: 'beneficiaries_per_day', limit: 8 },
    ]);
  });
  it('refuses a line that is not more, a bad number, and an empty ask', () => {
    expect(askCaps(rows, { 'daily_payout:USDT': '10000' }).problem).toBe('notMore');
    expect(askCaps(rows, { 'daily_payout:USDT': 'lots' }).problem).toBe('format');
    expect(askCaps(rows, {}).problem).toBe('none');
  });
});
