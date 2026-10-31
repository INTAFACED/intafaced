import type { Amount } from '@intafaced/ledger-client';

/**
 * RailAdapter — the §6.1 adapter interface.
 *
 * Doctrine §0.4: "Adapters, not integrations. All external rails (card issuers,
 * PSP partners, bank rails, liquidity venues) sit behind internal interfaces…
 * the platform never depends on them to function." Every partner rail named in
 * §6.1 plugs in later as an adapter; none of them is named here, because a
 * partner's name has no place in the code that would have to survive them.
 *
 * §6.1 states the claim this file has to make true: every partner rail — card
 * acquiring, PSP, bank — "drops in later as an adapter with zero core changes".
 * That is a testable claim, not a hope, and `conformance.ts` is what tests it —
 * a new adapter passes the kit or it does not merge (§6.3).
 *
 * The shape mirrors `packages/venue-adapter/src/source.ts`, which is how this
 * repo already does adapters: an interface, capability flags, health, and every
 * implementation behind it. The core asks what an adapter can do rather than
 * knowing which adapter it is talking to — that is the entire mechanism by
 * which a new rail costs zero core changes.
 *
 * MONEY IS `Amount` — a scaled bigint — everywhere in this file. A rail that
 * speaks decimal strings or minor units converts at its own boundary, on the
 * way in and on the way out, and never lets a `number` past it.
 */

/**
 * §6.1: `capabilities: RailCapability[]`.
 *
 * THE FIRST FIVE ARE THE ORIGINAL PORT and every registered adapter declares
 * some subset of them. The rest were added when the ADR of 2026-08-04
 * (`docs/adr/2026-08-04-pay-rails-and-psp-socket.md`) established that the port
 * could not express what a card rail does: *"Ours knows authorized | captured |
 * refunded | failed | payout.completed. A card rail needs partial capture, void,
 * 3DS/SCA next-action, disputes, mandates and FX."*
 *
 * ADDING A MEMBER HERE IS NOT ADDING A FEATURE. It is adding a QUESTION the core
 * is allowed to ask an adapter, and the only two honest answers are "yes, and
 * here is the method" and a refusal that names the rail and the operation. There
 * is deliberately no third answer, because the third answer is the one where a
 * rail returns a plausible result for an operation it never performed — see
 * `RailOperationUnsupportedError`.
 *
 * `crypto-native` and `card-sandbox` declare exactly what they declared before
 * this list grew. A capability an adapter does not name is one the core refuses
 * to route to it, so growth here cannot silently change either of them.
 */
export const RAIL_CAPABILITIES = [
  'authorize',
  'capture',
  'refund',
  'payout',
  'webhook',
  /** Capture LESS than was authorised, leaving the remainder to void or expire. */
  'capture.partial',
  /** Release an authorization without ever taking the money. */
  'void',
  /** Report and contest chargebacks. A rail without this cannot be disputed against. */
  'dispute',
  /** Store a payer's agreement to be charged again later (SEPA DD, card-on-file). */
  'mandate',
  /** Quote and settle across currencies at the rail boundary. */
  'fx',
] as const;
export type RailCapability = (typeof RAIL_CAPABILITIES)[number];

/**
 * WHETHER THIS RAIL MOVES REAL MONEY. The most important field on the interface.
 *
 *   live    — a real counterparty is at the other end. A `paid_out` result means
 *             funds actually left, and the `railRef` names a movement somebody
 *             outside this company can be asked about.
 *   sandbox — the counterparty is simulated. Everything on this side of the
 *             interface is real, and NOTHING on the other side is. It SUCCEEDS.
 *   absent  — nothing is behind this rail at all. Every call refuses. The rail is
 *             registered so the core can name it and say why it cannot be used.
 *
 * ── WHY THERE ARE THREE, AND WHY THERE USED TO BE TWO ────────────────────────
 *
 * `ChainPosture` in `chain-port.ts` has had three values from the start, and its
 * comment says why: *"a sandbox succeeds and an absent chain must refuse."*
 * `RailMode` had two, and `crypto-native` collapsed the third into `sandbox`:
 *
 *     this.mode = chain.posture === 'live' ? 'live' : 'sandbox';
 *
 * So a rail that was MISSING and a rail that was DELIBERATELY SIMULATED reported
 * the same thing — and the collapse ran in the unsafe direction, because absence
 * read as a working sandbox. The ADR of 2026-08-04 names this a defect and
 * requires the distinction: *"Make `RailMode` carry `absent` distinctly, or state
 * in the type why it may not."* This is it carrying it.
 *
 * ── WHAT THE COLLAPSE ACTUALLY COST, CONCRETELY ──────────────────────────────
 *
 * It was not only a reporting blur. `defaultChainFor` gives `staging`/`prod` an
 * `UnconfiguredChain` when nothing is configured — that is the DESIGNED
 * production default, and it is the safe one. Under the collapse that chain made
 * `crypto-native` report `sandbox`, `assertRailPosture` counted it as a sandbox
 * rail, and the process REFUSED TO BOOT. The only way out was
 * `PAY_ALLOW_SANDBOX_RAILS=true` — the flag whose whole meaning is "sandbox rails
 * may move value here". The collapse therefore manufactured pressure to set, in
 * production, the exact override it exists to warn about, in order to start a
 * service that had no chain to abuse in the first place.
 *
 * With `absent` distinct, an unconfigured production deployment boots, every
 * crypto call refuses by name with `chain.not_configured`, and the override stays
 * unset and meaningful.
 *
 * ── THE PROPERTY THAT MUST SURVIVE EVERY FUTURE EDIT ─────────────────────────
 *
 * SANDBOX IS NEVER REPORTABLE AS LIVE, BY ANY COLLAPSE, AT ANY LAYER. Widening
 * this type does not touch that: `isLive` is `mode === 'live'` and nothing else,
 * and every posture gate in `posture.ts` lets only `'live'` through and refuses
 * everything else. A member added here is refused by default; it could only ever
 * become permissive by someone editing `isLive`, which is one line, reviewed on
 * its own, and asserted against in `rail-adapter.widening.test.ts`.
 *
 * WHY IT IS ON THE INTERFACE AND NOT IN A CONFIG FILE. An adapter is the only
 * thing that knows whether it has a counterparty; a deployment list of "which
 * rails are real" is a second copy of that fact, and the copy is what goes stale.
 * `card-sandbox` is `sandbox` by construction and cannot be configured otherwise.
 * `crypto-native` is `live` exactly when the chain behind it is live, and it
 * derives its own answer rather than being told.
 *
 * WHAT IT PREVENTS. A withdrawal settled against a sandbox rail debits the user's
 * real ledger balance, returns a fabricated provider reference, and reports
 * `sent`. The user has been told their money moved. There is no worse bug
 * available in this service, and it is not detectable after the fact — the books
 * balance perfectly, because the only thing missing is the money. `posture.ts`
 * is what refuses it; this field is what makes the refusal possible.
 */
