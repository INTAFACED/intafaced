import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  railFailure,
  railHealthStaleReason,
  railRefusalIfBlocking,
  RAIL_HEALTH_MAX_STALENESS_MS,
  RAIL_MARKED_DOWN,
  RAIL_SANDBOX_ONLY,
  PARTNER_TERMS_NOT_KNOWN,
  type AcquirerPartnerTerms,
  type PaymentIntent,
  type RailAdapter,
  type RailCapability,
  type RailEvent,
  type RailHealth,
  type RailProbeResult,
  type RailResult,
  type PayoutRailStatus,
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
  /** A due date that is not a parseable string is ignored. The event still stands. */
  readonly noteMalformedEvidenceDueBy?: (eventId: string) => void;
}

/** Instrument tokens that steer the sandbox, the way a real sandbox uses test PANs. */
export const SANDBOX_DECLINE_TOKEN = 'tok_decline';
export const SANDBOX_ERROR_TOKEN = 'tok_rail_error';
/**
 * The issuer declines with a code no catalogue lists (TEST): what a real acquirer does when it adds a reason. The
 * merchant must read the generic sentence for it, never the rail's own words (merchant-failure.ts, J-merchant-05 #5).
 */
export const SANDBOX_UNLISTED_DECLINE_TOKEN = 'tok_decline_unlisted';
/**
 * The acquirer captures the charge and holds the funds (RC-merchant-10): the capture result says `funds: pending`, and
 * the funds stay held until a signed `funds.available` delivery names the charge.
 */
export const SANDBOX_FUNDS_HELD_TOKEN = 'tok_funds_held';

interface AcquirerCharge {
  ref: string;
  paymentId: string;
  assetId: string;
  authorized: Amount;
  captured: Amount;
  refunded: Amount;
  status: 'authorized' | 'captured' | 'refunded' | 'failed';
  /** Set from the instrument at authorize: the acquirer holds this charge's funds after capture. */
  fundsHeld: boolean;
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
  /**
   * The TEST partner's terms per business. A business the partner has said nothing about reads every term "not known"
   * (`PARTNER_TERMS_NOT_KNOWN`). Set only by the test controls below or a signed `partner.terms` report.
   */
  private readonly terms = new Map<string, AcquirerPartnerTerms>();
  /** The time of the last terms report taken per business: a replayed or late report never overwrites a newer one. */
  private readonly termsAt = new Map<string, number>();

  constructor(private readonly options: CardSandboxOptions) {
    this.now = options.now ?? (() => new Date());
    this.toleranceSeconds = options.toleranceSeconds;
    this.lastContact = this.now();
  }

  health(): RailHealth {
    const ageMs = this.now().getTime() - this.lastContact.getTime();
    if (ageMs > RAIL_HEALTH_MAX_STALENESS_MS) {
      return { healthy: false, latencyMs: 12, lastUpdate: this.lastContact, reason: railHealthStaleReason(ageMs) };
    }
    if (!this.up) {
      return { healthy: false, latencyMs: 12, lastUpdate: this.lastContact, reason: RAIL_MARKED_DOWN };
    }
    return { healthy: true, latencyMs: 12, lastUpdate: this.lastContact, reason: RAIL_SANDBOX_ONLY };
  }

  /** In-process. Success refreshes contact. A marked-down acquirer does not. */
  async probe(): Promise<RailProbeResult> {
    if (!this.up) return { ok: false, reason: RAIL_MARKED_DOWN };
    this.lastContact = this.now();
    return { ok: true };
  }

