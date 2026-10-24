import { describe, expect, it } from 'vitest';
import { ledgerHref, ledgerQueryFromParams, searchPlan, searchQuery } from './cross-search';

const TX = '33333333-3333-4333-8333-333333333333';
const KEY = 'deposit:local-test:LOCAL-TEST-abcd';

describe('cross-desk search term', () => {
  it('trims, and refuses an empty, an over-long or a control-character term in words', () => {
    expect(searchQuery('  ana@example.com ')).toEqual({ q: 'ana@example.com' });
    expect(searchQuery('   ')).toMatchObject({ error: expect.stringContaining('Type an email') });
    expect(searchQuery(null)).toMatchObject({ error: expect.any(String) });
    expect(searchQuery('x'.repeat(513))).toMatchObject({ error: expect.stringContaining('512') });
    expect(searchQuery('a\u0000b')).toMatchObject({ error: expect.stringContaining('control') });
  });
});

describe('what each desk is asked', () => {
  it('a business key: traced on the ledger, read as a possible transfer id, and not an identity search', () => {
    const plan = searchPlan(KEY);
    expect(plan.ledger).toEqual({ kind: 'lookup', query: { businessKey: KEY } });
    expect(plan.payments).toEqual({ kind: 'transfer', id: KEY });
    expect(plan.accounts).toMatchObject({ kind: 'not-asked', why: expect.stringContaining('Identity was not asked') });
  });
  it('an email: identity searches it, the ledger traces it as a key, and svc-bank is not asked', () => {
    const plan = searchPlan('Ana@Example.com');
    expect(plan.accounts).toEqual({ kind: 'search', term: { kind: 'email', value: 'ana@example.com' } });
    expect(plan.ledger).toEqual({ kind: 'lookup', query: { businessKey: 'Ana@Example.com' } });
    expect(plan.payments).toMatchObject({ kind: 'not-asked', why: expect.stringContaining('email') });
  });
  it('a handle start: identity searches it; too short for a transfer id', () => {
    const plan = searchPlan('pgq');
    expect(plan.accounts).toEqual({ kind: 'search', term: { kind: 'handle', value: 'pgq' } });
    expect(plan.payments).toMatchObject({ kind: 'not-asked', why: expect.stringContaining('8 to 64') });
  });
  it('a UUID: a transaction id on the ledger, an account id for the record, a transfer id for svc-bank', () => {
    const plan = searchPlan(TX.toUpperCase());
    expect(plan.ledger).toEqual({ kind: 'lookup', query: { txId: TX } });
    expect(plan.accounts).toEqual({ kind: 'record', userId: TX });
    expect(plan.payments).toEqual({ kind: 'transfer', id: TX.toUpperCase() });
  });
});

describe('the link back to the ledger desk', () => {
  it('round-trips through the ledger page’s parameters', () => {
    expect(ledgerQueryFromParams(Object.fromEntries(new URL(`https://a.example${ledgerHref({ txId: TX })}`).searchParams))).toEqual({
      txId: TX,
    });
    const key = Object.fromEntries(new URL(`https://a.example${ledgerHref({ businessKey: KEY })}`).searchParams);
    expect(ledgerQueryFromParams(key)).toEqual({ businessKey: KEY });
  });
  it('opens no lookup for a missing, repeated or malformed parameter', () => {
    expect(ledgerQueryFromParams({})).toBeNull();
    expect(ledgerQueryFromParams({ txId: [TX, TX] })).toBeNull();
    expect(ledgerQueryFromParams({ txId: 'not-an-id' })).toBeNull();
    expect(ledgerQueryFromParams({ businessKey: 'x'.repeat(513) })).toBeNull();
    expect(ledgerQueryFromParams({ businessKey: '  ' })).toBeNull();
  });
});