export const RAIL_MODES = ['live', 'sandbox', 'absent'] as const;
export type RailMode = (typeof RAIL_MODES)[number];

/**
 * Health, in the shape `LiquiditySource` uses.
 *
 * `lastUpdate` matters for the same reason it does for a venue: a rail that has
 * stopped responding but still answers is worse than one that is plainly down,
 * because the router keeps sending it traffic.
 */
export interface RailHealth {
  readonly healthy: boolean;
  /** Round-trip latency in ms. Ties break on it, and degradation shows in it. */
  readonly latencyMs: number;
  readonly lastUpdate: Date;
  readonly reason?: string;
}

/** What the payer is paying with. Rails read only the parts they understand. */
export interface PaymentInstrument {
  /** 'card' | 'crypto' | 'bank_transfer' — the family, not the brand. */
  readonly kind: string;
  /** Tokenised card / stored instrument reference. Never a PAN. */
  readonly token?: string;
  /** On-chain address the payer will send from, when the rail knows it. */
  readonly address?: string;
}

/** §6.1: `authorize(p: PaymentIntent)`. */
export interface PaymentIntent {
  /** Our payment id. The rail echoes it back so a webhook can be matched. */
  readonly paymentId: string;
  readonly merchantId: string;
  /** Scaled bigint. Never a number, never a float, never minor units. */
  readonly amount: Amount;
  /** Asset id as the ledger knows it: 'USDT', 'BTC', 'EUR'. */
  readonly assetId: string;
  readonly method: string;
  readonly instrument?: PaymentInstrument;
  /** Merchant's reference for the buyer — opaque to us and to the rail. */
  readonly customerRef?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * What a rail status query may answer about one original payout key.
 * `amount` and `assetId` are null when the rail can prove a send but does
 * not echo the instruction. A disagreeing amount is not a send of this payout.
 */
export type PayoutRailStatus =
  | { readonly status: 'sent'; readonly railRef: string; readonly amount: Amount | null; readonly assetId: string | null }
  | { readonly status: 'not_sent' }
  | { readonly status: 'unknown' };

/** §6.1: `payout(s: SettlementInstruction)`. */
export interface SettlementInstruction {
  readonly settlementId: string;
  readonly merchantId: string;
  /** Net owed to the merchant for the window. Scaled bigint. */
  readonly amount: Amount;
  readonly assetId: string;
  readonly window: string;
  readonly destination: PayoutDestination;
}

export interface PayoutDestination {
  /** 'crypto' | 'bank'. */
  readonly kind: string;
  /** Address or masked account reference. */
  readonly ref: string;
}

/**
 * WHAT A RAIL CALL ENDED UP AS.
 *
 * The first six are the original set. The rest exist because a card rail spends
 * most of its life in states this list could not name — the ADR's scale check is
 * that Hyperswitch's `IntentStatus` has seventeen variants against our six.
 *
 * THE ADDITIONS ARE NOT A COMPLETENESS EXERCISE. Each one is a state in which the
 * core must do something DIFFERENT with a merchant's money, and which was
 * previously indistinguishable from a state where it must not:
 *
 *   partially_captured — value moved, but less than was authorised. Booking this
 *                        as `captured` credits a merchant for the full
 *                        authorization, which is money they were never paid.
 *   voided             — the authorization is released and NOTHING moved. Under
 *                        the old set this could only be reported as `failed`,
 *                        which reads as "the rail broke" to every operator and
 *                        every retry policy, when in fact the platform asked for
 *                        it and it worked.
 *   requires_action    — 3DS/SCA. The payer must do something before this can
 *                        proceed. It is NOT `pending` (which means "waiting for
 *                        the world") and NOT `failed` (which means "give up"):
 *                        collapsing it into either abandons a payer mid-flow,
 *                        holding a challenge they were never shown.
 *   disputed           — the payer's bank has taken the money back pending a
 *                        decision. `payment_status` in the database has had this
 *                        value since `0000_pay_init` with nothing able to reach
 *                        it; this is the rail-side half of reaching it.
 *   reversed           — a movement we already booked has been undone at the
 *                        rail. Distinct from `refunded`: a refund is ours and
 *                        deliberate, a reversal is theirs and imposed.
 *
 * `ok === (status !== 'failed')` still holds for every member. A dispute or a
 * reversal is a true report of something that happened, not a failed call — the
 * call worked, the news is bad, and those are different facts.
 */
export type RailResultStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'paid_out'
  | 'failed'
  | 'partially_captured'
  | 'voided'
  | 'requires_action'
  | 'disputed'
  | 'reversed';

/**
 * WHAT THE PAYER STILL HAS TO DO — 3DS, SCA, a bank redirect, an app approval.
 *
 * WHY THIS IS A FIELD ON THE RESULT RATHER THAN AN EXCEPTION OR A NULL. A payment
 * that needs a challenge is not a failure and not a success; it is a payment with
 * an outstanding instruction addressed to somebody who is not us. Represented as
 * a failure it is abandoned. Represented as success the merchant ships goods
 * against an authorization that does not exist yet. Represented as `pending` with
 * no payload the payer is left staring at a page while the one thing that could
 * move them forward — the redirect URL — is discarded in our own adapter.
 *
 * NOTHING IN HERE IS EVER A SECRET OF OURS. It is a URL and a challenge payload
 * the rail minted for one payer, and it is handed to that payer's browser. An
 * adapter must not put credentials, merchant configuration or its own signing
 * material in this object; the hosted checkout renders it, and the hosted
 * checkout is reachable by strangers.
 */
export interface RailNextAction {
  /**
   *   redirect            — send the payer's browser to `url`.
   *   challenge           — render the rail's challenge payload in place.
   *   display_instruction — show the payer something to do out of band (an
   *                         address to send to, a reference to quote at a bank).
   */
  readonly kind: 'redirect' | 'challenge' | 'display_instruction';
  readonly url?: string;
  /** Opaque to us. Passed to the payer's browser and never interpreted here. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * When the payer's window closes.
   *
   * A challenge with no expiry is a payment that can never be reconciled: the
   * core has nothing to time out against and the row sits in `requires_action`
   * for ever, holding a merchant's authorization open.
   */
  readonly expiresAt?: Date;
}

/**
 * §6.1: `RailResult`.
 *
 * `ok` and `status` are not redundant: `ok === (status !== 'failed')` is an
 * invariant the conformance kit asserts on every adapter, so a caller can
 * branch on either and be certain the other agrees. An adapter that returns
 * `ok: true` with a failure status has a bug the kit catches before merge —
 * and that particular bug quietly books money that never moved.
 *
 * A rail declining is a RESULT, not an exception. Declines are ordinary
 * traffic; throwing for them makes the ordinary path the exceptional one and
 * loses the decline code the merchant needs.
 */
export interface RailResult {
  readonly ok: boolean;
  /** The rail's own reference. Stable across authorize → capture → refund. */
  readonly railRef: string;
  readonly status: RailResultStatus;
  /** What the rail actually moved. Scaled bigint. */
  readonly amount: Amount;
  readonly assetId: string;
  readonly at: Date;
  /** Machine-readable, e.g. 'card.declined', 'chain.insufficient_confirmations'. */
  readonly failureCode?: string;
  readonly failureReason?: string;
  /** The rail's untranslated response, for support and reconciliation. */
  readonly raw?: Readonly<Record<string, unknown>>;

