import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { createLedgerClient } from './ledger-client.js';
import { postPayLedger } from './ledger-receipt.js';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request = recipes.withdrawHold({
  userId: '11111111-1111-4111-8111-111111111111',
  assetId: 'USDT',
  amount: parseAmount('40'),
  rail: 'card-sandbox',
  withdrawalId: 'original-business-id:0',
});
describe('payment ledger receipt identity', () => {
  it('accepts request-linked compact HTTP ACKs and keeps unavailable receipt reads unavailable', async () => {
    let wire: unknown;
    globalThis.fetch = async (_url, init) => {
      wire = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ txId: 'tx-original', hash: 'hash-original', postedAt: '2026-10-11T00:00:00.000Z' }));
    };
    const ledger = createLedgerClient('http://ledger.test', 'fixture-internal-service-secret-32-chars');
    const ack = await postPayLedger(ledger, request);
    expect(ack.entries).toHaveLength(0);
    expect(wire).toMatchObject({ idempotencyKey: request.idempotencyKey, entries: [{ amount: '40' }, { amount: '40' }] });
    // A lookup the ledger cannot answer stays a failure; it never reads as "not booked".
    globalThis.fetch = async () => new Response('down', { status: 503 });
    await expect(ledger.getTxByKey(request.idempotencyKey)).rejects.toThrow('/trpc/txByKey failed (503)');
  });
  it('refuses a malformed compact ACK without treating it as a no-effect receipt', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ txId: '', postedAt: 'invalid' }));
    const ledger = createLedgerClient('http://ledger.test', 'fixture-internal-service-secret-32-chars');
    await expect(postPayLedger(ledger, request)).rejects.toMatchObject({ code: 'pay.ledger_receipt_mismatch' });
  });
  it('refuses rich receipts with changed original key or legs even when current balances differ', async () => {
    const book = new MemoryLedger();
    await book.post(
      recipes.deposit({
        userId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDT',
        amount: parseAmount('100'),
        rail: 'card-sandbox',
        railRef: 'fixture-credit',
      }),
    );
    const receipt = await book.post(request);
    const readOnlyIdentity: LedgerClient = {
      post: async () => ({
        ...receipt,
        entries: receipt.entries.map((entry, index) => (index === 0 ? { ...entry, amount: parseAmount('41') } : entry)),
      }),
      balance: book.balance.bind(book),
      balances: book.balances.bind(book),
      getTx: book.getTx.bind(book),
      getTxByKey: book.getTxByKey.bind(book),
    };
    await expect(postPayLedger(readOnlyIdentity, request)).rejects.toMatchObject({ code: 'pay.ledger_receipt_mismatch' });
    await expect(
      postPayLedger({ ...readOnlyIdentity, post: async () => ({ ...receipt, idempotencyKey: 'other-key' }) }, request),
    ).rejects.toMatchObject({ code: 'pay.ledger_receipt_mismatch' });
    expect((await postPayLedger({ ...readOnlyIdentity, post: async () => receipt }, request)).id).toBe(receipt.id);
  });
});
