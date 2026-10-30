import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { ChainNotConfiguredError, ChainSendRefusedError, type ConfirmedTransfer, type CryptoChainPort } from './chain-port.js';
import {
  railFailure,
  railHealthStaleReason,
  railRefusalIfBlocking,
  RAIL_HEALTH_MAX_STALENESS_MS,
  RAIL_MARKED_DOWN,
  RAIL_PROBE_FAILED,
  RAIL_RPC_UNSET,
  type PaymentIntent,
  type RailAdapter,
  type RailCapability,
  type RailCaptureOptions,
  type RailEvent,
  type RailHealth,
  type RailMode,
  type PayoutRailStatus,
  type RailProbeResult,
  type RailResult,
  type RailWebhookRequest,
  type SettlementInstruction,
} from './rail-adapter.js';
import { signPayload, verifySignature } from './webhook-signature.js';

/**
 * crypto-native — §6.1's real v1 adapter, and §13's "crypto-native is real from
 * day one".
 *
 * It accepts on-chain assets and settles them into the ledger. There is no
 * partner in the flow of funds, which is why this rail works on day one while
 * every card rail waits on a sponsor.
 *
 * ON A CHAIN, "AUTHORIZE" AND "CAPTURE" ARE NOT WHAT THEY ARE ON A CARD.
 *
 * A card authorization is a promise the issuer can be held to; capture is when
 * the money actually moves. A chain has no such split — there is no hold, and
 * nothing to complete. A transfer either has not landed, or it has landed and
 * is irreversible once it is deep enough.
 *
 * So this adapter maps them honestly rather than pretending:
 *
 *   authorize → "a transfer to this payment's acceptance address has reached
 *                `minConfirmations`". Under the threshold the answer is
 *                `pending`, because a shallow transaction can still be
 *                reorganised away, and treating it as authorized is precisely
 *                how a merchant ships goods against a payment that unwinds.
 *   capture   → an accounting act. The value is already ours; capture is the
 *                moment the core is told to book it. It re-checks finality
 *                rather than trusting a decision made minutes ago.
 *
 * If this crashes between the two, nothing is stranded: the funds are on-chain
 * at an address we control, `capture` is derived from chain state rather than
 * from adapter memory, and the ledger post it triggers is keyed on the payment.
 * Re-running produces the same answer.
 */

export interface CryptoNativeOptions {
  readonly chain: CryptoChainPort;
  /** Webhook signing secret for the chain watcher's deliveries. */
  readonly secret: string;
  /**
   * Confirmations before a transfer counts as final.
   *
   * This is the reorg risk budget. Too low and a deep reorg takes back money
   * already settled to a merchant, out of a clearing account that has since
   * been emptied. Owner-published — never invent 6.
   */
  readonly minConfirmations: number;
  readonly now?: () => Date;
  /** Deliveries older than this are treated as replays. Owner-published — never invent 300. */
  readonly toleranceSeconds: number;
}

export class CryptoNativeAdapter implements RailAdapter {
  readonly id = 'crypto-native';
  readonly capabilities: readonly RailCapability[] = ['authorize', 'capture', 'refund', 'payout', 'webhook'];
  readonly refundIsIdempotentByRefundId = true;

  /**
   * DERIVED FROM THE CHAIN, never configured.
   *
   * §13 says "`crypto-native` is real from day one". That is true of the ADAPTER
   * and false of the deployment until a chain watcher exists: this file is
   * correct on-chain logic pointed at whatever implements `CryptoChainPort`, and
   * pointed at `MemoryChain` it is a sandbox no matter what the spec says.
   *
   * Reading it off the port rather than off configuration is the whole point. A
   * `PAY_CRYPTO_RAIL_IS_LIVE=true` would be a claim; this is a fact.
   *
   * THREE VALUES NOW, AND THEY ARE THE PORT'S OWN THREE. This used to read
   * `chain.posture === 'live' ? 'live' : 'sandbox'` — a three-into-two collapse
   * that reported an ABSENT chain as a working sandbox, which is the unsafe
   * direction: a sandbox succeeds and an absent chain refuses, and the rail was
   * announcing the wrong one of those. `RailMode` carries `absent` since the
   * 2026-08-04 ADR, so the mapping below is the identity and there is nothing
   * left to collapse. See `RailMode` for what the collapse actually cost at boot.
   */
  readonly mode: RailMode;

