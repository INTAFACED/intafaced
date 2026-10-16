import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  railFailure,
  type PaymentIntent,
  type RailAdapter,
  type RailCapability,
  type RailEvent,
  type RailHealth,
  type RailResult,
  type RailWebhookRequest,
  type SettlementInstruction,
} from './rail-adapter.js';
import { signPayload, verifySignature } from './webhook-signature.js';

/**
 * card-sandbox — §6.1's second v1 adapter: "full flow against a mock acquirer
 * for end-to-end testing".
 *
 * It is a mock ACQUIRER, not a mock adapter. Everything on this side of the
 * interface is real: the state machine, the decline codes, the refund
 * arithmetic, the signed webhooks, the idempotency. Only the counterparty is
 * simulated. That distinction is the whole value of it — when a live acquiring
 * rail lands, the core it plugs into has already run the complete lifecycle
 * thousands of times in CI, and the only new thing is HTTP.
 *
 * It is also the reference implementation for anyone writing the next adapter:
 * a partner rail that behaves like this file will pass the conformance kit,
 * and §6.1's "zero core changes" claim holds for it.
 */

export interface CardSandboxOptions {
  /** Webhook signing secret. In dev this is config; in prod it is a vault ref. */
  readonly secret: string;
  /** Injectable clock so tests can drive replay windows deterministically. */
  readonly now?: () => Date;
  /** Deliveries older than this are treated as replays. Owner-published — never invent 300. */
  readonly toleranceSeconds: number;
}

/** Instrument tokens that steer the sandbox, the way a real sandbox uses test PANs. */
export const SANDBOX_DECLINE_TOKEN = 'tok_decline';
export const SANDBOX_ERROR_TOKEN = 'tok_rail_error';

interface AcquirerCharge {
  ref: string;
  paymentId: string;
  assetId: string;
  authorized: Amount;
  captured: Amount;
  refunded: Amount;
  status: 'authorized' | 'captured' | 'refunded' | 'failed';
}

export class CardSandboxAdapter implements RailAdapter {
  readonly id = 'card-sandbox';
  readonly capabilities: readonly RailCapability[] = ['authorize', 'capture', 'refund', 'payout', 'webhook'];

  /**
   * SANDBOX, permanently, and not configurable.
   *
   * There is no option that makes this class live, because the counterparty it
   * talks to is the `charges` map twelve lines below. `po_<settlementId>` is not
   * a payout reference — it is a string this file made up. A live card rail is a
   * DIFFERENT adapter that passes the same conformance kit; it is not this one
   * with a flag flipped.
   */
  readonly mode = 'sandbox' as const;

  /** The mock acquirer's books. A real adapter holds no state; this one is the counterparty. */
  private readonly charges = new Map<string, AcquirerCharge>();
  private readonly payouts = new Map<string, { ref: string; amount: Amount; assetId: string }>();
  private readonly now: () => Date;
  private readonly toleranceSeconds: number;
  private lastContact: Date;
  private forcedFailure: { code: string; reason: string } | null = null;
  private up = true;

  constructor(private readonly options: CardSandboxOptions) {
    this.now = options.now ?? (() => new Date());
    this.toleranceSeconds = options.toleranceSeconds;
    this.lastContact = this.now();
  }

  health(): RailHealth {
    return {
      healthy: this.up,
      latencyMs: 12,
      lastUpdate: this.lastContact,
      reason: this.up ? undefined : 'sandbox acquirer marked down',
    };
  }

  // ── Test controls ──────────────────────────────────────────────────────────
  //
  // A rail's failure branches are the ones that strand money, so they have to be
  // reachable on demand rather than only when a real acquirer happens to be
  // having a bad day.

  /** The next rail call fails, once. */
  failNext(code = 'acquirer.unavailable', reason = 'Simulated acquirer failure'): void {
    this.forcedFailure = { code, reason };
  }

  setHealthy(up: boolean): void {
    this.up = up;
  }

  reset(): void {
    this.charges.clear();
    this.payouts.clear();
    this.forcedFailure = null;
    this.up = true;
    this.lastContact = this.now();
  }

  // ── The interface ──────────────────────────────────────────────────────────

