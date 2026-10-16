import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell } from './csv';
import {
  activeHalts,
  approvalSummary,
  bpsPercent,
  closestToLimit,
  actorName,
  decisionBlock,
  decisionLanded,
  isCheckedPending,
  filterPayments,
  freshnessAt,
  isCalcAmount,
  isUuid,
  latestApproval,
  limitRows,
  matchesSearch,
  minReasonOk,
  nextLimit,
  paymentLinks,
  paymentRefunds,
  paymentSteps,
  payoutRows,
  payoutState,
  readLimit,
  readSort,
  refundable,
  roleMayDecide,
  sortRows,
  spanParts,
  statementTies,
  successRate,
  usagePct,
} from './model';
import type { Approval, PaymentEvent, Payment, Settlement } from './schemas';

// TEST DATA only.
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const pay = (patch: Partial<Payment> = {}): Payment => ({
  id: 'aa000001-0000-4000-8000-000000000001',
  merchantId: 'm',
  profileId: null,
  amount: '100',
  assetId: 'USDT',
  method: 'TEST-card',
  railAdapter: 'crypto-native',
  railRef: 'TEST-ref-1',
  status: 'captured',
  capturedAmount: '100',
  refundedAmount: '0',
  createdAt: '2026-10-14T00:00:00.000Z',
  ...patch,
});
const ev = (event: string, payload: Record<string, unknown>, ts: string): PaymentEvent => ({
  id: 'e',
  event,
  payload,
  railEventId: null,
  ts,
});
const apr = (patch: Partial<Approval> = {}): Approval => ({
  approvalId: 'cc1',
  merchantId: 'm',
  settlementId: 's1',
  amount: '10',
  assetCode: 'USDT',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  status: 'pending',
  makerUserId: 'maker',
  checkerUserId: null,
  createdAt: '2026-10-15T09:00:00.000Z',
  decidedAt: null,
  expiresAt: '2026-10-16T09:00:00.000Z',
  ...patch,
});
const stl = (patch: Partial<Settlement> = {}): Settlement => ({
  id: 's1',
  merchantId: 'm',
  window: 'w',
  assetId: 'USDT',
  gross: '100',
  fees: '1.5',
  net: '98.5',
  payoutMethod: null,
  payoutRef: null,
  status: 'posted',
  ...patch,
});