  private readonly chain: CryptoChainPort;
  private readonly minConfirmations: number;
  private readonly now: () => Date;
  private readonly toleranceSeconds: number;

  /**
   * Refunded totals per acceptance address.
   *
   * Bookkeeping, not custody: the core's `payment_events` is the authority on
   * how much of a payment has been refunded. This exists so the adapter refuses
   * an over-refund on its own account too — a rail that will broadcast whatever
   * it is told is one bug away from sending a merchant's whole balance back to
   * one buyer.
   */
  private readonly refunded = new Map<string, Amount>();
  /** Successful refunds by chain idempotency key — same-process retry must not re-add totals (M226-02). */
  private readonly completedRefundKeys = new Map<string, RailResult>();
  private refundSequence = 0;
  private lastContact: Date;
  private up = true;
  /** Set when the last probe failed. Cleared only by a later successful probe or watcher refresh. */
  private probeDown: string | null = null;

  constructor(private readonly options: CryptoNativeOptions) {
    this.chain = options.chain;
    // The identity. `ChainPosture` and `RailMode` are the same three words, and
    // the compiler now enforces that they stay the same three: widening either
    // without the other stops this line assigning.
    this.mode = options.chain.posture;
    if (!Number.isInteger(options.minConfirmations) || options.minConfirmations < 1) {
      throw new Error('minConfirmations is unset. Blank refuses — never 6. Owner must set a positive integer (6 is allowed if explicit).');
    }
    this.minConfirmations = options.minConfirmations;
    this.now = options.now ?? (() => new Date());
    this.toleranceSeconds = options.toleranceSeconds;
    this.lastContact = this.now();
  }

  /**
   * An ABSENT chain is reported unhealthy, always.
   *
   * `isUsable` is what routing and the operator console read, and a rail whose
   * every call is going to throw must not appear on either as available. A
   * sandbox chain is reported healthy on purpose — it genuinely works, which is
   * what dev and CI need; `mode` is what stops it moving real money. Dev with
   * no RPC is that sandbox (`MemoryChain`). The standing reason is
   * `rail.rpc_unset` so the console is not a blank dash. It is not a block.
   *
   * `lastUpdate` is the last successful probe (or watcher refresh), not the
   * last payment. Older than {@link RAIL_HEALTH_MAX_STALENESS_MS} is unknown:
   * `healthy: false`, reason `rail.health_stale`, and money calls refuse.
   */
  health(): RailHealth {
    if (this.chain.posture === 'absent') {
      return { healthy: false, latencyMs: 0, lastUpdate: this.now(), reason: this.chain.description };
    }
    const ageMs = this.now().getTime() - this.lastContact.getTime();
    if (this.probeDown) {
      return { healthy: false, latencyMs: 40, lastUpdate: this.lastContact, reason: this.probeDown };
    }
    if (ageMs > RAIL_HEALTH_MAX_STALENESS_MS) {
      return { healthy: false, latencyMs: 40, lastUpdate: this.lastContact, reason: railHealthStaleReason(ageMs) };
    }
    if (!this.up) {
      return { healthy: false, latencyMs: 40, lastUpdate: this.lastContact, reason: RAIL_MARKED_DOWN };
    }
    if (this.chain.posture === 'sandbox') {
      return { healthy: true, latencyMs: 40, lastUpdate: this.lastContact, reason: RAIL_RPC_UNSET };
    }
    return { healthy: true, latencyMs: 40, lastUpdate: this.lastContact };
  }

  /**
   * Confirm the chain is answering. Success refreshes `lastContact`. Failure
   * does not: a missed probe ages into `rail.health_stale`, and a thrown ping
   * is `rail.probe_failed` immediately.
   */
  async probe(): Promise<RailProbeResult> {
    if (this.chain.posture === 'absent') return { ok: false, reason: RAIL_RPC_UNSET };
    if (!this.up) return { ok: false, reason: RAIL_MARKED_DOWN };
    try {
      await this.chain.ping();
      this.probeDown = null;
      this.lastContact = this.now();
      return { ok: true };
    } catch (err) {
      this.probeDown = err instanceof ChainNotConfiguredError ? RAIL_RPC_UNSET : RAIL_PROBE_FAILED;
      return { ok: false, reason: this.probeDown };
    }
  }

