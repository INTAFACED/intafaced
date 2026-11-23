import { describe, expect, it } from 'vitest';
import { createReversalLedger, reverseOutcomeOf } from './ledger.js';

const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIRST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = `ops:reversal:${ORIGINAL}:1`;
const CALL = { originalTxId: ORIGINAL, ordinal: '1', reason: 'LOCAL TEST wrong account', caseRef: 'CASE-1' };
const RECEIPT = {
  txId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  idempotencyKey: KEY,
  postedAt: '2026-11-24T08:00:00.000Z',
  reverses: ORIGINAL,
};

describe('what an operatorReverse answer proves', () => {
  it('a receipt for this key and original is posted; any other receipt is not believed', () => {
    expect(reverseOutcomeOf(CALL, KEY, { status: 200, body: RECEIPT })).toEqual({ kind: 'posted', txId: RECEIPT.txId });
    expect(reverseOutcomeOf(CALL, `ops:reversal:${ORIGINAL}:2`, { status: 200, body: RECEIPT })).toEqual({
      kind: 'retry',
      code: 'ledger.reply_invalid',
    });
    expect(reverseOutcomeOf(CALL, KEY, { status: 200, body: { ...RECEIPT, reverses: FIRST } })).toEqual({
      kind: 'retry',
      code: 'ledger.reply_invalid',
    });
    expect(reverseOutcomeOf(CALL, KEY, { status: 200, body: null })).toEqual({ kind: 'retry', code: 'ledger.reply_invalid' });
  });

  it('a refusal the ledger gives before booking settles the request, naming the first reversal when it says so', () => {
    expect(
      reverseOutcomeOf(CALL, KEY, { status: 409, body: { code: 'ledger.reversal_already_reversed', reversedBy: FIRST, message: 'x' } }),
    ).toEqual({
      kind: 'refused',
      code: 'ledger.reversal_already_reversed',
      reversedBy: FIRST,
    });
    expect(reverseOutcomeOf(CALL, KEY, { status: 400, body: { code: 'ledger.insufficient_funds' } })).toEqual({
      kind: 'refused',
      code: 'ledger.insufficient_funds',
      reversedBy: null,
    });
    expect(reverseOutcomeOf(CALL, KEY, { status: 404, body: { code: 'ledger.tx_not_found' } })).toMatchObject({ kind: 'refused' });
    // An original that moved a customer's balance: the ledger's recipe refuses it, and nothing was booked.
    expect(reverseOutcomeOf(CALL, KEY, { status: 400, body: { code: 'ledger.invalid_entry', message: 'x' } })).toEqual({
      kind: 'refused',
      code: 'ledger.invalid_entry',
      reversedBy: null,
    });
  });

  it('the posting freeze, an unnamed failure and a conflict under our own key are sent again, never settled', () => {
    expect(reverseOutcomeOf(CALL, KEY, { status: 412, body: { code: 'ledger.frozen' } })).toEqual({ kind: 'retry', code: 'ledger.frozen' });
    expect(reverseOutcomeOf(CALL, KEY, { status: 409, body: { code: 'ledger.idempotency_conflict' } })).toEqual({
      kind: 'retry',
      code: 'ledger.idempotency_conflict',
    });
    expect(reverseOutcomeOf(CALL, KEY, { status: 502, body: null })).toEqual({ kind: 'retry', code: 'http.502' });
  });
});

describe('the operatorReverse client', () => {
  it('is absent without a URL or a credential', () => {
    expect(createReversalLedger({ secret: 'x'.repeat(32) })).toBeUndefined();
    expect(createReversalLedger({ ledgerUrl: 'http://ledger:4001', secret: 'short' })).toBeUndefined();
  });

  it('sends the record’s body once, signed, to the door, and reads a thrown fetch as a lost reply', async () => {
    const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(RECEIPT), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const ledger = createReversalLedger({ ledgerUrl: 'http://ledger:4001/', secret: 's'.repeat(40), fetcher })!;
    expect(await ledger.reverse(CALL, KEY)).toEqual({ kind: 'posted', txId: RECEIPT.txId });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://ledger:4001/trpc/operatorReverse');
    expect(JSON.parse(seen[0]!.body)).toEqual(CALL);
    expect(Object.keys(seen[0]!.headers).length).toBeGreaterThan(1);

    const down = createReversalLedger({
      ledgerUrl: 'http://ledger:4001',
      secret: 's'.repeat(40),
      fetcher: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    })!;
    expect(await down.reverse(CALL, KEY)).toEqual({ kind: 'retry', code: 'ledger.reply_lost' });
  });
});