  /**
   * Set when, and only when, `status === 'requires_action'`.
   *
   * The core asserts the pairing rather than trusting it: an adapter reporting
   * `requires_action` with nothing here has stranded a payer, and one attaching a
   * challenge to a `captured` result is describing work nobody is going to do.
   */
  readonly nextAction?: RailNextAction;

  /**
   * On a PARTIAL capture: what is still authorised and not yet taken.
   *
   * Scaled bigint, and the reason it is on the result rather than derived is that
   * the rail is the authority. Our arithmetic (`authorized - captured`) is a
   * belief; a card scheme applying its own over-capture tolerance, or expiring an
   * authorization early, makes the rail's number the true one. Where the two
   * disagree the money follows the rail — the same rule `card-sandbox.refund`
   * already states about refundable balances.
   */
  readonly remainingAuthorized?: Amount;

  /**
   * On a rail that `checksPayerName`: the name on the sending account of EVERY transfer this result counts (null for one
   * the bank reported no name for), so the core checks exactly the money it is about to take in (RC-merchant-09).
   */
  readonly payerNames?: readonly (string | null)[];

  /**
   * On a `captured` result from a rail that holds captured funds before it makes them available (RC-merchant-10): the
   * rail's own word that the money is not yet released, with the day it says it will be where it names one. Absent means
   * the rail made the funds available at capture. Only the rail sets this; release comes later as a signed
   * `funds.available` delivery, never from a client.
   */
  readonly funds?: { readonly state: 'pending'; readonly availableOn?: Date };
}

/**
 * A webhook exactly as it arrived.
 *
 * `body` is the RAW body, not parsed JSON, and that is not a convenience: a
 * signature covers the bytes that were sent. Parsing and re-serialising before
 * verifying changes key order and whitespace, and the signature check then
 * fails for honest deliveries — or, worse, is quietly relaxed until it passes.
 */
export interface RailWebhookRequest {
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The five original types, plus the ones a card rail actually delivers.
 *
 * THE CORE'S WEBHOOK SWITCH IS NOT EXHAUSTIVE, ON PURPOSE, and that is what makes
 * growing this list safe. An unrecognised type falls through to the same place
 * `refunded` and `payout.completed` already land: RECORDED IN `payment_events`,
 * NOT ACTED ON. A rail cannot cause the core to move money merely by inventing an
 * event type, and adding one here does not change what any existing deployment
 * does until a `case` is written for it — deliberately a separate change, on the
 * money path, reviewed on its own.
 *
 * `dispute.opened` is the one this whole file was widened for. svc-pay posts
 * `chargebackOpen` through ledger-client or returns a named refuse — it must
 * not claim posted when the money port is absent. Shortfall/won stay unwired.
 */
export type RailEventType =
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'failed'
  | 'payout.completed'
  | 'capture.partial'
  | 'voided'
  | 'action.required'
  | 'dispute.opened'
  | 'dispute.won'
  | 'dispute.lost'
  | 'dispute.closed'
  | 'refund.reversed'
  | 'mandate.created'
  | 'mandate.revoked'
  /**
   * A chain watcher saw a transfer it reported leave the chain: the block it was in was rewritten and the transfer is not in
   * the new one (W-deposit-06). Carries `chain`. Only the customer deposit record acts on it; on a payment it is recorded and
   * not acted on, like any type without a `case`.
   */
  | 'chain.reorged'
  /**
   * The rail released a captured payment's held funds (RC-merchant-10). Settlement takes a payment whose capture the
   * rail reported held only after this delivery is recorded on it.
   */
  | 'funds.available'
  /** The rail still holds a captured payment's funds and names (`availableOn`) the day it will release them. */
  | 'funds.pending';

/** §6.1: `verifyWebhook(req): RailEvent | null`. */
export interface RailEvent {
  readonly railId: string;
  /** The rail's own event id. THE dedupe key — a redelivery repeats it. */
  readonly eventId: string;
  readonly type: RailEventType;
  readonly railRef: string;
  readonly amount?: Amount;
  readonly assetId?: string;
  readonly occurredAt: Date;
  readonly failureCode?: string;

  /**
   * The rail's dispute id, on any `dispute.*` delivery.
   *
   * SEPARATE FROM `railRef`, which names the CHARGE. One charge can be disputed
   * more than once — a second presentment, an arbitration after a won
   * representment — and keying the core's dispute record on the charge would make
   * the second one overwrite the first, losing the outcome of a case we won.
   */
  readonly disputeId?: string;

  /** The scheme's own reason code ('4855', 'fraudulent'). Never translated. */
  readonly reasonCode?: string;

  /**
   * When the rail says evidence must be in, on a `dispute.*` delivery.
   * Absent means the rail did not provide a deadline. Do not invent one.
   */
  readonly evidenceDueBy?: Date;

  /** The mandate this delivery is about, on `mandate.*`. */
  readonly mandateRef?: string;

  /** Where the chain saw the transfer, on a `captured` or `chain.reorged` delivery from a chain watcher. Absent from every other rail. */
  readonly chain?: { readonly txHash: string; readonly logIndex: number; readonly confirmations: number };

  /**
   * The name on the account the money came from, on a `captured` delivery from a bank rail that reports it. Compared with
   * the name the payer gave before a bank transfer is captured (RC-merchant-09); never shown to the payer or the business.
   */
  readonly payerName?: string;

