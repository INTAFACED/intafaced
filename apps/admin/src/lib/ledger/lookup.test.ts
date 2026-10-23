import { describe, expect, it } from 'vitest';
import { lookupQuery, lookupRefusal, parseLookupAnswer } from './lookup';

const TX = '33333333-3333-4333-8333-333333333333';
const KEY = 'deposit:local-test:LOCAL-TEST-abcd';
// TEST amounts only.
const tx = {
  txId: TX,
  businessKey: KEY,
  module: 'deposit',
  reason: 'deposit',
  postedAt: '2026-10-23T04:00:00.000Z',
  hash: 'h1',
  previousHash: 'h0',
  postings: [
    { entryId: 'e1', accountId: 'a1', assetId: 'USDT', direction: 'debit', amount: '25', balanceAfter: '-25' },
    { entryId: 'e2', accountId: 'a2', assetId: 'USDT', direction: 'credit', amount: '25', balanceAfter: '25.5' },
  ],
};

describe('lookupQuery', () => {
  it('takes a UUID transaction id (lower-cased) and a 1-512 character business key, trimmed', () => {
    expect(lookupQuery('txId', ` ${TX.toUpperCase()} `)).toEqual({ txId: TX });
    expect(lookupQuery('businessKey', `  ${KEY} `)).toEqual({ businessKey: KEY });
  });

  it('refuses a non-UUID id, a blank key and an over-long key, so nothing is sent', () => {
    expect(lookupQuery('txId', 'not-a-uuid')).toBeNull();
    expect(lookupQuery('businessKey', '   ')).toBeNull();
    expect(lookupQuery('businessKey', 'k'.repeat(513))).toBeNull();
  });
});

describe('parseLookupAnswer', () => {
  it('accepts the transaction asked for by id, amounts kept as decimal strings', () => {
    const answer = parseLookupAnswer({ txId: TX }, tx);
    expect(answer).toEqual({ found: true, transaction: tx });
    expect(answer?.found && answer.transaction.postings[1]?.balanceAfter).toBe('25.5');
  });

  it('accepts a trace hit for exactly that key, and found:false for a key that never booked', () => {
    expect(parseLookupAnswer({ businessKey: KEY }, { found: true, ...tx })).toEqual({ found: true, transaction: tx });
    expect(parseLookupAnswer({ businessKey: 'never' }, { found: false, businessKey: 'never' })).toEqual({
      found: false,
      businessKey: 'never',
    });
  });

  it('refuses an answer for another id or key, a number amount, an empty posting list or a bad time', () => {
    expect(parseLookupAnswer({ txId: '44444444-4444-4444-8444-444444444444' }, tx)).toBeNull();
    expect(parseLookupAnswer({ businessKey: 'other' }, { found: true, ...tx })).toBeNull();
    expect(parseLookupAnswer({ businessKey: 'other' }, { found: false, businessKey: KEY })).toBeNull();
    expect(parseLookupAnswer({ txId: TX }, { ...tx, postings: [{ ...tx.postings[0], amount: 25 }] })).toBeNull();
    expect(parseLookupAnswer({ txId: TX }, { ...tx, postings: [] })).toBeNull();
    expect(parseLookupAnswer({ txId: TX }, { ...tx, postedAt: 'yesterday' })).toBeNull();
    expect(parseLookupAnswer({ txId: TX }, null)).toBeNull();
  });
});

describe('lookupRefusal', () => {
  it('says each known refusal in words and names the status for anything else', () => {
    expect(lookupRefusal('ledger.tx_not_found', 404)).toBe('No transaction has that id.');
    expect(lookupRefusal('ledger.lookup_unrecorded', 503)).toContain('did not read it');
    expect(lookupRefusal('mfa.required', 401)).toContain('second factor');
    expect(lookupRefusal('something.else', 418)).toBe('The lookup was refused (418).');
  });
});
