import { describe, expect, it } from 'vitest';
import {
  approvalActions,
  buildPayrollInput,
  canRunPayroll,
  canSend,
  payrollMatches,
  payrollProblem,
  payrollTotal,
  proposalMatches,
  recipientQuery,
  proposalOutcome,
  shortRef,
  companySpaces,
  needsSecondPerson,
  ownSpaceName,
  thresholdProblem,
  whoMade,
} from './business-model';

describe('approval actions', () => {
  it('lets the maker cancel; with the role unknown anyone else is offered everything and the service decides', () => {
    expect(approvalActions({ status: 'pending', makerUserId: 'u1' }, 'u1')).toEqual(['cancel']);
    expect(approvalActions({ status: 'pending', makerUserId: 'u1' }, 'u2')).toEqual(['approve', 'reject', 'cancel']);
  });
  it('narrows the buttons once the role is known', () => {
    const approval = { status: 'pending' as const, makerUserId: 'u1' };
    expect(approvalActions(approval, 'u2', 'admin')).toEqual(['approve', 'reject', 'cancel']);
    expect(approvalActions(approval, 'u2', 'checker')).toEqual(['approve', 'reject']);
    expect(approvalActions(approval, 'u2', 'maker')).toEqual([]);
  });
  it('shortens an id to its first block', () => {
    expect(shortRef('a779d840-9715-4517-af5d-d9f7195e466a')).toBe('a779d840');
  });
  it('offers nothing once decided or when signed out', () => {
    expect(approvalActions({ status: 'approved', makerUserId: 'u1' }, 'u2')).toEqual([]);
    expect(approvalActions({ status: 'pending', makerUserId: 'u1' }, null)).toEqual([]);
  });
  it('says who proposed without showing an id', () => {
    expect(whoMade({ makerUserId: 'u1' }, 'u1')).toBe('you');
    expect(whoMade({ makerUserId: 'u1' }, 'u2')).toBe('teammate');
    expect(whoMade({ makerUserId: 'u1' }, null)).toBe('teammate');
  });
});

