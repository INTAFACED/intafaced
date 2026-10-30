import { describe, expect, it, beforeEach } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { runRailAdapterConformance, type RailHarness } from './conformance.js';
import { CardSandboxAdapter, SANDBOX_DECLINE_TOKEN, SANDBOX_FUNDS_HELD_TOKEN } from './card-sandbox.js';
import { CryptoNativeAdapter, RailOutcomeUnknownError } from './crypto-native.js';
import { MemoryChain } from './chain-port.js';
import { RailRegistry, UnknownRailError, RailCapabilityError } from './registry.js';
import { signPayload, verifySignature } from './webhook-signature.js';
import { isUsable, supports, type PaymentIntent, type RailWebhookRequest } from './rail-adapter.js';

/**
 * BOTH v1 ADAPTERS THROUGH THE CONFORMANCE KIT (§6.3).
 *
 * This is the file that makes §6.1's "drop in later with zero core changes" a
 * testable claim. A third adapter is added by writing a harness here and running
 * the same suite — and if it does not pass, the core would have had to change to
 * accommodate it, which is precisely what the kit exists to prevent.
 */

const SECRET = 'conformance-secret-at-least-32-chars-long';

// ── card-sandbox ─────────────────────────────────────────────────────────────

const cardAdapter = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });

runRailAdapterConformance('card-sandbox', async (): Promise<RailHarness> => {
  const signRaw = (body: string): RailWebhookRequest => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      headers: { 'x-sandbox-signature': signPayload(SECRET, timestamp, body), 'x-sandbox-timestamp': timestamp },
      body,
    };
  };

  return {
    adapter: cardAdapter,
    reset: async () => cardAdapter.reset(),
    // A mock acquirer needs nothing to be able to authorize — which is exactly
    // what makes it useful for driving the core's full flow in CI.
    primeAuthorization: async () => undefined,
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
    signRaw,
    failNext: () => cardAdapter.failNext(),
    payoutDestination: () => ({ kind: 'bank', ref: 'GB82WEST12345698765432' }),
  };
});

// ── crypto-native ────────────────────────────────────────────────────────────

const chain = new MemoryChain();
const cryptoAdapter = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });

runRailAdapterConformance('crypto-native', async (): Promise<RailHarness> => {
  const signRaw = (body: string): RailWebhookRequest => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      headers: { 'x-chain-signature': signPayload(SECRET, timestamp, body), 'x-chain-timestamp': timestamp },
      body,
    };
  };

  return {
    adapter: cryptoAdapter,
    reset: async () => {
      chain.reset();
      cryptoAdapter.reset();
    },
    /** On a chain, "primed" means the payer has actually sent the funds. */
    primeAuthorization: async (intent: PaymentIntent) => {
      const address = await chain.acceptanceAddress(intent.paymentId, intent.assetId);
      if (intent.amount > 0n) {
        chain.credit({ address, assetId: intent.assetId, amount: intent.amount, confirmations: 12 });
      }
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
    signRaw,
    failNext: () => chain.failNextCall(),
    payoutDestination: () => ({ kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' }),
  };
});

// ── Behaviour the kit cannot express, because it is rail-specific ────────────

describe('crypto-native — finality is the whole rail', () => {
  let localChain: MemoryChain;
  let adapter: CryptoNativeAdapter;

  const intent = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
    paymentId: 'p-fin-1',
    merchantId: 'm-1',
    amount: amt('100'),
    assetId: 'USDT',
    method: 'crypto',
    ...overrides,
  });

  beforeEach(() => {
    localChain = new MemoryChain();
    adapter = new CryptoNativeAdapter({ chain: localChain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
  });

  it('is pending, not authorized, before the payer has sent anything', async () => {
    const result = await adapter.authorize(intent());
    expect(result.ok).toBe(true);
    expect(result.status).toBe('pending');
    // The address is handed out anyway — that is what the payer pays into.
    expect(result.railRef).toContain('addr_usdt_');
  });

  it('is pending while the transfer is too shallow to be final', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), confirmations: 2 });

    const result = await adapter.authorize(intent());
    expect(result.status).toBe('pending');
    expect(result.raw).toMatchObject({ confirmations: 2, required: 6 });
  });

  it('authorizes once the transfer is deep enough', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), confirmations: 2 });
    expect((await adapter.authorize(intent())).status).toBe('pending');

    localChain.setConfirmations(address, 6);
    expect((await adapter.authorize(intent())).status).toBe('authorized');
  });

  it('refuses to capture a transfer that has become too shallow', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), confirmations: 12 });
    const auth = await adapter.authorize(intent());

    // A reorg between authorize and capture. Capture re-reads the chain rather
    // than trusting a decision made minutes ago, which is the only reason this
    // is catchable at all.
    localChain.setConfirmations(address, 1);

    const result = await adapter.capture(auth.railRef);
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('chain.insufficient_confirmations');
  });

  it('keeps an underpayment pending, with where the money is and what is missing', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12 });

    const result = await adapter.authorize(intent());
    // Not failed: the payer may send the rest, and failing the payment would leave that second transfer pointing at nothing.
    expect(result.ok).toBe(true);
    expect(result.status).toBe('pending');
    expect(formatAmount(result.amount)).toBe('60');
    // Where the money is, and who to send it back to — in the result, not in a log.
    expect(result.raw).toMatchObject({ address, received: '60', missing: '40', transfers: [{ from: '0xbuyer', amount: '60' }] });
  });

  it('authorizes and captures once two final transfers add up, booking both (M-payments-core-04b)', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0x60' });
    expect((await adapter.authorize(intent())).status).toBe('pending');

    // The rest arrives, but shallow: it counts for nothing yet.
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), from: '0xbuyer', confirmations: 2, txHash: '0x40' });
    const shallow = await adapter.authorize(intent());
    expect(shallow.status).toBe('pending');
    // On its way, so the page does not ask for it again.
    expect(shallow.raw).toMatchObject({ received: '60', missing: '40', confirming: '40', confirmations: 2, required: 6 });

    localChain.setConfirmations(address, 6, '0x40');
    const auth = await adapter.authorize(intent());
    expect(auth.status).toBe('authorized');
    expect(formatAmount(auth.amount)).toBe('100');
    expect(auth.raw).toMatchObject({ txHashes: ['0x60', '0x40'], from: '0xbuyer' });

    const captured = await adapter.capture(auth.railRef);
    expect(captured).toMatchObject({ ok: true, status: 'captured', assetId: 'USDT' });
    expect(formatAmount(captured.amount)).toBe('100');

    // A later transfer that is still shallow, or was reorganised away, is not counted.
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('5'), from: '0xbuyer', confirmations: 0, txHash: '0x05' });
    expect(formatAmount((await adapter.capture(auth.railRef)).amount)).toBe('100');

    // Nor is one that lands, final, after authorize (anyone can send dust to a public address): the core names the
    // authorization and the rail books exactly that.
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('0.000001'), from: '0xanyone', confirmations: 12, txHash: '0xdust' });
    const named = await adapter.capture(auth.railRef, { authorized: auth.amount });
    expect(formatAmount(named.amount)).toBe('100');
    expect(named.raw).toMatchObject({ txHashes: ['0x60', '0x40'] });

    // One part reorganised away between authorize and capture: the total comes back short of the 100 authorized, which
    // the core refuses to book (pay.rail_amount_mismatch).
    localChain.setConfirmations(address, 1, '0x60');
    expect(formatAmount((await adapter.capture(auth.railRef, { authorized: auth.amount })).amount)).toBe('40.000001');
    localChain.setConfirmations(address, 1);
    expect((await adapter.capture(auth.railRef)).failureCode).toBe('chain.insufficient_confirmations');
  });

  it('never adds a transfer in another token to the payment, and lists it for support', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0x60' });
    localChain.creditAnother({ address, assetId: 'USDC', amount: amt('40'), from: '0xbuyer', confirmations: 12, txHash: '0xc40' });

    const result = await adapter.authorize(intent());
    expect(result.status).toBe('pending');
    expect(result.raw).toMatchObject({ received: '60', missing: '40', strays: [{ txHash: '0xc40', assetId: 'USDC', amount: '40' }] });
  });

  it('refunds up to everything a payment paid in parts received', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0x60' });
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), from: '0xbuyer', confirmations: 12, txHash: '0x40' });
    const auth = await adapter.authorize(intent());
    await adapter.capture(auth.railRef);

    // A shallow transfer after capture is not refundable value.
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('20'), from: '0xbuyer', confirmations: 0, txHash: '0x20' });
    expect((await adapter.refund(auth.railRef, amt('100'))).ok).toBe(true);
    expect(localChain.outboundTransfers()[0]).toMatchObject({ to: '0xbuyer', assetId: 'USDT' });
    expect((await adapter.refund(auth.railRef, amt('1'))).failureCode).toBe('refund.exceeds_captured');
  });

  it('refuses to refund a payment paid from two addresses rather than send one payer the money of another', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xalice', confirmations: 12, txHash: '0x60' });
    localChain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), from: '0xbob', confirmations: 12, txHash: '0x40' });
    const auth = await adapter.authorize(intent());
    await adapter.capture(auth.railRef);

    expect((await adapter.refund(auth.railRef, amt('10'))).failureCode).toBe('refund.destination_ambiguous');
    expect(localChain.outboundTransfers()).toHaveLength(0);
  });

  it('fails when the payer sent the wrong token to the right address', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDC', amount: amt('100'), from: '0xbuyer', confirmations: 12 });

    const result = await adapter.authorize(intent());
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('chain.wrong_asset');
    expect(result.raw).toMatchObject({ receivedAsset: 'USDC' });
  });

  it('books an overpayment at what actually arrived, never at what was asked', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('150'), confirmations: 12 });

    const result = await adapter.authorize(intent());
    expect(result.status).toBe('authorized');
    // Booking 100 would strand 50 at an address nothing points at.
    expect(formatAmount(result.amount)).toBe('150');
  });

  it('refunds to the address that paid, and only that address', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), from: '0xbuyer', confirmations: 12 });
    const auth = await adapter.authorize(intent());
    await adapter.capture(auth.railRef);

    await adapter.refund(auth.railRef, amt('40'));

    const outbound = localChain.outboundTransfers();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ to: '0xbuyer', assetId: 'USDT' });
    expect(formatAmount(outbound[0]!.amount)).toBe('40');
  });

  it('does not advance its refunded total when the broadcast fails', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), confirmations: 12 });
    const auth = await adapter.authorize(intent());
    await adapter.capture(auth.railRef);

    localChain.failNextBroadcast();
    // A broadcast that throws is uncertainty, never a refusal: the caller must
    // not treat the refund as not sent.
    const outcome = await adapter.refund(auth.railRef, amt('100')).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(RailOutcomeUnknownError);
    expect(outcome).toMatchObject({ code: 'pay.rail_outcome_unknown' });

    // Here nothing left the chain, so the whole 100 is still refundable. If the
    // total had advanced, the buyer's money would be unreachable.
    const retry = await adapter.refund(auth.railRef, amt('100'));
    expect(retry.ok).toBe(true);
    expect(localChain.totalSent('USDT')).toBe('100');
  });

  it('keys on-chain refunds with durable refundId so restart does not double-send (M226-02)', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), from: '0xbuyer', confirmations: 12 });
    const auth = await adapter.authorize(intent());
    await adapter.capture(auth.railRef);

    const first = await adapter.refund(auth.railRef, amt('40'), { refundId: 'pay-1:1' });
    expect(first.ok).toBe(true);
    expect(first.raw).toMatchObject({ idempotencyKey: `pay.refund:${auth.railRef}:pay-1:1` });
    expect(localChain.outboundTransfers()).toHaveLength(1);

    // Process-local sequence would mint a new key after restart; durable id must not.
    adapter.reset();
    // reset clears in-adapter refunded totals — re-seed capture path via new adapter state
    // but the chain still holds the first send under the business key.
    const second = await adapter.refund(auth.railRef, amt('40'), { refundId: 'pay-1:1' });
    expect(second.ok).toBe(true);
    expect(localChain.outboundTransfers()).toHaveLength(1);
    expect(localChain.totalSent('USDT')).toBe('40');

    // A different refundId is a different partial refund (second real send).
    const third = await adapter.refund(auth.railRef, amt('30'), { refundId: 'pay-1:2' });
    expect(third.ok).toBe(true);
    expect(localChain.outboundTransfers()).toHaveLength(2);
    expect(localChain.totalSent('USDT')).toBe('70');
  });

  it('answers a replayed full refund with its first result, not refund.exceeds_captured', async () => {
    const address = await localChain.acceptanceAddress('p-fin-1', 'USDT');
    localChain.credit({ address, assetId: 'USDT', amount: amt('100'), from: '0xbuyer', confirmations: 12 });
    const auth = await adapter.authorize(intent());
    await adapter.capture(auth.railRef);

    const first = await adapter.refund(auth.railRef, amt('100'), { refundId: 'pay-1:1' });
    expect(first.ok).toBe(true);

    // A lost reply makes the core retry the same refund id. The refunded total
    // is already 100, so the refundable check must not run before the replay
    // lookup: the rail would report a failure for a refund it already sent.
    const replay = await adapter.refund(auth.railRef, amt('100'), { refundId: 'pay-1:1' });
    expect(replay.ok).toBe(true);
    expect(replay.raw).toMatchObject({ idempotencyKey: `pay.refund:${auth.railRef}:pay-1:1` });
    expect(localChain.outboundTransfers()).toHaveLength(1);
    expect(localChain.totalSent('USDT')).toBe('100');
  });

  it('never broadcasts a payout twice for one settlement', async () => {
    const instruction = {
      settlementId: 's-1',
      merchantId: 'm-1',
      amount: amt('500'),
      assetId: 'USDT',
      window: '2026-07-27',
      destination: { kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' },
    };

    await adapter.payout(instruction);
    await adapter.payout(instruction);
    await adapter.payout(instruction);

    expect(localChain.outboundTransfers()).toHaveLength(1);
    expect(localChain.totalSent('USDT')).toBe('500');
  });
});