  /** Live chain watcher, after `refresh()` returned. Not a payment. */
  noteAlive(): void {
    if (this.chain.posture === 'absent') return;
    this.probeDown = null;
    this.lastContact = this.now();
  }

  setHealthy(up: boolean): void {
    this.up = up;
  }

  reset(): void {
    this.refunded.clear();
    this.completedRefundKeys.clear();
    this.refundSequence = 0;
    this.up = true;
    this.probeDown = null;
    this.lastContact = this.now();
  }

  /** Refuse a new money call when the rail is stale, down, or the probe failed. Does not refresh contact. */
  private blockMoney(amount: Amount, assetId: string, railRef = ''): RailResult | null {
    return railRefusalIfBlocking(this, { amount, assetId, railRef, at: this.now() });
  }

  // ── The interface ──────────────────────────────────────────────────────

  async authorize(p: PaymentIntent): Promise<RailResult> {
    const blocked = this.blockMoney(p.amount, p.assetId);
    if (blocked) return blocked;
    this.lastContact = this.now();

    if (p.amount <= 0n) {
      return railFailure({
        railRef: '',
        amount: p.amount,
        assetId: p.assetId,
        failureCode: 'authorize.invalid_amount',
        failureReason: 'Authorization amount must be positive',
        at: this.now(),
      });
    }

    // The acceptance address IS the rail reference for this payment. It is
    // derived from the payment id, so it is stable across retries and across
    // process restarts — a second authorize never hands the buyer a second
    // address to pay into, which would split one payment across two.
    let address: string;
    let transfers: readonly ConfirmedTransfer[];
    try {
      address = await this.chain.acceptanceAddress(p.paymentId, p.assetId);
      transfers = await this.chain.inboundTransfers(address);
    } catch (err) {
      // A chain provider having a bad minute is not an exception in a payments
      // core. Nothing has moved and nothing is stranded — the buyer's funds, if
      // they sent any, are at an address derived from the payment id, so the
      // retry finds them.
      return railFailure({
        railRef: '',
        amount: p.amount,
        assetId: p.assetId,
        failureCode: this.chainFailureCode(err, 'chain.unavailable'),
        failureReason: err instanceof Error ? err.message : String(err),
        at: this.now(),
      });
    }

    if (transfers.length === 0) {
      return {
        ok: true,
        railRef: address,
        status: 'pending',
        amount: p.amount,
        assetId: p.assetId,
        at: this.now(),
        raw: { address, awaiting: formatAmount(p.amount) },
      };
    }

    const inAsset = transfers.filter((t) => t.assetId === p.assetId);
    // A later transfer in another token: not this payment's, but not gone either. It stays in `raw` with who sent it,
    // so support can send it back without a chain explorer.
    const strays = transfers
      .filter((t) => t.assetId !== p.assetId)
      .map((t) => ({ txHash: t.txHash, from: t.from, assetId: t.assetId, amount: formatAmount(t.amount) }));

    const transfer = transfers[0]!;
    if (transfer.assetId !== p.assetId) {
      // The payer sent the wrong token to the right address. Payers do this.
      // The payment fails, but the funds are not gone: they are at `address`,
      // in `transfer.assetId`, refundable to `transfer.from` — all of which is
      // in `raw` precisely so support can act on it without a chain explorer.
      // The first transfer decides the address's asset here and in `capture`
      // alike, so the two can never book different tokens.
      return railFailure({
        railRef: address,
        amount: transfer.amount,
        assetId: transfer.assetId,
        failureCode: 'chain.wrong_asset',
        failureReason: `Expected ${p.assetId}, received ${transfer.assetId}`,
        at: this.now(),
        raw: { address, txHash: transfer.txHash, from: transfer.from, receivedAsset: transfer.assetId },
      });
    }

    // A payer can pay in parts (J-merchant-04 step 5, M-payments-core-04b): every final transfer in the payment's asset
    // counts, and the payment authorizes once, when they add up. A shallow transfer counts for nothing yet — it can
    // still be reorganised away, and a merchant who ships against it has shipped against nothing.
    const final = inAsset.filter((t) => t.confirmations >= this.minConfirmations);
    const received = final.reduce((sum, t) => sum + t.amount, 0n);

    if (received < p.amount) {
      // Not enough is final yet: the payer has sent part of it, or the rest is
      // still shallow. Pending, not failed — an underpayment is the first half
      // of a payment more often than it is a mistake, and the funds that did
      // arrive are at `address`, listed here with who sent them. The payment
      // stays open for the rest; failing it would turn the payer's second
      // transfer into money nothing points at.
      const shallow = inAsset.filter((t) => t.confirmations < this.minConfirmations);
      const confirming = shallow.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ok: true,
        railRef: address,
        status: 'pending',
        amount: received,
        assetId: p.assetId,
        at: this.now(),
        raw: {
          address,
          received: formatAmount(received),
          missing: formatAmount(p.amount - received),
          // Sent but not yet final: the page must not ask the payer to send this again.
          confirming: formatAmount(confirming),
          required: this.minConfirmations,
          // J-merchant-05 #4: the count the merchant reads while it waits, from the transfer furthest from final.
          ...(shallow.length > 0 ? { confirmations: Math.min(...shallow.map((t) => t.confirmations)) } : {}),
          transfers: inAsset.map((t) => ({
            txHash: t.txHash,
            from: t.from,
            amount: formatAmount(t.amount),
            confirmations: t.confirmations,
          })),
          ...(shallow.length === 1 && final.length === 0 ? { txHash: shallow[0]!.txHash } : {}),
          ...(strays.length > 0 ? { strays } : {}),
        },
      };
    }