  private blockMoney(amount: Amount, assetId: string, railRef = ''): RailResult | null {
    return railRefusalIfBlocking(this, { amount, assetId, railRef, at: this.now() });
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

  /**
   * TEST switch: the partner's terms for one business, merged over what it said before. A term left out keeps its
   * last value; a business never set reads every term "not known".
   */
  setPartnerTerms(merchantId: string, terms: Partial<AcquirerPartnerTerms>): void {
    this.terms.set(merchantId, Object.freeze({ ...this.partnerTerms(merchantId), ...terms }));
  }

  /** TEST switch: the destination sends a payout back. Builds the signed delivery the partner would send. */
  returnPayout(idempotencyKey: string, returned: Amount, at: Date = this.now()): RailWebhookRequest {
    const row = this.payouts.get(idempotencyKey);
    if (!row) throw new Error(`TEST acquirer: no payout ${idempotencyKey} to return`);
    if (returned <= 0n || returned > row.amount)
      throw new Error('TEST acquirer: a returned amount is positive and at most what was paid out');
    return this.signWebhook(
      {
        // One delivery per return: a second partial return of the same payout is its own event, never a duplicate.
        id: `payout.returned:${idempotencyKey}:${formatAmount(returned)}:${at.toISOString()}`,
        type: 'payout.returned',
        ref: idempotencyKey,
        amount: formatAmount(returned),
        assetId: row.assetId,
        occurredAt: at.toISOString(),
      },
      at,
    );
  }

  partnerTerms(merchantId: string): AcquirerPartnerTerms {
    return this.terms.get(merchantId) ?? PARTNER_TERMS_NOT_KNOWN;
  }

  /**
   * A signed `partner.terms` report from the TEST partner (the stack's `card-terms` command). `not_terms` for any
   * delivery that is not one, so the caller passes it on as an ordinary webhook; `malformed` for one that verifies but
   * does not parse (never half-applied); `stale` for one no newer than the last taken (`occurredAt`), which changes
   * nothing; `refused` outside dev and test.
   */
  receivePartnerTerms(
    req: RailWebhookRequest,
    opts: { allowed: boolean } = { allowed: true },
  ): 'not_terms' | 'applied' | 'stale' | 'malformed' | 'refused' {
    const ok = verifySignature({
      body: req.body,
      signature: req.headers['x-sandbox-signature'],
      timestamp: req.headers['x-sandbox-timestamp'],
      secret: this.options.secret,
      toleranceSeconds: this.toleranceSeconds,
      now: this.now(),
    });
    if (!ok) return 'not_terms';
    let body: unknown;
    try {
      body = JSON.parse(req.body);
    } catch {
      return 'not_terms';
    }
    if (typeof body !== 'object' || body === null || (body as { type?: unknown }).type !== 'partner.terms') return 'not_terms';
    // Outside dev and test the switches are refused by name, before anything is parsed or kept.
    if (!opts.allowed) return 'refused';
    const parsed = parsePartnerTermsReport(body as Record<string, unknown>);
    const at = Date.parse(String((body as { occurredAt?: unknown }).occurredAt ?? ''));
    if (!parsed || !Number.isFinite(at)) return 'malformed';
    const last = this.termsAt.get(parsed.merchantId);
    if (last !== undefined && at <= last) return 'stale';
    this.termsAt.set(parsed.merchantId, at);
    this.setPartnerTerms(parsed.merchantId, parsed.terms);
    return 'applied';
  }

  reset(): void {
    this.terms.clear();
    this.termsAt.clear();
    this.charges.clear();
    this.payouts.clear();
    this.forcedFailure = null;
    this.up = true;
    this.lastContact = this.now();
  }

  // ── The interface ──────────────────────────────────────────────────────────

  async authorize(p: PaymentIntent): Promise<RailResult> {
    const blocked = this.blockMoney(p.amount, p.assetId, chargeRef(p.paymentId));
    if (blocked) return blocked;
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

    if (p.instrument?.token === SANDBOX_UNLISTED_DECLINE_TOKEN) {
      return railFailure({
        railRef: chargeRef(p.paymentId),
        amount: p.amount,
        assetId: p.assetId,
        failureCode: 'card.test_unlisted_reason',
        failureReason: 'Issuer declined the authorization with TEST reason 7Q (not in any catalogue)',
        at: this.now(),
        raw: { declineCode: '7Q' },
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
      fundsHeld: p.instrument?.token === SANDBOX_FUNDS_HELD_TOKEN,
    };
    this.charges.set(ref, charge);

    return this.resultFor(charge, 'authorized');
  }

  async capture(ref: string): Promise<RailResult> {
    const charge = this.charges.get(ref);
    const blocked = this.blockMoney(charge?.authorized ?? 0n, charge?.assetId ?? '', ref);
    if (blocked) return blocked;
    this.lastContact = this.now();

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
    const charge = this.charges.get(ref);
    const blocked = this.blockMoney(amount, charge?.assetId ?? '', ref);
    if (blocked) return blocked;
    this.lastContact = this.now();

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

  payoutIdempotencyKey(s: SettlementInstruction): string {
    return `po_${s.settlementId}`;
  }

  async queryPayout(idempotencyKey: string): Promise<PayoutRailStatus> {
    const row = this.payouts.get(idempotencyKey);
    if (!row) return { status: 'not_sent' };
    return { status: 'sent', railRef: row.ref, amount: row.amount, assetId: row.assetId };
  }

  async payout(s: SettlementInstruction): Promise<RailResult> {
    const blocked = this.blockMoney(s.amount, s.assetId, this.payoutIdempotencyKey(s));
    if (blocked) return blocked;
    this.lastContact = this.now();

    const ref = this.payoutIdempotencyKey(s);
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

    return toRailEvent(this.id, body, this.options.noteMalformedEvidenceDueBy);
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
      // The sandbox names no release day: it releases when a signed `funds.available` delivery says so.
      ...(status === 'captured' && charge.fundsHeld ? { funds: { state: 'pending' as const } } : {}),
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
  'funds.available',
  'funds.pending',
  'payout.returned',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET = /^[A-Z0-9]{1,16}$/;

/**
 * Shape-check a verified `partner.terms` report: `{ merchantId, terms: { reserveRule?, shortfallCover?, currencies?,
 * instantPayout? } }`, each term `{ known: false }` or its known shape. Amounts are decimal strings. Anything else is
 * refused whole.
 */
function parsePartnerTermsReport(b: Record<string, unknown>): { merchantId: string; terms: Partial<AcquirerPartnerTerms> } | null {
  const merchantId = typeof b.merchantId === 'string' && UUID.test(b.merchantId) ? b.merchantId : null;
  const t = b.terms;
  if (!merchantId || typeof t !== 'object' || t === null) return null;
  const raw = t as Record<string, unknown>;
  const out: { -readonly [K in keyof AcquirerPartnerTerms]?: AcquirerPartnerTerms[K] } = {};
  const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);
  const notKnown = (v: Record<string, unknown>) => v.known === false && Object.keys(v).length === 1;
  const whole = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);
  for (const key of Object.keys(raw)) {
    const v = obj(raw[key]);
    if (!v) return null;
    if (key === 'reserveRule') {
      if (notKnown(v)) out.reserveRule = { known: false };
      else {
        const bps = whole(v.rollingReserveBps, 10_000);
        const days = whole(v.holdDays, 3650);
        if (v.known !== true || bps === null || days === null) return null;
        out.reserveRule = { known: true, rollingReserveBps: bps, holdDays: days };
      }
    } else if (key === 'shortfallCover') {
      if (notKnown(v)) out.shortfallCover = { known: false };
      else if (v.known === true && (v.who === 'merchant' || v.who === 'partner' || v.who === 'house'))
        out.shortfallCover = { known: true, who: v.who };
      else return null;
    } else if (key === 'currencies') {
      if (notKnown(v)) out.currencies = { known: false };
      else if (v.known === true && Array.isArray(v.offered) && v.offered.every((a) => typeof a === 'string' && ASSET.test(a)))
        out.currencies = { known: true, offered: Object.freeze([...(v.offered as string[])]) };
      else return null;
    } else if (key === 'instantPayout') {
      if (notKnown(v)) out.instantPayout = { known: false };
      else if (v.known === true && v.offered === false) out.instantPayout = { known: true, offered: false };
      else if (v.known === true && v.offered === true) {
        const fee = obj(v.fee);
        if (!fee) return null;
        if (notKnown(fee)) out.instantPayout = { known: true, offered: true, fee: { known: false } };
        else {
          if (fee.known !== true || typeof fee.amount !== 'string' || typeof fee.assetId !== 'string' || !ASSET.test(fee.assetId))
            return null;
          let amount: Amount;
          try {
            amount = parseAmount(fee.amount);
          } catch {
            return null;
          }
          if (amount < 0n) return null;
          out.instantPayout = { known: true, offered: true, fee: { known: true, amount, assetId: fee.assetId } };
        }
      } else return null;
    } else return null;
  }
  return { merchantId, terms: out };
}

/** Shape-check a verified body. A valid signature proves origin, not structure. */
function toRailEvent(railId: string, body: unknown, noteMalformedEvidenceDueBy?: (eventId: string) => void): RailEvent | null {
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
    const parsed = typeof b.evidenceDueBy === 'string' ? new Date(b.evidenceDueBy) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      // A bad due date must not drop the dispute. The opening still runs; the
      // deadline stays absent, which is what a rail that sent none looks like.
      noteMalformedEvidenceDueBy?.(eventId);
    } else {
      evidenceDueBy = parsed;
    }
  }

  let availableOn: Date | undefined;
  if (b.availableOn !== undefined && b.availableOn !== null) {
    // A release day that does not parse is a malformed event: showing the business a wrong day is worse than none.
    const parsed = typeof b.availableOn === 'string' ? new Date(b.availableOn) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return null;
    availableOn = parsed;
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
    availableOn,
  };
}
