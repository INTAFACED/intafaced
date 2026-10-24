import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  InsufficientFundsError,
  LedgerError,
  formatAmount,
  parseAmount,
  recipes,
  rewardsEngine,
  userAvailable,
  withdrawalHoldAccount,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { isDefiniteLedgerRefusal } from '../ledger-outcome.js';
import { assertCardAuthorizationsListLimit, assertCardsListLimit } from '../owner-list-limit.js';
import type { MarkQuality, PriceSource } from '../loans/prices.js';
import { withMoneySpan } from '../tracing.js';
import {
  DEFAULT_CARD_CONVERSION_POLICY,
  fundingFor,
  noConversionRates,
  quoteConversion,
  type CardConversionPolicy,
  type ConversionQuote,
} from './conversion.js';
import { cardProgrammeOutput, cashbackOn, noCardIssuer, type CardIssuerAdapter } from './issuer.js';

/**
 * CARDS (§8.1) — the LEDGER half: authorise, hold, capture, reverse, cash back.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS SERVICE ADDS NO RECIPE, AND THAT IS THE INTERESTING PART
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A card spend is a WITHDRAWAL. That sentence is the whole design, and once it
 * is said out loud the four recipes this module needs already exist:
 *
 *   authorisation approved  `withdrawHold`     available → hold, one account
 *                                              per authorisation
 *   capture (clearing)      `withdrawSettle`   hold → rail boundary; the value
 *                                              leaves our book
 *   the unspent remainder   `withdrawReverse`  hold → available, defined rather
 *                                              than improvised
 *   cashback                `rewardPay`        rewards engine → available
 *
 * The staging is not a convenience — it is what makes "authorised but not yet
 * captured" a BALANCE somebody can read (`withdrawalHoldAccount(user, asset,
 * authId)`) instead of an incident to be reconstructed. It is the same argument
 * `merchantClearing` makes for payments and `loanCollateralAccount` makes for
 * collateral, and it is why a partial capture here is two postings and not one
 * adjusted number: the merchant takes what they charged, the remainder goes
 * back, and the hold account ends at exactly zero.
 *
 * A new recipe would have been the wrong instinct twice over. `packages/ledger-
 * client` is owner carve-out territory, and more to the point a `cardSpend`
 * recipe would have been `withdrawSettle` with a different string in it — a
 * second way to spell one movement, which is how two subsystems come to
 * disagree about what happened.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IF THE PROCESS DIES EXACTLY HERE, WHOSE FUNDS ARE STRANDED?
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ── authorize(): decide, claim, THEN hold ────────────────────────────────────
 *
 *   after the decision row, before the hold post
 *     The authorisation is `approved` and `pending` with no ledger transaction.
 *     Nothing has moved and nothing is stranded: the user's funds are still
 *     their own available balance. A redelivered webhook re-drives it, and the
 *     post is idempotent on `withdraw.hold:<authorisation uuid>`, so it finds the
 *     original transaction or makes it once.
 *
 *   after the hold post, before the row is marked settled
 *     The funds are in a hold account keyed to THIS authorisation — an account
 *     the ledger says belongs to the user. The record catches up on re-drive.
 *     The worst case is a hold nobody captures, which `reverse()` returns.
 *
 *   THE REVERSE ORDER IS THE BUG. Hold-then-decide would post against an
 *   authorisation that has no row, so a crash would leave value in an account
 *   whose key nothing on this side can reconstruct.
 *
 * ── capture(): capture and reverse are two posts, and both must happen ───────
 *
 *   after the capture, before the remainder is returned
 *     The merchant has been paid and the user's unspent remainder is still in
 *     the hold account. Visible — `cards.test.ts` reads that account directly —
 *     and returned by `resumeSettlements`, which re-drives the reversal for the
 *     amount its row was claimed with. Nothing is lost; something is late.
 *
 *     NOT by re-driving `capture`. That was claimed here for a while and it was
 *     never true: a settled sequence 0 closes the authorisation, so the re-drive
 *     is refused `bank.card_authorization_closed` before either post is reached,
 *     and the repo's own test asserts that refusal. A recovery story that only
 *     exists in a comment is worse than an admitted gap — it is why the loans
 *     module has `resumePendingLoans` as a CALL and not as a paragraph.
 *
 *     They are NOT one posting, unlike the loan seizure. The argument that made
 *     a liquidation atomic was that the borrower could spend inside the window;
 *     here the window contains value the user CANNOT reach — it is in a hold —
 *     so splitting it costs a delay and buys two independently auditable facts.
 *
 * ── cashback(): after the money moved, and allowed to fail on its own ────────
 *
 *   Cashback is paid on a CAPTURE, never on an authorisation, because an
 *   authorisation that is later reversed is a purchase that did not happen and
 *   the reward would have to be clawed back from a balance the user may have
 *   already spent. Paying late is honest; taking money back is not a thing this
 *   service can do.
 *
 *   An empty pot is a named refusal: the row is `rejected` with
 *   `bank.cashback_pot_unfunded`, and the capture stays. Any other ledger error
 *   leaves the row `pending`. `rewardPay` keys the post on
 *   `reward:bank.card.cashback:<authorisation>`, and a repeat of that key
 *   returns the original transaction, so `resumeSettlements` can retry it
 *   without paying a second reward. Marking the row rejected would make that
 *   retry look like the pot was empty. Throwing would report a failed purchase
 *   after the merchant had already been paid.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT HERE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   · A LIVE RAIL. `socket.live-issuer` — a card-scheme sponsor and an issuing
 *     BIN. See `issuer.ts`, which is the seam, and states at length what
 *     `card-sim` is not.
 *   · REFUNDS. A merchant-initiated refund is value re-entering the book over
 *     the rail (`recipes.deposit`, rail `card-sim`), and it is not built here
 *     because it brings a question this module has not answered: whether the
 *     cashback paid on the original capture is clawed back. It is a product
 *     decision with a real answer either way, and inventing one to make a
 *     module look finished is how a card programme ends up paying for purchases
 *     that were returned.
 *   · DISPUTES AND CHARGEBACKS. A scheme process, downstream of a scheme.
 *   · INCREMENTAL AUTHORISATIONS, and any multi-capture flow. One capture per
 *     authorisation, enforced by `unique(authorization_id, sequence)` plus the
 *     closed check. Hotel and fuel flows need the first; they also need a live
 *     rail to be worth having.
 *   · FRAUD SCORING, velocity limits, 3-D Secure, MCC policy. All of it belongs
 *     to a rail, and none of it is simulated here — a decline in this module is
 *     always one of four named reasons and never a score.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * JUST-IN-TIME CONVERSION (§18) — WHAT IT CHANGED HERE, AND WHAT IT DID NOT
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A card may now be charged in a SETTLEMENT asset that is not the asset it draws
 * on, which is what §18's "spend pulls exact fiat equivalent via just-in-time
 * conversion" describes and what this module previously had no way to express.
 *
 * WHAT DID NOT CHANGE IS THE MONEY PATH. There is still one asset on our book —
 * the funding asset — moving available → hold → rail through the same three
 * recipes, and this file still adds no recipe. A conversion decides the SIZE of
 * that movement and is not a second movement; `conversion.ts` argues that at
 * length, including why booking the counterparty's leg would be a second book.
 *
 * Three consequences worth having in one place:
 *
 *   · `authorize()` and `capture()` take amounts in the SETTLEMENT asset — the
 *     merchant's number, which is the only number the merchant has. On a
 *     same-asset card the two are the same asset and nothing about the call
 *     changes.
 *   · `card_authorizations.amount` is the FUNDING amount, because that is what
 *     the hold, the capture and the reversal are all denominated in. A column
 *     that sometimes meant one asset and sometimes another is how a reversal
 *     comes to return the wrong number.
 *   · The rate is quoted ONCE and frozen in the same transaction as the
 *     decision. `capture()` re-reads it and never re-quotes, so a rate that
 *     moves between the swipe and the clearing cannot settle a different number
 *     of units than were held.
 *
 * And the refusal that matters most: with no rate adapter configured — which is
 * every deployment, because this platform has no FX source — a card that needs a
 * conversion refuses `bank.mark_missing` and writes nothing. It does not decline
 * (a decline is an answer, and nobody answered), and it does not invent a rate.
 */

export interface CardRecord {
  id: string;
  userId: string;
  /** Which of the user's balances this card draws on. Every posting is in this asset. */
  assetId: string;
  /**
   * What merchants charge this card in (§18).
   *
   * Equal to `assetId` means no conversion, and no rate is ever consulted.
   * Different means every authorisation is quoted at the authorisation moment,
   * and refuses by name if no rate can be got.
   */
  settlementAssetId: string;
  issuer: string;
  /** TRUE MEANS NO CARD EXISTS. Carried on every surface that renders a card. */
  simulated: boolean;
  issuerRef: string;
  panTail: string;
  status: 'active' | 'frozen' | 'closed';
  cashbackBps: number;
  perAuthorizationLimit: Amount;
  /** NULL means no ceiling. A policy, not a remaining balance. */
  dailyLimit: Amount | null;
  monthlyLimit: Amount | null;
  cashLimit: Amount | null;
  online: boolean;
  contactless: boolean;
  atm: boolean;
  abroad: boolean;
  cardType: 'virtual' | 'physical';
  shippingAddress: CardShippingAddress | null;
  replacesCardId: string | null;
  replacedByCardId: string | null;
  replaceReason: CardReplaceReason | null;
  /** `operator` is a freeze the owner cannot lift. Null when the card is not frozen that way, or the owner froze it. */
  frozenBy: 'owner' | 'operator' | null;
}

export interface CardShippingAddress {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
}

export type CardChannel = 'card-present' | 'online' | 'contactless' | 'atm' | 'foreign';
export type CardReplaceReason = 'lost' | 'stolen' | 'damaged';

const SECRET_TTL_MS = 60_000;

const PAN_UNSET =
  'No live card issuer can return a card number. The missing piece is socket.live-issuer (a card-scheme sponsor and an issuing BIN). This service will not invent a number, expiry, or security code.';
const PIN_UNSET =
  'No live card issuer can view or set a PIN. The missing piece is socket.live-issuer (a card-scheme sponsor and an issuing BIN). This service will not invent a PIN.';
const WALLET_UNSET =
  'No live card issuer can add this card to a phone wallet. The missing piece is socket.live-issuer (a card-scheme sponsor and an issuing BIN). This service will not invent a provisioning payload.';

/**
 * The rate one authorisation converted at, as it was written down.
 *
 * Read-only forever. Nothing re-rates an authorisation, and `capture()` reads
 * this rather than asking the feed again — see `conversion.ts` for what breaks
 * if it did.
 */
export interface ConversionRecord {
  readonly settlementAssetId: string;
  readonly settlementAmount: Amount;
  readonly fundingAssetId: string;
  readonly fundingAmount: Amount;
  readonly rate: Amount;
  readonly quality: MarkQuality;
  readonly rateAsOf: Date;
}

export interface AuthorizationRecord {
  id: string;
  cardId: string;
  authorizationRef: string;
  /** WHAT MOVES, in the card's FUNDING asset. Not the merchant's number on a converted card. */
  amount: Amount;
  merchantCategory: string | null;
  channel: CardChannel;
  decision: 'approved' | 'declined';
  declineCode: string | null;
  status: 'pending' | 'settled' | 'rejected';
  holdLedgerTxId: string | null;
  decidedAt: Date;
  /** NULL on a same-asset card, where nothing was converted and no rate was consulted. */
  conversion: ConversionRecord | null;
}