  /** On a `funds.pending` delivery: the day the rail says it will release the funds. Absent when it names none. */
  readonly availableOn?: Date;
}

/**
 * THE INTERFACE (§6.1, verbatim in shape).
 *
 * ```ts
 * interface RailAdapter {
 *   id: string;
 *   capabilities: RailCapability[];
 *   authorize(p: PaymentIntent): Promise<RailResult>;
 *   capture(ref: string, opts?: RailCaptureOptions): Promise<RailResult>;
 *   refund(ref: string, amount: Amount, opts?: RailRefundOptions): Promise<RailResult>;
 *   payout(s: SettlementInstruction): Promise<RailResult>;
 *   verifyWebhook(req): RailEvent | null;
 * }
 * ```
 *
 * `health()` is the one addition, taken from `LiquiditySource` — routing and
 * the operator console both need to know whether a rail is answering, and an
 * adapter that cannot say is one the core has to guess about.
 *
 * Note what `capture` takes: a reference, and nothing else. THAT REMAINS TRUE and
 * is not a defect to be edited away — `capture(ref)` means "take the whole
 * authorization", which is what every existing caller and both v1 adapters mean
 * by it, and changing its signature would be a breaking change to a money path in
 * order to express a case that has its own method. Partial capture is
 * `capturePartial`, below, and it is optional: a rail declares `capture.partial`
 * or the core refuses to ask it, by name.
 *
 * `capture` optional `authorized` (J-merchant-04 step 5) is not a partial
 * capture: it is the whole authorization, named, for a rail whose reference
 * can keep receiving value after authorize (a chain acceptance address paid in
 * parts). Such a rail books exactly what it authorized, so a later transfer to
 * the address (anyone can send dust to a public address) cannot make every
 * capture disagree with the authorization. Other rails ignore it.
 *
 * `refund` optional `refundId` (M226-02): irreversible chain refunds must key
 * the outbound broadcast on the core's durable refund id, not a process-local
 * counter. Sandbox rails may ignore it.
 */
/** Optional third argument to `RailAdapter.refund` (backward compatible). */
export interface RailCaptureOptions {
  /** The amount the core holds as authorized for this reference: the whole authorization, never less. */
  readonly authorized?: Amount;
}

export interface RailRefundOptions {
  /**
   * Durable business key from the payment core (ledger / payment_events).
   * Live crypto rails MUST use this in the chain send idempotency key when set.
   */
  readonly refundId?: string;
}

// ── THE WIDENED OPERATIONS ───────────────────────────────────────────────────
//
// Everything below is OPTIONAL on the interface and additive to the file. An
// adapter written before any of it existed still satisfies `RailAdapter`, which
// is the property the ADR required: "crypto-native and card-sandbox must keep
// working unchanged". They do, and their tests are the proof.
//
// None of it implements a card rail. There is no acquirer — `socket.psp-partners`
// is a sponsor bank and an acquiring BIN, which is a commercial relationship and
// not a code gap, and the ADR of 2026-08-04 settled that no library closes it.
// This is the SHAPE a card rail would plug into, and the refusals that hold the
// place until one does.

/**
 * CAPTURE LESS THAN WAS AUTHORISED.
 *
 * THE MONEY LAW IS THE WHOLE POINT OF THIS SHAPE. `amount` is an `Amount` — a
 * scaled bigint — because a partial capture is the first operation on this port
 * where the core names a figure that is neither "all of it" nor derived from
 * something the rail already told us. A `number` here is `19.99` becoming
 * `19.989999999999998` and a merchant being credited a figure that exists in no
 * ledger. Decimal strings on the wire, scaled bigint in memory, never a `number`.
 *
 * WHY `final` IS REQUIRED AND NOT INFERRED. After a partial capture the remainder
 * is either released back to the payer or still held against a later capture, and
 * NOBODY CAN INFER WHICH FROM THE AMOUNTS. A shipper capturing 40 of 100 because
 * one item shipped today means something entirely different from a merchant
 * capturing 40 of 100 and abandoning the rest — the first must not release the
 * remaining 60, the second must. Left implicit, the adapter guesses, and the
 * guess is a hold on a buyer's card that nobody ever releases.
 */
export interface RailCaptureRequest {
  /** The rail reference from `authorize`. */
  readonly ref: string;
  /** Scaled bigint. Never a number, never minor units, never a float. */
  readonly amount: Amount;
  /**
   * True when no further capture will be attempted and the remainder should be
   * released. False keeps the remaining authorization open.
   */
  readonly final: boolean;
  /**
   * Durable business key from the core, so a retried capture is the same capture.
   * A rail that ignores it and captures twice has taken a buyer's money twice.
   */
  readonly captureId?: string;
}

/**
 * RELEASE AN AUTHORIZATION WITHOUT TAKING THE MONEY.
 *
 * A void is not a refund and the difference is not pedantic. A refund moves value
 * back out of the book, hits the merchant's balance or clearing, appears on the
 * payer's statement as two lines, and costs interchange. A void reaches a hold
 * that never became money — nothing to reverse in the ledger because nothing was
 * ever posted, and nothing on the payer's statement at all.
 *
 * SO IT IS NOT ON `VALUE_LEAVING_CAPABILITIES`. Voiding on a sandbox rail is
 * harmless in the way `authorize` is harmless: no user has been told their own
 * money left, because none of it ever arrived.
 */
export interface RailVoidRequest {
  readonly ref: string;
  /** Machine-readable, for the rail and for our own audit. */
  readonly reason?: string;
  readonly voidId?: string;
}

/**
 * DISPUTE STATUS — seven, matching what a scheme lifecycle actually contains.
 *
 * The ADR's scale check: Hyperswitch's `DisputeStatus` has seven variants against
 * our zero, because we had no dispute concept at all.
 *
 *   opened            — the payer's bank has taken the money. This is the state
 *                       where the loss is already real for us.
 *   evidence_required — we may contest, and there is a deadline.
 *   under_review      — evidence is in, the issuer is deciding.
 *   won               — the money comes back. The ONLY happy terminal state.
 *   lost              — it does not. The loss is final and must be booked.
 *   accepted          — we chose not to contest. Economically identical to
 *                       `lost` and kept separate anyway, because "we decided" and
 *                       "we were overruled" are different facts about the same
 *                       money and an operator reviewing a dispute rate needs to
 *                       tell them apart.
 *   expired           — the deadline passed with no response. Also economically
 *                       `lost`, and also a distinct fact: it means a queue was
 *                       not worked, which is an operational failure rather than a
 *                       commercial outcome.
 */
export const RAIL_DISPUTE_STATUSES = ['opened', 'evidence_required', 'under_review', 'won', 'lost', 'accepted', 'expired'] as const;
export type RailDisputeStatus = (typeof RAIL_DISPUTE_STATUSES)[number];

/** A chargeback as the rail describes it. */
export interface RailDispute {
  /** The rail's dispute id. The business key — NOT the charge reference. */
  readonly disputeId: string;
  /** The charge being disputed. */
  readonly railRef: string;
  readonly status: RailDisputeStatus;
  /**
   * What the payer's bank took back. Scaled bigint.
   *
   * MAY BE LESS THAN THE PAYMENT. Partial chargebacks are ordinary, and a core
   * that assumes "disputed means the whole payment" reverses a merchant for more
   * than was ever taken from them.
   */
  readonly amount: Amount;
  readonly assetId: string;
  /** The scheme's own code ('4855', 'fraudulent'). Never translated by us. */
  readonly reasonCode?: string;
  readonly openedAt: Date;
  /**
   * When evidence must be in.
   *
   * The most operationally load-bearing field here. A dispute nobody answered
   * before this passes is `expired`, which is money lost to an unworked queue
   * rather than to a decision. It is optional only because some rails do not
   * publish one; when a rail does, dropping it is not permitted.
   */
  readonly evidenceDueBy?: Date;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * Evidence for a representment.
 *
 * `documents` are opaque references — a blob key, a rail-side upload id — and
 * NEVER bytes and never a PAN. Evidence for a card dispute is exactly the kind of
 * material that carries cardholder data, and this port is not a place to put it.
 */
export interface RailDisputeEvidence {
  readonly disputeId: string;
  readonly narrative?: string;
  readonly documents?: readonly string[];
  readonly submittedBy: string;
}

/**
 * A PAYER'S STANDING AGREEMENT TO BE CHARGED AGAIN — card-on-file, SEPA direct
 * debit, an open-banking VRP.
 *
 * WHY THIS IS ON THE PORT AND NOT IN THE CORE. A mandate is a thing the RAIL
 * holds. We hold a reference to it. The moment the core stores anything that
 * looks like the instrument itself, this service is in scope for card data, and
 * that is a compliance perimeter nobody has agreed to move.
 *
 * `maxAmount` is an `Amount`, and it is the difference between a mandate and a
 * blank cheque: it is the ceiling the payer agreed to, and a rail that will charge
 * above it is one the core must be able to refuse before it does.
 */
export interface RailMandate {
  /** The rail's reference. What the core stores. Never an instrument. */
  readonly mandateRef: string;
  /** 'card' | 'sepa_dd' | 'vrp' — the family, not the brand. */
  readonly scheme: string;
  readonly status: 'pending' | 'active' | 'revoked' | 'expired';
  /** The ceiling the payer agreed to, per charge. Scaled bigint. */
  readonly maxAmount?: Amount;
  readonly assetId?: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
}

export interface RailMandateRequest {
  /** Our own id for this agreement, so a retry finds the first mandate. */
  readonly mandateId: string;
  readonly merchantId: string;
  readonly instrument: PaymentInstrument;
  readonly scheme: string;
  readonly maxAmount?: Amount;
  readonly assetId?: string;
  /** The payer's reference. Opaque to us and to the rail. */
  readonly customerRef?: string;
}

/**
 * AN FX QUOTE AT THE RAIL BOUNDARY.
 *
 * ── THE RATE IS NOT A `number`, AND THAT IS THE ONLY INTERESTING THING HERE ──
 *
 * Every instinct says a rate is a float. `1.0834`. It fits, it is what the API
 * returns, and it is wrong for the same reason money is: the rate is a MULTIPLIER
 * ON MONEY, so its error is money's error. Multiplying a scaled bigint by a
 * binary float reintroduces every problem `Amount` exists to prevent, one layer
 * up, where nobody is looking for it.
 *
 * So the rate is `rateScaled` — the rate times 10^18, the same scale as `Amount`
 * — and it crosses a wire as a decimal string exactly as an amount does.
 *
 * AND THE QUOTE CARRIES BOTH SIDES ANYWAY. `sourceAmount` and `targetAmount` are
 * both present and both authoritative. The core BOOKS THOSE and never re-derives
 * one from the other through the rate, because the rail's own rounding is the one
 * that determines what actually settles. The rate is for display, audit and
 * disputes; the two amounts are what the ledger sees.
 */
export interface RailFxQuoteRequest {
  readonly fromAssetId: string;
  readonly toAssetId: string;
  /** Scaled bigint, in `fromAssetId`. */
  readonly amount: Amount;
}

export interface RailFxQuote {
  /** The rail's quote id. Required to bind a settlement to the rate it was given. */
  readonly quoteId: string;
  readonly fromAssetId: string;
  readonly toAssetId: string;
  /** What leaves, in `fromAssetId`. Scaled bigint. */
  readonly sourceAmount: Amount;
  /** What arrives, in `toAssetId`. Scaled bigint. Booked, never re-derived. */
  readonly targetAmount: Amount;
  /** The rate × 10^18. NEVER a `number`. See the note above. */
  readonly rateScaled: Amount;
  readonly quotedAt: Date;
  /**
   * When the rate stops being honoured.
   *
   * A quote with no expiry is a rate we have promised for ever. Rails do not do
   * that, so an adapter that reports it is describing something that is not true.
   */
  readonly expiresAt: Date;
}

/**
 * THE RAIL CANNOT DO THIS, AND SAYS SO BY NAME.
 *
 * ── WHY A THROW AND NOT A `RailResult` WITH `ok: false` ──────────────────────
 *
 * This is the single most important decision in the widening, and it is settled
 * by `packages/venue-contracts/src/errors.ts`, which met the same fork and wrote
 * down the answer:
 *
 *     "The tempting alternative is to return `{ status: 'rejected' }`, which
 *      type-checks and lets a caller proceed. It is the worst option available:
 *      an execution port that answers plausibly while doing nothing reports fills
 *      that never happened…
 *      A missing key is not a market condition. It is a deployment that is not
 *      finished, and it must read like one."
 *
 * Substitute "a missing capability" for "a missing key" and the argument is
 * unchanged. A failed `RailResult` is the shape of a DECLINE — ordinary traffic,
 * retried, routed around, reported to the merchant as "the issuer said no". A rail
 * that cannot do partial capture has not declined anything. Handing back a
 * decline-shaped object would put "capture the remaining 60 elsewhere" logic in
 * front of an authorization that is still fully held, and would let a merchant be
 * told their partial capture was refused by a bank that was never asked.
 *
 * So: declines are results, and missing capabilities are exceptions. The core
 * cannot proceed past one by accident.
 *
 * WHAT THE MESSAGE HAS TO CONTAIN is what the reader must do next, because the
 * reader is an operator and not a debugger — the same contract
 * `ChainNotConfiguredError` and `SandboxRailError` already keep.
 */
export class RailOperationUnsupportedError extends Error {
  readonly code = 'pay.rail_operation_unsupported';

