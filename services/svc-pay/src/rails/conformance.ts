import { describe, expect, it, beforeEach } from 'vitest';
import { formatAmount, parseAmount as amt, type Amount } from '@intafaced/ledger-client';
import {
  RAIL_CAPABILITIES,
  RAIL_MODES,
  isLive,
  isUsable,
  supports,
  type PaymentIntent,
  type RailAdapter,
  type RailCapability,
  type RailResult,
  type RailWebhookRequest,
  type SettlementInstruction,
} from './rail-adapter.js';

/**
 * THE RAIL ADAPTER CONFORMANCE KIT (§6.3 exit criteria).
 *
 * "Adapter conformance test kit (any future adapter must pass it before merge)."
 *
 * Same role as `packages/ledger-client/src/testing/conformance.ts`: every
 * implementation of the interface runs this file unmodified, and where two
 * adapters disagree, this file says which behaviour is correct.
 *
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE SERVICE.
 *
 * §6.1 promises that every partner rail "drops in later as an adapter with zero
 * core changes". That promise is only as good as the agreement about what an
 * adapter must do — and an agreement written in prose is discovered to have been
 * ambiguous on the day a partner's sandbox behaves differently and a payment is
 * captured twice.
 *
 * So the agreement is executable. A new adapter passes this kit or it does not
 * merge. What the kit asserts is, precisely, what the core is entitled to
 * assume, and nothing the core assumes is left out of it.
 *
 * Optional capabilities are skipped when an adapter does not declare them, so a
 * refund-less rail can still prove the parts it does support — but it can never
 * skip a capability it claims.
 */

export interface RailHarness {
  readonly adapter: RailAdapter;

  /** Return the adapter (and its simulated counterparty) to empty between tests. */
  reset(): Promise<void>;

  /**
   * Make `authorize` able to succeed for this intent.
   *
   * A card rail needs nothing. A chain rail needs the payer to have actually
   * sent the funds. The kit does not care which — it only needs the adapter put
   * into the state where an authorization is legitimately possible, because a
   * kit that could not do that could only ever test declines.
   */
  primeAuthorization(intent: PaymentIntent): Promise<void>;

  /**
   * Produce a webhook delivery the adapter should accept, signed the way the
   * real rail signs. Omit if the adapter does not declare 'webhook'.
   *
   * `at` is the instant the signature covers. Omit it and the delivery is
   * signed now. A replay case passes an old `at` so the MAC is computed over
   * that timestamp: rewriting the header afterwards would fail the signature
   * check instead of the freshness window.
   */
  signWebhook?(event: {
    id: string;
    type: string;
    ref: string;
    amount?: Amount;
    assetId?: string;
    at?: Date;
  }): RailWebhookRequest;

  /**
   * Sign an arbitrary raw body, correctly.
   *
   * This is what lets the kit test the SHAPE check independently of the
   * signature check: a body that is genuinely from the rail and still has to be
   * rejected. Without it, every malformed-payload test would be passing for the
   * uninteresting reason that the signature no longer matched.
   */
  signRaw?(body: string): RailWebhookRequest;

  /** Force the NEXT rail call to fail once. Omit if the rail cannot be made to fail. */
  failNext?(): void;

  /** A destination `payout` will accept. Omit if the adapter does not declare 'payout'. */
  payoutDestination?(): { kind: string; ref: string };

  teardown?(): Promise<void>;
}

const MERCHANT = '55555555-5555-4555-8555-555555555555';

let intentSequence = 0;

function nextIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  intentSequence++;
  return {
    paymentId: `conf-${intentSequence.toString().padStart(4, '0')}`,
    merchantId: MERCHANT,
    amount: amt('100'),
    assetId: 'USDT',
    method: 'conformance',
    ...overrides,
  };
}