  async authorize(p: PaymentIntent): Promise<RailResult> {
    this.lastContact = this.now();

    const forced = this.takeForcedFailure(chargeRef(p.paymentId), p.amount, p.assetId);
    if (forced) return forced;

    if (p.amount <= 0n) {
      return railFailure({
        railRef: chargeRef(p.paymentId),
        amount: p.amount,
        assetId: p.assetId,
        failureCode: 'authorize.invalid_amount',
        failureReason: 'Authorization amount must be positive',
        at: this.now(),
      });
    }

    if (p.instrument?.token === SANDBOX_ERROR_TOKEN) {
      return railFailure({
        railRef: chargeRef(p.paymentId),
        amount: p.amount,
        assetId: p.assetId,
        failureCode: 'acquirer.unavailable',
        failureReason: 'Simulated acquirer outage',
        at: this.now(),
      });
    }

    if (p.instrument?.token === SANDBOX_DECLINE_TOKEN) {
      return railFailure({
        railRef: chargeRef(p.paymentId),
        amount: p.amount,
        assetId: p.assetId,
        failureCode: 'card.declined',
        failureReason: 'Issuer declined the authorization',
        at: this.now(),
        raw: { declineCode: '05', networkAdvice: 'do_not_honor' },
      });
    }

    // The reference is derived from OUR payment id, so re-authorizing the same
    // payment finds the same charge instead of opening a second one. A retry
    // after a timeout must not put two holds on a buyer's card.
    const ref = chargeRef(p.paymentId);
    const existing = this.charges.get(ref);
    if (existing) return this.resultFor(existing, existing.status === 'authorized' ? 'authorized' : 'captured');

    const charge: AcquirerCharge = {
      ref,
      paymentId: p.paymentId,
      assetId: p.assetId,
      authorized: p.amount,
      captured: 0n,
      refunded: 0n,
      status: 'authorized',
    };
    this.charges.set(ref, charge);

    return this.resultFor(charge, 'authorized');
  }

  async capture(ref: string): Promise<RailResult> {
    this.lastContact = this.now();

    const charge = this.charges.get(ref);
    if (!charge) return this.unknownReference(ref);

    const forced = this.takeForcedFailure(ref, charge.authorized, charge.assetId);
    if (forced) return forced;

    // Idempotent by nature: a redelivered capture returns the first one's
    // result. The core relies on the ledger's idempotency key as well, but a
    // rail that double-captures has already taken the buyer's money twice, and
    // no amount of correct bookkeeping on our side undoes that.
    if (charge.status === 'captured' || charge.status === 'refunded') {
      return this.resultFor(charge, 'captured');
    }

    if (charge.status !== 'authorized') {
      return railFailure({
        railRef: ref,
        amount: charge.authorized,
        assetId: charge.assetId,
        failureCode: 'capture.not_authorized',
        failureReason: `Charge is ${charge.status}, not authorized`,
        at: this.now(),
      });
    }

    charge.captured = charge.authorized;
    charge.status = 'captured';
    return this.resultFor(charge, 'captured');
  }

  async refund(ref: string, amount: Amount): Promise<RailResult> {
    this.lastContact = this.now();

    const charge = this.charges.get(ref);
    if (!charge) return this.unknownReference(ref);

    const forced = this.takeForcedFailure(ref, amount, charge.assetId);
    if (forced) return forced;

    if (amount <= 0n) {
      return railFailure({
        railRef: ref,
        amount,
        assetId: charge.assetId,
        failureCode: 'refund.invalid_amount',
        failureReason: 'Refund amount must be positive',
        at: this.now(),
      });
    }

    const refundable = charge.captured - charge.refunded;
    if (amount > refundable) {
      // The core checks this too, from its own records. Both check because they
      // are checking different truths: ours says what we believe we captured,
      // the acquirer's says what it will actually send back. When they disagree,
      // the money follows the acquirer.
      return railFailure({
        railRef: ref,
        amount,
        assetId: charge.assetId,
        failureCode: 'refund.exceeds_captured',
        failureReason: `Refundable balance is ${formatAmount(refundable)}, requested ${formatAmount(amount)}`,
        at: this.now(),
      });
    }

    charge.refunded += amount;
    if (charge.refunded === charge.captured) charge.status = 'refunded';

    return {
      ok: true,
      railRef: ref,
      status: 'refunded',
      amount,
      assetId: charge.assetId,
      at: this.now(),
      raw: { refundedTotal: formatAmount(charge.refunded) },
    };
  }

  async payout(s: SettlementInstruction): Promise<RailResult> {
    this.lastContact = this.now();

    const ref = `po_${s.settlementId}`;
    const forced = this.takeForcedFailure(ref, s.amount, s.assetId);
    if (forced) return forced;

    if (s.amount <= 0n) {
      return railFailure({
        railRef: ref,
        amount: s.amount,
        assetId: s.assetId,
        failureCode: 'payout.invalid_amount',
        failureReason: 'Payout amount must be positive',
        at: this.now(),
      });
    }

    // Keyed on the settlement: a retried payout finds the original rather than
    // sending the merchant their window twice.
    const existing = this.payouts.get(ref);
    if (!existing) this.payouts.set(ref, { ref, amount: s.amount, assetId: s.assetId });

    return {
      ok: true,
      railRef: ref,
      status: 'paid_out',
      amount: existing?.amount ?? s.amount,
      assetId: s.assetId,
      at: this.now(),
      raw: { destination: s.destination.kind },
    };
  }