  constructor(
    readonly railId: string,
    readonly operation: RailCapability,
    readonly declared: readonly RailCapability[],
  ) {
    super(
      `Rail "${railId}" cannot ${operation}. NOTHING WAS ATTEMPTED and nothing needs unwinding.\n\n` +
        `Declared capabilities: ${declared.join(', ') || '(none)'}\n\n` +
        `This is not a decline. A decline is a real answer from a real counterparty and it arrives ` +
        `as a RailResult with ok: false, so a caller can retry it, route around it, or tell the ` +
        `merchant what the issuer said. This is the absence of an implementation, and it is thrown ` +
        `precisely so no caller can mistake it for the former — an execution port that answers ` +
        `plausibly while doing nothing reports movements that never happened.\n\n` +
        `IF THE RAIL SHOULD BE ABLE TO DO THIS: the adapter must both declare "${operation}" in its ` +
        `capabilities AND implement the corresponding method, then pass the conformance kit ` +
        `(services/svc-pay/src/rails/conformance.ts). Declaring without implementing is caught here ` +
        `rather than at the call site, because "declared but missing" is a half-finished deployment ` +
        `and it must read like one.\n\n` +
        `IF NO RAIL HERE CAN DO THIS: for card operations — partial capture, void, 3DS/SCA, disputes ` +
        `— the missing piece is a sponsor bank and an acquiring BIN. §13 lists that as socket ` +
        `"psp-partners" because it is a commercial relationship, not code: no library closes it, and ` +
        `the 2026-08-04 ADR settled that an orchestrator does not either.`,
    );
    this.name = 'RailOperationUnsupportedError';
  }
}

/**
 * Assert an adapter both DECLARES and IMPLEMENTS an operation, or refuse by name.
 *
 * BOTH HALVES ARE CHECKED, and the second is the one that catches real bugs. An
 * adapter that declares `capture.partial` and has no `capturePartial` method would
 * otherwise fail as `adapter.capturePartial is not a function` — a TypeError,
 * thrown from inside a money path, naming nothing an operator can act on and
 * indistinguishable in a log from a genuine crash.
 */
export function requireRailOperation(adapter: RailAdapter, operation: RailCapability, method: keyof RailAdapter): void {
  if (!supports(adapter, operation) || typeof adapter[method] !== 'function') {
    throw new RailOperationUnsupportedError(adapter.id, operation, adapter.capabilities);
  }
}

// ── THE CALL SITES ───────────────────────────────────────────────────────────
//
// The core calls these rather than the optional methods directly. That is not
// ceremony: `adapter.capturePartial?.(…)` is valid TypeScript, compiles, and
// evaluates to `undefined` for a rail that cannot do it — which is the silent
// no-op this whole file exists to make impossible. Going through a function that
// throws is how "the rail cannot do this" stops being an `undefined` a caller
// might not check.

/** Capture part of an authorization, or refuse by name. */
export async function capturePartial(adapter: RailAdapter, request: RailCaptureRequest): Promise<RailResult> {
  requireRailOperation(adapter, 'capture.partial', 'capturePartial');
  return adapter.capturePartial!(request);
}

/** Release an authorization without taking it, or refuse by name. */
export async function voidAuthorization(adapter: RailAdapter, request: RailVoidRequest): Promise<RailResult> {
  requireRailOperation(adapter, 'void', 'voidAuthorization');
  return adapter.voidAuthorization!(request);
}

/** Read a dispute from the rail, or refuse by name. */
export async function fetchDispute(adapter: RailAdapter, disputeId: string): Promise<RailDispute | null> {
  requireRailOperation(adapter, 'dispute', 'fetchDispute');
  return adapter.fetchDispute!(disputeId);
}

/** Contest a chargeback, or refuse by name. */
export async function submitDisputeEvidence(adapter: RailAdapter, evidence: RailDisputeEvidence): Promise<RailDispute> {
  requireRailOperation(adapter, 'dispute', 'submitDisputeEvidence');
  return adapter.submitDisputeEvidence!(evidence);
}

/**
 * Concede a chargeback, or refuse by name.
 *
 * Separate from letting it expire, and separate from losing it. See
 * `RAIL_DISPUTE_STATUSES` for why the three stay distinct.
 */
export async function acceptDispute(adapter: RailAdapter, disputeId: string): Promise<RailDispute> {
  requireRailOperation(adapter, 'dispute', 'acceptDispute');
  return adapter.acceptDispute!(disputeId);
}

/** Create a standing mandate, or refuse by name. */
export async function createMandate(adapter: RailAdapter, request: RailMandateRequest): Promise<RailMandate> {
  requireRailOperation(adapter, 'mandate', 'createMandate');
  return adapter.createMandate!(request);
}

/** Revoke a standing mandate, or refuse by name. */
export async function revokeMandate(adapter: RailAdapter, mandateRef: string): Promise<RailMandate> {
  requireRailOperation(adapter, 'mandate', 'revokeMandate');
  return adapter.revokeMandate!(mandateRef);
}

/** Quote a cross-currency conversion, or refuse by name. */
export async function quoteFx(adapter: RailAdapter, request: RailFxQuoteRequest): Promise<RailFxQuote> {
  requireRailOperation(adapter, 'fx', 'quoteFx');
  return adapter.quoteFx!(request);
}

export interface RailAdapter {
  readonly id: string;
  readonly capabilities: readonly RailCapability[];
  /**
   * True only when `refund(ref, amount, { refundId })` called again with the same refundId returns the first result and
   * moves value once (a live chain rail keys its broadcast on it). The core resumes an in-flight refund whose reply was
   * lost only on such a rail; on any other it stays in flight until someone reconciles it.
   */
  readonly refundIsIdempotentByRefundId?: boolean;
  /**
   * True on a rail the payer pushes money to from an account they choose (a bank transfer). Its authorize results name
   * the sending account of every transfer counted (`RailResult.payerNames`), and the core holds the payment for review,
   * instead of authorizing it, when any of them fails the owner's payer-name rule (RC-merchant-09). Keyed on the rail,
   * never on the payment's method string, so no method name skips the check.
   */
  readonly checksPayerName?: boolean;

