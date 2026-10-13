import { describe, expect, it } from 'vitest';
import type { CrmOpportunity } from '@intafaced/contracts';
import {
  DEFAULT_CRM_SORT,
  ariaSort,
  compareDecimal,
  formatIndicativeAmount,
  indicativeAmountOf,
  nextSort,
  sortEnquiries,
} from './crm-list';

let counter = 0;
function row(over: Record<string, unknown>): CrmOpportunity {
  counter += 1;
  return {
    id: `o${counter}`,
    contactId: `c${counter}`,
    organisationId: null,
    submissionId: `s${counter}`,
    ownerUserId: 'u1',
    revision: 1,
    audience: 'investor',
    stage: 'new',
    nextAction: { description: 'Call', dueAt: '2026-10-20T09:00:00.000Z' },
    closedDisposition: null,
    closingEvidenceRef: null,
    createdAt: '2026-10-10T09:00:00.000Z',
    updatedAt: '2026-10-10T09:00:00.000Z',
    indicativeContribution: { status: 'undecided' },
    ...over,
  } as CrmOpportunity;
}
const stated = (amount: string, currency = 'EUR') => ({ indicativeContribution: { status: 'stated', amount, currency } });

describe('indicative amount', () => {
  it('formats with currency, no decimals for whole amounts, and a dash when undecided', () => {
    expect(formatIndicativeAmount({ amount: '150000', currency: 'EUR' })).toBe('€150,000');
    expect(formatIndicativeAmount({ amount: '1250.5', currency: 'GBP' })).toBe('£1,250.5');
    expect(formatIndicativeAmount({ amount: '0', currency: 'EUR' })).toBe('€0');
    expect(formatIndicativeAmount(null)).toBe('—');
  });
  it('falls back to plain digits for a currency the browser does not know', () => {
    expect(formatIndicativeAmount({ amount: '1500000', currency: 'ZZ' })).toBe('1,500,000 ZZ');
  });
  it('reads the amount only from a stated investor contribution', () => {
    expect(indicativeAmountOf(row(stated('250000')))).toEqual({ amount: '250000', currency: 'EUR' });
    expect(indicativeAmountOf(row({}))).toBeNull();
    expect(indicativeAmountOf(row({ audience: 'trader', stage: 'new', indicativeContribution: undefined }))).toBeNull();
  });
  it('compares decimal strings exactly', () => {
    expect(compareDecimal('9', '10')).toBe(-1);
    expect(compareDecimal('100', '99.99')).toBe(1);
    expect(compareDecimal('1.50', '1.5')).toBe(0);
    expect(compareDecimal('12345678901234567890.000000000000000002', '12345678901234567890.000000000000000001')).toBe(1);
  });
});

describe('sorting the loaded page', () => {
  const contacts = new Map([
    ['c1', { name: 'Zoe' }],
    ['c2', { name: 'adam' }],
    ['c3', { name: 'Ben' }],
    ['c4', { name: 'Chloe' }],
  ]);
  const make = () => {
    counter = 0;
    return [
      row({
        createdAt: '2026-10-13T00:00:00.000Z',
        ...stated('50000'),
        nextAction: { description: 'a', dueAt: '2026-10-25T00:00:00.000Z' },
      }),
      row({
        createdAt: '2026-10-12T00:00:00.000Z',
        ...stated('250000'),
        nextAction: null,
        stage: 'closed',
        closedDisposition: 'declined',
        closingEvidenceRef: 'x',
      }),
      row({ createdAt: '2026-10-11T00:00:00.000Z', nextAction: { description: 'c', dueAt: '2026-10-14T00:00:00.000Z' } }),
      row({
        createdAt: '2026-10-10T00:00:00.000Z',
        ...stated('9000'),
        nextAction: { description: 'd', dueAt: '2026-10-30T00:00:00.000Z' },
      }),
    ];
  };
  const ids = (sorted: CrmOpportunity[]) => sorted.map((item) => item.id);
  it('keeps the server order for the default sort', () => {
    expect(ids(sortEnquiries(make(), contacts, DEFAULT_CRM_SORT))).toEqual(['o1', 'o2', 'o3', 'o4']);
  });
  it('sorts by received, oldest or newest', () => {
    expect(ids(sortEnquiries(make(), contacts, { key: 'received', direction: 'asc' }))).toEqual(['o4', 'o3', 'o2', 'o1']);
  });
  it('sorts by name, ignoring case', () => {
    expect(ids(sortEnquiries(make(), contacts, { key: 'name', direction: 'asc' }))).toEqual(['o2', 'o3', 'o4', 'o1']);
    expect(ids(sortEnquiries(make(), contacts, { key: 'name', direction: 'desc' }))).toEqual(['o1', 'o4', 'o3', 'o2']);
  });
  it('sorts by due time and puts rows with no next action last in both directions', () => {
    expect(ids(sortEnquiries(make(), contacts, { key: 'due', direction: 'asc' }))).toEqual(['o3', 'o1', 'o4', 'o2']);
    expect(ids(sortEnquiries(make(), contacts, { key: 'due', direction: 'desc' }))).toEqual(['o4', 'o1', 'o3', 'o2']);
  });
  it('sorts by amount and puts undecided rows last in both directions', () => {
    expect(ids(sortEnquiries(make(), contacts, { key: 'amount', direction: 'desc' }))).toEqual(['o2', 'o1', 'o4', 'o3']);
    expect(ids(sortEnquiries(make(), contacts, { key: 'amount', direction: 'asc' }))).toEqual(['o4', 'o1', 'o2', 'o3']);
  });
  it('keeps ties in their arrival order and never changes the input', () => {
    const input = make();
    const before = ids(input);
    const sorted = sortEnquiries(input, contacts, { key: 'amount', direction: 'desc' });
    expect(ids(input)).toEqual(before);
    expect(sorted).not.toBe(input);
  });
});

describe('header state', () => {
  it('starts a new column in its natural direction and flips the same column', () => {
    expect(nextSort(DEFAULT_CRM_SORT, 'amount')).toEqual({ key: 'amount', direction: 'desc' });
    expect(nextSort(DEFAULT_CRM_SORT, 'name')).toEqual({ key: 'name', direction: 'asc' });
    expect(nextSort(DEFAULT_CRM_SORT, 'due')).toEqual({ key: 'due', direction: 'asc' });
    expect(nextSort(DEFAULT_CRM_SORT, 'received')).toEqual({ key: 'received', direction: 'asc' });
  });
  it('reports aria-sort for the active column only', () => {
    expect(ariaSort({ key: 'name', direction: 'asc' }, 'name')).toBe('ascending');
    expect(ariaSort({ key: 'name', direction: 'desc' }, 'name')).toBe('descending');
    expect(ariaSort({ key: 'name', direction: 'desc' }, 'amount')).toBe('none');
  });
});