  verifyWebhook(req: RailWebhookRequest): RailEvent | null {
    const ok = verifySignature({
      body: req.body,
      signature: req.headers['x-sandbox-signature'],
      timestamp: req.headers['x-sandbox-timestamp'],
      secret: this.options.secret,
      toleranceSeconds: this.toleranceSeconds,
      now: this.now(),
    });
    if (!ok) return null;

    // Only parse AFTER the signature verifies. Parsing unverified input is
    // running an attacker's bytes through a parser for free.
    let body: unknown;
    try {
      body = JSON.parse(req.body);
    } catch {
      return null;
    }

    return toRailEvent(this.id, body);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Sign a webhook the way the acquirer would — used by tests and the harness. */
  signWebhook(payload: Record<string, unknown>, at: Date = this.now()): RailWebhookRequest {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(at.getTime() / 1000).toString();
    return {
      headers: {
        'x-sandbox-signature': signPayload(this.options.secret, timestamp, body),
        'x-sandbox-timestamp': timestamp,
      },
      body,
    };
  }

  private takeForcedFailure(railRef: string, amount: Amount, assetId: string): RailResult | null {
    if (this.forcedFailure === null) return null;
    const { code, reason } = this.forcedFailure;
    this.forcedFailure = null;
    return railFailure({ railRef, amount, assetId, failureCode: code, failureReason: reason, at: this.now() });
  }

  private unknownReference(ref: string): RailResult {
    return railFailure({
      railRef: ref,
      // Zero would be a lie about an amount we do not know. The caller must not
      // treat a failure's amount as authoritative, and the kit asserts it never
      // does — but a made-up number here is still how a bad reconciliation
      // report gets written.
      amount: 0n,
      assetId: '',
      failureCode: 'rail.unknown_reference',
      failureReason: `No charge with reference ${ref}`,
      at: this.now(),
    });
  }

  private resultFor(charge: AcquirerCharge, status: 'authorized' | 'captured'): RailResult {
    return {
      ok: true,
      railRef: charge.ref,
      status,
      amount: status === 'authorized' ? charge.authorized : charge.captured,
      assetId: charge.assetId,
      at: this.now(),
      raw: { paymentId: charge.paymentId, chargeStatus: charge.status },
    };
  }
}

function chargeRef(paymentId: string): string {
  return `ch_${paymentId}`;
}

const EVENT_TYPES = new Set([
  'authorized',
  'captured',
  'refunded',
  'failed',
  'payout.completed',
  'dispute.opened',
  'dispute.won',
  'dispute.lost',
  'dispute.closed',
]);

/** Shape-check a verified body. A valid signature proves origin, not structure. */
function toRailEvent(railId: string, body: unknown): RailEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  const eventId = typeof b.id === 'string' ? b.id : null;
  const type = typeof b.type === 'string' && EVENT_TYPES.has(b.type) ? (b.type as RailEvent['type']) : null;
  const railRef = typeof b.ref === 'string' ? b.ref : null;
  if (!eventId || !type || !railRef) return null;

  let amount: Amount | undefined;
  if (typeof b.amount === 'string') {
    try {
      amount = parseAmount(b.amount);
    } catch {
      // A malformed amount is a malformed event. Accepting it with the amount
      // dropped would book a capture for the wrong number.
      return null;
    }
  } else if (b.amount !== undefined) {
    // Notably: a JSON number. Money never arrives as one, and silently
    // coercing it is how 0.1 + 0.2 gets into a payments book.
    return null;
  }

  const occurredAt = typeof b.occurredAt === 'string' ? new Date(b.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;

  const disputeId = typeof b.disputeId === 'string' && b.disputeId.trim() ? b.disputeId.trim() : undefined;
  const reasonCode = typeof b.reasonCode === 'string' && b.reasonCode.trim() ? b.reasonCode.trim() : undefined;
  let evidenceDueBy: Date | undefined;
  if (b.evidenceDueBy !== undefined && b.evidenceDueBy !== null) {
    if (typeof b.evidenceDueBy !== 'string') return null;
    const parsed = new Date(b.evidenceDueBy);
    if (Number.isNaN(parsed.getTime())) return null;
    evidenceDueBy = parsed;
  }

  return {
    railId,
    eventId,
    type,
    railRef,
    amount,
    assetId: typeof b.assetId === 'string' ? b.assetId : undefined,
    occurredAt,
    failureCode: typeof b.failureCode === 'string' ? b.failureCode : undefined,
    disputeId,
    reasonCode,
    evidenceDueBy,
  };
}