  /**
   * `live`, `sandbox` or `absent`. See `RailMode`.
   *
   * Required, and deliberately not defaulted. A new adapter has to state this,
   * because the alternative is an adapter author forgetting and the default
   * being the answer that loses money.
   */
  readonly mode: RailMode;

  health(): RailHealth;

  /**
   * Confirm the counterparty is still answering and refresh `lastUpdate`.
   * A successful probe is what keeps an idle rail usable. Money calls do not
   * count: they are the traffic a stale rail must not receive.
   */
  probe?(): Promise<RailProbeResult>;

  authorize(p: PaymentIntent): Promise<RailResult>;
  capture(ref: string, opts?: RailCaptureOptions): Promise<RailResult>;
  refund(ref: string, amount: Amount, opts?: RailRefundOptions): Promise<RailResult>;
  payout(s: SettlementInstruction): Promise<RailResult>;

  /**
   * Provider idempotency key `payout` will use for this instruction.
   * Absent means the core must not call `payout`: it cannot journal the key
   * a reconciler would have to ask later.
   */
  payoutIdempotencyKey?(s: SettlementInstruction): string;

  /**
   * Whether the ORIGINAL key was sent. Absent means the core has no rail
   * status query: a dispatched hold stays, and nothing here may reverse it.
   * `unknown` is the same fact at call time (the rail cannot say).
   */
  queryPayout?(idempotencyKey: string): Promise<PayoutRailStatus>;