describe('card-sandbox — a mock acquirer with real decline behaviour', () => {
  let adapter: CardSandboxAdapter;

  const intent = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
    paymentId: 'p-card-1',
    merchantId: 'm-1',
    amount: amt('100'),
    assetId: 'USDT',
    method: 'card',
    ...overrides,
  });

  beforeEach(() => {
    adapter = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
  });

  it('declines a decline-token instrument with a code the merchant can act on', async () => {
    const result = await adapter.authorize(intent({ instrument: { kind: 'card', token: SANDBOX_DECLINE_TOKEN } }));
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('card.declined');
    expect(result.raw).toMatchObject({ declineCode: '05' });
  });

  it('refuses to capture a charge that was never authorized', async () => {
    await adapter.authorize(intent({ instrument: { kind: 'card', token: SANDBOX_DECLINE_TOKEN } }));
    const result = await adapter.capture('ch_p-card-1');
    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('rail.unknown_reference');
  });

  it('holds the funds of a funds-held instrument at capture, and only an ordinary capture says nothing', async () => {
    await adapter.authorize(intent({ instrument: { kind: 'card', token: SANDBOX_FUNDS_HELD_TOKEN } }));
    expect((await adapter.capture('ch_p-card-1')).funds).toEqual({ state: 'pending' });
    await adapter.authorize(intent({ paymentId: 'p-card-2', instrument: { kind: 'card', token: 'tok_ok' } }));
    expect((await adapter.capture('ch_p-card-2')).funds).toBeUndefined();
  });

  it('reads a signed funds delivery, and refuses one whose release day does not parse', () => {
    const ok = adapter.verifyWebhook(
      adapter.signWebhook({ id: 'e-1', type: 'funds.pending', ref: 'ch_p-card-1', availableOn: '2026-11-02T00:00:00.000Z' }),
    );
    expect(ok).toMatchObject({ type: 'funds.pending', railRef: 'ch_p-card-1', availableOn: new Date('2026-11-02T00:00:00.000Z') });
    expect(adapter.verifyWebhook(adapter.signWebhook({ id: 'e-2', type: 'funds.available', ref: 'ch_p-card-1' }))).toMatchObject({
      type: 'funds.available',
    });
    expect(
      adapter.verifyWebhook(adapter.signWebhook({ id: 'e-3', type: 'funds.pending', ref: 'ch_p-card-1', availableOn: 'soon' })),
    ).toBeNull();
  });

  it('reports itself unusable once marked down', () => {
    expect(isUsable(adapter)).toBe(true);
    adapter.setHealthy(false);
    expect(isUsable(adapter)).toBe(false);
  });
});

