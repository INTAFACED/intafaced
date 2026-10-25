import { describe, expect, it, beforeEach } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { runRailAdapterConformance, type RailHarness } from './conformance.js';
import { BankTransferSandboxAdapter, bankTransferReference, BANK_TRANSFER_REFERENCE } from './bank-transfer-sandbox.js';
import { signPayload } from './webhook-signature.js';
import type { PaymentIntent, RailWebhookRequest } from './rail-adapter.js';

const SECRET = 'conformance-secret-at-least-32-chars-long';

const signRaw = (body: string, at = new Date()): RailWebhookRequest => {
  const timestamp = Math.floor(at.getTime() / 1000).toString();
  return { headers: { 'x-bank-signature': signPayload(SECRET, timestamp, body), 'x-bank-timestamp': timestamp }, body };
};

const kitAdapter = new BankTransferSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });

runRailAdapterConformance('bank-transfer-sandbox', async (): Promise<RailHarness> => ({
  adapter: kitAdapter,
  reset: async () => kitAdapter.reset(),
  /** At a bank, "primed" means the payer's transfer has arrived for the whole amount. */
  primeAuthorization: async (intent: PaymentIntent) => {
    if (intent.amount <= 0n) return;
    kitAdapter.receive(
      kitAdapter.verifyWebhook(
        signRaw(
          JSON.stringify({
            id: `prime-${intent.paymentId}`,
            type: 'captured',
            ref: bankTransferReference(intent.paymentId),
            amount: formatAmount(intent.amount),
            assetId: intent.assetId,
            payerName: 'TEST Payer',
          }),
        ),
      ),
    );
  },
  signWebhook: (event) =>
    signRaw(
      JSON.stringify({
        id: event.id,
        type: event.type,
        ref: event.ref,
        amount: event.amount === undefined ? undefined : formatAmount(event.amount),
        assetId: event.assetId,
      }),
    ),
  signRaw: (body) => signRaw(body),
  failNext: () => kitAdapter.failNext(),
}));

describe('bank-transfer-sandbox: a TEST bank taking pushed transfers (J-merchant-04 step 6)', () => {
  const adapter = new BankTransferSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
  const intent: PaymentIntent = {
    paymentId: '6f1c2a40-0000-4000-8000-000000000001',
    merchantId: 'm1',
    amount: amt('30'),
    assetId: 'EUR',
    method: 'bank_transfer',
  };
  const ref = bankTransferReference(intent.paymentId);
  const deliver = (body: Record<string, unknown>) => adapter.verifyWebhook(signRaw(JSON.stringify({ type: 'captured', ref, ...body })));

  beforeEach(() => adapter.reset());

  it('is a sandbox, always, and takes no refund or payout', () => {
    expect(adapter.mode).toBe('sandbox');
    expect(adapter.capabilities).toEqual(['authorize', 'capture', 'webhook']);
  });

  it('gives a payer the same short reference for the same payment', () => {
    expect(ref).toMatch(BANK_TRANSFER_REFERENCE);
    expect(bankTransferReference(intent.paymentId)).toBe(ref);
    expect(bankTransferReference('6f1c2a40-0000-4000-8000-000000000002')).not.toBe(ref);
  });

  it('answers pending with the reference until transfers in the currency cover the payment', async () => {
    const before = await adapter.authorize(intent);
    expect(before).toMatchObject({ ok: true, status: 'pending', railRef: ref });
    expect(adapter.receive(deliver({ id: 't1', amount: '20', assetId: 'EUR', payerName: 'Ada Lovelace' }))).toBe(true);
    // Another currency to the same reference does not count towards a EUR payment.
    adapter.receive(deliver({ id: 't2', amount: '50', assetId: 'GBP' }));
    expect((await adapter.authorize(intent)).status).toBe('pending');
    adapter.receive(deliver({ id: 't3', amount: '10', assetId: 'EUR' }));
    const auth = await adapter.authorize(intent);
    expect(auth.status).toBe('authorized');
    expect(formatAmount(auth.amount)).toBe(formatAmount(amt('30')));
    // It names whose accounts every counted transfer came from, so the core checks exactly that money.
    expect(auth.payerNames).toEqual(['Ada Lovelace', null]);
    const capture = await adapter.capture(ref);
    expect(capture).toMatchObject({ ok: true, status: 'captured', railRef: ref, assetId: 'EUR' });
    expect(formatAmount(capture.amount)).toBe(formatAmount(amt('30')));
  });

  it('books one transfer once, however often it is delivered', async () => {
    const event = deliver({ id: 't1', amount: '30', assetId: 'EUR' });
    expect(adapter.receive(event)).toBe(true);
    expect(adapter.receive(event)).toBe(false);
    expect(adapter.receive(deliver({ id: 't1', amount: '30', assetId: 'EUR' }))).toBe(false);
    await adapter.authorize(intent);
    expect(formatAmount((await adapter.capture(ref)).amount)).toBe(formatAmount(amt('30')));
  });

  it('reads the payer name the bank reports, and refuses one that is not text or too long', () => {
    expect(deliver({ id: 't1', amount: '30', assetId: 'EUR', payerName: '  A LOVELACE ' })?.payerName).toBe('A LOVELACE');
    expect(deliver({ id: 't2', amount: '30', assetId: 'EUR' })?.payerName).toBeUndefined();
    expect(deliver({ id: 't7', amount: '30', assetId: 'EUR', payerName: 'Ada\u0000Lovelace' })?.payerName).toBe('Ada Lovelace');
    expect(deliver({ id: 't3', amount: '30', assetId: 'EUR', payerName: 42 })).toBeNull();
    expect(deliver({ id: 't4', amount: '30', assetId: 'EUR', payerName: 'x'.repeat(141) })).toBeNull();
    // Money is never a JSON number, and a currency is a code.
    expect(deliver({ id: 't5', amount: 30, assetId: 'EUR' })).toBeNull();
    expect(deliver({ id: 't6', amount: '30', assetId: 'eur' })).toBeNull();
  });

  it('does not book a transfer with no amount or currency, or one from another rail', () => {
    expect(adapter.receive(deliver({ id: 't1', amount: '30' }))).toBe(false);
    expect(adapter.receive(deliver({ id: 't2', type: 'failed', amount: '30', assetId: 'EUR' }))).toBe(false);
    expect(adapter.receive(null)).toBe(false);
  });

  it('refuses a refund and a payout by name instead of reporting money it never sent', async () => {
    expect(await adapter.refund(ref, amt('1'))).toMatchObject({ ok: false, failureCode: 'rail.operation_unsupported' });
    expect(await adapter.payout()).toMatchObject({ ok: false, failureCode: 'rail.operation_unsupported' });
  });
});