/** What a capture did, including the reward it could not pay. */
export interface CaptureResult {
  authorizationId: string;
  /** What LEFT THE BOOK, in the funding asset. On a same-asset card, also what the merchant took. */
  captured: Amount;
  /** The unspent part of the hold, returned in the same pass. Often zero. Funding asset. */
  returned: Amount;
  captureLedgerTxId: string;
  reversalLedgerTxId: string | null;
  cashback: CashbackOutcome;
  /**
   * What the merchant cleared, in their currency, and the frozen rate it
   * converted at. NULL on a same-asset card, where the two are one number.
   */
  settlement: { readonly assetId: string; readonly amount: Amount; readonly rate: Amount } | null;
  /** Spare-change sweep. Capture never rolls back on this. */
  roundUp: RoundUpOutcome;
}

/**
 * Cashback is reported, never assumed.
 *
 * `refused` is a first-class outcome with a code on it. A capture whose reward
 * could not be paid is not a failed capture, and it is not a silent success
 * either — an operator seeing `bank.cashback_pot_unfunded` has learned that the
 * advertised rate is currently unfunded, on the day it became true. Any other
 * ledger error is the same outcome with the row left `pending`, so the same
 * authorisation can be retried.
 */
export type CashbackOutcome =
  | { readonly status: 'none'; readonly amount: Amount }
  | { readonly status: 'paid'; readonly amount: Amount; readonly ledgerTxId: string }
  | { readonly status: 'refused'; readonly amount: Amount; readonly reason: string };

/**
 * Spare-change sweep after capture. Same reporting rule as cashback: the
 * capture stands even when this refuses. `none` means no rule; `skipped` is
 * a named no-op (kill switch, exact multiple).
 */
export type RoundUpOutcome =
  | { readonly status: 'none'; readonly amount: Amount }
  | { readonly status: 'skipped'; readonly amount: Amount; readonly reason: string }
  | { readonly status: 'settled'; readonly amount: Amount; readonly positionId: string }
  /** Into one of the person's own spaces (BK-pots-02): the space and the own-space transfer that moved it. */
  | { readonly status: 'settled'; readonly amount: Amount; readonly spaceId: string; readonly ledgerTxId: string }
  | { readonly status: 'refused'; readonly amount: Amount; readonly reason: string };

export type CaptureSettledHook = (event: {
  userId: string;
  assetId: string;
  authorizationId: string;
  captured: Amount;
}) => Promise<RoundUpOutcome>;

export interface CardServiceOptions {
  /**
   * Absent means NO CARD PROGRAMME, and every procedure refuses by name.
   *
   * Same posture as the loan price source: the dangerous default is the
   * plausible one, so there is no default. See `noCardIssuer`.
   */
  readonly issuer?: CardIssuerAdapter;
  /**
   * Where a JIT conversion rate comes from — and it does not come from here.
   *
   * Absent means `noConversionRates`, which has no rates in it, so a card whose
   * settlement asset differs from its funding asset refuses every authorisation
   * by name. Same posture and the same reason as `issuer` above: this platform
   * has no FX source, and the dangerous default is the plausible one.
   */
  readonly rates?: PriceSource;
  readonly conversionPolicy?: CardConversionPolicy;
  /** Injectable so a test can hold the staleness guards at a fixed instant. */
  readonly clock?: () => Date;
  /**
   * Module kill (`BANK_CARDS_ENABLED` / FLAG_REGISTRY bank.cards). Default true.
   * When false, issue and authorise refuse `bank.cards_disabled`.
   */
  readonly moduleEnabled?: boolean;
  /**
   * After a capture settles (and cashback is attempted), sweep spare change.
   * Absent = no round-up. Must not throw in a way that undoes the capture —
   * CardService catches and reports `refused`.
   */
  readonly onCaptureSettled?: CaptureSettledHook;
}