  /**
   * W-withdraw-06: on a rail whose payout is final only at a depth (a chain), how deep the send of this instruction is now.
   * Present, a send out of the platform on this rail settles only once that reaches the owner's settle depth
   * (`PAY_WITHDRAW_MIN_CONFIRMATIONS`); `null` means the rail cannot say, and the hold stays. Absent, the rail's acceptance is final (ENGINE W-4).
   */
  payoutDepth?(s: SettlementInstruction): Promise<number | null>;

  /**
   * Verify and parse an inbound webhook.
   *
   * Returns null for anything that does not verify — a bad signature, a missing
   * header, a replayed timestamp, a body that does not parse. Never throws for
   * malformed input, because a webhook endpoint that throws on garbage is a
   * denial-of-service surface anyone on the internet can reach.
   *
   * MUST be constant-time in the signature comparison (`crypto.timingSafeEqual`).
   * A timing side channel on a signature check is a real attack: an attacker who
   * can measure it can forge a webhook byte by byte, and a forged webhook here
   * says "this payment was captured" about money that never moved.
   */
  verifyWebhook(req: RailWebhookRequest): RailEvent | null;

  // ── OPTIONAL: THE CARD-SHAPED OPERATIONS ───────────────────────────────────
  //
  // Every method below is optional, and that is what makes this widening
  // additive: `crypto-native` and `card-sandbox` implement none of them, satisfy
  // `RailAdapter` unchanged, and their tests pass without modification.
  //
  // OPTIONAL DOES NOT MEAN "SILENTLY ABSENT". An adapter that does not implement
  // one must not declare the matching capability, and the core reaches all of
  // them through the module-level functions above, which refuse by name. The
  // pairing — capability declared AND method present — is what `requireRailOperation`
  // enforces, and it is enforced on every call rather than once at registration,
  // for the reason `posture.ts` gives about its own second gate: a check that only
  // runs at boot is a check that only used to run.

  /** Declare `capture.partial`. See `RailCaptureRequest`. */
  capturePartial?(request: RailCaptureRequest): Promise<RailResult>;

  /** Declare `void`. See `RailVoidRequest`. */
  voidAuthorization?(request: RailVoidRequest): Promise<RailResult>;

  /**
   * Declare `dispute`. Returns null when the rail has no such dispute — a fact
   * about the rail, and distinct from throwing, which would be a fact about us.
   */
  fetchDispute?(disputeId: string): Promise<RailDispute | null>;

  /** Declare `dispute`. Contest a chargeback with evidence. */
  submitDisputeEvidence?(evidence: RailDisputeEvidence): Promise<RailDispute>;

  /** Declare `dispute`. Concede without contesting. */
  acceptDispute?(disputeId: string): Promise<RailDispute>;

  /** Declare `mandate`. */
  createMandate?(request: RailMandateRequest): Promise<RailMandate>;

  /** Declare `mandate`. */
  revokeMandate?(mandateRef: string): Promise<RailMandate>;