    return {
      ok: true,
      railRef: address,
      status: 'authorized',
      // What the chain actually delivered, which may be MORE than asked. The
      // core books what arrived; inventing a smaller number here would leave
      // the difference stranded at an address nothing points at.
      amount: received,
      assetId: p.assetId,
      at: this.now(),
      raw: {
        address,
        txHash: final[0]!.txHash,
        from: final[0]!.from,
        confirmations: Math.min(...final.map((t) => t.confirmations)),
        ...(final.length > 1 ? { txHashes: final.map((t) => t.txHash) } : {}),
        ...(strays.length > 0 ? { strays } : {}),
      },
    };
  }

  async capture(ref: string, opts?: RailCaptureOptions): Promise<RailResult> {
    const blocked = this.blockMoney(0n, '', ref);
    if (blocked) return blocked;
    this.lastContact = this.now();

    // Derived from chain state, never from adapter memory — that is what makes
    // this safe to re-run after a crash at any point.
    let paid: PaidAt | null;
    try {
      paid = await this.paidAt(ref);
    } catch (err) {
      return railFailure({
        railRef: ref,
        amount: 0n,
        assetId: '',
        failureCode: this.chainFailureCode(err, 'chain.unavailable'),
        failureReason: err instanceof Error ? err.message : String(err),
        at: this.now(),
      });
    }

    if (!paid) {
      return railFailure({
        railRef: ref,
        amount: 0n,
        assetId: '',
        failureCode: 'rail.unknown_reference',
        failureReason: `No confirmed transfer at ${ref}`,
        at: this.now(),
      });
    }

    if (paid.final.length === 0) {
      const shallow = paid.shallow[0]!;
      return railFailure({
        railRef: ref,
        amount: shallow.amount,
        assetId: paid.assetId,
        failureCode: 'chain.insufficient_confirmations',
        failureReason: `${shallow.confirmations} confirmations, ${this.minConfirmations} required`,
        at: this.now(),
      });
    }

    // The final transfers, as `authorize` counted them: oldest first, up to
    // the authorization the core names. A transfer that landed after authorize
    // (dust anyone can send to a public address) comes later on the chain and
    // is left out, so it cannot make every capture disagree with the
    // authorization. A part reorganised away since is not counted, so the total
    // comes back short and the core books neither number
    // (`pay.rail_amount_mismatch`) until the chain agrees again.
    const counted = countedUpTo(paid.final, opts?.authorized);
    return {
      ok: true,
      railRef: ref,
      status: 'captured',
      amount: counted.reduce((sum, t) => sum + t.amount, 0n),
      assetId: paid.assetId,
      at: this.now(),
      raw: {
        txHash: counted[0]!.txHash,
        confirmations: Math.min(...counted.map((t) => t.confirmations)),
        ...(counted.length > 1 ? { txHashes: counted.map((t) => t.txHash) } : {}),
      },
    };
  }

  async refund(ref: string, amount: Amount, opts?: { refundId?: string }): Promise<RailResult> {
    const blocked = this.blockMoney(amount, '', ref);
    if (blocked) return blocked;
    this.lastContact = this.now();

    let paid: PaidAt | null;
    try {
      paid = await this.paidAt(ref);
    } catch (err) {
      throw new RailOutcomeUnknownError(err);
    }
    const transfer = paid?.final[0] ?? null;

    if (!transfer) {
      return railFailure({
        railRef: ref,
        amount,
        assetId: '',
        failureCode: 'rail.unknown_reference',
        failureReason: `No confirmed transfer at ${ref}`,
        at: this.now(),
      });
    }

    const senders = new Set(paid!.final.map((t) => t.from?.trim() ?? ''));
    const payer = transfer.from?.trim() ?? '';
    // Payer dest only — never invent an address.
    if (!payer || senders.has('')) {
      return railFailure({
        railRef: ref,
        amount,
        assetId: transfer.assetId,
        failureCode: 'refund.destination_missing',
        failureReason: 'On-chain refund requires the payer address — no invented dest',
        at: this.now(),
      });
    }
    if (senders.size > 1) {
      // Paid in parts from different addresses: sending it all to one of them
      // would give one payer another's money, irreversibly.
      return railFailure({
        railRef: ref,
        amount,
        assetId: transfer.assetId,
        failureCode: 'refund.destination_ambiguous',
        failureReason: `The payment arrived from ${senders.size} addresses; an on-chain refund has no single destination`,
        at: this.now(),
      });
    }

    if (amount <= 0n) {
      return railFailure({
        railRef: ref,
        amount,
        assetId: transfer.assetId,
        failureCode: 'refund.invalid_amount',
        failureReason: 'Refund amount must be positive',
        at: this.now(),
      });
    }

    // A replay of a durable refund id answers with the first result. It must
    // come before the refundable check: a full refund already shrank
    // `refundable` to zero, so the replay would otherwise read as a failure for
    // a refund that was sent.
    const durableId = opts?.refundId?.trim();
    if (durableId) {
      const replayed = this.completedRefundKeys.get(`pay.refund:${ref}:${durableId}`);
      if (replayed) return replayed;
    }

    const already = this.refunded.get(ref) ?? 0n;
    // A payment paid in parts refunds up to all of its final transfers.
    const refundable = paid!.total - already;
    if (amount > refundable) {
      return railFailure({
        railRef: ref,
        amount,
        assetId: transfer.assetId,
        failureCode: 'refund.exceeds_captured',
        failureReason: `Refundable balance is ${formatAmount(refundable)}, requested ${formatAmount(amount)}`,
        at: this.now(),
      });
    }

    // An on-chain refund is a new transfer back to the payer, and it is
    // irreversible the moment it is broadcast. Prefer the core's durable
    // refundId (M226-02) so process restart reuses the same broadcast key via
    // BroadcastStore. Process-local sequence is fallback for conformance /
    // direct adapter calls that do not pass an id.
    const refundId = opts?.refundId?.trim();
    const usedSequenceFallback = !refundId;
    const sequencePart = refundId && refundId.length > 0 ? refundId : String(++this.refundSequence);
    const idempotencyKey = `pay.refund:${ref}:${sequencePart}`;

    const prior = this.completedRefundKeys.get(idempotencyKey);
    if (prior) return prior;

    try {
      const { txHash } = await this.chain.send({
        to: payer,
        assetId: transfer.assetId,
        amount,
        idempotencyKey,
      });

      this.refunded.set(ref, already + amount);

      const ok: RailResult = {
        ok: true,
        railRef: ref,
        status: 'refunded',
        amount,
        assetId: transfer.assetId,
        at: this.now(),
        raw: { txHash, to: payer, refundedTotal: formatAmount(already + amount), idempotencyKey },
      };
      this.completedRefundKeys.set(idempotencyKey, ok);
      return ok;
    } catch (err) {
      // Only a chain that was never configured is a known "not sent": nothing
      // left the building, the refunded total was not advanced, and the value
      // is still in the merchant's clearing account. Any other throw (a timeout
      // after the node took the transaction, a dropped reply) may already have
      // paid the payer, so it is uncertainty, never a refusal: the core keeps
      // the refund in flight rather than crediting the merchant back. Same rule
      // as `payout`.
      if (err instanceof ChainNotConfiguredError) {
        if (usedSequenceFallback) this.refundSequence--;
        return railFailure({
          railRef: ref,
          amount,
          assetId: transfer.assetId,
          failureCode: 'chain.not_configured',
          failureReason: err.message,
          at: this.now(),
        });
      }
      throw new RailOutcomeUnknownError(err);
    }
  }

  payoutIdempotencyKey(s: SettlementInstruction): string {
    return `pay.payout:${s.settlementId}`;
  }

  async queryPayout(idempotencyKey: string): Promise<PayoutRailStatus> {
    try {
      const found = await this.chain.lookupSend(idempotencyKey);
      if (found.state === 'not_sent') return { status: 'not_sent' };
      if (found.state === 'unknown') return { status: 'unknown' };
      return { status: 'sent', railRef: found.txHash, amount: found.amount, assetId: found.assetId };
    } catch (err) {
      if (err instanceof ChainNotConfiguredError) return { status: 'unknown' };
      return { status: 'unknown' };
    }
  }

  /** The send's depth on the chain; the caller compares it with the owner's settle depth. The chain cannot say: `null`. */
  async payoutDepth(s: SettlementInstruction): Promise<number | null> {
    try {
      return await this.chain.sendDepth(this.payoutIdempotencyKey(s));
    } catch {
      return null;
    }
  }

  async payout(s: SettlementInstruction): Promise<RailResult> {
    const blocked = this.blockMoney(s.amount, s.assetId);
    if (blocked) return blocked;
    this.lastContact = this.now();

    if (s.amount <= 0n) {
      return railFailure({
        railRef: '',
        amount: s.amount,
        assetId: s.assetId,
        failureCode: 'payout.invalid_amount',
        failureReason: 'Payout amount must be positive',
        at: this.now(),
      });
    }

    if (!s.destination.ref) {
      return railFailure({
        railRef: '',
        amount: s.amount,
        assetId: s.assetId,
        failureCode: 'payout.no_destination',
        failureReason: 'Settlement instruction carries no destination address',
        at: this.now(),
      });
    }

    try {
      // Keyed on the settlement, so a retried payout returns the original
      // broadcast. There is no undo on a chain.
      const { txHash } = await this.chain.send({
        to: s.destination.ref,
        assetId: s.assetId,
        amount: s.amount,
        idempotencyKey: this.payoutIdempotencyKey(s),
      });

      return {
        ok: true,
        railRef: txHash,
        status: 'paid_out',
        amount: s.amount,
        assetId: s.assetId,
        at: this.now(),
        raw: { txHash, to: s.destination.ref, window: s.window },
      };
    } catch (err) {
      if (err instanceof ChainNotConfiguredError)
        return railFailure({
          railRef: '',
          amount: s.amount,
          assetId: s.assetId,
          failureCode: 'chain.not_configured',
          failureReason: err.message,
          at: this.now(),
        });
      // Refused before broadcast: nothing left, so this is a refusal the hold can be reversed on, never an unknown outcome.
      if (err instanceof ChainSendRefusedError)
        return railFailure({
          railRef: '',
          amount: s.amount,
          assetId: s.assetId,
          failureCode: 'rail.refused',
          failureReason: err.message,
          at: this.now(),
        });
      throw new RailOutcomeUnknownError(err);
    }
  }

  verifyWebhook(req: RailWebhookRequest): RailEvent | null {
    const ok = verifySignature({
      body: req.body,
      signature: req.headers['x-chain-signature'],
      timestamp: req.headers['x-chain-timestamp'],
      secret: this.options.secret,
      toleranceSeconds: this.toleranceSeconds,
      now: this.now(),
    });
    if (!ok) return null;

    let body: unknown;
    try {
      body = JSON.parse(req.body);
    } catch {
      return null;
    }

    if (typeof body !== 'object' || body === null) return null;
    const b = body as Record<string, unknown>;

    const eventId = typeof b.id === 'string' ? b.id : null;
    const railRef = typeof b.ref === 'string' ? b.ref : null;
    const type = typeof b.type === 'string' ? b.type : null;
    if (!eventId || !railRef || !type) return null;
    if (!['authorized', 'captured', 'refunded', 'failed', 'payout.completed', 'chain.reorged'].includes(type)) return null;

    let amount: Amount | undefined;
    if (typeof b.amount === 'string') {
      try {
        amount = parseAmount(b.amount);
      } catch {
        return null;
      }
    } else if (b.amount !== undefined) {
      // A JSON number where money should be. Rejected outright rather than
      // coerced — the whole reason money is a string on the wire.
      return null;
    }

    const occurredAt = typeof b.occurredAt === 'string' ? new Date(b.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) return null;

    const chain =
      typeof b.txHash === 'string' &&
      b.txHash &&
      Number.isInteger(b.logIndex) &&
      (b.logIndex as number) >= 0 &&
      Number.isInteger(b.confirmations) &&
      (b.confirmations as number) >= 0
        ? { txHash: b.txHash, logIndex: b.logIndex as number, confirmations: b.confirmations as number }
        : undefined;
    // A reorg names the transfer it takes back by its chain position; without one there is nothing it could be about.
    if (type === 'chain.reorged' && !chain) return null;

    return {
      railId: this.id,
      eventId,
      type: type as RailEvent['type'],
      railRef,
      amount,
      assetId: typeof b.assetId === 'string' ? b.assetId : undefined,
      occurredAt,
      failureCode: typeof b.failureCode === 'string' ? b.failureCode : undefined,
      chain,
    };
  }

  /** Sign a watcher delivery — used by the conformance harness and by dev tooling. */
  signWebhook(payload: Record<string, unknown>, at: Date = this.now()): RailWebhookRequest {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(at.getTime() / 1000).toString();
    return {
      headers: {
        'x-chain-signature': signPayload(this.options.secret, timestamp, body),
        'x-chain-timestamp': timestamp,
      },
      body,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * WHICH KIND OF "the chain did not answer" THIS WAS.
   *
   * `chain.unavailable` and `chain.broadcast_failed` both read as transient: an
   * operator seeing either goes and looks at the node, and a retry policy keeps
   * trying. Neither is true when nothing is configured — that will never fix
   * itself, and the work that fixes it is commercial rather than operational.
   *
   * So an absent chain gets its own code. The distinction is the difference
   * between paging somebody at 3am and filing a procurement task, and it is also
   * the code an operator console should render as "this rail cannot pay out"
   * rather than "this rail is having a bad minute".
   */
  private chainFailureCode(err: unknown, transient: 'chain.unavailable' | 'chain.broadcast_failed'): string {
    return err instanceof ChainNotConfiguredError ? 'chain.not_configured' : transient;
  }

  /**
   * A rail reference for this adapter is an acceptance address. The chain says
   * what landed there — including which asset — so nothing here has to infer
   * the asset from the shape of a string. The payment's asset is the first
   * transfer's, and its total is every FINAL transfer in that asset, as
   * `authorize` counts it (a payer can pay in parts); a transfer in another
   * token, or one still shallow or reorganised away, is never added to it.
   */
  private async paidAt(address: string): Promise<PaidAt | null> {
    if (!address) return null;
    const all = await this.chain.inboundTransfers(address);
    const first = all[0];
    if (!first) return null;
    const inAsset = all.filter((t) => t.assetId === first.assetId);
    const final = inAsset.filter((t) => t.confirmations >= this.minConfirmations);
    return {
      assetId: first.assetId,
      final,
      shallow: inAsset.filter((t) => t.confirmations < this.minConfirmations),
      total: final.reduce((sum, t) => sum + t.amount, 0n),
    };
  }
}

/** The oldest transfers whose sum first reaches `authorized`; all of them when it is not named or never reached. */
function countedUpTo(transfers: readonly ConfirmedTransfer[], authorized: Amount | undefined): readonly ConfirmedTransfer[] {
  if (authorized === undefined) return transfers;
  let sum = 0n;
  for (let i = 0; i < transfers.length; i++) {
    sum += transfers[i]!.amount;
    if (sum >= authorized) return transfers.slice(0, i + 1);
  }
  return transfers;
}

/** What landed at an acceptance address in the payment's asset, oldest first: final and still shallow. */
interface PaidAt {
  readonly assetId: string;
  readonly final: readonly ConfirmedTransfer[];
  readonly shallow: readonly ConfirmedTransfer[];
  /** The final transfers' sum. */
  readonly total: Amount;
}

/** Transport failure is uncertainty, never a provider refusal or rollback. */
export class RailOutcomeUnknownError extends Error {
  readonly code = 'pay.rail_outcome_unknown';
  constructor(cause: unknown) {
    super('Chain send outcome is unknown; preserve the original claim', { cause });
    this.name = 'RailOutcomeUnknownError';
  }
}