export function runRailAdapterConformance(name: string, createHarness: () => Promise<RailHarness>): void {
  describe(`rail adapter conformance — ${name}`, () => {
    let harness: RailHarness;
    let adapter: RailAdapter;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      adapter = harness.adapter;
    });

    /** Authorize a fresh, primed intent — the starting point of most tests here. */
    async function authorized(overrides: Partial<PaymentIntent> = {}): Promise<{ intent: PaymentIntent; result: RailResult }> {
      const intent = nextIntent(overrides);
      await harness.primeAuthorization(intent);
      const result = await adapter.authorize(intent);
      return { intent, result };
    }

    async function captured(overrides: Partial<PaymentIntent> = {}): Promise<{ intent: PaymentIntent; result: RailResult }> {
      const { intent, result } = await authorized(overrides);
      expect(result.status).toBe('authorized');
      const capture = await adapter.capture(result.railRef);
      expect(capture.ok).toBe(true);
      return { intent, result: capture };
    }

    // ── Identity ──────────────────────────────────────────────────────────────
    //
    // The `id` is written into `payments.rail_adapter` on every row. It is a
    // permanent key in the database, not a display name.

    describe('identity and capabilities', () => {
      it('has a non-empty id', () => {
        expect(typeof adapter.id).toBe('string');
        expect(adapter.id.length).toBeGreaterThan(0);
      });

      it('reports the same id every time — it is a stored key, not a label', () => {
        expect(adapter.id).toBe(adapter.id);
        expect(adapter.id.trim()).toBe(adapter.id);
      });

      /**
       * THE HONESTY DECLARATION. A new adapter cannot merge without answering it.
       *
       * `mode` is what stops a rail with a simulated counterparty being asked to
       * send a user's money. An adapter that forgot to declare it would default to
       * whatever TypeScript's absence means at runtime — `undefined`, which is not
       * `'sandbox'`, which means the posture check would wave it through. So the
       * kit asserts the value is one of exactly two strings rather than merely
       * truthy.
       */
      it('DECLARES WHETHER IT IS LIVE OR A SANDBOX', () => {
        expect(RAIL_MODES).toContain(adapter.mode);
      });

      it('does not change its mind about being live between calls', () => {
        // Read twice through the interface: a rail whose honesty depends on when
        // it is asked cannot be gated on.
        const first = adapter.mode;
        expect(adapter.mode).toBe(first);
        expect(isLive(adapter)).toBe(adapter.mode === 'live');
      });

      it('declares only known capabilities, without duplicates', () => {
        expect(adapter.capabilities.length).toBeGreaterThan(0);
        for (const capability of adapter.capabilities) {
          expect(RAIL_CAPABILITIES).toContain(capability);
        }
        expect(new Set(adapter.capabilities).size).toBe(adapter.capabilities.length);
      });

      it('declares authorize and capture — a rail that cannot take money is not a rail', () => {
        expect(supports(adapter, 'authorize')).toBe(true);
        expect(supports(adapter, 'capture')).toBe(true);
      });

      it('agrees with `supports` about everything it does and does not declare', () => {
        for (const capability of RAIL_CAPABILITIES) {
          expect(supports(adapter, capability)).toBe(adapter.capabilities.includes(capability));
        }
      });
    });

    // ── Health ────────────────────────────────────────────────────────────────

    describe('health', () => {
      it('answers with a well-formed health record', () => {
        const health = adapter.health();
        expect(typeof health.healthy).toBe('boolean');
        expect(Number.isFinite(health.latencyMs)).toBe(true);
        expect(health.latencyMs).toBeGreaterThanOrEqual(0);
        expect(health.lastUpdate).toBeInstanceOf(Date);
        expect(Number.isNaN(health.lastUpdate.getTime())).toBe(false);
      });

      it('is usable when healthy and fresh', () => {
        expect(isUsable(adapter, new Date())).toBe(adapter.health().healthy);
      });

      it('is not usable when its health is stale, however healthy it claims to be', () => {
        const longAfter = new Date(adapter.health().lastUpdate.getTime() + 10 * 60 * 1000);
        expect(isUsable(adapter, longAfter)).toBe(false);
      });

      it('does not throw or block on health — it is called on every routing decision', () => {
        expect(() => adapter.health()).not.toThrow();
      });
    });

    // ── The result contract ───────────────────────────────────────────────────
    //
    // Every branch of the core reads these fields. An adapter that shapes them
    // differently does not fail loudly; it books the wrong number.

    describe('the RailResult contract', () => {
      it('never reports money as a number — Amount is a bigint, always', async () => {
        const { result } = await authorized();
        expect(typeof result.amount).toBe('bigint');
      });

      it('keeps ok and status in agreement: ok === (status !== "failed")', async () => {
        const { result } = await authorized();
        expect(result.ok).toBe(result.status !== 'failed');

        const failure = await adapter.capture('definitely-not-a-real-reference');
        expect(failure.ok).toBe(failure.status !== 'failed');
      });

      it('carries a machine-readable failure code on every failure', async () => {
        const failure = await adapter.capture('definitely-not-a-real-reference');
        expect(failure.ok).toBe(false);
        expect(typeof failure.failureCode).toBe('string');
        expect(failure.failureCode!.length).toBeGreaterThan(0);
      });

      it('stamps a real timestamp on every result', async () => {
        const { result } = await authorized();
        expect(result.at).toBeInstanceOf(Date);
        expect(Number.isNaN(result.at.getTime())).toBe(false);
      });

      it('returns a non-empty rail reference for anything that succeeded', async () => {
        const { result } = await authorized();
        expect(result.railRef.length).toBeGreaterThan(0);
      });

      it('echoes the asset it was asked about', async () => {
        const { intent, result } = await authorized({ assetId: 'USDT' });
        expect(result.assetId).toBe(intent.assetId);
      });
    });

    // ── Authorize ─────────────────────────────────────────────────────────────

    describe('authorize', () => {
      it('authorizes a primed intent for the amount asked', async () => {
        const { intent, result } = await authorized({ amount: amt('250.5') });
        expect(result.status).toBe('authorized');
        expect(formatAmount(result.amount)).toBe(formatAmount(intent.amount));
      });

      it('is idempotent on the payment id — a retry finds the first authorization', async () => {
        const intent = nextIntent();
        await harness.primeAuthorization(intent);

        const first = await adapter.authorize(intent);
        const second = await adapter.authorize(intent);

        // Two authorizations of one payment means two holds on one buyer.
        expect(second.railRef).toBe(first.railRef);
        expect(formatAmount(second.amount)).toBe(formatAmount(first.amount));
      });

      it('refuses a zero or negative amount rather than opening a charge for nothing', async () => {
        const zero = await adapter.authorize(nextIntent({ amount: 0n }));
        expect(zero.ok).toBe(false);

        const negative = await adapter.authorize(nextIntent({ amount: amt('-1') }));
        expect(negative.ok).toBe(false);
      });

      it('does not mutate the intent it was given', async () => {
        const intent = Object.freeze(nextIntent());
        await harness.primeAuthorization(intent);
        // Freezing is the assertion: a strict-mode write to a frozen object
        // throws, so an adapter that stamps its own fields onto the caller's
        // intent fails here rather than in the caller.
        await expect(adapter.authorize(intent)).resolves.toBeDefined();
      });

      it('handles an unprimed intent without throwing', async () => {
        // Unprimed means different things per rail — no funds on chain, no
        // instrument on a card. Whatever it means, the answer is a result.
        const result = await adapter.authorize(nextIntent({ amount: amt('7') }));
        expect(typeof result.ok).toBe('boolean');
        expect(typeof result.amount).toBe('bigint');
      });
    });

    // ── Capture ───────────────────────────────────────────────────────────────

    describe('capture', () => {
      it('captures an authorization', async () => {
        const { result } = await captured();
        expect(result.status).toBe('captured');
        expect(formatAmount(result.amount)).toBe(formatAmount(amt('100')));
      });

      it('keeps the same rail reference from authorize through capture', async () => {
        const { result: auth } = await authorized();
        const capture = await adapter.capture(auth.railRef);
        expect(capture.railRef).toBe(auth.railRef);
      });

      it('is idempotent — capturing twice does not capture twice', async () => {
        const { result: auth } = await authorized();

        const first = await adapter.capture(auth.railRef);
        const second = await adapter.capture(auth.railRef);

        expect(second.ok).toBe(true);
        expect(second.railRef).toBe(first.railRef);
        expect(formatAmount(second.amount)).toBe(formatAmount(first.amount));
      });

      it('refuses an unknown reference instead of inventing a payment', async () => {
        const result = await adapter.capture('no-such-reference-at-all');
        expect(result.ok).toBe(false);
        expect(result.status).toBe('failed');
      });

      it('does not throw on a malformed reference', async () => {
        for (const ref of ['', ' ', '../../etc/passwd', '\0', 'x'.repeat(4096)]) {
          const result = await adapter.capture(ref);
          expect(result.ok).toBe(false);
        }
      });
    });

    // ── Refund ────────────────────────────────────────────────────────────────

    describe('refund', () => {
      it('refunds the full captured amount', async () => {
        if (!supports(adapter, 'refund')) return;

        const { result } = await captured();
        const refund = await adapter.refund(result.railRef, result.amount);

        expect(refund.ok).toBe(true);
        expect(refund.status).toBe('refunded');
        expect(formatAmount(refund.amount)).toBe(formatAmount(result.amount));
      });

      it('refunds in parts, and the parts sum to the whole', async () => {
        if (!supports(adapter, 'refund')) return;

        const { result } = await captured();

        const first = await adapter.refund(result.railRef, amt('30'));
        const second = await adapter.refund(result.railRef, amt('70'));

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(first.amount + second.amount).toBe(result.amount);
      });

      it('REFUSES A REFUND EXCEEDING WHAT WAS CAPTURED', async () => {
        if (!supports(adapter, 'refund')) return;

        const { result } = await captured();
        const over = await adapter.refund(result.railRef, result.amount + amt('0.000000000000000001'));

        expect(over.ok).toBe(false);
        expect(over.status).toBe('failed');
      });

      it('refuses to over-refund across several partial refunds', async () => {
        if (!supports(adapter, 'refund')) return;

        const { result } = await captured();

        expect((await adapter.refund(result.railRef, amt('60'))).ok).toBe(true);
        expect((await adapter.refund(result.railRef, amt('40'))).ok).toBe(true);
        // The whole 100 is back with the buyer. One more unit is the merchant's
        // own money going out of the door.
        expect((await adapter.refund(result.railRef, amt('0.01'))).ok).toBe(false);
      });

      it('refuses a zero or negative refund', async () => {
        if (!supports(adapter, 'refund')) return;

        const { result } = await captured();
        expect((await adapter.refund(result.railRef, 0n)).ok).toBe(false);
        expect((await adapter.refund(result.railRef, amt('-5'))).ok).toBe(false);
      });

      it('refuses to refund an unknown reference', async () => {
        if (!supports(adapter, 'refund')) return;

        const result = await adapter.refund('no-such-reference-at-all', amt('1'));
        expect(result.ok).toBe(false);
      });
    });

    // ── Payout ────────────────────────────────────────────────────────────────

    describe('payout', () => {
      const instruction = (overrides: Partial<SettlementInstruction> = {}): SettlementInstruction => ({
        settlementId: `conf-settlement-${++intentSequence}`,
        merchantId: MERCHANT,
        amount: amt('500'),
        assetId: 'USDT',
        window: '2026-07-27',
        destination: harness.payoutDestination?.() ?? { kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' },
        ...overrides,
      });

      it('pays out a settlement', async () => {
        if (!supports(adapter, 'payout')) return;

        const result = await adapter.payout(instruction());
        expect(result.ok).toBe(true);
        expect(result.status).toBe('paid_out');
        expect(result.railRef.length).toBeGreaterThan(0);
        expect(typeof result.amount).toBe('bigint');
      });

      it('is idempotent on the settlement id — a retry does not pay twice', async () => {
        if (!supports(adapter, 'payout')) return;

        const request = instruction();
        const first = await adapter.payout(request);
        const second = await adapter.payout(request);

        expect(second.ok).toBe(true);
        expect(second.railRef).toBe(first.railRef);
      });

      it('refuses a zero or negative payout', async () => {
        if (!supports(adapter, 'payout')) return;

        expect((await adapter.payout(instruction({ amount: 0n }))).ok).toBe(false);
        expect((await adapter.payout(instruction({ amount: amt('-1') }))).ok).toBe(false);
      });
    });

    // ── Webhooks ──────────────────────────────────────────────────────────────
    //
    // A webhook endpoint is reachable by anyone on the internet, and what it
    // says is "money moved". Both halves of that matter.

    describe('verifyWebhook', () => {
      it('accepts a genuine delivery and returns a usable event', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const request = harness.signWebhook({ id: 'evt_1', type: 'captured', ref: 'ref_1', amount: amt('100'), assetId: 'USDT' });
        const event = adapter.verifyWebhook(request);

        expect(event).not.toBeNull();
        expect(event!.railId).toBe(adapter.id);
        expect(event!.eventId).toBe('evt_1');
        expect(event!.type).toBe('captured');
        expect(event!.railRef).toBe('ref_1');
        expect(typeof event!.amount).toBe('bigint');
        expect(event!.occurredAt).toBeInstanceOf(Date);
      });

      it('returns the same event id for the same delivery — that is what makes dedupe possible', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const request = harness.signWebhook({ id: 'evt_stable', type: 'captured', ref: 'ref_1', amount: amt('100') });
        const first = adapter.verifyWebhook(request);
        const second = adapter.verifyWebhook(request);

        expect(first?.eventId).toBe('evt_stable');
        expect(second?.eventId).toBe(first?.eventId);
      });

      it('REJECTS A TAMPERED BODY', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const request = harness.signWebhook({ id: 'evt_2', type: 'captured', ref: 'ref_1', amount: amt('100'), assetId: 'USDT' });
        // The attack, stated plainly: keep the signature, change the amount.
        const tampered = { ...request, body: request.body.replace('100', '100000') };

        expect(adapter.verifyWebhook(tampered)).toBeNull();
      });

      it('rejects a missing signature', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const request = harness.signWebhook({ id: 'evt_3', type: 'captured', ref: 'ref_1' });
        expect(adapter.verifyWebhook({ ...request, headers: {} })).toBeNull();
      });

      it('rejects a signature of the wrong length without throwing', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const request = harness.signWebhook({ id: 'evt_4', type: 'captured', ref: 'ref_1' });
        const headerName = Object.keys(request.headers).find((h) => h.includes('signature'))!;

        for (const bad of ['', 'ab', 'f'.repeat(63), 'f'.repeat(65), 'f'.repeat(1000)]) {
          const headers = { ...request.headers, [headerName]: bad };
          expect(() => adapter.verifyWebhook({ ...request, headers })).not.toThrow();
          expect(adapter.verifyWebhook({ ...request, headers })).toBeNull();
        }
      });

      it('rejects a near-miss signature — the byte-at-a-time forgery probe', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const request = harness.signWebhook({ id: 'evt_5', type: 'captured', ref: 'ref_1' });
        const headerName = Object.keys(request.headers).find((h) => h.includes('signature'))!;
        const valid = request.headers[headerName]!;

        // Each of these shares a longer prefix with the real signature than the
        // last. An implementation that short-circuits on first difference leaks
        // how far the attacker got; `crypto.timingSafeEqual` does not. The
        // constant-time property itself cannot be asserted by a unit test
        // without flakiness, so what is asserted here is that every one of them
        // is rejected, and the implementation is required to use
        // `timingSafeEqual` for the comparison.
        for (let keep = 0; keep < valid.length; keep += 8) {
          const forged = valid.slice(0, keep) + flipHexChar(valid[keep]!) + valid.slice(keep + 1);
          expect(adapter.verifyWebhook({ ...request, headers: { ...request.headers, [headerName]: forged } })).toBeNull();
        }
      });

      it('rejects a replayed delivery once it is old enough', () => {
        if (!supports(adapter, 'webhook') || !harness.signWebhook) return;

        const event = { id: 'evt_6', type: 'captured', ref: 'ref_1' };
        const fresh = harness.signWebhook(event);
        expect(adapter.verifyWebhook(fresh)).not.toBeNull();

        // A week is far outside the freshness window. The harness signs this
        // instant, so the MAC matches the old timestamp and a null result is
        // the age check. Overwriting only the header would reject a bad MAC.
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const stale = harness.signWebhook({ ...event, at: weekAgo });
        const timestampHeader = Object.keys(stale.headers).find((h) => h.includes('timestamp'));
        expect(timestampHeader).toBeDefined();
        expect(stale.headers[timestampHeader!]).toBe(Math.floor(weekAgo.getTime() / 1000).toString());

        const signatureHeader = Object.keys(stale.headers).find((h) => h.includes('signature'));
        expect(signatureHeader).toBeDefined();
        expect(stale.headers[signatureHeader!]).not.toBe(fresh.headers[signatureHeader!]);

        expect(adapter.verifyWebhook(stale)).toBeNull();
      });

      it('never throws on garbage, whatever the garbage is', () => {
        if (!supports(adapter, 'webhook')) return;

        const bodies = ['', '{', 'null', '[]', '"string"', '{"amount": 100}', '\0\u0001', 'x'.repeat(10_000)];
        const signatures = ['', 'zz', 'not-hex', '0'.repeat(64), 'deadbeef'];

        for (const body of bodies) {
          for (const signature of signatures) {
            const headers: Record<string, string> = {
              'x-sandbox-signature': signature,
              'x-sandbox-timestamp': '0',
              'x-chain-signature': signature,
              'x-chain-timestamp': '0',
            };
            expect(() => adapter.verifyWebhook({ headers, body })).not.toThrow();
            expect(adapter.verifyWebhook({ headers, body })).toBeNull();
          }
        }
      });

      it('rejects a correctly signed delivery whose money is a JSON number', () => {
        if (!supports(adapter, 'webhook') || !harness.signRaw) return;

        // Genuinely from the rail — the signature is valid — and still wrong:
        // money is a decimal string on the wire. Coercing this is how a float
        // gets into a payments book, so the answer is null even though the
        // sender is real.
        const body = JSON.stringify({ id: 'evt_7', type: 'captured', ref: 'ref_1', amount: 100, assetId: 'USDT' });
        expect(adapter.verifyWebhook(harness.signRaw(body))).toBeNull();
      });

      it('rejects a correctly signed delivery that is missing its identifiers', () => {
        if (!supports(adapter, 'webhook') || !harness.signRaw) return;

        for (const body of [
          JSON.stringify({ type: 'captured', ref: 'ref_1' }), // no event id — cannot dedupe
          JSON.stringify({ id: 'evt_a', ref: 'ref_1' }), // no type — cannot act
          JSON.stringify({ id: 'evt_b', type: 'captured' }), // no reference — cannot match a payment
          JSON.stringify([1, 2, 3]),
          'null',
        ]) {
          expect(adapter.verifyWebhook(harness.signRaw(body))).toBeNull();
        }
      });

      it('rejects a correctly signed delivery with an unknown event type', () => {
        if (!supports(adapter, 'webhook') || !harness.signRaw) return;

        const body = JSON.stringify({ id: 'evt_8', type: 'transmogrified', ref: 'ref_1' });
        expect(adapter.verifyWebhook(harness.signRaw(body))).toBeNull();
      });
    });

    // ── Failure injection ─────────────────────────────────────────────────────
    //
    // Rails fail. The question is only whether they fail in a shape the core
    // can act on.

    describe('rail failure', () => {
      it('surfaces a rail failure as a result, not an exception', async () => {
        if (!harness.failNext) return;

        const intent = nextIntent();
        await harness.primeAuthorization(intent);
        harness.failNext();

        const result = await adapter.authorize(intent);
        expect(result.ok).toBe(false);
        expect(result.status).toBe('failed');
        expect(typeof result.failureCode).toBe('string');
      });

      it('leaves nothing half-done — the next attempt still works', async () => {
        if (!harness.failNext) return;

        const intent = nextIntent();
        await harness.primeAuthorization(intent);

        harness.failNext();
        expect((await adapter.authorize(intent)).ok).toBe(false);

        // A failed call must not have consumed the authorization. If it had,
        // the buyer's money would be somewhere the retry cannot reach.
        const retry = await adapter.authorize(intent);
        expect(retry.ok).toBe(true);
        expect(retry.status).toBe('authorized');
      });

      it('fails a capture cleanly, leaving the authorization capturable', async () => {
        if (!harness.failNext) return;

        const { result: auth } = await authorized();

        harness.failNext();
        const failed = await adapter.capture(auth.railRef);
        expect(failed.ok).toBe(false);

        const retry = await adapter.capture(auth.railRef);
        expect(retry.ok).toBe(true);
        expect(retry.status).toBe('captured');
      });
    });

    // ── The whole lifecycle ───────────────────────────────────────────────────

    describe('lifecycle', () => {
      it('runs authorize → capture → partial refund → refund the rest', async () => {
        const { result: auth } = await authorized({ amount: amt('80') });
        expect(auth.status).toBe('authorized');

        const capture = await adapter.capture(auth.railRef);
        expect(capture.status).toBe('captured');
        expect(formatAmount(capture.amount)).toBe('80');

        if (!supports(adapter, 'refund')) return;

        const partial = await adapter.refund(auth.railRef, amt('30'));
        expect(partial.ok).toBe(true);

        const rest = await adapter.refund(auth.railRef, amt('50'));
        expect(rest.ok).toBe(true);

        expect(partial.amount + rest.amount).toBe(capture.amount);
        expect((await adapter.refund(auth.railRef, amt('0.000000000000000001'))).ok).toBe(false);
      });

      it('keeps one payment separate from another', async () => {
        const a = await authorized({ amount: amt('10') });
        const b = await authorized({ amount: amt('20') });

        expect(a.result.railRef).not.toBe(b.result.railRef);

        const capturedA = await adapter.capture(a.result.railRef);
        expect(formatAmount(capturedA.amount)).toBe('10');

        if (!supports(adapter, 'refund')) return;
        // Refunding A must not draw on B's captured value.
        expect((await adapter.refund(a.result.railRef, amt('20'))).ok).toBe(false);
      });
    });

    describe('teardown', () => {
      it('closes cleanly', async () => {
        await harness.teardown?.();
      });
    });
  });
}

function flipHexChar(c: string): string {
  return c === '0' ? '1' : '0';
}

/** Re-exported so an adapter package can type its harness without a deep import. */
export type { RailCapability };