describe('company accounts', () => {
  const spaces = [
    { id: 'a', name: 'Main', assetId: 'USDT' },
    { id: 'b', name: 'Tax', assetId: 'USDT' },
    { id: 'c', name: 'BTC', assetId: 'BTC' },
  ];
  it('keeps only accounts in the company asset', () => {
    expect(companySpaces(spaces, 'USDT').map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('names only the customer’s own accounts', () => {
    expect(ownSpaceName(spaces, 'b')).toBe('Tax');
    expect(ownSpaceName(spaces, 'z')).toBeNull();
  });
  it('requires an exact positive threshold', () => {
    expect(thresholdProblem('0')).toBe('zero');
    expect(thresholdProblem('0.000000000000000001')).toBeNull();
    expect(thresholdProblem('-5')).toBe('invalid');
    expect(thresholdProblem('')).toBe('invalid');
  });
  it('asks for a second person at or above the threshold, and posts straight away below it', () => {
    expect(needsSecondPerson('1000', '1000')).toBe(true);
    expect(needsSecondPerson('999.999999999999999999', '1000')).toBe(false);
    expect(needsSecondPerson('abc', '1000')).toBeNull();
  });
});

describe('payment proposal reply', () => {
  const id = '0b9d6f1c-1d0f-4c9d-8a2a-5f5c8f7a1e11';
  const input = { accountId: 'acc', fromSpaceId: 'a', toSpaceId: 'b', amount: '10.5', clientId: id };
  const approval = { id, accountId: 'acc', fromSpaceId: 'a', toSpaceId: 'b', amount: '10.50', status: 'pending' };
  it('accepts a pending approval only if it is the one asked for, to the digit', () => {
    expect(proposalMatches({ kind: 'pending', approval }, input)).toBe(true);
    expect(proposalMatches({ kind: 'pending', approval: { ...approval, id: '11111111-1111-4111-8111-111111111111' } }, input)).toBe(false);
    expect(proposalMatches({ kind: 'pending', approval: { ...approval, amount: '10.51' } }, input)).toBe(false);
    expect(proposalMatches({ kind: 'pending', approval: { ...approval, toSpaceId: 'c' } }, input)).toBe(false);
    expect(proposalMatches({ kind: 'pending', approval: { ...approval, accountId: 'other' } }, input)).toBe(false);
  });
  it('accepts a posted payment only with a ledger transaction', () => {
    expect(proposalMatches({ kind: 'posted', transferId: 't', ledgerTxId: 'tx1' }, input)).toBe(true);
    expect(proposalMatches({ kind: 'posted', transferId: 't', ledgerTxId: ' ' }, input)).toBe(false);
    expect(proposalMatches({ kind: 'other' }, input)).toBe(false);
    expect(proposalMatches(null, input)).toBe(false);
  });
  it('tells the two outcomes apart', () => {
    expect(proposalOutcome({ kind: 'pending' })).toBe('pending');
    expect(proposalOutcome({ kind: 'posted' })).toBe('posted');
    expect(proposalOutcome({ kind: 'x' })).toBeNull();
  });
});

describe('who may send and run payroll', () => {
  it('lets administrators and makers, and no one else', () => {
    expect(canSend('admin')).toBe(true);
    expect(canSend('maker')).toBe(true);
    expect(canSend('checker')).toBe(false);
    expect(canRunPayroll('checker')).toBe(false);
    expect(canSend(null)).toBe(false);
  });
});

describe('finding a person by handle or email', () => {
  it('reads a handle with or without the at sign, and an email, and nothing else', () => {
    expect(recipientQuery('ada_l')).toEqual({ handle: 'ada_l' });
    expect(recipientQuery('  @ada_l ')).toEqual({ handle: 'ada_l' });
    expect(recipientQuery('ada@example.com')).toEqual({ email: 'ada@example.com' });
    expect(recipientQuery('')).toBeNull();
    expect(recipientQuery('ab')).toBeNull();
    expect(recipientQuery('has space')).toBeNull();
    expect(recipientQuery('a@b')).toBeNull();
    expect(recipientQuery('@@ada')).toBeNull();
  });
});

describe('a payroll', () => {
  const source = '11111111-1111-4111-8111-111111111111';
  const a = { handle: 'ada', toSpaceId: '22222222-2222-4222-8222-222222222222', amount: '100.50' };
  const b = { handle: 'bob', toSpaceId: '33333333-3333-4333-8333-333333333333', amount: '200' };
  const base = { fromSpaceId: source, threshold: '1000', balance: '5000' };
  it('adds exact amounts without rounding', () => {
    expect(payrollTotal([a, b])).toBe(30050n * 10n ** 16n);
    expect(payrollTotal([{ amount: '0.000000000000000001' }, { amount: '0.000000000000000002' }])).toBe(3n);
    expect(payrollTotal([{ amount: '1e3' }])).toBeNull();
  });
  it('is ready when everyone is paid once, the total is below the limit and the money is there', () => {
    expect(payrollProblem({ ...base, lines: [a, b] })).toBeNull();
  });
  it('names the first reason it cannot go out, using the bank’s own rules', () => {
    expect(payrollProblem({ ...base, lines: [] })).toBe('empty');
    expect(
      payrollProblem({
        ...base,
        lines: Array.from({ length: 65 }, (_, i) => ({
          ...a,
          toSpaceId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          amount: '1',
        })),
      }),
    ).toBe('tooMany');
    expect(payrollProblem({ ...base, lines: [{ ...a, amount: '0' }] })).toBe('amount');
    expect(payrollProblem({ ...base, lines: [{ ...a, amount: '-1' }] })).toBe('amount');
    expect(payrollProblem({ ...base, lines: [a, { ...b, toSpaceId: a.toSpaceId.toUpperCase() }] })).toBe('duplicate');
    expect(payrollProblem({ ...base, lines: [{ ...a, toSpaceId: source }] })).toBe('source');
  });
  it('stays strictly below the approval limit, because a payroll has no second approver', () => {
    expect(payrollProblem({ ...base, lines: [{ ...a, amount: '999.999999999999999999' }] })).toBeNull();
    expect(payrollProblem({ ...base, lines: [{ ...a, amount: '1000' }] })).toBe('overLimit');
    expect(
      payrollProblem({
        ...base,
        lines: [
          { ...a, amount: '600' },
          { ...b, amount: '400' },
        ],
      }),
    ).toBe('overLimit');
  });
  it('does not promise more than the source account holds', () => {
    expect(payrollProblem({ ...base, balance: '300.49', lines: [a, b] })).toBe('overBalance');
    expect(payrollProblem({ ...base, balance: '300.50', lines: [a, b] })).toBeNull();
    // An unreadable balance does not block: the bank checks it.
    expect(payrollProblem({ ...base, balance: null, lines: [a, b] })).toBeNull();
  });
  it('is sent as the payroll id, the source and every person with an exact amount', () => {
    const payrollId = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
    const accountId = '44444444-4444-4444-8444-444444444444';
    const input = buildPayrollInput(payrollId, accountId, source, [a, { ...b, amount: ' 200 ' }]);
    expect(input).toEqual({
      payrollId,
      accountId,
      fromSpaceId: source,
      recipients: [
        { toSpaceId: a.toSpaceId, amount: '100.50' },
        { toSpaceId: b.toSpaceId, amount: '200' },
      ],
    });
    // The same payroll sent twice is the same request, so the bank pays it once.
    expect(buildPayrollInput(payrollId, accountId, source, [a, b])).toEqual(buildPayrollInput(payrollId, accountId, source, [a, b]));
  });
  it('accepts a reply only for that payroll, with every person and amount to the digit', () => {
    const payrollId = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
    const accountId = '44444444-4444-4444-8444-444444444444';
    const input = buildPayrollInput(payrollId, accountId, source, [a, b]);
    const reply = {
      payrollId,
      accountId,
      fromSpaceId: source,
      assetId: 'USDT',
      ledgerTxId: 'tx-1',
      recipients: [
        { toSpaceId: b.toSpaceId, amount: '200.0' },
        { toSpaceId: a.toSpaceId, amount: '100.5' },
      ],
      createdAt: '2026-10-18T00:00:00Z',
    };
    expect(payrollMatches(reply, input)).toBe(true);
    expect(payrollMatches({ ...reply, payrollId: '00000000-0000-4000-8000-000000000000' }, input)).toBe(false);
    expect(payrollMatches({ ...reply, ledgerTxId: ' ' }, input)).toBe(false);
    expect(payrollMatches({ ...reply, recipients: reply.recipients.slice(1) }, input)).toBe(false);
    expect(payrollMatches({ ...reply, recipients: [reply.recipients[0], { ...reply.recipients[1]!, amount: '100.51' }] }, input)).toBe(
      false,
    );
    expect(payrollMatches({ ...reply, recipients: [reply.recipients[0], { ...reply.recipients[1]!, toSpaceId: source }] }, input)).toBe(
      false,
    );
    expect(payrollMatches({ ...reply, fromSpaceId: a.toSpaceId }, input)).toBe(false);
    expect(payrollMatches(null, input)).toBe(false);
  });
});
