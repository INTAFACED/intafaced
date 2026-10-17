import { describe, expect, it } from 'vitest';
import {
  approvalActions,
  proposalMatches,
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