describe('payment list helpers', () => {
  it('filters loaded rows by asset, UTC day range and search, case-insensitively', () => {
    const rows = [
      pay(),
      pay({ id: 'aa000002-0000-4000-8000-000000000002', assetId: 'USD', createdAt: '2026-10-10T23:59:59.999Z', railRef: 'OTHER-9' }),
      pay({ id: 'aa000003-0000-4000-8000-000000000003', createdAt: '2026-10-12T00:00:00.000Z' }),
    ];
    const none = { q: '', asset: '', from: '', to: '' };
    expect(filterPayments(rows, none)).toHaveLength(3);
    expect(filterPayments(rows, { ...none, asset: 'USD' }).map((r) => r.assetId)).toEqual(['USD']);
    expect(filterPayments(rows, { ...none, from: '2026-10-11' })).toHaveLength(2);
    expect(filterPayments(rows, { ...none, to: '2026-10-10' })).toHaveLength(1);
    expect(filterPayments(rows, { ...none, from: '2026-10-12', to: '2026-10-12' })).toHaveLength(1);
    expect(filterPayments(rows, { ...none, q: 'other-9' })).toHaveLength(1);
    expect(filterPayments(rows, { ...none, q: 'AA000003' })).toHaveLength(1);
    expect(filterPayments(rows, { ...none, from: 'not-a-date' })).toHaveLength(3);
  });
  it('matches search against any field and treats blank as everything', () => {
    expect(matchesSearch(['abc', null], '  ')).toBe(true);
    expect(matchesSearch([null, undefined], 'x')).toBe(false);
    expect(matchesSearch(['Hello'], 'ELL')).toBe(true);
  });
  it('sorts by time and by exact amount, never by a float', () => {
    const rows = [
      pay({ id: 'a', amount: '9.000000000000000002', createdAt: '2026-10-01T00:00:00.000Z' }),
      pay({ id: 'b', amount: '9.000000000000000001', createdAt: '2026-10-03T00:00:00.000Z' }),
      pay({ id: 'c', amount: '10', createdAt: '2026-10-02T00:00:00.000Z' }),
    ];
    const ids = (s: Parameters<typeof sortRows>[1]) =>
      sortRows(
        rows,
        s,
        (r) => r.createdAt,
        (r) => r.amount,
      ).map((r) => r.id);
    expect(ids('newest')).toEqual(['b', 'c', 'a']);
    expect(ids('oldest')).toEqual(['a', 'c', 'b']);
    expect(ids('largest')).toEqual(['c', 'a', 'b']);
    expect(ids('smallest')).toEqual(['b', 'a', 'c']);
  });
  it('allows only the page sizes the service accepts', () => {
    expect(readLimit('100')).toBe(100);
    expect(readLimit('7')).toBe(25);
    expect(readLimit('')).toBe(25);
    expect(nextLimit(25)).toBe(50);
    expect(nextLimit(100)).toBe(200);
    expect(nextLimit(200)).toBe(200);
    expect(readSort('largest')).toBe('largest');
    expect(readSort('x')).toBe('newest');
  });
  it('computes a success rate that is not 100% when there were no payments', () => {
    expect(successRate([])).toEqual({ total: 0, failed: 0, pct: null });
    expect(
      successRate([
        { status: 'captured', count: 9 },
        { status: 'failed', count: 3 },
      ]),
    ).toEqual({ total: 12, failed: 3, pct: 75 });
  });
  it('works out what can still be refunded without going below zero', () => {
    expect(refundable({ capturedAmount: '100', refundedAmount: '20.25' })).toBe('79.75');
    expect(refundable({ capturedAmount: '100', refundedAmount: '100' })).toBe('0');
    expect(refundable({ capturedAmount: '0', refundedAmount: '5' })).toBe('0');
  });
  it('recognises a uuid and rejects anything else before a request is made', () => {
    expect(isUuid('aa000001-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('p0000001-0000-4000-8000-000000000001')).toBe(false);
    expect(isUuid('../etc/passwd')).toBe(false);
  });
});

describe('payment history', () => {
  const events = [
    ev('created', { amount: '100', customerRef: 'TEST-cust', instrument: { token: 'tok_secret' } }, '2026-10-14T00:00:00.000Z'),
    ev('rail.authorize', { raw: 1 }, '2026-10-14T00:00:10.000Z'),
    ev('authorized', { amount: '100' }, '2026-10-14T00:00:20.000Z'),
    ev('captured', { amount: '100', ledgerTxId: 'TEST-tx' }, '2026-10-14T00:01:00.000Z'),
    ev('refund.posted', { refundId: 'r1', amount: '10' }, '2026-10-14T01:00:00.000Z'),
    ev('refunded', { refundId: 'r1', amount: '10' }, '2026-10-14T01:00:01.000Z'),
    ev('refund.posted', { refundId: 'r2', amount: '5' }, '2026-10-14T02:00:00.000Z'),
    ev('refund.posted', { refundId: 'r3', amount: '2' }, '2026-10-14T03:00:00.000Z'),
    ev('refund.reversed', { refundId: 'r3', amount: '2', failureCode: 'x' }, '2026-10-14T03:00:05.000Z'),
    ev('settled', { settlementId: 's1' }, '2026-10-14T05:00:00.000Z'),
    ev('disputed', { disputeId: 'd1' }, '2026-10-14T06:00:00.000Z'),
  ];
  it('shows only the events a merchant should read, in time order, with no rail internals', () => {
    const steps = paymentSteps([...events].reverse());
    expect(steps.map((s) => s.kind)).toEqual(['created', 'authorized', 'captured', 'refunded', 'refund_reversed', 'settled', 'disputed']);
    expect(JSON.stringify(steps)).not.toMatch(/tok_secret|raw/);
  });
  it('tracks each refund by its own id through posted, completed and reversed', () => {
    const refunds = paymentRefunds(events);
    expect(refunds.map((r) => [r.refundId, r.state, r.amount])).toEqual([
      ['r1', 'completed', '10'],
      ['r2', 'in_progress', '5'],
      ['r3', 'reversed', '2'],
    ]);
  });
  it('leaves out an amount that is not an exact decimal instead of letting it reach the page', () => {
    const odd = [
      ev('captured', { amount: 'lots' }, '2026-10-14T00:00:00.000Z'),
      ev('refund.posted', { refundId: 'r9', amount: '1e3' }, '2026-10-14T01:00:00.000Z'),
    ];
    expect(paymentSteps(odd)[0]?.amount).toBeNull();
    expect(paymentRefunds(odd)[0]?.amount).toBeNull();
  });
  it('pulls out the few ids worth linking', () => {
    expect(paymentLinks(events)).toEqual({ customerRef: 'TEST-cust', ledgerTxId: 'TEST-tx', settlementId: 's1', disputeId: 'd1' });
    expect(paymentLinks([])).toEqual({ customerRef: null, ledgerTxId: null, settlementId: null, disputeId: null });
  });
});

describe('settlements and payouts', () => {
  it('checks that gross less fees is net to the last decimal', () => {
    expect(statementTies({ gross: '100', fees: '1.5', net: '98.5' })).toBe(true);
    expect(statementTies({ gross: '100', fees: '1.5', net: '98.500000000000000001' })).toBe(false);
  });
  it('reads a payout’s state from the settlement and its newest approval', () => {
    expect(payoutState(stl({ status: 'paid_out' }), apr({ status: 'consumed' }))).toBe('paid_out');
    expect(payoutState(stl({ status: 'failed' }), null)).toBe('failed');
    expect(payoutState(stl({ status: 'pending' }), null)).toBe('not_ready');
    expect(payoutState(stl(), null)).toBe('ready');
    expect(payoutState(stl(), apr())).toBe('awaiting_approval');
    expect(payoutState(stl(), apr({ status: 'approved' }))).toBe('approved');
    expect(payoutState(stl(), apr({ status: 'rejected' }))).toBe('rejected');
    // A request that no longer counts puts the payout back to "ready", never to "approved".
    expect(payoutState(stl(), apr({ status: 'voided' }))).toBe('ready');
    expect(payoutState(stl(), apr({ status: 'expired' }))).toBe('ready');
  });
  it('never calls a payout "ready" when its approvals could not be read', () => {
    expect(payoutState(stl(), null, false)).toBe('unknown');
    expect(payoutState(stl(), apr(), false)).toBe('unknown');
    // A settled or failed payout does not depend on approvals.
    expect(payoutState(stl({ status: 'paid_out' }), null, false)).toBe('paid_out');
    expect(payoutState(stl({ status: 'failed' }), null, false)).toBe('failed');
    expect(payoutState(stl({ status: 'pending' }), null, false)).toBe('not_ready');
    const rows = payoutRows([stl(), stl({ id: 's3', status: 'paid_out' })], null);
    expect(rows.map((r) => r.state)).toEqual(['unknown', 'paid_out']);
  });
  it('picks the newest approval for a settlement and ignores other settlements', () => {
    const list = [
      apr({ approvalId: 'old', createdAt: '2026-10-01T00:00:00.000Z', status: 'rejected' }),
      apr({ approvalId: 'new', createdAt: '2026-10-05T00:00:00.000Z' }),
      apr({ approvalId: 'other', settlementId: 's2', createdAt: '2026-10-09T00:00:00.000Z' }),
    ];
    expect(latestApproval(list, 's1')?.approvalId).toBe('new');
    expect(latestApproval(list, 's9')).toBeNull();
  });
  it('lists payouts without the settlements that are not payable yet', () => {
    const rows = payoutRows([stl(), stl({ id: 's2', status: 'pending' }), stl({ id: 's3', status: 'paid_out', payoutRef: 'TX' })], [apr()]);
    expect(rows.map((r) => [r.settlementId, r.state, r.amount])).toEqual([
      ['s1', 'awaiting_approval', '98.5'],
      ['s3', 'paid_out', '98.5'],
    ]);
  });
});

describe('approvals', () => {
  it('blocks the person who asked, a role that cannot decide, an expired request and a decided one, in that order of importance', () => {
    const p = apr();
    expect(decisionBlock(p, 'checker', 'finance', NOW)).toBeNull();
    expect(decisionBlock(p, 'maker', 'owner', NOW)).toBe('own');
    expect(decisionBlock(p, 'checker', 'viewer', NOW)).toBe('role');
    expect(decisionBlock(p, 'checker', 'developer', NOW)).toBe('role');
    expect(decisionBlock(apr({ expiresAt: '2026-10-15T11:59:59.000Z' }), 'checker', 'finance', NOW)).toBe('expired');
    expect(decisionBlock(apr({ status: 'approved' }), 'checker', 'finance', NOW)).toBe('status');
    // Not knowing the role or the user does not invent a block: the service decides.
    expect(decisionBlock(p, null, null, NOW)).toBeNull();
  });
  it('treats a request a teammate already approved as waiting on INTAFACED, not as undecided', () => {
    const checked = apr({ checkerUserId: 'teammate' });
    expect(isCheckedPending(checked)).toBe(true);
    expect(isCheckedPending(apr())).toBe(false);
    expect(isCheckedPending(apr({ status: 'approved', checkerUserId: 'teammate' }))).toBe(false);
    expect(decisionBlock(checked, 'someone-else', 'finance', NOW)).toBe('checked');
    // Even the person who approved it, or the one who asked, is told the same thing: nothing is left to decide.
    expect(decisionBlock(checked, 'teammate', 'owner', NOW)).toBe('checked');
    expect(decisionBlock(checked, 'maker', 'owner', NOW)).toBe('checked');
  });
  it('keeps requests that wait on INTAFACED out of "waiting for you" and "your requests"', () => {
    const list = [
      apr({ approvalId: 'a' }),
      apr({ approvalId: 'b', checkerUserId: 'teammate' }),
      apr({ approvalId: 'c', makerUserId: 'me', checkerUserId: 'teammate' }),
      apr({ approvalId: 'd', makerUserId: 'me' }),
    ];
    const s = approvalSummary(list, 'me', NOW);
    expect(s).toMatchObject({ waiting: 4, forOthers: 1, mine: 1, signoff: 2 });
  });
  it('says whether a decision the service answered actually took effect', () => {
    expect(decisionLanded('approve', 'approved')).toBe(true);
    expect(decisionLanded('approve', 'pending')).toBe(true); // waits for INTAFACED's sign-off
    expect(decisionLanded('approve', 'consumed')).toBe(true);
    expect(decisionLanded('approve', 'voided')).toBe(false);
    expect(decisionLanded('approve', 'expired')).toBe(false);
    expect(decisionLanded('approve', 'rejected')).toBe(false);
    expect(decisionLanded('reject', 'rejected')).toBe(true);
    expect(decisionLanded('reject', 'voided')).toBe(false);
    expect(decisionLanded('reject', 'approved')).toBe(false);
  });
  it('shows a name where there is one and a short id otherwise', () => {
    const names = new Map([['u-1', 'Accounts']]);
    expect(actorName('u-1', names)).toBe('Accounts');
    expect(actorName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', names)).toBe('aaaaaaaa…');
    expect(actorName('short', names)).toBe('short');
  });
  it('lets owner, admin and finance decide, and leaves an unknown role to the service', () => {
    expect([roleMayDecide('owner'), roleMayDecide('admin'), roleMayDecide('finance'), roleMayDecide(null)]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([roleMayDecide('developer'), roleMayDecide('viewer')]).toEqual([false, false]);
  });
  it('summarises what is waiting, what is yours to decide, the oldest and the next to expire', () => {
    const list = [
      apr({ approvalId: 'a', createdAt: '2026-10-15T06:00:00.000Z', expiresAt: '2026-10-15T20:00:00.000Z' }),
      apr({ approvalId: 'b', makerUserId: 'me', createdAt: '2026-10-15T10:00:00.000Z', expiresAt: '2026-10-15T14:00:00.000Z' }),
      apr({ approvalId: 'c', status: 'approved' }),
      apr({ approvalId: 'd', expiresAt: '2026-10-15T01:00:00.000Z' }),
    ];
    const s = approvalSummary(list, 'me', NOW);
    expect(s.waiting).toBe(3);
    expect(s.mine).toBe(1);
    expect(s.forOthers).toBe(2);
    expect(s.oldest?.approvalId).toBe('a');
    // A request already past its expiry is not "next to expire".
    expect(s.next?.approvalId).toBe('b');
    expect(approvalSummary([], 'me', NOW)).toMatchObject({ waiting: 0, oldest: null, next: null });
  });
  it('wants a reason of 3 to 500 characters, trimmed', () => {
    expect([
      minReasonOk(''),
      minReasonOk('ab'),
      minReasonOk('  ab '),
      minReasonOk('abc'),
      minReasonOk('x'.repeat(500)),
      minReasonOk('x'.repeat(501)),
    ]).toEqual([false, false, false, true, true, false]);
  });
  it('turns a length of time into the largest sensible unit', () => {
    expect(spanParts(30_000)).toEqual({ n: 0, unit: 'minutes' });
    expect(spanParts(59 * 60_000)).toEqual({ n: 59, unit: 'minutes' });
    expect(spanParts(3 * 3600_000)).toEqual({ n: 3, unit: 'hours' });
    expect(spanParts(47 * 3600_000)).toEqual({ n: 47, unit: 'hours' });
    expect(spanParts(72 * 3600_000)).toEqual({ n: 3, unit: 'days' });
    expect(spanParts(-5000)).toEqual({ n: 0, unit: 'minutes' });
  });
});

describe('limits', () => {
  const usage = {
    rows: [
      {
        kind: 'daily_intake' as const,
        assetCode: 'USDT',
        limit: '20000',
        used: '14200.5',
        remaining: '5799.5',
        resetsAt: '2026-10-16T00:00:00.000Z',
      },
      {
        kind: 'beneficiaries_per_day' as const,
        assetCode: null,
        limit: '5',
        used: '5',
        remaining: '0',
        resetsAt: '2026-10-16T00:00:00.000Z',
      },
      { kind: 'per_payment' as const, assetCode: 'USDT', limit: '5000', used: null, remaining: null, resetsAt: null },
    ],
  };
  it('always lists all five kinds in a fixed order, and marks the ones nobody set', () => {
    const rows = limitRows(usage, null);
    expect(rows.map((r) => r.kind)).toEqual(['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout', 'beneficiaries_per_day']);
    expect(rows.filter((r) => !r.configured).map((r) => r.kind)).toEqual(['monthly_intake', 'daily_payout']);
    const unset = rows.find((r) => r.kind === 'monthly_intake')!;
    expect([unset.limit, unset.used, unset.pct]).toEqual([null, null, null]);
  });
  it('falls back to the configured caps, without usage, when usage cannot be read', () => {
    const rows = limitRows(null, {
      caps: [
        { kind: 'daily_payout', assetCode: 'USDT', limit: '10000' },
        { kind: 'beneficiaries_per_day', limit: 5 },
      ],
    });
    expect(rows.filter((r) => r.configured).map((r) => [r.kind, r.limit, r.pct])).toEqual([
      ['daily_payout', '10000', null],
      ['beneficiaries_per_day', '5', null],
    ]);
  });
  it('shows everything as not configured when there are no caps and no usage', () => {
    expect(limitRows({ rows: [] }, { caps: null }).every((r) => !r.configured)).toBe(true);
    expect(limitRows(null, null).every((r) => !r.configured)).toBe(true);
  });
  it('sizes a bar with exact integer maths and caps it at 100', () => {
    expect(usagePct('14200.5', '20000')).toBe(71);
    expect(usagePct('0', '100')).toBe(0);
    expect(usagePct('100', '100')).toBe(100);
    expect(usagePct('250', '100')).toBe(100);
    expect(usagePct('0', '0')).toBe(100);
    expect(usagePct('1', '3')).toBe(33.3);
    expect(usagePct('99999999999999999999', '99999999999999999999.999999999999999999')).toBeLessThanOrEqual(100);
  });
  it('finds the limit closest to being used up', () => {
    expect(closestToLimit(limitRows(usage, null))?.kind).toBe('beneficiaries_per_day');
    expect(closestToLimit(limitRows(null, null))).toBeNull();
  });
  it('computes how old a time-only read is, and refuses to call an unreadable time live', () => {
    expect(freshnessAt('2026-10-15T11:59:40.000Z', NOW)).toEqual({ asOf: '2026-10-15T11:59:40.000Z', lagSeconds: 20 });
    expect(freshnessAt('2026-10-15T12:00:05.000Z', NOW).lagSeconds).toBe(0);
    expect(freshnessAt('garbage', NOW)).toEqual({ asOf: null, lagSeconds: null });
  });
});

describe('pricing and pauses', () => {
  it('writes basis points as a percentage with integer maths', () => {
    expect([bpsPercent(0), bpsPercent(1), bpsPercent(150), bpsPercent(1205), bpsPercent(10000)]).toEqual([
      '0.00%',
      '0.01%',
      '1.50%',
      '12.05%',
      '100.00%',
    ]);
  });
  it('accepts only a positive exact decimal for the calculator', () => {
    for (const ok of ['1', '0.5', '100.000000000000000001']) expect(isCalcAmount(ok), ok).toBe(true);
    for (const bad of ['', '0', '0.0', '-1', '1e3', '1,5', '1.1234567890123456789', 'abc', ' ']) expect(isCalcAmount(bad), bad).toBe(false);
  });
  it('reports pauses for the named operations only, and counts an unreadable store as paused', () => {
    const status = {
      readable: true,
      states: [
        { scope: 'payout' as const, target: { level: 'global' as const }, halted: true, changedAt: '2026-10-15T00:00:00.000Z' },
        { scope: 'intake' as const, target: { level: 'merchant' as const, merchantId: 'm' }, halted: false, changedAt: null },
        { scope: 'conversion' as const, target: { level: 'global' as const }, halted: true, changedAt: null },
        {
          scope: 'payout' as const,
          target: { level: 'rail' as const, railId: 'crypto-native' },
          halted: true,
          changedAt: '2026-10-15T01:00:00.000Z',
        },
      ],
    };
    expect(activeHalts(status, ['payout', 'intake'])).toEqual({
      unreadable: false,
      halts: [
        { scope: 'payout', level: 'global', changedAt: '2026-10-15T00:00:00.000Z' },
        { scope: 'payout', level: 'rail', railId: 'crypto-native', changedAt: '2026-10-15T01:00:00.000Z' },
      ],
    });
    expect(activeHalts({ readable: false, states: [] }, ['payout'])).toEqual({ unreadable: true, halts: [] });
  });
});

describe('csv', () => {
  it('quotes every cell, doubles quotes, and puts the generated-at and as-of times on every row', () => {
    const csv = buildCsv(['a', 'b'], [['x "y"', 'z']], { generatedAt: 'G', asOf: 'A' });
    expect(csv).toBe('"a","b","generated_at","as_of"\r\n"x ""y""","z","G","A"\r\n');
  });
  it('defuses a cell a spreadsheet would run as a formula, but leaves a plain negative number alone', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('+1+1')).toBe(`"'+1+1"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('-cmd')).toBe(`"'-cmd"`);
    expect(csvCell('-12.5')).toBe('"-12.5"');
    expect(csvCell(null)).toBe('""');
  });
});