export class CardService {
  private readonly issuer: CardIssuerAdapter;
  private readonly rates: PriceSource;
  private readonly conversionPolicy: CardConversionPolicy;
  private readonly clock: () => Date;
  private readonly moduleEnabled: boolean;
  private readonly onCaptureSettled: CaptureSettledHook | null;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    options: CardServiceOptions = {},
  ) {
    this.issuer = options.issuer ?? noCardIssuer;
    this.rates = options.rates ?? noConversionRates;
    this.conversionPolicy = options.conversionPolicy ?? DEFAULT_CARD_CONVERSION_POLICY;
    this.clock = options.clock ?? (() => new Date());
    this.moduleEnabled = options.moduleEnabled !== false;
    this.onCaptureSettled = options.onCaptureSettled ?? null;
  }

  private assertModuleEnabled(): void {
    if (!this.moduleEnabled) {
      throw new BankError('Cards module is disabled (BANK_CARDS_ENABLED / bank.cards)', 'bank.cards_disabled');
    }
  }

  /**
   * Live `card-sim` must refuse BEFORE a row or a hold. `tellIssuer` swallows
   * adapter errors after the ledger has already moved, so throwing from
   * `respondToAuthorization` is not enough.
   */
  private assertIssuerMayMutate(): void {
    const code = this.issuer.mutationRefuse;
    if (!code) return;
    throw new BankError('card-sim is not a live issuer — this deployment will not issue or authorise as if a BIN exists', code);
  }

  /** What this deployment's card programme is, and whether it is real. */
  programme(): CardIssuerAdapter['programme'] {
    return cardProgrammeOutput(this.issuer.programme);
  }

  /**
   * Rewards stay refused until a real card issuer is connected.
   * `cashbackBps` is a rate field, not a balance, and this posts nothing.
   */
  /**
   * Cashback already paid, summed from settled reward records in one asset.
   *
   * Refuses until a non-simulated issuer is connected. A rate on the card is
   * not a balance, and card-sim does not pay one. Two assets are not added.
   */
  async rewards(userId: string): Promise<{ balance: Amount; assetId: string }> {
    if (!this.liveSecretProgramme()) {
      throw new BankError(
        'Card rewards are refused. The missing piece is an outside company, the card issuer. A cashback field is not a rewards balance.',
        'bank.rewards_issuer_unset',
      );
    }
    const rows = await this.sql<Array<{ asset_id: string; balance: string }>>`
      SELECT c.asset_id,
             COALESCE(SUM(cb.amount) FILTER (WHERE cb.status = 'settled'), 0)::text AS balance
        FROM bank.cards c
        LEFT JOIN bank.card_authorizations a ON a.card_id = c.id
        LEFT JOIN bank.card_cashback cb ON cb.authorization_id = a.id
       WHERE c.user_id = ${userId}
         AND c.simulated = false
         AND c.issuer = ${this.issuer.programme.id}
       GROUP BY c.asset_id
    `;
    if (rows.length === 0) {
      throw new BankError(
        'Card rewards are refused. The missing piece is an outside company, the card issuer. A cashback field is not a rewards balance.',
        'bank.rewards_issuer_unset',
      );
    }
    if (rows.length > 1) {
      throw new BankError(
        'Cashback for this customer is in more than one asset. This call will not add those figures together.',
        'bank.rewards_asset_ambiguous',
      );
    }
    const row = rows[0]!;
    return { balance: parseAmount(row.balance), assetId: row.asset_id };
  }

  // ── Cards ──────────────────────────────────────────────────────────────────

  /**
   * Issue a card against one of the user's asset balances.
   *
   * The issuer is asked FIRST. A row written before the issuer answered would be
   * a card this service believes in and no issuer has heard of, and on a live
   * rail that is a card a user can see in the app and cannot use anywhere.
   */
  async issue(input: {
    cardId: string;
    userId: string;
    assetId: string;
    /**
     * What merchants charge this card in. Defaults to the funding asset, which
     * is every card that existed before §18 and means no conversion at all.
     *
     * A card may be issued with a settlement asset nothing can currently quote.
     * That is deliberate: asking the feed at issue time would let one transient
     * outage refuse a card, and it would put a rate lookup on a path that moves
     * no money. The refusal belongs on the authorisation, where the rate is
     * actually needed and where `bank.mark_missing` says so by name.
     */
    settlementAssetId?: string;
    cashbackBps?: number;
    perAuthorizationLimit: Amount;
    /** Omitted means virtual. A physical card stores a delivery address and stays simulated on card-sim. */
    cardType?: 'virtual' | 'physical';
    shippingAddress?: CardShippingAddress;
  }): Promise<CardRecord> {
    this.assertModuleEnabled();
    this.assertIssuerMayMutate();
    if (input.perAuthorizationLimit <= 0n) {
      throw new BankError('A card needs a positive per-authorisation limit', 'bank.card_limit_exceeded');
    }

    const cardType = input.cardType ?? 'virtual';
    const shipping = cardType === 'physical' ? requireShippingAddress(input.shippingAddress) : null;
    const settlementAssetId = input.settlementAssetId ?? input.assetId;
    const handle = await this.issuer.issue({ cardId: input.cardId, userId: input.userId, assetId: input.assetId });
    const programme = this.issuer.programme;

    const rows = await this.sql<CardRow[]>`
      INSERT INTO bank.cards (
        id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, cashback_bps, per_authorization_limit,
        card_type, shipping_address
      )
      VALUES (
        ${input.cardId}, ${input.userId}, ${input.assetId}, ${settlementAssetId}, ${programme.id}, ${programme.simulated},
        ${handle.issuerRef}, ${handle.panTail}, ${input.cashbackBps ?? 0},
        ${formatAmount(input.perAuthorizationLimit)}::numeric,
        ${cardType}, ${shipping === null ? null : JSON.stringify(shipping)}::jsonb
      )
      ON CONFLICT (issuer, issuer_ref) DO NOTHING
      RETURNING id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by
    `;

    // A redelivered issue is the same card, not a second one drawing on the same
    // balance. The unique index is what makes that true; this reads it back.
    const existing = rows[0] ?? (await this.cardByIssuerRef(programme.id, handle.issuerRef));
    if (!existing) throw new BankError('Card could not be issued', 'bank.card_not_found');
    const card = toCard(existing);
    if (card.cardType !== cardType) {
      throw new BankError('This card id was already issued as a different card type', 'bank.card_issue_conflict');
    }
    if (cardType === 'physical' && canonicalAddress(card.shippingAddress) !== canonicalAddress(shipping)) {
      throw new BankError('This card id was already issued to a different delivery address', 'bank.card_issue_conflict');
    }
    return card;
  }

  async card(cardId: string): Promise<CardRecord> {
    const rows = await this.sql<CardRow[]>`
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by FROM bank.cards WHERE id = ${cardId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Card ${cardId} not found`, 'bank.card_not_found');
    return toCard(row);
  }

  async cardsOf(userId: string, limit?: number): Promise<CardRecord[]> {
    const page = assertCardsListLimit(limit);
    const rows = await this.sql<CardRow[]>`
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by FROM bank.cards WHERE user_id = ${userId} ORDER BY created_at DESC
       LIMIT ${page}
    `;
    return rows.map(toCard);
  }

  /**
   * Freeze, unfreeze or close a card.
   *
   * The issuer is told, and if it refuses the row is not changed: a card this
   * service thinks is frozen while the issuer still authorises on it is the
   * worst of the available states, because the user has been told they are safe.
   */
  async setStatus(cardId: string, status: CardRecord['status']): Promise<CardRecord> {
    const card = await this.card(cardId);
    if (card.status === 'closed' && status !== 'closed') {
      throw new BankError('A closed card cannot be reopened', 'bank.card_not_active');
    }
    if (card.frozenBy === 'operator' && status === 'active') {
      throw new BankError(
        'An operator froze this card. The owner cannot lift that freeze (bank.card_operator_frozen)',
        'bank.card_operator_frozen',
      );
    }
    if (card.frozenBy === 'operator' && status === 'frozen') return card;

    await this.issuer.setStatus({ cardId: card.id, issuerRef: card.issuerRef, status });
    const frozenBy = status === 'frozen' ? 'owner' : null;
    await this.sql`UPDATE bank.cards SET status = ${status}, frozen_by = ${frozenBy}, updated_at = now() WHERE id = ${cardId}`;
    return this.card(cardId);
  }

  /**
   * Operator freeze or unfreeze. The client id is the idempotency key.
   * The approval is consumed only on the first new command, and only after a
   * replay of the same terms has been ruled out, so a lost reply does not
   * spend a second approval. A refused approval changes nothing.
   */
  async setOperatorStatus(input: {
    cardId: string;
    status: 'frozen' | 'active';
    reason: string;
    clientRequestId: string;
    consume: () => Promise<void>;
  }): Promise<{ cardId: string; status: 'frozen' | 'active'; frozenBy: 'operator' | null }> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new BankError(
        'An operator card change needs a reason of at least 10 characters (bank.ops_reason_too_short)',
        'bank.ops_reason_too_short',
      );
    }
    const prior = await this.operatorCommand(this.sql, input.clientRequestId);
    if (prior) return this.replayOperatorCommand(prior, input.cardId, input.status, reason);

    await input.consume();

    return transaction(this.sql, async (tx) => {
      const raced = await this.operatorCommand(tx, input.clientRequestId);
      if (raced) return this.replayOperatorCommand(raced, input.cardId, input.status, reason);

      const rows = await tx<CardRow[]>`
        SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by
          FROM bank.cards WHERE id = ${input.cardId}
         FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new BankError(`Card ${input.cardId} not found`, 'bank.card_not_found');
      const card = toCard(row);
      if (card.status === 'closed') throw new BankError('A closed card cannot be reopened', 'bank.card_not_active');

      await this.issuer.setStatus({ cardId: card.id, issuerRef: card.issuerRef, status: input.status });
      const frozenBy = input.status === 'frozen' ? 'operator' : null;
      await tx`UPDATE bank.cards SET status = ${input.status}, frozen_by = ${frozenBy}, updated_at = now() WHERE id = ${card.id}`;
      await tx`
        INSERT INTO bank.card_operator_commands (client_request_id, card_id, target_status, reason, result_status, frozen_by)
        VALUES (${input.clientRequestId}, ${card.id}, ${input.status}, ${reason}, ${input.status}, ${frozenBy})
      `;
      return { cardId: card.id, status: input.status, frozenBy };
    });
  }

  async countProgramme(): Promise<{ issued: number; active: number; frozen: number }> {
    const rows = await this.sql<Array<{ issued: number; active: number; frozen: number }>>`
      SELECT count(*)::int AS issued,
             count(*) FILTER (WHERE status = 'active')::int AS active,
             count(*) FILTER (WHERE status = 'frozen')::int AS frozen
        FROM bank.cards
    `;
    const row = rows[0];
    return { issued: Number(row?.issued ?? 0), active: Number(row?.active ?? 0), frozen: Number(row?.frozen ?? 0) };
  }

  async authorisationDays(
    from: Date,
    to: Date,
  ): Promise<Array<{ day: string; assetId: string; decision: 'approved' | 'declined'; amount: Amount; count: number }>> {
    const rows = await this.sql<Array<{ day: string; asset_id: string; decision: 'approved' | 'declined'; amount: string; count: number }>>`
      SELECT to_char(a.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             c.asset_id,
             a.decision::text AS decision,
             COALESCE(SUM(a.amount), 0)::text AS amount,
             count(*)::int AS count
        FROM bank.card_authorizations a
        JOIN bank.cards c ON c.id = a.card_id
       WHERE a.decided_at >= ${from} AND a.decided_at < ${to}
       GROUP BY 1, 2, 3
    `;
    return rows.map((row) => ({
      day: row.day,
      assetId: row.asset_id,
      decision: row.decision,
      amount: parseAmount(row.amount),
      count: Number(row.count),
    }));
  }

  /**
   * Change the spending ceilings. `commandId` is the idempotency key.
   * Omitted optional limits stay as they are. Null clears that ceiling.
   */
  async setLimits(input: {
    cardId: string;
    userId: string;
    commandId: string;
    perAuthorizationLimit: Amount;
    dailyLimit?: Amount | null;
    monthlyLimit?: Amount | null;
    cashLimit?: Amount | null;
  }): Promise<CardRecord> {
    this.assertModuleEnabled();
    if (input.perAuthorizationLimit <= 0n) {
      throw new BankError('A card needs a positive per-authorisation limit', 'bank.card_limit_exceeded');
    }
    for (const value of [input.dailyLimit, input.monthlyLimit, input.cashLimit]) {
      if (value != null && value <= 0n) {
        throw new BankError('A card limit must be a positive amount', 'bank.card_limit_exceeded');
      }
    }
    const card = await this.ownedCard(input.cardId, input.userId);
    const hash = commandHash({
      perAuthorizationLimit: formatAmount(input.perAuthorizationLimit),
      dailyLimit: limitToken(input.dailyLimit),
      monthlyLimit: limitToken(input.monthlyLimit),
      cashLimit: limitToken(input.cashLimit),
    });
    await transaction(this.sql, async (tx) => {
      const claim = await this.claimCommand(tx, card.id, input.commandId, 'set_limits', hash);
      if (claim === 'replay') return;
      const daily = input.dailyLimit === undefined ? card.dailyLimit : input.dailyLimit;
      const monthly = input.monthlyLimit === undefined ? card.monthlyLimit : input.monthlyLimit;
      const cash = input.cashLimit === undefined ? card.cashLimit : input.cashLimit;
      await tx`
        UPDATE bank.cards
           SET per_authorization_limit = ${formatAmount(input.perAuthorizationLimit)}::numeric,
               daily_limit = ${daily === null ? null : formatAmount(daily)}::numeric,
               monthly_limit = ${monthly === null ? null : formatAmount(monthly)}::numeric,
               cash_limit = ${cash === null ? null : formatAmount(cash)}::numeric,
               updated_at = now()
         WHERE id = ${card.id}
      `;
    });
    return this.card(card.id);
  }

  /** Flip the four channel switches. `commandId` is the idempotency key. */
  async setChannels(input: {
    cardId: string;
    userId: string;
    commandId: string;
    online: boolean;
    contactless: boolean;
    atm: boolean;
    abroad: boolean;
  }): Promise<CardRecord> {
    this.assertModuleEnabled();
    const card = await this.ownedCard(input.cardId, input.userId);
    const hash = commandHash({
      online: input.online ? '1' : '0',
      contactless: input.contactless ? '1' : '0',
      atm: input.atm ? '1' : '0',
      abroad: input.abroad ? '1' : '0',
    });
    await transaction(this.sql, async (tx) => {
      const claim = await this.claimCommand(tx, card.id, input.commandId, 'set_channels', hash);
      if (claim === 'replay') return;
      await tx`
        UPDATE bank.cards
           SET channel_online = ${input.online},
               channel_contactless = ${input.contactless},
               channel_atm = ${input.atm},
               channel_abroad = ${input.abroad},
               updated_at = now()
         WHERE id = ${card.id}
      `;
    });
    return this.card(card.id);
  }

  /**
   * Refuse a card-number or PIN call when this deployment has no live issuer
   * method. card-sim and `none` stay `bank.card_pan_issuer_unset` /
   * `bank.card_pin_issuer_unset`, and the router runs this before step-up.
   */
  assertSecretIssuer(kind: 'pan' | 'pin', op: 'revealCredentials' | 'revealPin' | 'setPin'): void {
    this.assertModuleEnabled();
    this.assertLiveSecret(kind);
    const present =
      op === 'revealCredentials' ? this.issuer.revealCredentials : op === 'revealPin' ? this.issuer.revealPin : this.issuer.setPin;
    if (present) return;
    if (kind === 'pan') throw new BankError(PAN_UNSET, 'bank.card_pan_issuer_unset');
    throw new BankError(PIN_UNSET, 'bank.card_pin_issuer_unset');
  }

  /** A PIN that is not 4–12 digits. The message does not echo the PIN. */
  assertPinDigits(pin: string): void {
    if (!/^\d{4,12}$/.test(pin)) {
      throw new BankError('A PIN must be 4 to 12 digits', 'bank.card_pin_invalid');
    }
  }

  /**
   * PAN, expiry and CVV from a live issuer. Not stored. The audit row names the
   * reveal and not the secret. `expiresAt` is when the caller should drop it.
   */
  async reveal(input: { cardId: string; userId: string; revealId: string }): Promise<{
    pan: string;
    expiry: string;
    cvv: string;
    expiresAt: string;
  }> {
    this.assertModuleEnabled();
    const card = await this.ownedCard(input.cardId, input.userId);
    this.assertLiveSecret('pan');
    if (!this.issuer.revealCredentials) throw new BankError(PAN_UNSET, 'bank.card_pan_issuer_unset');
    const revealed = await this.issuer.revealCredentials({ cardId: card.id, issuerRef: card.issuerRef });
    await this.auditSecret({
      id: input.revealId,
      cardId: card.id,
      userId: input.userId,
      kind: 'pan_reveal',
      payloadHash: commandHash({ cardId: card.id, kind: 'pan_reveal' }),
    });
    return { pan: revealed.pan, expiry: revealed.expiry, cvv: revealed.cvv, expiresAt: this.secretExpiresAt() };
  }

  async revealPin(input: { cardId: string; userId: string; revealId: string }): Promise<{ pin: string; expiresAt: string }> {
    this.assertModuleEnabled();
    const card = await this.ownedCard(input.cardId, input.userId);
    this.assertLiveSecret('pin');
    if (!this.issuer.revealPin) throw new BankError(PIN_UNSET, 'bank.card_pin_issuer_unset');
    const revealed = await this.issuer.revealPin({ cardId: card.id, issuerRef: card.issuerRef });
    await this.auditSecret({
      id: input.revealId,
      cardId: card.id,
      userId: input.userId,
      kind: 'pin_reveal',
      payloadHash: commandHash({ cardId: card.id, kind: 'pin_reveal' }),
    });
    return { pin: revealed.pin, expiresAt: this.secretExpiresAt() };
  }

  /** The PIN is sent to the issuer and is not written, hashed, or put in an error. */
  async setPin(input: { cardId: string; userId: string; commandId: string; pin: string }): Promise<{ ok: true }> {
    this.assertModuleEnabled();
    this.assertPinDigits(input.pin);
    const card = await this.ownedCard(input.cardId, input.userId);
    this.assertLiveSecret('pin');
    if (!this.issuer.setPin) throw new BankError(PIN_UNSET, 'bank.card_pin_issuer_unset');
    const payloadHash = commandHash({ cardId: card.id, kind: 'pin_set' });
    if (!(await this.secretAlreadyAudited(input.commandId, card.id, 'pin_set', payloadHash))) {
      await this.issuer.setPin({ cardId: card.id, issuerRef: card.issuerRef, pin: input.pin });
      await this.auditSecret({
        id: input.commandId,
        cardId: card.id,
        userId: input.userId,
        kind: 'pin_set',
        payloadHash,
      });
    }
    return { ok: true };
  }

  /**
   * Opaque wallet payload from a live issuer. The payload is not stored.
   * `provisionId` is the idempotency key; a different nonce under the same id conflicts.
   */
  async walletProvision(input: {
    cardId: string;
    userId: string;
    provisionId: string;
    wallet: 'apple' | 'google';
    nonce: string;
  }): Promise<{ payload: string; expiresAt: string }> {
    this.assertModuleEnabled();
    const card = await this.ownedCard(input.cardId, input.userId);
    this.assertLiveSecret('wallet');
    if (!this.issuer.provisionWallet) throw new BankError(WALLET_UNSET, 'bank.card_wallet_issuer_unset');
    const payloadHash = commandHash({ wallet: input.wallet, nonce: input.nonce });
    const provisioned = await this.issuer.provisionWallet({
      cardId: card.id,
      issuerRef: card.issuerRef,
      wallet: input.wallet,
      nonce: input.nonce,
    });
    await this.auditSecret({
      id: input.provisionId,
      cardId: card.id,
      userId: input.userId,
      kind: 'wallet_provision',
      payloadHash,
    });
    return { payload: provisioned.payload, expiresAt: this.secretExpiresAt() };
  }

  /**
   * Close `cardId` and issue `replacementId` with the same asset, ceilings and channels.
   * A retry of the same replacement id returns that card. A different id or reason conflicts.
   */
  async replace(input: { cardId: string; userId: string; replacementId: string; reason: CardReplaceReason }): Promise<CardRecord> {
    this.assertModuleEnabled();
    this.assertIssuerMayMutate();
    const card = await this.ownedCard(input.cardId, input.userId);
    if (card.replacedByCardId) {
      if (card.replacedByCardId !== input.replacementId || card.replaceReason !== input.reason) {
        throw new BankError('This card was already replaced on different terms', 'bank.card_replace_conflict');
      }
      return this.ownedCard(card.replacedByCardId, input.userId);
    }
    if (card.status === 'closed') {
      throw new BankError('A closed card cannot be replaced', 'bank.card_not_active');
    }

    const existing = await this.cardOrNull(input.replacementId);
    if (existing) {
      if (existing.replacesCardId !== card.id || existing.userId !== input.userId) {
        throw new BankError('This replacement id already belongs to another card', 'bank.card_replace_conflict');
      }
      await this.closeReplaced(card, existing.id, input.reason);
      return this.card(existing.id);
    }

    const handle = await this.issuer.issue({ cardId: input.replacementId, userId: input.userId, assetId: card.assetId });
    const programme = this.issuer.programme;
    await this.sql`
      INSERT INTO bank.cards (
        id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, cashback_bps, per_authorization_limit,
        daily_limit, monthly_limit, cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad,
        card_type, shipping_address, replaces_card_id
      )
      VALUES (
        ${input.replacementId}, ${card.userId}, ${card.assetId}, ${card.settlementAssetId}, ${programme.id}, ${programme.simulated},
        ${handle.issuerRef}, ${handle.panTail}, ${card.cashbackBps},
        ${formatAmount(card.perAuthorizationLimit)}::numeric,
        ${card.dailyLimit === null ? null : formatAmount(card.dailyLimit)}::numeric,
        ${card.monthlyLimit === null ? null : formatAmount(card.monthlyLimit)}::numeric,
        ${card.cashLimit === null ? null : formatAmount(card.cashLimit)}::numeric,
        ${card.online}, ${card.contactless}, ${card.atm}, ${card.abroad},
        ${card.cardType}, ${card.shippingAddress === null ? null : JSON.stringify(card.shippingAddress)}::jsonb,
        ${card.id}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    const created = await this.card(input.replacementId);
    if (created.replacesCardId !== card.id) {
      throw new BankError('This replacement id already belongs to another card', 'bank.card_replace_conflict');
    }
    await this.closeReplaced(card, created.id, input.reason);
    return this.card(created.id);
  }

  // ── The authorisation webhook ──────────────────────────────────────────────

  /**
   * AN AUTHORISATION ARRIVED. Decide, and hold if the answer is yes.
   *
   * The order is: recorded decision first (a redelivery must not decide twice),
   * then the ledger, then the issuer. The ledger is the AUTHORITY on whether the
   * money is there — the balance read below is a fast path that lets a shortfall
   * be recorded as a decline instead of thrown as an exception, and if the two
   * ever disagree the post is the one that decides, because between the read and
   * the post the user may have spent the money somewhere else.
   */
  async authorize(input: {
    cardId: string;
    authorizationRef: string;
    /** THE MERCHANT'S NUMBER, in the card's SETTLEMENT asset. */
    amount: Amount;
    merchantCategory?: string;
    /** Omitted means card-present (chip or swipe at home), which the four switches do not gate. */
    channel?: CardChannel;
  }): Promise<AuthorizationRecord> {
    this.assertModuleEnabled();
    this.assertIssuerMayMutate();
    const card = await this.card(input.cardId);

    // Idempotency, before anything else. An issuer redelivering an
    // authorisation must receive the decision it already got, and must not cause
    // a second hold against the same purchase — nor a second QUOTE, which is why
    // a finished row returns before the rate source is touched.
    //
    // An approved row still pending with no hold is not that decision. The
    // process died after the insert and before hold_ledger_tx_id was written.
    // Returning it leaves a hold capture and reverse both refuse, because they
    // require status settled. Re-drive the stored amount. Do not quote again.
    const already = await this.authorizationByRef(card.id, input.authorizationRef);
    if (already) {
      const strandedHold = already.decision === 'approved' && already.status === 'pending' && already.holdLedgerTxId === null;
      if (!strandedHold) return already;
      return this.redriveHold(card, already);
    }

    return withMoneySpan(
      'bank.card.authorize',
      { operation: 'card-authorize', cardId: card.id, amount: formatAmount(input.amount), assetId: card.settlementAssetId },
      async (span) => {
        // JIT CONVERSION (§18), and it happens BEFORE the decision because the
        // decision is denominated in funding units: the limit is a ceiling on
        // what may leave the user's balance and the balance check is a read of
        // that balance. A rate that cannot be got throws — nothing is written,
        // nothing moves, and no decision is recorded, because nobody made one.
        const quote = await this.quote(card, input.amount);
        const fundingAmount = quote ? quote.fundingAmount : input.amount;
        const channel = input.channel ?? 'card-present';
        span.setAttribute('intafaced.card_funding_amount', formatAmount(fundingAmount));
        span.setAttribute('intafaced.card_channel', channel);

        const declineCode = await this.declineReason(card, fundingAmount, channel);

        if (declineCode) {
          span.setAttribute('intafaced.card_decision', 'declined');
          const declined = await this.recordDecision({
            card,
            input: { ...input, channel },
            fundingAmount,
            quote,
            decision: 'declined',
            declineCode,
          });
          await this.tellIssuer(card, declined, { decision: 'declined', reason: declineCode });
          return declined;
        }

        const claimed = await this.recordDecision({
          card,
          input: { ...input, channel },
          fundingAmount,
          quote,
          decision: 'approved',
          declineCode: null,
        });
        const finished = await this.commitHold(card, claimed, input.amount);
        if (finished.decision === 'declined') return finished;

        span.setAttribute('intafaced.card_decision', 'approved');
        return finished;
      },
    );
  }

  /**
   * The hold for an approved row that never received one.
   *
   * No quote. The amount and the withdrawal id are the ones already stored.
   * A second post of `withdraw.hold:<authorisation uuid>` finds the original
   * transaction or makes it once.
   */
  private async redriveHold(card: CardRecord, already: AuthorizationRecord): Promise<AuthorizationRecord> {
    const merchantAmount = already.conversion ? already.conversion.settlementAmount : already.amount;
    return withMoneySpan(
      'bank.card.authorize',
      {
        operation: 'card-authorize',
        cardId: card.id,
        amount: formatAmount(merchantAmount),
        assetId: card.settlementAssetId,
      },
      async (span) => {
        span.setAttribute('intafaced.card_funding_amount', formatAmount(already.amount));
        const finished = await this.commitHold(card, already, merchantAmount);
        span.setAttribute('intafaced.card_decision', finished.decision);
        return finished;
      },
    );
  }

  /**
   * Post the hold for a claimed authorisation, then write the row.
   *
   * THE CLAIMED ROW'S AMOUNT, not this call's quote. A second delivery that
   * lost the decision insert has its own quote in hand and must not hold
   * against it — the frozen rate is the one that won, and `claimed.amount` is
   * what it converted to. The withdrawal id is OUR uuid, not the issuer's
   * reference: the hold account is keyed on it, and an id chosen by a
   * counterparty must not name an account in our book. The rail label is the
   * programme id, so the boundary account a capture lands in is greppable back
   * to the card that made it.
   */
  private async commitHold(card: CardRecord, claimed: AuthorizationRecord, merchantAmount: Amount): Promise<AuthorizationRecord> {
    try {
      const posted = await this.ledger.post(
        recipes.withdrawHold({
          userId: card.userId,
          assetId: card.assetId,
          amount: claimed.amount,
          rail: card.issuer,
          withdrawalId: claimed.id,
        }),
      );

      await this.sql`
        UPDATE bank.card_authorizations
           SET status = 'settled', hold_ledger_tx_id = ${posted.id}, settled_at = now()
         WHERE id = ${claimed.id}
      `;
    } catch (err) {
      // The ledger is the authority and it just said no. The DECISION
      // becomes a decline — a purchase the user was told about at the till —
      // rather than an exception that leaves an `approved` row with no hold.
      if (err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds')) {
        await this.sql`
          UPDATE bank.card_authorizations
             SET decision = 'declined', decline_code = 'ledger.insufficient_funds', status = 'rejected'
           WHERE id = ${claimed.id}
        `;
        const declined = (await this.authorizationByRef(card.id, claimed.authorizationRef))!;
        await this.tellIssuer(card, declined, { decision: 'declined', reason: 'ledger.insufficient_funds' });
        return declined;
      }
      // Anything else — svc-ledger unreachable, a frozen module — must NOT
      // be turned into a decline. A decline is an answer, and answering
      // "no" on behalf of a ledger that never spoke is a lie the user pays
      // for at the till. The row stays `pending` and a redelivery re-drives.
      throw err;
    }

    const approved = (await this.authorizationByRef(card.id, claimed.authorizationRef))!;
    await this.tellIssuer(card, approved, { decision: 'approved', amount: merchantAmount });
    return approved;
  }

  /**
   * Named declines only. No score and no invented fee.
   *
   * Period ceilings sum approved authorisation records in the UTC day or month.
   * They are not a column that counts down. ATM cash uses the cash ceiling on
   * top of the daily and monthly ones. Card-present (chip or swipe at home) is
   * not one of the four switches.
   */
  private async declineReason(card: CardRecord, fundingAmount: Amount, channel: CardChannel): Promise<string | null> {
    if (card.status !== 'active') return 'bank.card_not_active';
    // THE CEILING IS IN THE FUNDING ASSET, and it is checked against the
    // CONVERTED amount. A limit denominated in the asset the card draws on is a
    // limit on what may leave the user's balance, which is the thing a ceiling
    // protects; a settlement-denominated limit is a spending-tier concept and
    // belongs with tiering, which is not built here.
    if (fundingAmount > card.perAuthorizationLimit) return 'bank.card_limit_exceeded';
    if (!channelOpen(card, channel)) return 'bank.card_channel_off';

    const now = this.clock();
    if (card.dailyLimit !== null) {
      const spent = await this.approvedSpend(card.id, startOfUtc(now, 'day'));
      if (spent + fundingAmount > card.dailyLimit) return 'bank.card_daily_limit_exceeded';
    }
    if (card.monthlyLimit !== null) {
      const spent = await this.approvedSpend(card.id, startOfUtc(now, 'month'));
      if (spent + fundingAmount > card.monthlyLimit) return 'bank.card_monthly_limit_exceeded';
    }
    if (channel === 'atm' && card.cashLimit !== null) {
      const spent = await this.approvedSpend(card.id, startOfUtc(now, 'day'), 'atm');
      if (spent + fundingAmount > card.cashLimit) return 'bank.card_cash_limit_exceeded';
    }

    const balance = (await this.ledger.balance(userAvailable(card.userId, card.assetId))).amount;
    if (balance < fundingAmount) return 'ledger.insufficient_funds';
    return null;
  }

  // ── The rate ───────────────────────────────────────────────────────────────

  /**
   * Quote this spend, or return null because there is nothing to quote.
   *
   * A same-asset card short-circuits BEFORE the rate source is touched. That is
   * not an optimisation — it is what keeps every card that existed before §18
   * working in a deployment that has no rate adapter, which is every deployment.
   */
  private async quote(card: CardRecord, settlementAmount: Amount): Promise<ConversionQuote | null> {
    if (card.settlementAssetId === card.assetId) return null;

    return quoteConversion({
      rates: this.rates,
      fundingAssetId: card.assetId,
      settlementAssetId: card.settlementAssetId,
      settlementAmount,
      previous: await this.lastAcceptedRate(card.id),
      now: this.clock(),
      policy: this.conversionPolicy,
    });
  }

  /**
   * The last rate this card converted at — what arms the deviation breaker.
   *
   * DECLINED authorisations count. Their rate passed the same gate; the decline
   * was about the user's balance or the card's ceiling, not about the number. A
   * breaker that only looked at approvals could be walked past by printing a
   * rate through a series of spends too large to approve.
   *
   * `conversion.ts` decides whether the answer is recent enough to compare
   * against, and treats an old one as no previous rate at all rather than
   * refusing a genuine market at a till.
   */
  private async lastAcceptedRate(cardId: string): Promise<{ rate: Amount; acceptedAt: Date } | null> {
    const rows = await this.sql<Array<{ rate: string; rate_as_of: Date }>>`
      SELECT c.rate::text AS rate, c.rate_as_of
        FROM bank.card_conversions c
        JOIN bank.card_authorizations a ON a.id = c.authorization_id
       WHERE a.card_id = ${cardId}
       ORDER BY c.created_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    return row ? { rate: parseAmount(row.rate), acceptedAt: row.rate_as_of } : null;
  }

  /**
   * Tell the issuer, and never let the telling undo the decision.
   *
   * The decision is already true — it is a row, and on an approval the funds are
   * already held. If the issuer cannot be reached, the network will treat the
   * silence as a decline at the till and the hold is released by `reverse()`
   * when the authorisation expires. Throwing here would instead unwind a
   * transaction the ledger has already committed.
   */
  private async tellIssuer(
    card: CardRecord,
    authorization: AuthorizationRecord,
    outcome: Parameters<CardIssuerAdapter['respondToAuthorization']>[0]['outcome'],
  ): Promise<void> {
    try {
      await this.issuer.respondToAuthorization({
        cardId: card.id,
        issuerRef: card.issuerRef,
        authorizationRef: authorization.authorizationRef,
        outcome,
      });
    } catch {
      // Deliberately swallowed HERE and nowhere else in this file. The
      // authorisation row is the durable record of what we decided; delivery is
      // a separate fact, and the loans module keeps the same distinction between
      // a margin call raised and a margin call notified.
    }
  }

  // ── Capture and reversal ───────────────────────────────────────────────────

  /**
   * The merchant took `amount`. The rest of the hold goes back to the user.
   *
   * Two postings, in this order, both idempotent on the authorisation:
   *
   *   1. `withdrawSettle` for the captured amount — value leaves the book at
   *      `rail/<issuer>/<asset>`.
   *   2. `withdrawReverse` for the remainder, when there is one — value returns
   *      to the user's available balance.
   *
   * After both, the authorisation's hold account reads zero. That is the
   * invariant worth checking, and the test checks it on the ACCOUNT rather than
   * by adding up these two rows.
   */
  async capture(input: { cardId: string; authorizationRef: string; amount: Amount }): Promise<CaptureResult> {
    const card = await this.card(input.cardId);
    const authorization = await this.requireOpenAuthorization(card, input.authorizationRef, 'capture');
    const conversion = authorization.conversion;

    // The ceiling is checked in the MERCHANT'S currency, because the merchant's
    // number is what a caller passes and what a clearing file contains.
    const authorized = conversion ? conversion.settlementAmount : authorization.amount;
    if (input.amount <= 0n || input.amount > authorized) {
      throw new BankError(
        `Capture of ${formatAmount(input.amount)} exceeds the authorised ${formatAmount(authorized)}`,
        'bank.card_capture_exceeds_authorization',
      );
    }

    // THE FROZEN RATE, RE-READ — never re-quoted. `conversion.ts` sets out what
    // a second quote here would do to the hold. `fundingFor` is monotonic in the
    // settlement amount, so this can never exceed what was held and equals it
    // exactly on a full capture, which is what lets the hold account reach zero.
    const capturedFunding = conversion ? fundingFor(input.amount, conversion.rate) : input.amount;
    if (capturedFunding > authorization.amount) {
      // Unreachable by the monotonicity above, and asserted rather than assumed:
      // if it ever fires, the alternative is a capture that overdraws a hold
      // account, which the ledger would refuse anyway but only after the row
      // claiming it was written.
      throw new BankError(
        `Capture converts to ${formatAmount(capturedFunding)} against a hold of ${formatAmount(authorization.amount)}`,
        'bank.card_capture_exceeds_authorization',
      );
    }

    return withMoneySpan(
      'bank.card.capture',
      { operation: 'card-capture', cardId: card.id, amount: formatAmount(capturedFunding), assetId: card.assetId },
      async () => {
        const captureTxId = await this.settlement({
          authorization,
          sequence: 0,
          kind: 'capture',
          amount: capturedFunding,
          post: () =>
            this.ledger.post(
              recipes.withdrawSettle({
                userId: card.userId,
                assetId: card.assetId,
                amount: capturedFunding,
                rail: card.issuer,
                withdrawalId: authorization.id,
              }),
            ),
        });

        const remainder = authorization.amount - capturedFunding;
        const reversalTxId =
          remainder > 0n
            ? await this.settlement({
                authorization,
                sequence: 1,
                kind: 'reversal',
                amount: remainder,
                post: () =>
                  this.ledger.post(
                    recipes.withdrawReverse({
                      userId: card.userId,
                      assetId: card.assetId,
                      amount: remainder,
                      rail: card.issuer,
                      withdrawalId: authorization.id,
                    }),
                  ),
              })
            : null;

        // Cashback is a share of what actually left the book, in the asset the
        // rewards pot is funded in — the funding asset. Rating the merchant's
        // settlement number instead would pay a reward denominated in a currency
        // this platform holds no pot for.
        const cashback = await this.payCashback(card, authorization, capturedFunding);
        const roundUp = await this.applyRoundUp(card, authorization, capturedFunding);

        return {
          authorizationId: authorization.id,
          captured: capturedFunding,
          returned: remainder,
          captureLedgerTxId: captureTxId,
          reversalLedgerTxId: reversalTxId,
          cashback,
          roundUp,
          settlement: conversion ? { assetId: conversion.settlementAssetId, amount: input.amount, rate: conversion.rate } : null,
        };
      },
    );
  }

  /**
   * The authorisation expired or was voided. Give the whole hold back.
   *
   * Sequence 0, the same slot a capture would have taken, so the unique index
   * makes "captured then reversed" impossible rather than merely unlikely.
   */
  async reverse(input: { cardId: string; authorizationRef: string }): Promise<{ returned: Amount; ledgerTxId: string }> {
    const card = await this.card(input.cardId);
    const authorization = await this.requireOpenAuthorization(card, input.authorizationRef, 'reversal');

    return withMoneySpan(
      'bank.card.reverse',
      { operation: 'card-reverse', cardId: card.id, amount: formatAmount(authorization.amount), assetId: card.assetId },
      async () => {
        const ledgerTxId = await this.settlement({
          authorization,
          sequence: 0,
          kind: 'reversal',
          amount: authorization.amount,
          post: () =>
            this.ledger.post(
              recipes.withdrawReverse({
                userId: card.userId,
                assetId: card.assetId,
                amount: authorization.amount,
                rail: card.issuer,
                withdrawalId: authorization.id,
              }),
            ),
        });
        return { returned: authorization.amount, ledgerTxId };
      },
    );
  }

  /** What is still held against an authorisation — read from the ledger, never stored. */
  async heldFor(authorizationId: string, userId: string, assetId: string): Promise<Amount> {
    return (await this.ledger.balance(withdrawalHoldAccount(userId, assetId, authorizationId))).amount;
  }

  /**
   * OPERATOR SURFACE: re-drive the posts of settlements that were claimed and
   * never reached the ledger, and report what is still held.
   *
   * The other half of the crash story, and the card equivalent of
   * `resumePendingLoans` — which exists for exactly this reason on the loan side.
   * Three shapes of stuck money end up here, and none is reachable by calling
   * `capture` again:
   *
   *   · A capture whose post failed. Sequence 0 is `rejected` or `pending`, and
   *     the user's ENTIRE hold is still in the authorisation's hold account.
   *   · A partial capture whose REVERSAL post failed. Sequence 0 is settled — so
   *     the authorisation is correctly closed to new decisions — and the user's
   *     unspent remainder is stuck in that account with nothing left to move it.
   *   · A cashback row still `pending` after a ledger error that was not an empty
   *     pot. The capture has already settled, so `capture` again is refused. The
   *     row is re-driven for the amount it was claimed with, on the same reward
   *     id. A `settled` row is not paid again. A `rejected` row — the pot was
   *     empty — is not retried.
   *
   * Safe to run at any time and any number of times, for the same reason
   * `resumePending` is: every post is idempotent on the authorisation, and each
   * row is re-driven for THE AMOUNT IT WAS CLAIMED WITH. No amount is passed in
   * here, because a recovery that can restate what moved is not a recovery.
   *
   * Failures are collected rather than thrown, so one unpostable row does not
   * hide the rows behind it — the same reasoning as `runRiskSweep.refused`.
   */
  async resumeSettlements(input: { cardId: string; authorizationRef: string }): Promise<{
    authorizationId: string;
    resumed: Array<{
      sequence: number;
      kind: 'capture' | 'reversal';
      amount: Amount;
      outcome: 'settled' | 'failed';
      ledgerTxId?: string;
      reason?: string;
    }>;
    held: Amount;
  }> {
    const card = await this.card(input.cardId);
    const authorization = await this.requireApprovedAuthorization(card, input.authorizationRef);

    const rows = await this.sql<Array<{ sequence: number; kind: 'capture' | 'reversal'; amount: string }>>`
      SELECT sequence, kind, amount::text AS amount FROM bank.card_settlements
       WHERE authorization_id = ${authorization.id} AND status <> 'settled'
       ORDER BY sequence ASC
    `;

    const resumed: Array<{
      sequence: number;
      kind: 'capture' | 'reversal';
      amount: Amount;
      outcome: 'settled' | 'failed';
      ledgerTxId?: string;
      reason?: string;
    }> = [];

    for (const row of rows) {
      const amount = parseAmount(row.amount);
      try {
        const ledgerTxId = await this.settlement({
          authorization,
          sequence: row.sequence,
          kind: row.kind,
          amount,
          post: () =>
            this.ledger.post(
              row.kind === 'capture'
                ? recipes.withdrawSettle({
                    userId: card.userId,
                    assetId: card.assetId,
                    amount,
                    rail: card.issuer,
                    withdrawalId: authorization.id,
                  })
                : recipes.withdrawReverse({
                    userId: card.userId,
                    assetId: card.assetId,
                    amount,
                    rail: card.issuer,
                    withdrawalId: authorization.id,
                  }),
            ),
        });
        resumed.push({ sequence: row.sequence, kind: row.kind, amount, outcome: 'settled', ledgerTxId });
      } catch (err) {
        resumed.push({
          sequence: row.sequence,
          kind: row.kind,
          amount,
          outcome: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Pending cashback only. A settled reward is already paid. A rejected one
    // is the empty pot, and paying it here would undo that named refusal.
    // This does not insert a capture: the settlement loop above only re-drives
    // rows that already exist.
    await this.retryPendingCashback(card, authorization.id);

    return {
      authorizationId: authorization.id,
      resumed,
      held: await this.heldFor(authorization.id, card.userId, card.assetId),
    };
  }

  /**
   * Spare-change sweep after the capture (and cashback) have settled.
   *
   * Never throws out to `capture()`: a failed round-up must not look like a
   * failed purchase. Same posture as `payCashback`.
   */
  private async applyRoundUp(card: CardRecord, authorization: AuthorizationRecord, captured: Amount): Promise<RoundUpOutcome> {
    if (!this.onCaptureSettled) return { status: 'none', amount: 0n };
    try {
      return await this.onCaptureSettled({
        userId: card.userId,
        assetId: card.assetId,
        authorizationId: authorization.id,
        captured,
      });
    } catch (err) {
      return {
        status: 'refused',
        amount: 0n,
        reason: err instanceof BankError ? err.code : 'bank.auto_invest_run_failed',
      };
    }
  }

  // ── Cashback ───────────────────────────────────────────────────────────────

  /**
   * Pay the reward, or refuse it by name and leave the capture standing.
   *
   * The pot is `rewardsEngine(assetId)`, the same one real-yield is paid from,
   * and it is funded from bank revenue by `fundCashbackPot`. That is what makes
   * cashback a share of money the platform actually earned rather than a number
   * conjured for a marketing page — and it is also why it can refuse.
   */
  /**
   * A real issuer is an outside company. card-sim and an unconfigured programme
   * are not one. A simulated card must not pay rewards.
   */
  private rewardsIssuerConnected(card: CardRecord): boolean {
    const programme = this.issuer.programme;
    if (programme.simulated || card.simulated) return false;
    if (programme.id === 'none' || programme.id === 'card-sim') return false;
    if (card.issuer === 'none' || card.issuer === 'card-sim') return false;
    return card.issuer === programme.id;
  }

  private async payCashback(card: CardRecord, authorization: AuthorizationRecord, captured: Amount): Promise<CashbackOutcome> {
    const amount = cashbackOn(captured, card.cashbackBps);
    // Zero is not a refusal and not a payment. A card with no cashback rate, or
    // a purchase too small to earn one atomic unit at that rate, earns nothing —
    // and posting a zero-value transaction to say so would be noise in the book.
    if (amount <= 0n) return { status: 'none', amount: 0n };

    // No issuer is connected. Do not call rewardPay and do not write a cashback
    // row — that row would be a rewards balance. The capture already stands.
    if (!this.rewardsIssuerConnected(card)) {
      return { status: 'refused', amount, reason: 'bank.rewards_issuer_unset' };
    }

    const claimed = await this.sql<
      Array<{ id: string; status: string; ledger_tx_id: string | null; amount: string; rejection_code: string | null }>
    >`
      INSERT INTO bank.card_cashback (authorization_id, rate_bps, amount)
      VALUES (${authorization.id}, ${card.cashbackBps}, ${formatAmount(amount)}::numeric)
      ON CONFLICT (authorization_id) DO NOTHING
      RETURNING id, status, ledger_tx_id, amount::text AS amount, rejection_code
    `;

    const row =
      claimed[0] ??
      (
        await this.sql<Array<{ id: string; status: string; ledger_tx_id: string | null; amount: string; rejection_code: string | null }>>`
          SELECT id, status, ledger_tx_id, amount::text AS amount, rejection_code
            FROM bank.card_cashback WHERE authorization_id = ${authorization.id}
        `
      )[0]!;

    // The row's amount, not a re-rate. A later change to the card's bps must
    // not post a different reward than the one this authorisation claimed.
    const payable = parseAmount(row.amount);
    if (row.status === 'settled' && row.ledger_tx_id) return { status: 'paid', amount: payable, ledgerTxId: row.ledger_tx_id };
    if (row.status === 'rejected') {
      return { status: 'refused', amount: payable, reason: row.rejection_code ?? 'bank.cashback_pot_unfunded' };
    }
    return this.postCashbackReward(card, authorization.id, row.id, payable);
  }

  /**
   * Re-drive a cashback row that is still `pending`.
   *
   * Does not insert a settlement and does not select `settled` or `rejected`.
   * The amount is the one stored on the row.
   */
  private async retryPendingCashback(card: CardRecord, authorizationId: string): Promise<void> {
    const rows = await this.sql<Array<{ id: string; amount: string }>>`
      SELECT id, amount::text AS amount
        FROM bank.card_cashback
       WHERE authorization_id = ${authorizationId}
         AND status = 'pending'
    `;
    for (const row of rows) {
      await this.postCashbackReward(card, authorizationId, row.id, parseAmount(row.amount));
    }
  }

  /**
   * Post one cashback reward, or record why it did not pay.
   *
   * `rewardPay` is idempotent on `reward:bank.card.cashback:<authorisation>`.
   * A repeat returns the original transaction when the first post committed,
   * and posts once when it did not. Insufficient funds is the only error that
   * rejects the row. Any other ledger error leaves it `pending` and does not
   * throw: the capture has already landed, and throwing would strand the retry.
   */
  private async postCashbackReward(card: CardRecord, authorizationId: string, rowId: string, amount: Amount): Promise<CashbackOutcome> {
    try {
      const reward = recipes.rewardPay({
        rewardId: `bank.card.cashback:${authorizationId}`,
        userId: card.userId,
        assetId: card.assetId,
        amount,
        reason: 'bank.card.cashback',
      });
      // A legacy pending row may name a reward whose acknowledgement was lost.
      // Reconcile that committed transaction without posting again. A missing
      // issuer must never let recovery create a new simulated-card reward.
      const committed = await this.ledger.getTxByKey(reward.idempotencyKey);
      if (!committed && !this.rewardsIssuerConnected(card)) {
        return { status: 'refused', amount, reason: 'bank.rewards_issuer_unset' };
      }
      const posted = committed ?? (await this.ledger.post(reward));
      await this.sql`
        UPDATE bank.card_cashback
           SET status = 'settled', ledger_tx_id = ${posted.id}, settled_at = now(), rejection_code = NULL
         WHERE id = ${rowId}
           AND status <> 'settled'
      `;
      return { status: 'paid', amount, ledgerTxId: posted.id };
    } catch (err) {
      if (err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds')) {
        await this.sql`
          UPDATE bank.card_cashback
             SET status = 'rejected', rejection_code = 'bank.cashback_pot_unfunded'
           WHERE id = ${rowId}
             AND status = 'pending'
        `;
        // Surfaced, not thrown. Reversing a capture the merchant already has,
        // because a reward could not be paid, would undo a purchase that
        // happened. The row and this outcome are how an operator finds it.
        return { status: 'refused', amount, reason: 'bank.cashback_pot_unfunded' };
      }
      return {
        status: 'refused',
        amount,
        reason: err instanceof LedgerError ? err.code : 'bank.post_failed',
      };
    }
  }

  /**
   * OPERATOR SURFACE: move bank revenue into the pot cashback is paid from.
   *
   * `sweepFeesToRewards` — the existing recipe, unchanged. Cashback has a NAMED
   * SOURCE and this is it: `houseFees('bank', asset)`, fees the platform really
   * charged. A pot funded from anywhere else, or from nowhere, would make the
   * advertised rate a promise against future revenue, which is a different
   * product with a different licence.
   */
  async fundCashbackPot(input: { windowId: string; assetId: string; amount: Amount }): Promise<{ ledgerTxId: string }> {
    const posted = await this.ledger.post(
      recipes.sweepFeesToRewards({
        windowId: `bank.card:${input.windowId}`,
        sourceModule: 'bank',
        assetId: input.assetId,
        amount: input.amount,
      }),
    );
    return { ledgerTxId: posted.id };
  }

  /** What the pot can currently pay. A ledger read, like every other figure here. */
  async cashbackCapacity(assetId: string): Promise<Amount> {
    return (await this.ledger.balance(rewardsEngine(assetId))).amount;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async authorizationsOf(cardId: string, limit?: number): Promise<AuthorizationRecord[]> {
    const page = assertCardAuthorizationsListLimit(limit);
    const rows = await this.sql<AuthorizationRow[]>`
      SELECT a.id, a.card_id, a.authorization_ref, a.amount, a.merchant_category, a.channel, a.decision, a.decline_code, a.status,
             a.hold_ledger_tx_id, a.decided_at,
             c.settlement_asset_id, c.settlement_amount, c.funding_asset_id, c.funding_amount, c.rate, c.rate_quality, c.rate_as_of
        FROM bank.card_authorizations a
        LEFT JOIN bank.card_conversions c ON c.authorization_id = a.id
       WHERE a.card_id = ${cardId}
       ORDER BY a.decided_at DESC
       LIMIT ${page}
    `;
    return rows.map(toAuthorization);
  }

  /** One authorisation by id, for the operator read (BK-cops-01). Null when there is none; never writes. */
  async authorizationById(authorizationId: string): Promise<(AuthorizationRecord & { userId: string; assetId: string }) | null> {
    const rows = await this.sql<Array<AuthorizationRow & { user_id: string; card_asset_id: string }>>`
      SELECT a.id, a.card_id, a.authorization_ref, a.amount, a.merchant_category, a.channel, a.decision, a.decline_code, a.status,
             a.hold_ledger_tx_id, a.decided_at,
             c.settlement_asset_id, c.settlement_amount, c.funding_asset_id, c.funding_amount, c.rate, c.rate_quality, c.rate_as_of,
             k.user_id, k.asset_id AS card_asset_id
        FROM bank.card_authorizations a
        JOIN bank.cards k ON k.id = a.card_id
        LEFT JOIN bank.card_conversions c ON c.authorization_id = a.id
       WHERE a.id = ${authorizationId}
    `;
    const row = rows[0];
    // `amount` is in the card's funding asset (see `AuthorizationRecord.amount`), which is `bank.cards.asset_id`.
    return row ? { ...toAuthorization(row), userId: row.user_id, assetId: row.card_asset_id } : null;
  }

  async cashbackFor(authorizationId: string): Promise<{ amount: Amount; status: string; rejectionCode: string | null } | null> {
    const rows = await this.sql<Array<{ amount: string; status: string; rejection_code: string | null }>>`
      SELECT amount, status, rejection_code FROM bank.card_cashback WHERE authorization_id = ${authorizationId}
    `;
    const row = rows[0];
    return row ? { amount: parseAmount(row.amount), status: row.status, rejectionCode: row.rejection_code } : null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async cardByIssuerRef(issuer: string, issuerRef: string): Promise<CardRow | undefined> {
    const rows = await this.sql<CardRow[]>`
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by FROM bank.cards WHERE issuer = ${issuer} AND issuer_ref = ${issuerRef}
    `;
    return rows[0];
  }

  private async authorizationByRef(cardId: string, authorizationRef: string): Promise<AuthorizationRecord | null> {
    const rows = await this.sql<AuthorizationRow[]>`
      SELECT a.id, a.card_id, a.authorization_ref, a.amount, a.merchant_category, a.channel, a.decision, a.decline_code, a.status,
             a.hold_ledger_tx_id, a.decided_at,
             c.settlement_asset_id, c.settlement_amount, c.funding_asset_id, c.funding_amount, c.rate, c.rate_quality, c.rate_as_of
        FROM bank.card_authorizations a
        LEFT JOIN bank.card_conversions c ON c.authorization_id = a.id
       WHERE a.card_id = ${cardId} AND a.authorization_ref = ${authorizationRef}
    `;
    const row = rows[0];
    return row ? toAuthorization(row) : null;
  }

  /** An authorisation that exists, was approved, and whose hold really landed. */
  private async requireApprovedAuthorization(card: CardRecord, authorizationRef: string): Promise<AuthorizationRecord> {
    const authorization = await this.authorizationByRef(card.id, authorizationRef);
    if (!authorization) {
      throw new BankError(`Authorisation ${authorizationRef} not found on this card`, 'bank.card_authorization_not_found');
    }
    if (authorization.decision !== 'approved' || authorization.status !== 'settled') {
      throw new BankError(`Authorisation ${authorizationRef} was declined and holds nothing`, 'bank.card_authorization_declined');
    }
    return authorization;
  }

  /**
   * An authorisation that is approved, whose hold landed, and that this kind
   * may still move.
   *
   * `status = 'settled'` IS THE LOAD-BEARING PART OF THE CLOSED CHECK. Counting
   * every sequence-0 row regardless of status closes the authorisation on the
   * strength of a settlement that never reached the ledger: a post that threw
   * leaves a `rejected` row, a process that died between the claim and the post
   * leaves a `pending` one, and in both cases the user's whole hold is still
   * sitting in an account only this authorisation can name. Treating either as
   * "already settled" refuses the retry that would release it. That is stranded
   * funds with no way out, produced by one transient ledger error.
   *
   * A settlement that DID reach the ledger still closes the authorisation, which
   * is what makes a second capture at a different amount, and a reversal after a
   * capture, impossible rather than merely unlikely. Recovering the remainder of
   * a capture that got that far is `resumeSettlements`, not a re-drive of this.
   *
   * A pending row is not settled, and it is not an open door for the other kind.
   * Capture and reverse both take sequence 0. Letting a reverse through while a
   * capture claim is pending — or a capture through while a reversal claim is
   * pending — makes them share that row. The same kind stays open, because that
   * is the re-drive. A rejected row stays open too, including for the other
   * kind: the post never landed, and `reverse()` after a failed capture is how
   * the hold goes back. That call does not settle the rejected row. Sequence 0
   * is claimed again, as the kind that is actually posting.
   */
  private async requireOpenAuthorization(
    card: CardRecord,
    authorizationRef: string,
    kind: 'capture' | 'reversal',
  ): Promise<AuthorizationRecord> {
    const authorization = await this.requireApprovedAuthorization(card, authorizationRef);
    const rows = await this.sql<Array<{ status: string; kind: 'capture' | 'reversal' }>>`
      SELECT status, kind FROM bank.card_settlements
       WHERE authorization_id = ${authorization.id} AND sequence = 0
    `;
    const claim = rows[0];
    if (claim?.status === 'settled') {
      throw new BankError(`Authorisation ${authorizationRef} has already been settled`, 'bank.card_authorization_closed');
    }
    if (claim?.status === 'pending' && claim.kind !== kind) {
      throw new BankError(
        `Authorisation ${authorizationRef} has a pending ${claim.kind} on sequence 0, not a ${kind}`,
        'bank.card_settlement_kind_conflict',
      );
    }
    return authorization;
  }

  /**
   * The decision and the rate it was taken at, in ONE database transaction.
   *
   * THE ATOMICITY IS THE FREEZE. Two deliveries of one authorisation race on
   * `unique(card_id, authorization_ref)`; the loser gets zero rows back, writes
   * no conversion row, and reads the winner's decision. So there is exactly one
   * rate per purchase, it belongs to the decision that actually stands, and the
   * two can never disagree about what a spend cost.
   *
   * Writing them separately would have been the bug: the loser's quote could
   * land in `card_conversions` first, and the hold, the capture and the
   * remainder would then be computed from a rate no decision was taken at.
   */
  private async recordDecision(input: {
    card: CardRecord;
    input: { authorizationRef: string; merchantCategory?: string; channel: CardChannel };
    fundingAmount: Amount;
    quote: ConversionQuote | null;
    decision: 'approved' | 'declined';
    declineCode: string | null;
  }): Promise<AuthorizationRecord> {
    await transaction(
      this.sql,
      async (tx) => {
        const claimed = await tx<Array<{ id: string }>>`
          INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, merchant_category, channel, decision, decline_code, status)
          VALUES (
            ${input.card.id}, ${input.input.authorizationRef}, ${formatAmount(input.fundingAmount)}::numeric,
            ${input.input.merchantCategory ?? null}, ${input.input.channel}, ${input.decision}, ${input.declineCode},
            ${input.decision === 'approved' ? 'pending' : 'rejected'}
          )
          ON CONFLICT (card_id, authorization_ref) DO NOTHING
          RETURNING id
        `;

        const row = claimed[0];
        // Lost the race, or a redelivery that slipped past the read above. The
        // winner's rate is the rate; this call's quote is discarded unwritten.
        if (!row || !input.quote) return;

        await tx`
          INSERT INTO bank.card_conversions (
            authorization_id, settlement_asset_id, settlement_amount, funding_asset_id, funding_amount, rate, rate_quality, rate_as_of
          )
          VALUES (
            ${row.id}, ${input.quote.settlementAssetId}, ${formatAmount(input.quote.settlementAmount)}::numeric,
            ${input.quote.fundingAssetId}, ${formatAmount(input.quote.fundingAmount)}::numeric,
            ${formatAmount(input.quote.rate)}::numeric, ${input.quote.quality}, ${input.quote.rateAsOf}
          )
        `;
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    return (await this.authorizationByRef(input.card.id, input.input.authorizationRef))!;
  }

  /**
   * Claim the settlement row, post, mark it. Same shape as `drivenPost` in
   * `loan-service.ts` and the same crash story: the row is claimed before the
   * post so a process that dies between them leaves a `pending` row with a
   * deterministic ledger key, and re-driving finds the original transaction
   * rather than making a second one.
   */
  private async settlement(input: {
    authorization: AuthorizationRecord;
    sequence: number;
    kind: 'capture' | 'reversal';
    amount: Amount;
    post: () => Promise<{ id: string }>;
  }): Promise<string> {
    const claim = await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<Array<{ id: string; ledger_tx_id: string | null }>>`
          INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount)
          VALUES (${input.authorization.id}, ${input.sequence}, ${input.kind}, ${formatAmount(input.amount)}::numeric)
          ON CONFLICT (authorization_id, sequence) DO NOTHING
          RETURNING id, ledger_tx_id
        `;
        if (rows.length > 0) {
          return {
            claimed: true as const,
            id: rows[0]!.id,
            ledgerTxId: null,
            amount: input.amount,
            kind: input.kind,
            status: 'pending' as const,
          };
        }
        const existing = await tx<
          Array<{ id: string; ledger_tx_id: string | null; amount: string; kind: 'capture' | 'reversal'; status: string }>
        >`
          SELECT id, ledger_tx_id, amount::text AS amount, kind, status FROM bank.card_settlements
           WHERE authorization_id = ${input.authorization.id} AND sequence = ${input.sequence}
        `;
        const prior = existing[0]!;
        const priorAmount = parseAmount(prior.amount);
        // A rejected full capture sits on sequence 0 with kind `capture` and
        // the hold as its amount. The other kind may release that hold, but
        // not by posting onto this row or by returning its ledger transaction.
        // Retire the failed claim and insert a new one. A different amount is
        // left for the conflict check below, which must still see the old row.
        if (prior.kind !== input.kind && prior.status === 'rejected' && priorAmount === input.amount) {
          const removed = await tx<Array<{ id: string }>>`
            DELETE FROM bank.card_settlements
             WHERE id = ${prior.id} AND status = 'rejected' AND kind = ${prior.kind}
            RETURNING id
          `;
          if (removed.length === 0) {
            throw new BankError(
              `Settlement ${input.sequence} on this authorisation was claimed as ${prior.kind}, not ${input.kind}`,
              'bank.card_settlement_kind_conflict',
            );
          }
          const inserted = await tx<Array<{ id: string }>>`
            INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount)
            VALUES (${input.authorization.id}, ${input.sequence}, ${input.kind}, ${formatAmount(input.amount)}::numeric)
            RETURNING id
          `;
          return {
            claimed: true as const,
            id: inserted[0]!.id,
            ledgerTxId: null,
            amount: input.amount,
            kind: input.kind,
            status: 'pending' as const,
          };
        }
        return {
          claimed: false as const,
          id: prior.id,
          ledgerTxId: prior.ledger_tx_id,
          amount: priorAmount,
          kind: prior.kind,
          status: prior.status,
        };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    // THE LEDGER KEY IS THE AUTHORISATION, NOT THE AMOUNT.
    //
    // `post()` returns the existing transaction for a reused business key; in the ledger's
    // `detect` mode it still does not refuse a different body (it logs
    // `ledger.idempotency_mismatch`), which is correct for a re-drive and wrong for a
    // disagreement. Without this check a second caller arriving at
    // the same sequence with a DIFFERENT amount is handed the first caller's
    // transaction and believes its own number: it reports a capture at a value
    // the ledger never saw, computes its remainder from that value — so the
    // reversal is wrong too — and pays cashback on it out of a real pot. Two
    // concurrent operator calls, or a client retry landing before the first
    // response, is all it takes.
    //
    // The claimed row is the record of what this sequence is for. A caller who
    // disagrees with it is refused by name rather than quietly reconciled.
    //
    // Kind is the other half. Capture and reverse both take sequence 0, so the
    // lost insert is not proof they asked for the same movement. Returning
    // `ledgerTxId` here would report the capture's transaction as the reversal.
    // A rejected row is not an exception to that. Nothing was posted, so the
    // other kind may still release the hold, but the claim above retires the
    // failed row first. Settling it in place would leave kind `capture` and,
    // when the reject left a ledger transaction id, hand that capture back as
    // the reversal.
    if (!claim.claimed && claim.kind !== input.kind) {
      throw new BankError(
        `Settlement ${input.sequence} on this authorisation was claimed as ${claim.kind}, not ${input.kind}`,
        'bank.card_settlement_kind_conflict',
      );
    }
    if (claim.amount !== input.amount) {
      throw new BankError(
        `Settlement ${input.sequence} on this authorisation was claimed for ${formatAmount(claim.amount)}, not ${formatAmount(input.amount)}`,
        'bank.card_settlement_amount_conflict',
      );
    }

    if (!claim.claimed && claim.ledgerTxId) return claim.ledgerTxId;

    let posted: { id: string };
    try {
      posted = await input.post();
    } catch (err) {
      // Only a definite ledger refusal proves nothing committed under this key.
      // Anything else (a transport error, a 5xx, an untyped body) can follow a
      // commit whose reply was lost: the row stays `pending` and a retry
      // re-drives the same key. A durable `rejected` for a committed capture
      // would let the same authorisation settle twice.
      if (isDefiniteLedgerRefusal(err)) {
        await this.sql`
          UPDATE bank.card_settlements
             SET status = 'rejected',
                 rejection_code = ${(err as LedgerError).code},
                 ledger_tx_id = NULL
           WHERE id = ${claim.id}
        `;
      }
      throw err;
    }

    await this.sql`
      UPDATE bank.card_settlements SET status = 'settled', ledger_tx_id = ${posted.id}, settled_at = now() WHERE id = ${claim.id}
    `;
    return posted.id;
  }

  private liveSecretProgramme(): boolean {
    const programme = this.issuer.programme;
    return programme.simulated === false && programme.id !== 'none' && programme.id !== 'card-sim';
  }

  private assertLiveSecret(kind: 'pan' | 'pin' | 'wallet'): void {
    if (this.liveSecretProgramme()) return;
    if (kind === 'pan') throw new BankError(PAN_UNSET, 'bank.card_pan_issuer_unset');
    if (kind === 'pin') throw new BankError(PIN_UNSET, 'bank.card_pin_issuer_unset');
    throw new BankError(WALLET_UNSET, 'bank.card_wallet_issuer_unset');
  }

  private secretExpiresAt(): string {
    return new Date(this.clock().getTime() + SECRET_TTL_MS).toISOString();
  }

  private async operatorCommand(
    sql: Sql,
    clientRequestId: string,
  ): Promise<{ card_id: string; target_status: string; reason: string; result_status: string; frozen_by: string | null } | null> {
    const rows = await sql<
      Array<{ card_id: string; target_status: string; reason: string; result_status: string; frozen_by: string | null }>
    >`
      SELECT card_id, target_status, reason, result_status, frozen_by
        FROM bank.card_operator_commands
       WHERE client_request_id = ${clientRequestId}
    `;
    return rows[0] ?? null;
  }

  private replayOperatorCommand(
    prior: { card_id: string; target_status: string; reason: string; result_status: string; frozen_by: string | null },
    cardId: string,
    status: 'frozen' | 'active',
    reason: string,
  ): { cardId: string; status: 'frozen' | 'active'; frozenBy: 'operator' | null } {
    if (prior.card_id !== cardId || prior.target_status !== status || prior.reason !== reason) {
      throw new BankError('This command id was already used for a different card change', 'bank.card_command_conflict');
    }
    const result = prior.result_status === 'active' ? 'active' : 'frozen';
    return { cardId: prior.card_id, status: result, frozenBy: prior.frozen_by === 'operator' ? 'operator' : null };
  }

  private async ownedCard(cardId: string, userId: string): Promise<CardRecord> {
    const card = await this.card(cardId);
    if (card.userId !== userId) throw new BankError(`Card ${cardId} not found`, 'bank.card_not_found');
    return card;
  }

  private async cardOrNull(cardId: string): Promise<CardRecord | null> {
    const rows = await this.sql<CardRow[]>`
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by FROM bank.cards WHERE id = ${cardId}
    `;
    const row = rows[0];
    return row ? toCard(row) : null;
  }

  private async claimCommand(
    tx: Sql,
    cardId: string,
    commandId: string,
    kind: 'set_limits' | 'set_channels',
    hash: string,
  ): Promise<'new' | 'replay'> {
    const inserted = await tx<Array<{ id: string }>>`
      INSERT INTO bank.card_commands (id, card_id, kind, payload_hash)
      VALUES (${commandId}, ${cardId}, ${kind}, ${hash})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length > 0) return 'new';
    const rows = await tx<Array<{ card_id: string; kind: string; payload_hash: string }>>`
      SELECT card_id, kind, payload_hash FROM bank.card_commands WHERE id = ${commandId}
    `;
    const row = rows[0];
    if (!row || row.card_id !== cardId || row.kind !== kind || row.payload_hash !== hash) {
      throw new BankError('This command id was already used for a different card change', 'bank.card_command_conflict');
    }
    return 'replay';
  }

  private async secretAlreadyAudited(
    id: string,
    cardId: string,
    kind: 'pan_reveal' | 'pin_reveal' | 'pin_set' | 'wallet_provision',
    payloadHash: string,
  ): Promise<boolean> {
    const rows = await this.sql<Array<{ card_id: string; kind: string; payload_hash: string }>>`
      SELECT card_id, kind, payload_hash FROM bank.card_secret_audits WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) return false;
    if (row.card_id !== cardId || row.kind !== kind || row.payload_hash !== payloadHash) {
      throw new BankError('This command id was already used for a different card change', 'bank.card_command_conflict');
    }
    return true;
  }

  private async auditSecret(input: {
    id: string;
    cardId: string;
    userId: string;
    kind: 'pan_reveal' | 'pin_reveal' | 'pin_set' | 'wallet_provision';
    payloadHash: string;
  }): Promise<void> {
    const inserted = await this.sql<Array<{ id: string }>>`
      INSERT INTO bank.card_secret_audits (id, card_id, user_id, kind, payload_hash)
      VALUES (${input.id}, ${input.cardId}, ${input.userId}, ${input.kind}, ${input.payloadHash})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length > 0) return;
    const rows = await this.sql<Array<{ card_id: string; kind: string; payload_hash: string }>>`
      SELECT card_id, kind, payload_hash FROM bank.card_secret_audits WHERE id = ${input.id}
    `;
    const row = rows[0];
    if (!row || row.card_id !== input.cardId || row.kind !== input.kind || row.payload_hash !== input.payloadHash) {
      throw new BankError('This command id was already used for a different card change', 'bank.card_command_conflict');
    }
  }

  private async approvedSpend(cardId: string, since: Date, channel?: CardChannel): Promise<Amount> {
    const rows = channel
      ? await this.sql<Array<{ total: string }>>`
          SELECT COALESCE(SUM(amount), 0)::text AS total
            FROM bank.card_authorizations
           WHERE card_id = ${cardId}
             AND decision = 'approved'
             AND status <> 'rejected'
             AND decided_at >= ${since}
             AND channel = ${channel}
        `
      : await this.sql<Array<{ total: string }>>`
          SELECT COALESCE(SUM(amount), 0)::text AS total
            FROM bank.card_authorizations
           WHERE card_id = ${cardId}
             AND decision = 'approved'
             AND status <> 'rejected'
             AND decided_at >= ${since}
        `;
    return parseAmount(rows[0]?.total ?? '0');
  }

  private async closeReplaced(card: CardRecord, replacementId: string, reason: CardReplaceReason): Promise<void> {
    const current = await this.card(card.id);
    if (current.replacedByCardId === replacementId && current.status === 'closed' && current.replaceReason === reason) return;
    if (current.replaceReason && current.replaceReason !== reason) {
      throw new BankError('This card was already replaced on different terms', 'bank.card_replace_conflict');
    }
    await this.issuer.setStatus({ cardId: current.id, issuerRef: current.issuerRef, status: 'closed' });
    await this.sql`
      UPDATE bank.cards
         SET status = 'closed', replaced_by_card_id = ${replacementId}, replace_reason = ${reason}, updated_at = now()
       WHERE id = ${current.id}
    `;
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

interface CardRow {
  id: string;
  user_id: string;
  asset_id: string;
  settlement_asset_id: string;
  issuer: string;
  simulated: boolean;
  issuer_ref: string;
  pan_tail: string;
  status: CardRecord['status'];
  cashback_bps: number;
  per_authorization_limit: string;
  daily_limit: string | null;
  monthly_limit: string | null;
  cash_limit: string | null;
  channel_online: boolean;
  channel_contactless: boolean;
  channel_atm: boolean;
  channel_abroad: boolean;
  card_type: string;
  shipping_address: unknown;
  replaces_card_id: string | null;
  replaced_by_card_id: string | null;
  replace_reason: string | null;
  frozen_by: string | null;
}

interface AuthorizationRow {
  id: string;
  card_id: string;
  authorization_ref: string;
  amount: string;
  merchant_category: string | null;
  channel: string;
  decision: 'approved' | 'declined';
  decline_code: string | null;
  status: AuthorizationRecord['status'];
  hold_ledger_tx_id: string | null;
  decided_at: Date;
  /** All NULL together, from the LEFT JOIN, when this card converts nothing. */
  settlement_asset_id: string | null;
  settlement_amount: string | null;
  funding_asset_id: string | null;
  funding_amount: string | null;
  rate: string | null;
  rate_quality: MarkQuality | null;
  rate_as_of: Date | null;
}

function toCard(row: CardRow): CardRecord {
  if (typeof row.simulated !== 'boolean') {
    throw new TypeError('Card row must declare whether it is simulated');
  }
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    settlementAssetId: row.settlement_asset_id,
    issuer: row.issuer,
    simulated: row.simulated,
    issuerRef: row.issuer_ref,
    panTail: row.pan_tail,
    status: row.status,
    cashbackBps: Number(row.cashback_bps),
    perAuthorizationLimit: parseAmount(row.per_authorization_limit),
    dailyLimit: row.daily_limit === null ? null : parseAmount(row.daily_limit),
    monthlyLimit: row.monthly_limit === null ? null : parseAmount(row.monthly_limit),
    cashLimit: row.cash_limit === null ? null : parseAmount(row.cash_limit),
    online: row.channel_online,
    contactless: row.channel_contactless,
    atm: row.channel_atm,
    abroad: row.channel_abroad,
    cardType: row.card_type === 'physical' ? 'physical' : 'virtual',
    shippingAddress: toAddress(row.shipping_address),
    replacesCardId: row.replaces_card_id,
    replacedByCardId: row.replaced_by_card_id,
    replaceReason:
      row.replace_reason === 'lost' || row.replace_reason === 'stolen' || row.replace_reason === 'damaged' ? row.replace_reason : null,
    frozenBy: row.frozen_by === 'owner' || row.frozen_by === 'operator' ? row.frozen_by : null,
  };
}