// ── The signature primitive itself ───────────────────────────────────────────

describe('webhook signature verification', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const body = JSON.stringify({ id: 'evt', type: 'captured', ref: 'r' });
  const base = { body, secret: SECRET, toleranceSeconds: 300, now };

  it('accepts a correct signature', () => {
    expect(verifySignature({ ...base, signature: signPayload(SECRET, timestamp, body), timestamp })).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifySignature({ ...base, signature: signPayload('other-secret-32-characters-long!!', timestamp, body), timestamp })).toBe(
      false,
    );
  });

  it('rejects a signature that does not cover the timestamp', () => {
    // Signing the body alone makes a signature valid forever, so anyone who
    // ever observes one delivery can replay it indefinitely.
    const bodyOnly = signPayload(SECRET, '', body);
    expect(verifySignature({ ...base, signature: bodyOnly, timestamp })).toBe(false);
  });

  it('rejects a stale delivery even with a perfect signature', () => {
    const old = Math.floor((now.getTime() - 3600_000) / 1000).toString();
    expect(verifySignature({ ...base, signature: signPayload(SECRET, old, body), timestamp: old })).toBe(false);
  });

  it('rejects a delivery from the future beyond tolerance — a clock is not a licence', () => {
    const ahead = Math.floor((now.getTime() + 3600_000) / 1000).toString();
    expect(verifySignature({ ...base, signature: signPayload(SECRET, ahead, body), timestamp: ahead })).toBe(false);
  });

  it('rejects a non-hex signature rather than truncating it to nothing', () => {
    // Buffer.from('zz', 'hex') is empty, and two empty buffers compare equal —
    // a signature of nothing verifying nothing.
    expect(verifySignature({ ...base, signature: 'zz', timestamp })).toBe(false);
    expect(verifySignature({ ...base, signature: '', timestamp })).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    const inputs = ['', 'x', '0'.repeat(63), '0'.repeat(65), 'ffff', 'null', 'undefined'];
    for (const signature of inputs) {
      for (const ts of ['', 'abc', '-1', timestamp, '99999999999999']) {
        expect(() => verifySignature({ ...base, signature, timestamp: ts })).not.toThrow();
      }
    }
    expect(verifySignature({ ...base, signature: undefined, timestamp: undefined })).toBe(false);
  });

  it('rejects every one-character mutation of a valid signature', () => {
    const valid = signPayload(SECRET, timestamp, body);
    for (let i = 0; i < valid.length; i++) {
      const mutated = valid.slice(0, i) + (valid[i] === 'a' ? 'b' : 'a') + valid.slice(i + 1);
      if (mutated === valid) continue;
      expect(verifySignature({ ...base, signature: mutated, timestamp })).toBe(false);
    }
  });
});