  /** Declare `fx`. The rate is never a `number` — see `RailFxQuote`. */
  quoteFx?(request: RailFxQuoteRequest): Promise<RailFxQuote>;
}

export function supports(adapter: RailAdapter, capability: RailCapability): boolean {
  return adapter.capabilities.includes(capability);
}

/**
 * True when this rail has a real counterparty at the other end.
 *
 * ONE EQUALITY, AGAINST ONE STRING, AND IT MUST STAY THAT WAY. This is the
 * predicate every posture gate is built on, and its safety property is that it is
 * an ALLOW-LIST OF SIZE ONE: whatever `RailMode` grows to, a new member is not
 * live. The unsafe refactor is the tempting one — `mode !== 'sandbox'` reads the
 * same, passes the same tests today, and silently promotes `absent` to live the
 * moment the type widened. It did widen. This did not change.
 */
export function isLive(adapter: RailAdapter): boolean {
  return adapter.mode === 'live';
}

/** Deliberately simulated: it succeeds, and none of it is real. */
export function isSandbox(adapter: RailAdapter): boolean {
  return adapter.mode === 'sandbox';
}

/**
 * Nothing is behind this rail. Every call refuses.
 *
 * DISTINCT FROM `isSandbox`, which is the entire point of the third mode. A
 * sandbox and an absent rail need opposite operator responses: a sandbox is
 * working as designed and must never be pointed at a stranger's money, while an
 * absent rail is a deployment that is not finished and the work to finish it is
 * usually commercial rather than operational.
 */
export function isAbsent(adapter: RailAdapter): boolean {
  return adapter.mode === 'absent';
}

/**
 * THE CAPABILITIES THAT MOVE REAL MONEY IN THE REAL WORLD.
 *
 * `payout` sends funds out of the platform's custody; `refund` sends captured
 * funds back to a payer. Both are irreversible at the rail and both are the
 * subject of a sentence we say to a user ("your money is on its way"), which is
 * why a sandbox behind either of them is a lie rather than a limitation.
 *
 * `authorize` and `capture` are deliberately NOT on this list. They move value
 * INTO the book from a counterparty, and a sandbox authorize is how the whole
 * lifecycle is exercised in CI without a sponsor bank. If a sandbox capture
 * credits a merchant who was never paid, the platform is short — bad, and
 * caught by reconciliation against the rail boundary, which is exactly the
 * figure that exists for it. Nobody has been told their own money left.
 *
 * THE WIDENED CAPABILITIES ARE JUDGED BY THE SAME TEST, and most of them fail it:
 *
 *   capture.partial — value IN, like `capture`. Not on the list.
 *   void            — reaches a hold that never became money. There is nothing to
 *                     send anywhere and nothing on the payer's statement. Not on
 *                     the list, and this is the one worth stating out loud,
 *                     because "void" sounds destructive and is the opposite: it
 *                     is the operation that returns a buyer's headroom to them.
 *   dispute         — the money has already left, taken by the payer's bank. We
 *                     are not the ones moving it, and a sandbox cannot fabricate
 *                     a chargeback into a real account. Not on the list.
 *   mandate         — creates permission to charge, and moves nothing.
 *   fx              — a quote is a number, not a movement. The movement it
 *                     precedes is a payout or a capture, and THAT is gated.
 *
 * So the list does not grow. A capability that fails the "have we told a user
 * their own money left" test does not belong on it, and adding one that does not
 * belong would refuse a sandbox operation that CI depends on while teaching
 * nobody anything true.
 */
export const VALUE_LEAVING_CAPABILITIES: readonly RailCapability[] = ['payout', 'refund'];

/**
 * How long a rail may go without a successful probe before it is unknown.
 * Same idea as a stale venue quote (`isRoutable`): lastUpdate is the last
 * confirmation, not the last payment. Idle is not "up".
 */
export const RAIL_HEALTH_MAX_STALENESS_MS = 30_000;

/** No successful probe within {@link RAIL_HEALTH_MAX_STALENESS_MS}. The reason includes `ageMs`. */
export const RAIL_HEALTH_STALE = 'rail.health_stale';
/** crypto-native in dev/test with no `PAY_CRYPTO_RPC_URL` (MemoryChain). The rail can still run the fixture. */
export const RAIL_RPC_UNSET = 'rail.rpc_unset';
/** card-sandbox is up. It is a mock acquirer, not a live one. */
export const RAIL_SANDBOX_ONLY = 'rail.sandbox_only';
/** `setHealthy(false)` or an equivalent operator down. */
export const RAIL_MARKED_DOWN = 'rail.marked_down';
/** The last probe threw or the chain did not answer. */
export const RAIL_PROBE_FAILED = 'rail.probe_failed';

export interface RailProbeResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function railHealthStaleReason(ageMs: number): string {
  const age = Number.isFinite(ageMs) ? Math.max(0, Math.trunc(ageMs)) : 0;
  return `${RAIL_HEALTH_STALE} ageMs=${age}`;
}

/** The typed code at the front of a health reason. Prose that is not a code becomes `rail.unhealthy`. */
export function railReasonCode(reason: string): string {
  const token = reason.trim().split(/\s+/)[0] ?? '';
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(token)) return token;
  return 'rail.unhealthy';
}

/**
 * Why this rail must not be offered, or null when it may.
 *
 * `health()` and this function agree when `now` is the adapter's clock: a
 * stale `lastUpdate` is not healthy, and every not-usable state has a reason.
 * A caller-supplied `now` that is later than the adapter clock is still not
 * usable (`rail.health_stale`), which is what the conformance kit pins.
 */
export function railUnusableReason(
  adapter: RailAdapter,
  now: Date = new Date(),
  maxStalenessMs = RAIL_HEALTH_MAX_STALENESS_MS,
): string | null {
  const health = adapter.health();
  const ageMs = now.getTime() - health.lastUpdate.getTime();
  if (Number.isFinite(ageMs) && ageMs > maxStalenessMs) return railHealthStaleReason(ageMs);
  if (!health.healthy) {
    const reason = health.reason?.trim() ?? '';
    return reason.length > 0 ? reason : 'rail.unhealthy';
  }
  return null;
}

/**
 * Reasons that mean "do not send this call". Absent rails keep their own
 * refusal (`chain.not_configured` / `pay.rail_not_live`); a standing
 * `rail.rpc_unset` or `rail.sandbox_only` on a fresh sandbox is information,
 * not a block — dev and CI move fixture value through those rails.
 */
const MONEY_BLOCKING_REASONS: ReadonlySet<string> = new Set([RAIL_HEALTH_STALE, RAIL_PROBE_FAILED, RAIL_MARKED_DOWN]);

/**
 * `rail.health_stale`, `rail.probe_failed`, or `rail.marked_down`.
 * A standing `rail.rpc_unset` or `rail.sandbox_only` is not a block.
 * The argument may be a bare code or a reason that starts with one.
 */
export function isRailHealthBlockingCode(code: string): boolean {
  return MONEY_BLOCKING_REASONS.has(railReasonCode(code));
}

export function railBlockingReason(
  adapter: RailAdapter,
  now: Date = new Date(),
  maxStalenessMs = RAIL_HEALTH_MAX_STALENESS_MS,
): string | null {
  const reason = railUnusableReason(adapter, now, maxStalenessMs);
  if (!reason) return null;
  return isRailHealthBlockingCode(reason) ? reason : null;
}

/** A failed rail result when {@link railBlockingReason} is set. Does not touch the rail. */
export function railRefusalIfBlocking(
  adapter: RailAdapter,
  input: { amount: Amount; assetId: string; railRef?: string; at?: Date },
): RailResult | null {
  const at = input.at ?? new Date();
  const reason = railBlockingReason(adapter, at);
  if (!reason) return null;
  return railFailure({
    railRef: input.railRef ?? '',
    amount: input.amount,
    assetId: input.assetId,
    failureCode: railReasonCode(reason),
    failureReason: reason,
    at,
  });
}

/**
 * A rail is usable only when it is healthy AND its health is fresh.
 *
 * Same failure as a stale venue quote (`isRoutable` in venue-adapter): an
 * adapter whose health was last confirmed ten minutes ago is not "healthy", it
 * is "unknown", and routing traffic to unknown is how a payment sits in
 * `created` while a merchant watches a spinner.
 */
export function isUsable(adapter: RailAdapter, now: Date = new Date(), maxStalenessMs = RAIL_HEALTH_MAX_STALENESS_MS): boolean {
  return railUnusableReason(adapter, now, maxStalenessMs) === null;
}

/** A failed result, in one place, so every adapter shapes declines identically. */
export function railFailure(input: {
  railRef: string;
  amount: Amount;
  assetId: string;
  failureCode: string;
  failureReason: string;
  at?: Date;
  raw?: Readonly<Record<string, unknown>>;
}): RailResult {
  return {
    ok: false,
    railRef: input.railRef,
    status: 'failed',
    amount: input.amount,
    assetId: input.assetId,
    at: input.at ?? new Date(),
    failureCode: input.failureCode,
    failureReason: input.failureReason,
    raw: input.raw,
  };
}