function commandHash(fields: Record<string, string>): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function limitToken(value: Amount | null | undefined): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  return formatAmount(value);
}

function startOfUtc(now: Date, unit: 'day' | 'month'): Date {
  return unit === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function channelOpen(card: CardRecord, channel: CardChannel): boolean {
  switch (channel) {
    case 'card-present':
      return true;
    case 'online':
      return card.online;
    case 'contactless':
      return card.contactless;
    case 'atm':
      return card.atm;
    case 'foreign':
      return card.abroad;
  }
}

function parseChannel(value: string): CardChannel {
  if (value === 'online' || value === 'contactless' || value === 'atm' || value === 'foreign' || value === 'card-present') return value;
  return 'card-present';
}

function requireShippingAddress(input: CardShippingAddress | undefined): CardShippingAddress {
  if (!input) throw new BankError('A physical card needs a delivery address', 'bank.card_shipping_address_required');
  const address = {
    name: input.name.trim(),
    line1: input.line1.trim(),
    line2: input.line2?.trim() ? input.line2.trim() : null,
    city: input.city.trim(),
    region: input.region?.trim() ? input.region.trim() : null,
    postalCode: input.postalCode.trim(),
    country: input.country.trim().toUpperCase(),
  };
  if (!address.name || !address.line1 || !address.city || !address.postalCode || !/^[A-Z]{2}$/.test(address.country)) {
    throw new BankError('A physical card needs a delivery address', 'bank.card_shipping_address_required');
  }
  return address;
}

function canonicalAddress(address: CardShippingAddress | null): string {
  if (!address) return '';
  return JSON.stringify(address);
}

function toAddress(value: unknown): CardShippingAddress | null {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.name !== 'string' || typeof row.line1 !== 'string' || typeof row.city !== 'string') return null;
  if (typeof row.postalCode !== 'string' || typeof row.country !== 'string') return null;
  return {
    name: row.name,
    line1: row.line1,
    line2: typeof row.line2 === 'string' ? row.line2 : null,
    city: row.city,
    region: typeof row.region === 'string' ? row.region : null,
    postalCode: row.postalCode,
    country: row.country,
  };
}