// ── The registry ─────────────────────────────────────────────────────────────

describe('rail registry', () => {
  const registry = new RailRegistry([cardAdapter, cryptoAdapter]);

  it('resolves by id', () => {
    expect(registry.get('card-sandbox').id).toBe('card-sandbox');
    expect(registry.get('crypto-native').id).toBe('crypto-native');
  });

  it('refuses an unknown rail loudly, and says what it does know', () => {
    expect(() => registry.get('stripe')).toThrow(UnknownRailError);
    try {
      registry.get('stripe');
    } catch (err) {
      expect((err as Error).message).toContain('card-sandbox');
    }
  });

  it('refuses a capability an adapter does not declare', () => {
    const readOnly = {
      id: 'read-only',
      capabilities: ['authorize'] as const,
      health: () => ({ healthy: true, latencyMs: 1, lastUpdate: new Date() }),
      authorize: cardAdapter.authorize.bind(cardAdapter),
      capture: cardAdapter.capture.bind(cardAdapter),
      refund: cardAdapter.refund.bind(cardAdapter),
      payout: cardAdapter.payout.bind(cardAdapter),
      verifyWebhook: () => null,
    };
    const small = new RailRegistry([readOnly]);

    expect(small.require('read-only', 'authorize').id).toBe('read-only');
    // Checked at the call site, not discovered halfway through a money path.
    expect(() => small.require('read-only', 'refund')).toThrow(RailCapabilityError);
    expect(supports(readOnly, 'payout')).toBe(false);
  });

  it('refuses two adapters answering to one id', () => {
    expect(() => new RailRegistry([cardAdapter, new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })])).toThrow(/Duplicate/);
  });

  it('reports which rails are usable right now', () => {
    expect(
      registry
        .usable()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['card-sandbox', 'crypto-native']);
    expect(registry.health()).toHaveLength(2);
  });
});
