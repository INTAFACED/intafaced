import { describe, expect, it } from 'vitest';
import { approvalActions, companySpaces, needsSecondPerson, ownSpaceName, thresholdProblem, whoMade } from './business-model';

describe('approval actions', () => {
  it('lets the maker cancel and anyone else approve or reject', () => {
    expect(approvalActions({ status: 'pending', makerUserId: 'u1' }, 'u1')).toEqual(['cancel']);
    expect(approvalActions({ status: 'pending', makerUserId: 'u1' }, 'u2')).toEqual(['approve', 'reject']);
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