function toAuthorization(row: AuthorizationRow): AuthorizationRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    authorizationRef: row.authorization_ref,
    amount: parseAmount(row.amount),
    merchantCategory: row.merchant_category,
    channel: parseChannel(row.channel),
    decision: row.decision,
    declineCode: row.decline_code,
    status: row.status,
    holdLedgerTxId: row.hold_ledger_tx_id,
    decidedAt: row.decided_at,
    conversion: toConversion(row),
  };
}

/**
 * The conversion, or null because there wasn't one.
 *
 * Every column is required to be present together. A row with a rate and no
 * settlement amount is not a partially-known conversion to be patched up with
 * defaults — it is a shape the schema's NOT NULLs make impossible, and treating
 * it as recoverable here would hide the day one of them stopped being true.
 */
function toConversion(row: AuthorizationRow): ConversionRecord | null {
  if (
    row.settlement_asset_id === null ||
    row.settlement_amount === null ||
    row.funding_asset_id === null ||
    row.funding_amount === null ||
    row.rate === null ||
    row.rate_quality === null ||
    row.rate_as_of === null
  ) {
    return null;
  }
  return {
    settlementAssetId: row.settlement_asset_id,
    settlementAmount: parseAmount(row.settlement_amount),
    fundingAssetId: row.funding_asset_id,
    fundingAmount: parseAmount(row.funding_amount),
    rate: parseAmount(row.rate),
    quality: row.rate_quality,
    rateAsOf: row.rate_as_of,
  };
}
