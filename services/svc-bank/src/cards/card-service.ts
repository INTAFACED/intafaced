import { createHash } from 'node:crypto';
import type { PendingQuery, Row, Sql } from 'postgres';
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
import { acceptableForMarking, type MarkQuality, type PriceSource } from '../loans/prices.js';
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
import { CARD_TIERS, type CardProgrammeTerms, type CardTier, type CashbackRates } from './card-programme.js';
import { unconfiguredRankTier, type RankTierPort } from './rank-tier.js';
import {
  NOTHING_REPORTED,
  NOT_USED_FOR_CARDS,
  assertPayFromOrder,
  payFromAssets,
  requireSpendAssets,
  type CardCustodyMode,
  type CardPartnerTerms,
  type PayFromRow,
} from './partner-terms.js';
import {
  PartnerCardRefusal,
  partnerCardKey,
  type PartnerCardFigures,
  type PartnerCardHolds,
  type PartnerHoldReport,
  type PartnerMoveAnswer,
} from './partner-card-holds.js';
import { partnerUnset, type MoneyHeldBy } from '../partner/test-partner.js';
import {
  assertFundingOffered,
  fundingOfferStates,
  reconcileProgramme,
  type AppProgrammeFigure,
  type FundingKind,
  type FundingOfferState,
  type ReconciliationRow,
} from './programme-funding.js';

/** One programme funding instruction sent to the card partner (J-bank-26 #6). */
export interface ProgrammeFundingRequest {
  readonly clientRequestId: string;
  readonly kind: FundingKind;
  readonly assetId: string;
  readonly amount: string;
  readonly threshold: string | null;
  readonly partnerRef: string;
  readonly createdAt: string;
}

/** Programme funding as an operator reads it (J-bank-26 #6). */
export interface ProgrammeFundingView {
  readonly test: boolean;
  readonly fundingAssetId: string | null;
  readonly offers: Record<FundingKind, FundingOfferState>;
  readonly rows: ReconciliationRow[];
  readonly requests: ProgrammeFundingRequest[];
}

interface DisplayMark {
  readonly price: Amount;
  readonly asOf: Date;
}

interface FundingRow {
  client_request_id: string;
  kind: FundingKind;
  asset_id: string;
  amount: string;
  threshold: string | null;
  partner_ref: string | null;
  approved_at: Date | null;
  created_at: Date;
}

/** An answered instruction (one the partner has given its reference for). */
function toFundingRequest(r: FundingRow): ProgrammeFundingRequest {
  return {
    clientRequestId: r.client_request_id,
    kind: r.kind,
    assetId: r.asset_id,
    amount: formatAmount(parseAmount(r.amount)),
    threshold: r.threshold === null ? null : formatAmount(parseAmount(r.threshold)),
    partnerRef: r.partner_ref ?? '',
    createdAt: r.created_at.toISOString(),
  };
}

/** The same client request id is the same instruction: a different kind, amount or threshold under it refuses by name. */
function assertSameFunding(row: FundingRow, fields: { kind: FundingKind; amount: string; threshold: string | null }): void {
  const same =
    row.kind === fields.kind &&
    formatAmount(parseAmount(row.amount)) === fields.amount &&
    (row.threshold === null ? null : formatAmount(parseAmount(row.threshold))) === fields.threshold;
  if (!same) {
    throw new BankError(
      'This request id was already used for a different programme funding instruction (bank.card_funding_invalid)',
      'bank.card_funding_invalid',
    );
  }
}

function positiveOrRefuse(raw: string, what: string): Amount {
  if (!/^\d+(\.\d{1,18})?$/.test(raw) || parseAmount(raw) <= 0n) {
    throw new BankError(`A programme funding ${what} is a positive decimal (bank.card_funding_invalid)`, 'bank.card_funding_invalid');
  }
  return parseAmount(raw);
}

/** Pay from, as the bank answers it (J-bank-29 #1 and #2). */
export interface PayFromView {
  readonly test: boolean;
  readonly custodyMode: CardPartnerTerms['custodyMode'];
  /** What the person's open cards settle in, which every rate is quoted in; null when none, or they differ. */
  readonly settlementAssetId: string | null;
  readonly assets: PayFromRow[];
  /** The person's saved order, first to last, or null when none is saved. */
  readonly order: string[] | null;
  readonly notUsedForCards: Array<(typeof NOT_USED_FOR_CARDS)[number]>;
}

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
  /**
   * Who froze it: the owner, a holder of a shared pot the card is linked to (`holder`), or the bank (`operator`, a freeze
   * the owner cannot lift). Null when the card is not frozen by a recorded actor.
   */
  frozenBy: 'owner' | 'holder' | 'operator' | null;
  /**
   * When the person activated the card (BK-cissue-04). NULL is a card that has not been activated: a physical card ordered
   * through `cards.order`, or a replacement. It declines every authorisation `bank.card_not_active` until it is.
   * Omitted (a row from before activation existed, or a fake) reads as activated.
   */
  activatedAt?: Date | null;
  /** POLICY: captured payments a virtual card takes before it closes itself (single-use is 1). NULL is no limit. */
  usesAllowed?: number | null;
  /** The owner's design and delivery speed a physical card was ordered with, and the country the person lives in. */
  designId?: string | null;
  deliverySpeed?: string | null;
  residenceCountry?: string | null;
}

/** True when the card has not been activated yet (BK-cissue-04). */
export function cardInactive(card: Pick<CardRecord, 'activatedAt'>): boolean {
  return card.activatedAt === null;
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
  /**
   * WHOSE BOOK HOLDS IT (OWNER 226). `ledger`: the custodial layer, every movement a ledger post. `partner`: the card
   * partner holds it from the partner balance, and our ledger posts nothing for it (`partner-card-holds.ts`). Decided once,
   * at the decision, and every later movement of this authorisation follows it, whatever the switch says by then.
   */
  heldBy: 'ledger' | 'partner';
  /** The partner's reference for its hold, once it answered. Null on the ledger path. */
  partnerHoldRef: string | null;
  /** How the partner answered the hold: it holds the crypto, or the card pulls from the person's own wallet. */
  partnerMode: CardCustodyMode | null;
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
  /** Null on a partner-held authorisation: the partner moved it and `partner` names its instructions. */
  captureLedgerTxId: string | null;
  reversalLedgerTxId: string | null;
  /** Whose book this capture moved in. */
  heldBy: 'ledger' | 'partner';
  /** The partner's references and figures as it reports them, on a partner-held authorisation; else null. */
  partner: { readonly captureRef: string; readonly releaseRef: string | null; readonly figures: PartnerCardFigures | null } | null;
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
  /**
   * The owner's card programme terms (`BANK_CARD_PROGRAMME_JSON`, BK-cissue-01): count limits checked on every issue when
   * published. Absent, `issue` keeps its behaviour from before; the card room (`cards.order`) refuses without them.
   */
  readonly programmeTerms?: CardProgrammeTerms | null;
  /**
   * Cashback by rank card tier (RC-bank-02): the owner's rate table, identity's rank door, and whether the card simulator
   * pays (the TEST stand-in, `BANK_CARD_SIM_CASHBACK=test`, refused at boot outside dev/test). Absent: no tier rate, no
   * simulator cashback, exactly as before.
   */
  readonly cashback?: { readonly rates?: CashbackRates | null; readonly rankTier?: RankTierPort; readonly simulatorPays?: boolean };
  /**
   * After a card's status really changes, in the same transaction as the card's row: a shared pot's log names who did
   * it (BK-acct-09). Throwing rolls the row back. Absent = nothing else is told.
   */
  readonly onStatusChanged?: CardStatusHook;
  /**
   * The owner's list of assets a card may pay from (`BANK_CARD_SPEND_ASSETS`, BK-ccrypto-01). Absent or null, Pay from
   * refuses `bank.card_spend_assets_unset`.
   */
  readonly spendAssets?: readonly string[] | null;
  /**
   * WHOSE BOOK HOLDS THIS PERSON'S CARD MONEY (OWNER 226), asked once per new authorisation: `ledger` (the custodial
   * layer, as before), `partner` (the card partner holds it; `partnerHolds` below) or `none` (no partner and the custodial
   * layer off: refused `bank.partner_unset`, nothing written). Absent: always `ledger`, exactly as before.
   */
  readonly heldBy?: (userId: string) => MoneyHeldBy;
  /** The card partner that holds partner-held authorisations (today only the TEST partner card). Absent: none. */
  readonly partnerHolds?: PartnerCardHolds | null;
}

/** A refund the card partner made of a partner-held capture. */
export interface PartnerRefundResult {
  readonly authorizationId: string;
  readonly refunded: Amount;
  readonly partnerRef: string;
  /** The partner's figures from its answer; null on a replay of a refund already recorded (read `partnerHeld`). */
  readonly figures: PartnerCardFigures | null;
}

/** One partner-held authorisation as the partner reports it now; `report` null is the partner has no record of it. */
export interface PartnerHeldAuthorization {
  readonly authorizationId: string;
  readonly authorizationRef: string;
  readonly amount: Amount;
  readonly report: PartnerHoldReport | null;
}

/** One change of a card's status, as `onStatusChanged` hears it. */
export interface CardStatusChange {
  cardId: string;
  ownerUserId: string;
  /** A person's user id, or `operator` for the bank's own freeze. */
  actor: { userId: string } | 'operator';
  status: CardRecord['status'];
  /** Set when the card was closed because this card replaces it. */
  replacementCardId?: string;
}
export type CardStatusHook = (tx: Sql, change: CardStatusChange) => Promise<void>;

export class CardService {
  private readonly issuer: CardIssuerAdapter;
  private readonly rates: PriceSource;
  private readonly conversionPolicy: CardConversionPolicy;
  private readonly clock: () => Date;
  private readonly moduleEnabled: boolean;
  private readonly onCaptureSettled: CaptureSettledHook | null;
  private readonly onStatusChanged: CardStatusHook | null;
  private readonly programmeTerms: CardProgrammeTerms | null;
  private readonly cashbackRates: CashbackRates | null;
  private readonly rankTier: RankTierPort;
  private readonly simulatorPays: boolean;
  private readonly spendAssets: readonly string[] | null;
  private readonly heldByOf: (userId: string) => MoneyHeldBy;
  private readonly partnerHolds: PartnerCardHolds | null;

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
    this.onStatusChanged = options.onStatusChanged ?? null;
    this.programmeTerms = options.programmeTerms ?? null;
    this.cashbackRates = options.cashback?.rates ?? null;
    this.rankTier = options.cashback?.rankTier ?? unconfiguredRankTier();
    this.simulatorPays = options.cashback?.simulatorPays === true;
    this.spendAssets = options.spendAssets ?? null;
    this.heldByOf = options.heldBy ?? (() => 'ledger');
    this.partnerHolds = options.partnerHolds ?? null;
  }

  /**
   * What the card partner reports about its unknowns (CUSTODY-DELTA §1.3): custody mode, the assets it spends from, loss
   * liability, reserve and funder. An adapter that reports nothing reads "not known" in every one. No issuer refuses
   * `bank.no_card_issuer`; the simulator in a live deployment refuses `bank.card_sim_not_live`.
   */
  partnerTerms(): CardPartnerTerms {
    if (!this.issuer.partnerTerms) return { ...NOTHING_REPORTED, test: this.issuer.programme.simulated };
    return this.issuer.partnerTerms();
  }

  /**
   * Pay from (J-bank-29 #1 and #2): the owner's spendable assets and any other asset this person's cards draw on, each
   * marked offered, "not offered by the partner", or "not known" from the partner's own list, with how the partner spends
   * (it holds the crypto, or the card pulls from the person's own wallet). For each asset the partner can spend from: the
   * partner's reported balance, and the rate of one unit in the card's settlement asset with the time the rate source
   * stamped it; each is null ("not known") when its source is silent, never 0. Then the person's saved order, and the
   * account kinds a card never pays from. Reads only; nothing is held or posted.
   */
  async payFrom(userId: string): Promise<PayFromView> {
    // The partner first: with no issuer, or the simulator in a live deployment, that is the blocker to name.
    const terms = this.partnerTerms();
    const owner = requireSpendAssets(this.spendAssets);
    const cards = await this.sql<Array<{ asset_id: string; settlement_asset_id: string }>>`
      SELECT asset_id, settlement_asset_id FROM bank.cards WHERE user_id = ${userId} AND status <> 'closed' ORDER BY created_at, id
    `;
    const states = payFromAssets(owner, terms, [...new Set(cards.map((r) => r.asset_id))].sort());
    const offered = states.filter((a) => a.state === 'offered').map((a) => a.assetId);
    // One settlement asset to quote in: the one every open card settles in. None, or cards that settle in different
    // assets, and the rate is "not known" rather than a guess at which card a payment will use.
    const settlements = [...new Set(cards.map((r) => r.settlement_asset_id))];
    const settlementAssetId = settlements.length === 1 ? settlements[0]! : null;
    const marks = settlementAssetId ? await this.displayMarks(offered, settlementAssetId) : new Map<string, DisplayMark>();
    const balances = await this.partnerBalances(userId);
    const [saved] = await this.sql<Array<{ asset_ids: string[] }>>`
      SELECT asset_ids FROM bank.card_pay_from_orders WHERE user_id = ${userId}
    `;
    return {
      test: terms.test,
      custodyMode: terms.custodyMode,
      settlementAssetId,
      assets: states.map((a) => {
        const mark = a.state === 'offered' ? marks.get(a.assetId) : undefined;
        const balance = a.state === 'offered' ? balances?.[a.assetId] : undefined;
        return {
          ...a,
          partnerBalance: balance ?? null,
          rate: mark ? formatAmount(mark.price) : null,
          rateAsOf: mark ? mark.asOf.toISOString() : null,
        };
      }),
      order: saved ? saved.asset_ids : null,
      notUsedForCards: [...NOT_USED_FOR_CARDS],
    };
  }

  /**
   * Save the person's pay-from order (J-bank-29 #2): the assets a payment is taken from, first to last. Each must be one the
   * owner lists and the partner can spend from; the owner's list blank refuses `bank.card_spend_assets_unset` and nothing is
   * saved (J-bank-29 #1). Saving the same order again changes nothing. Moves no value.
   */
  async setPayFromOrder(userId: string, order: readonly string[]): Promise<PayFromView> {
    const terms = this.partnerTerms();
    const owner = requireSpendAssets(this.spendAssets);
    assertPayFromOrder(order, payFromAssets(owner, terms, []));
    await this.sql`
      INSERT INTO bank.card_pay_from_orders (user_id, asset_ids) VALUES (${userId}, ${this.sql.array([...order])}::text[])
      ON CONFLICT (user_id) DO UPDATE SET asset_ids = EXCLUDED.asset_ids, updated_at = now()
      WHERE bank.card_pay_from_orders.asset_ids IS DISTINCT FROM EXCLUDED.asset_ids
    `;
    return this.payFrom(userId);
  }

  /** The partner's reported spendable balances for this cardholder, or null where the adapter reports none. */
  private async partnerBalances(userId: string): Promise<Readonly<Record<string, string>> | null> {
    if (!this.issuer.cardholderBalances) return null;
    let reported: Readonly<Record<string, string>> | null;
    try {
      reported = await this.issuer.cardholderBalances({ userId });
    } catch (error) {
      // No partner to ask, or the simulator in a live deployment, is a blocker to name; any other failure is the partner
      // not answering, which reads "not known" rather than breaking Pay from.
      if (error instanceof BankError && (error.code === 'bank.no_card_issuer' || error.code === 'bank.card_sim_not_live')) throw error;
      return null;
    }
    if (!reported) return null;
    // Only a plain non-negative decimal is a figure; anything else the partner sent reads "not known" for that asset.
    return Object.fromEntries(Object.entries(reported).filter(([, v]) => typeof v === 'string' && /^\d+(\.\d{1,18})?$/.test(v)));
  }

  /**
   * Rates to SHOW (Pay from, the programme's stablecoin conversion): one unit of each asset in `quoteAssetId`. An asset in
   * itself is 1 by definition. Any other comes from the rate source and must pass the freshness and positive-price check a
   * conversion would (`acceptableForMarking` under the card conversion policy); a stale, zero or missing mark, or a source
   * that cannot answer, is left out and reads "not known".
   */
  private async displayMarks(assetIds: readonly string[], quoteAssetId: string): Promise<Map<string, DisplayMark>> {
    const now = this.clock();
    const out = new Map<string, DisplayMark>();
    const others = assetIds.filter((a) => a !== quoteAssetId);
    if (assetIds.includes(quoteAssetId)) out.set(quoteAssetId, { price: parseAmount('1'), asOf: now });
    if (others.length === 0) return out;
    try {
      const marks = await this.rates.marks(others, quoteAssetId);
      for (const [assetId, mark] of marks) {
        if (others.includes(assetId) && acceptableForMarking(mark, now, this.conversionPolicy).ok) {
          out.set(assetId, { price: mark.price, asOf: mark.asOf });
        }
      }
    } catch {
      // A rate source that cannot answer is silent.
    }
    return out;
  }

  /** The owner's published programme terms, or null (BK-cissue-01). */
  terms(): CardProgrammeTerms | null {
    return this.programmeTerms;
  }

  private async assertUnderCount(sql: Sql, userId: string, cardType: 'virtual' | 'physical', limit: number): Promise<void> {
    const held = await this.heldCount(userId, cardType, sql);
    if (held >= limit) {
      throw new BankError(
        `You already hold ${held} ${cardType} card${held === 1 ? '' : 's'}; the limit is ${limit}.`,
        'bank.card_count_limit',
      );
    }
  }

  /** Active or frozen cards of one kind this person holds: what the count limit counts. A closed card is not held. */
  async heldCount(userId: string, cardType: 'virtual' | 'physical', sql: Sql = this.sql): Promise<number> {
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM bank.cards WHERE user_id = ${userId} AND card_type = ${cardType} AND status <> 'closed'
    `;
    return Number(row?.n ?? 0);
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
    /** False starts the card not activated (a physical card ordered through `cards.order`). Omitted is activated. */
    activated?: boolean;
    /** Single-use (1) or n-use: captured payments before the card closes itself. Virtual cards only. */
    usesAllowed?: number | null;
    designId?: string | null;
    deliverySpeed?: string | null;
    residenceCountry?: string | null;
  }): Promise<CardRecord> {
    this.assertModuleEnabled();
    this.assertIssuerMayMutate();
    if (input.usesAllowed != null && (!Number.isInteger(input.usesAllowed) || input.usesAllowed < 1)) {
      throw new BankError('A use limit is a whole number of payments, at least one', 'bank.card_use_limit_invalid');
    }
    if (input.usesAllowed != null && (input.cardType ?? 'virtual') !== 'virtual') {
      throw new BankError('Only a virtual card can be single-use or limited to a number of payments', 'bank.card_use_limit_invalid');
    }
    if (input.perAuthorizationLimit <= 0n) {
      throw new BankError('A card needs a positive per-authorisation limit', 'bank.card_limit_exceeded');
    }

    const cardType = input.cardType ?? 'virtual';
    const shipping = cardType === 'physical' ? requireShippingAddress(input.shippingAddress) : null;
    const settlementAssetId = input.settlementAssetId ?? input.assetId;
    const limits = this.programmeTerms?.limits ?? null;
    // The count limit is read before the issuer is asked, so a refused order makes no card at the issuer; it is read
    // again under the person's lock below, where two orders at once are decided.
    if (limits && !(await this.cardOrNull(input.cardId))) await this.assertUnderCount(this.sql, input.userId, cardType, limits[cardType]);
    const handle = await this.issuer.issue({ cardId: input.cardId, userId: input.userId, assetId: input.assetId });
    const programme = this.issuer.programme;

    const rows = await transaction(this.sql, async (tx) => {
      // The count limit and the insert under one per-person lock, so two orders at once cannot both take the last place.
      // A retried order of a card that already exists is that card, whatever the count says now.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`card-count:${input.userId}`}))`;
      if (limits) {
        const already = await tx<Array<{ id: string }>>`SELECT id FROM bank.cards WHERE id = ${input.cardId}`;
        if (already.length === 0) await this.assertUnderCount(tx, input.userId, cardType, limits[cardType]);
      }
      return tx<CardRow[]>`
        INSERT INTO bank.cards (
          id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, cashback_bps, per_authorization_limit,
          card_type, shipping_address, activated_at, uses_allowed, design_id, delivery_speed, residence_country
        )
        VALUES (
          ${input.cardId}, ${input.userId}, ${input.assetId}, ${settlementAssetId}, ${programme.id}, ${programme.simulated},
          ${handle.issuerRef}, ${handle.panTail}, ${input.cashbackBps ?? 0},
          ${formatAmount(input.perAuthorizationLimit)}::numeric,
          ${cardType}, ${shipping === null ? null : JSON.stringify(shipping)}::jsonb,
          ${input.activated === false ? null : this.clock()}, ${input.usesAllowed ?? null}, ${input.designId ?? null},
          ${input.deliverySpeed ?? null}, ${input.residenceCountry ?? null}
        )
        ON CONFLICT (issuer, issuer_ref) DO NOTHING
        RETURNING id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by, activated_at, uses_allowed, design_id, delivery_speed, residence_country
    `;
    });
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
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by, activated_at, uses_allowed, design_id, delivery_speed, residence_country FROM bank.cards WHERE id = ${cardId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Card ${cardId} not found`, 'bank.card_not_found');
    return toCard(row);
  }

  async cardsOf(userId: string, limit?: number): Promise<CardRecord[]> {
    return this.cardsPage(userId, assertCardsListLimit(limit));
  }

  /**
   * One page of a person's cards, newest first. `page` is a size `assertCardsListLimit` already returned (1 to 200); the
   * caller checks it once, before anything else it does (the console's read checks it before its audit line).
   */
  async cardsPage(userId: string, page: number): Promise<CardRecord[]> {
    const rows = await this.sql<CardRow[]>`
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by, activated_at, uses_allowed, design_id, delivery_speed, residence_country FROM bank.cards WHERE user_id = ${userId} ORDER BY created_at DESC
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
   *
   * `actorUserId` is who asked: the owner by default, or a holder of a shared pot the card is linked to, whose freeze is
   * recorded as `holder`. When the status really changes, `onStatusChanged` hears it in the row's own transaction.
   */
  async setStatus(cardId: string, status: CardRecord['status'], actorUserId?: string): Promise<CardRecord> {
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
    const actor = actorUserId ?? card.userId;
    const frozenBy = status === 'frozen' ? (actor === card.userId ? 'owner' : 'holder') : null;
    await transaction(this.sql, async (tx) => {
      const changed = await this.updateStatus(tx, cardId, tx`status = ${status}, frozen_by = ${frozenBy}`, status);
      if (changed && this.onStatusChanged) {
        await this.onStatusChanged(tx, { cardId, ownerUserId: card.userId, actor: { userId: actor }, status });
      }
    });
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
        SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by, activated_at, uses_allowed, design_id, delivery_speed, residence_country
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
      // The row is locked above, so this is the status it had.
      if (card.status !== input.status && this.onStatusChanged) {
        await this.onStatusChanged(tx, { cardId: card.id, ownerUserId: card.userId, actor: 'operator', status: input.status });
      }
      await tx`
        INSERT INTO bank.card_operator_commands (client_request_id, card_id, target_status, reason, result_status, frozen_by)
        VALUES (${input.clientRequestId}, ${card.id}, ${input.status}, ${reason}, ${input.status}, ${frozenBy})
      `;
      return { cardId: card.id, status: input.status, frozenBy };
    });
  }

  /**
   * Programme funding (J-bank-26 #6): who funds the programme and the reserve come from `partnerTerms()`; this is the rest.
   * The settlement reconciliation of the app's records against the partner's figures, per funding asset; the stablecoin
   * conversion of each into the funding asset the partner reports; which of fund, defund and auto reload the partner
   * offers; and the instructions already sent. Reads only. No issuer refuses `bank.no_card_issuer`.
   */
  async programmeFunding(): Promise<ProgrammeFundingView> {
    const terms = this.partnerTerms();
    const app = await this.appProgrammeFigures();
    const assets = [...new Set([...app.keys(), ...Object.keys(terms.programmeFigures ?? {})])];
    const marks = terms.fundingAssetId ? await this.displayMarks(assets, terms.fundingAssetId) : new Map<string, DisplayMark>();
    const requests = await this.sql<FundingRow[]>`
      SELECT client_request_id, kind, asset_id, amount::text AS amount, threshold::text AS threshold, partner_ref, approved_at, created_at
        FROM bank.card_programme_funding_requests WHERE partner_ref IS NOT NULL
       ORDER BY created_at DESC, client_request_id LIMIT 20
    `;
    return {
      test: terms.test,
      fundingAssetId: terms.fundingAssetId,
      offers: fundingOfferStates(terms),
      rows: reconcileProgramme(app, terms.programmeFigures, marks),
      requests: requests.map(toFundingRequest),
    };
  }

  /**
   * One programme funding instruction to the card partner (J-bank-26 #6), after a second founder approved it. Refuses
   * before the approval is used when the partner does not offer the kind (`bank.card_funding_not_offered`) or the amount is
   * not positive (`bank.card_funding_invalid`). The same client request id replays the first answer. The partner is told
   * under the same key, so a crash between its answer and our record repeats one instruction, not two. Nothing posts.
   */
  async requestProgrammeFunding(input: {
    kind: FundingKind;
    amount: string;
    threshold: string | null;
    reason: string;
    clientRequestId: string;
    consume: () => Promise<void>;
  }): Promise<ProgrammeFundingRequest> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new BankError(
        'A programme funding request needs a reason of at least 10 characters (bank.ops_reason_too_short)',
        'bank.ops_reason_too_short',
      );
    }
    const amount = positiveOrRefuse(input.amount, 'amount');
    const threshold = input.kind === 'auto_reload' ? positiveOrRefuse(input.threshold ?? '', 'threshold') : null;
    if (input.kind !== 'auto_reload' && input.threshold !== null) {
      throw new BankError('Only auto reload takes a threshold (bank.card_funding_invalid)', 'bank.card_funding_invalid');
    }
    const fields = { kind: input.kind, amount: formatAmount(amount), threshold: threshold === null ? null : formatAmount(threshold) };
    let row = await this.fundingRow(input.clientRequestId);
    if (row) assertSameFunding(row, fields);
    if (row?.partner_ref) return toFundingRequest(row);
    const assetId = assertFundingOffered(this.partnerTerms(), input.kind);
    if (!this.issuer.programmeFunding) {
      throw new BankError(
        'The card partner takes no programme funding instructions (bank.card_funding_not_offered)',
        'bank.card_funding_not_offered',
      );
    }
    // The instruction is written down BEFORE the approval is used and marked approved after it, so a crash leaves a row
    // saying how far it got: not yet approved (a retry asks for the approval again), or approved and not yet answered (a
    // retry tells the partner again under the same key, which the partner deduplicates, and uses no second approval).
    if (!row) {
      await this.sql`
        INSERT INTO bank.card_programme_funding_requests (client_request_id, kind, asset_id, amount, threshold, reason)
        VALUES (${input.clientRequestId}, ${input.kind}, ${assetId}, ${fields.amount}::numeric, ${fields.threshold}::numeric, ${reason})
        ON CONFLICT (client_request_id) DO NOTHING
      `;
      row = (await this.fundingRow(input.clientRequestId))!;
      assertSameFunding(row, fields);
    }
    if (!row.approved_at) {
      await input.consume();
      await this.sql`
        UPDATE bank.card_programme_funding_requests SET approved_at = now()
         WHERE client_request_id = ${input.clientRequestId} AND approved_at IS NULL
      `;
    }
    const { partnerRef } = await this.issuer.programmeFunding({
      requestId: `card-funding:${input.clientRequestId}`,
      kind: input.kind,
      assetId: row.asset_id,
      amount: fields.amount,
      threshold: fields.threshold,
    });
    await this.sql`
      UPDATE bank.card_programme_funding_requests SET partner_ref = ${partnerRef}
       WHERE client_request_id = ${input.clientRequestId} AND partner_ref IS NULL
    `;
    return toFundingRequest((await this.fundingRow(input.clientRequestId))!);
  }

  private async fundingRow(clientRequestId: string): Promise<FundingRow | null> {
    const [r] = await this.sql<FundingRow[]>`
      SELECT client_request_id, kind, asset_id, amount::text AS amount, threshold::text AS threshold, partner_ref, approved_at, created_at
        FROM bank.card_programme_funding_requests WHERE client_request_id = ${clientRequestId}
    `;
    return r ?? null;
  }

  /**
   * The app's own programme figures per funding asset (J-bank-26 #5, #6): open holds (what each posted hold still holds, after
   * every settled capture and reversal against it) and settled captures. Both in the card's funding asset, as the ledger moved them.
   */
  async appProgrammeFigures(): Promise<Map<string, AppProgrammeFigure>> {
    const rows = await this.sql<Array<{ asset_id: string; held: string; captured: string }>>`
      SELECT k.asset_id,
             -- What each posted hold still holds: its amount less every settled capture and reversal against it.
             COALESCE(SUM(GREATEST(a.amount - COALESCE((
               SELECT SUM(s.amount) FROM bank.card_settlements s WHERE s.authorization_id = a.id AND s.status = 'settled'
             ), 0), 0)) FILTER (WHERE a.decision = 'approved' AND a.status = 'settled'), 0)::text AS held,
             COALESCE((
               SELECT SUM(s.amount) FROM bank.card_settlements s
                 JOIN bank.card_authorizations a2 ON a2.id = s.authorization_id
                 JOIN bank.cards k2 ON k2.id = a2.card_id
                WHERE k2.asset_id = k.asset_id AND s.kind = 'capture' AND s.status = 'settled'
             ), 0)::text AS captured
        FROM bank.card_authorizations a
        JOIN bank.cards k ON k.id = a.card_id
       GROUP BY k.asset_id
    `;
    return new Map(rows.map((r) => [r.asset_id, { held: parseAmount(r.held), captured: parseAmount(r.captured) }]));
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
        card_type, shipping_address, replaces_card_id, activated_at, uses_allowed, design_id, delivery_speed, residence_country
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
        ${card.id}, ${card.cardType === 'physical' ? null : this.clock()}, ${card.usesAllowed ?? null}, ${card.designId ?? null}, ${card.deliverySpeed ?? null},
        ${card.residenceCountry ?? null}
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
      const strandedHold =
        already.decision === 'approved' &&
        already.status === 'pending' &&
        (already.heldBy === 'partner' ? already.partnerHoldRef === null : already.holdLedgerTxId === null);
      if (!strandedHold) return already;
      return this.redriveHold(card, already);
    }

    // WHOSE BOOK (OWNER 226), decided before anything is written. `none` refuses by name: no partner holds this person's
    // money and the custodial layer is off, so there is nowhere honest to hold it. On the partner path the partner must
    // have said how it holds and what the person has, or nothing is decided: a decline is an answer, and nobody gave one.
    const heldBy = this.heldByOf(card.userId);
    if (heldBy === 'none') throw partnerUnset();
    const partnerAvailable = heldBy === 'partner' ? await this.partnerAvailable(card) : null;

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

        const declineCode = await this.declineReason(card, fundingAmount, channel, partnerAvailable);

        if (declineCode) {
          span.setAttribute('intafaced.card_decision', 'declined');
          const declined = await this.recordDecision({
            card,
            input: { ...input, channel },
            fundingAmount,
            quote,
            decision: 'declined',
            declineCode,
            heldBy,
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
          heldBy,
        });
        if (claimed.decision === 'declined') {
          // The card's use limit was reached under its lock (or a redelivery found a decline): an answer, told once.
          span.setAttribute('intafaced.card_decision', 'declined');
          if (claimed.declineCode === 'bank.card_use_limit_reached') {
            await this.tellIssuer(card, claimed, { decision: 'declined', reason: claimed.declineCode });
          }
          return claimed;
        }
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
    if (claimed.heldBy === 'partner') return this.commitPartnerHold(card, claimed, merchantAmount);
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
  private async declineReason(
    card: CardRecord,
    fundingAmount: Amount,
    channel: CardChannel,
    partnerAvailable: Amount | null = null,
  ): Promise<string | null> {
    if (card.status !== 'active' || cardInactive(card)) return 'bank.card_not_active';
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

    // A partner-held person's money is the partner's figure, never a read of our ledger (which holds none of it). The
    // partner's own hold answer is still the one that decides, as the ledger's post is on the custodial path.
    if (partnerAvailable !== null) return partnerAvailable < fundingAmount ? 'bank.card_partner_insufficient_funds' : null;
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
    if (authorization.heldBy === 'partner') return this.capturePartnerHeld(card, authorization, input.amount);
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
        await this.closeWhenUsedUp(card);

        return {
          authorizationId: authorization.id,
          captured: capturedFunding,
          returned: remainder,
          captureLedgerTxId: captureTxId,
          reversalLedgerTxId: reversalTxId,
          heldBy: 'ledger',
          partner: null,
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
  async reverse(input: { cardId: string; authorizationRef: string }): Promise<{
    returned: Amount;
    /** Null on a partner-held authorisation: the partner released it, and `partner` says how. */
    ledgerTxId: string | null;
    partner?: { readonly releaseRef: string; readonly by: 'instruction' | 'expiry'; readonly figures: PartnerCardFigures | null };
  }> {
    const card = await this.card(input.cardId);
    const authorization = await this.requireOpenAuthorization(card, input.authorizationRef, 'reversal');
    if (authorization.heldBy === 'partner') return this.releasePartnerHeld(card, authorization);

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

  // ── Partner-held authorisations (OWNER 226; `partner-card-holds.ts`) ──────
  //
  // IF THE PROCESS DIES EXACTLY HERE, WHOSE FUNDS ARE STRANDED? None of them are in our book: the partner holds the
  // money, and every instruction goes under a key derived from our authorisation id, so a re-drive asks the partner the
  // same question and gets the same answer.
  //
  //   after the decision row, before the partner's hold answer: the row is `approved` and `pending` with no partner
  //     reference. A redelivery re-sends `card.partner.hold:<id>`, and the partner holds once.
  //   after the partner held, before the row is marked: the same re-send finds the partner's first answer.
  //   after a capture claim, before the partner's answer: `resumeSettlements` re-sends `card.partner.capture:<id>`.
  //   a partner's refusal (`PartnerCardRefusal`) moved nothing: the claim is `rejected`, and the next ask retires it.

  private requirePartnerHolds(): PartnerCardHolds {
    if (!this.partnerHolds) {
      throw new BankError(
        'This card money is held by the partner, but the card programme has no partner that holds authorisations. Nothing was decided.',
        'bank.card_partner_holds_unset',
      );
    }
    return this.partnerHolds;
  }

  /** The partner's spendable figure, read before anything is written. Mode or balance not known refuses; nothing is decided. */
  private async partnerAvailable(card: CardRecord): Promise<Amount> {
    const figures = await this.requirePartnerHolds().figures({ userId: card.userId, assetId: card.assetId });
    if (figures.mode === null) {
      throw new BankError(
        'The card partner has not said whether it holds the crypto or pulls from the wallet. Nothing was decided.',
        'bank.card_partner_mode_not_known',
      );
    }
    if (figures.available === null) {
      throw new BankError(
        `The card partner reports no ${card.assetId} balance, so nothing can be held. Nothing was decided.`,
        'bank.card_partner_balance_not_known',
      );
    }
    return parseAmount(figures.available);
  }

  /**
   * The partner holds the claimed amount from the partner balance, once under `card.partner.hold:<authorisation>`. Our
   * ledger posts nothing. The partner's no is a decline (an answer); anything else it throws leaves the row `pending` for
   * a redelivery to re-send the same key, exactly as an unreachable ledger does on the custodial path.
   */
  private async commitPartnerHold(card: CardRecord, claimed: AuthorizationRecord, merchantAmount: Amount): Promise<AuthorizationRecord> {
    const decline = async (reason: string): Promise<AuthorizationRecord> => {
      await this.sql`
        UPDATE bank.card_authorizations
           SET decision = 'declined', decline_code = ${reason}, status = 'rejected'
         WHERE id = ${claimed.id} AND status = 'pending'
      `;
      const declined = (await this.authorizationByRef(card.id, claimed.authorizationRef))!;
      await this.tellIssuer(card, declined, { decision: 'declined', reason });
      return declined;
    };
    let answer: Awaited<ReturnType<PartnerCardHolds['hold']>>;
    try {
      answer = await this.requirePartnerHolds().hold({
        key: partnerCardKey('hold', claimed.id),
        userId: card.userId,
        assetId: card.assetId,
        amount: formatAmount(claimed.amount),
      });
    } catch (err) {
      // The partner's own refusal to hold (its mode or balance gone unknown since the read) proves nothing is held: the
      // purchase cannot go through, and that is told as a decline naming the partner's reason, never left pending to be
      // re-driven into the same refusal. Any other error may follow a hold the partner made: pending, re-sent on redelivery.
      if (err instanceof PartnerCardRefusal && err.code !== 'bank.card_partner_key_conflict') return decline(err.code);
      throw err;
    }
    if (!answer.approved) return decline(answer.reason);
    if (parseAmount(answer.hold.amount) !== claimed.amount) {
      throw new BankError(
        `The card partner holds ${answer.hold.amount} under this authorisation's key, not ${formatAmount(claimed.amount)}`,
        'bank.card_partner_key_conflict',
      );
    }
    await this.sql`
      UPDATE bank.card_authorizations
         SET status = 'settled', partner_hold_ref = ${answer.hold.partnerRef}, partner_mode = ${answer.hold.mode}, settled_at = now()
       WHERE id = ${claimed.id}
    `;
    const approved = (await this.authorizationByRef(card.id, claimed.authorizationRef))!;
    await this.tellIssuer(card, approved, { decision: 'approved', amount: merchantAmount });
    return approved;
  }

  /**
   * One partner instruction against a partner-held authorisation: claim the settlement row, send, mark it with the
   * partner's reference. The same claim rules as `settlement` (one kind and one amount per sequence), with one
   * difference: a partner's refusal moved nothing, so a `rejected` claim is retired and claimed again for what is asked
   * now (a capture refused above the hold, then asked within it).
   */
  private async partnerSettlement(input: {
    authorization: AuthorizationRecord;
    sequence: number;
    kind: 'capture' | 'reversal';
    amount: Amount;
    send: () => Promise<PartnerMoveAnswer>;
  }): Promise<{ partnerRef: string; answer: PartnerMoveAnswer | null }> {
    const claim = await transaction(
      this.sql,
      async (tx) => {
        const insert = () => tx<Array<{ id: string }>>`
          INSERT INTO bank.card_settlements (authorization_id, sequence, kind, amount, money_book)
          VALUES (${input.authorization.id}, ${input.sequence}, ${input.kind}, ${formatAmount(input.amount)}::numeric, 'partner')
          ON CONFLICT (authorization_id, sequence) DO NOTHING
          RETURNING id
        `;
        const fresh = await insert();
        if (fresh[0]) return { id: fresh[0].id, partnerRef: null };
        const [prior] = await tx<
          Array<{ id: string; kind: 'capture' | 'reversal'; amount: string; status: string; partner_ref: string | null }>
        >`
          SELECT id, kind, amount::text AS amount, status, partner_ref FROM bank.card_settlements
           WHERE authorization_id = ${input.authorization.id} AND sequence = ${input.sequence}
           FOR UPDATE
        `;
        if (prior!.status === 'rejected') {
          await tx`DELETE FROM bank.card_settlements WHERE id = ${prior!.id} AND status = 'rejected'`;
          const again = await insert();
          return { id: again[0]!.id, partnerRef: null };
        }
        if (prior!.kind !== input.kind) {
          throw new BankError(
            `Settlement ${input.sequence} on this authorisation was claimed as ${prior!.kind}, not ${input.kind}`,
            'bank.card_settlement_kind_conflict',
          );
        }
        if (parseAmount(prior!.amount) !== input.amount) {
          throw new BankError(
            `Settlement ${input.sequence} on this authorisation was claimed for ${prior!.amount}, not ${formatAmount(input.amount)}`,
            'bank.card_settlement_amount_conflict',
          );
        }
        return { id: prior!.id, partnerRef: prior!.status === 'settled' ? prior!.partner_ref : null };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
    if (claim.partnerRef) return { partnerRef: claim.partnerRef, answer: null };

    let answer: PartnerMoveAnswer;
    try {
      answer = await input.send();
    } catch (err) {
      // Only the partner's own no proves nothing moved there. Anything else may follow an instruction it carried out:
      // the claim stays `pending` and a retry re-sends the same key.
      if (err instanceof PartnerCardRefusal) {
        await this.sql`
          UPDATE bank.card_settlements SET status = 'rejected', rejection_code = ${err.code}
           WHERE id = ${claim.id} AND status = 'pending'
        `;
      }
      throw err;
    }
    if (parseAmount(answer.amount) !== input.amount) {
      throw new BankError(
        `The card partner moved ${answer.amount} under this ${input.kind}'s key, not ${formatAmount(input.amount)}`,
        'bank.card_partner_key_conflict',
      );
    }
    await this.sql`
      UPDATE bank.card_settlements SET status = 'settled', partner_ref = ${answer.partnerRef}, settled_at = now() WHERE id = ${claim.id}
    `;
    return { partnerRef: answer.partnerRef, answer };
  }

  /**
   * The partner captures what the merchant took, and gives the rest of its hold back: two instructions, each once under
   * its key, the same two steps as the custodial path. Above the hold is the partner's to refuse (J-bank-14's Money line),
   * and it does (`bank.card_partner_capture_exceeds_hold`). Nothing posts to our ledger, so no cashback and no round-up,
   * which both pay from our book: each reads `bank.card_partner_held`.
   */
  private async capturePartnerHeld(card: CardRecord, authorization: AuthorizationRecord, merchantAmount: Amount): Promise<CaptureResult> {
    if (merchantAmount <= 0n) {
      throw new BankError(`Capture of ${formatAmount(merchantAmount)} is not above zero`, 'bank.card_capture_exceeds_authorization');
    }
    const partner = this.requirePartnerHolds();
    const conversion = authorization.conversion;
    // On a converted card the partner sees funding units only, so the merchant's own ceiling is ours to keep: rounding
    // through the frozen rate must never let a merchant take more in their currency than was authorised. On a same-asset
    // card the hold is the ceiling, and the partner refuses above it (J-bank-14's Money line).
    if (conversion && merchantAmount > conversion.settlementAmount) {
      throw new BankError(
        `Capture of ${formatAmount(merchantAmount)} exceeds the authorised ${formatAmount(conversion.settlementAmount)}`,
        'bank.card_capture_exceeds_authorization',
      );
    }
    // The frozen rate, re-read, as on the custodial path. The partner holds the funding amount.
    const capturedFunding = conversion ? fundingFor(merchantAmount, conversion.rate) : merchantAmount;
    const holdKey = partnerCardKey('hold', authorization.id);
    return withMoneySpan(
      'bank.card.capture',
      { operation: 'card-capture', cardId: card.id, amount: formatAmount(capturedFunding), assetId: card.assetId },
      async () => {
        const captured = await this.partnerSettlement({
          authorization,
          sequence: 0,
          kind: 'capture',
          amount: capturedFunding,
          send: () => partner.capture({ key: partnerCardKey('capture', authorization.id), holdKey, amount: formatAmount(capturedFunding) }),
        });
        const remainder = authorization.amount - capturedFunding;
        const released =
          remainder > 0n
            ? await this.partnerSettlement({
                authorization,
                sequence: 1,
                kind: 'reversal',
                amount: remainder,
                send: () => partner.release({ key: partnerCardKey('release', authorization.id), holdKey }),
              })
            : null;
        await this.closeWhenUsedUp(card);
        return {
          authorizationId: authorization.id,
          captured: capturedFunding,
          returned: remainder,
          captureLedgerTxId: null,
          reversalLedgerTxId: null,
          heldBy: 'partner',
          partner: {
            captureRef: captured.partnerRef,
            releaseRef: released?.partnerRef ?? null,
            // The partner's figures from its own last answer: no second read after the money moved, so a read that fails
            // can never report a completed capture as failed.
            figures: (released ?? captured).answer?.figures ?? null,
          },
          cashback: { status: 'refused', amount: 0n, reason: 'bank.card_partner_held' },
          roundUp: { status: 'skipped', amount: 0n, reason: 'bank.card_partner_held' },
          settlement: conversion ? { assetId: conversion.settlementAssetId, amount: merchantAmount, rate: conversion.rate } : null,
        };
      },
    );
  }

  /**
   * The partner gives the whole hold back, once under `card.partner.release:<authorisation>`. If its hold time already ran
   * out, the partner had given it back itself, and says so (`by: 'expiry'`); this records that answer once.
   */
  private async releasePartnerHeld(
    card: CardRecord,
    authorization: AuthorizationRecord,
  ): Promise<{
    returned: Amount;
    ledgerTxId: null;
    partner: { releaseRef: string; by: 'instruction' | 'expiry'; figures: PartnerCardFigures | null };
  }> {
    const partner = this.requirePartnerHolds();
    const holdKey = partnerCardKey('hold', authorization.id);
    return withMoneySpan(
      'bank.card.reverse',
      { operation: 'card-reverse', cardId: card.id, amount: formatAmount(authorization.amount), assetId: card.assetId },
      async () => {
        const released = await this.partnerSettlement({
          authorization,
          sequence: 0,
          kind: 'reversal',
          amount: authorization.amount,
          send: () => partner.release({ key: partnerCardKey('release', authorization.id), holdKey }),
        });
        // A replay of a release already recorded has no fresh answer: how it happened is read from the partner's report.
        const by = released.answer
          ? released.answer.by
          : (await partner.holdState({ holdKey }).catch(() => null))?.status === 'expired'
            ? 'expiry'
            : 'instruction';
        return {
          returned: authorization.amount,
          ledgerTxId: null,
          partner: { releaseRef: released.partnerRef, by, figures: released.answer?.figures ?? null },
        };
      },
    );
  }

  /** `resumeSettlements` on a partner-held authorisation: re-send each unsettled claim under its key; `held` is the partner's. */
  private async resumePartnerHeld(authorization: AuthorizationRecord): Promise<{
    authorizationId: string;
    resumed: Array<{
      sequence: number;
      kind: 'capture' | 'reversal';
      amount: Amount;
      outcome: 'settled' | 'failed';
      partnerRef?: string;
      reason?: string;
    }>;
    held: Amount;
  }> {
    const partner = this.requirePartnerHolds();
    const holdKey = partnerCardKey('hold', authorization.id);
    // Pending claims only. A `rejected` one is the partner's answer to that ask (a capture above the hold, a hold already
    // closed): re-sending it would only ask the same question again. A new ask for a different amount retires it.
    const rows = await this.sql<Array<{ sequence: number; kind: 'capture' | 'reversal'; amount: string }>>`
      SELECT sequence, kind, amount::text AS amount FROM bank.card_settlements
       WHERE authorization_id = ${authorization.id} AND status = 'pending'
       ORDER BY sequence ASC
    `;
    const resumed: Array<{
      sequence: number;
      kind: 'capture' | 'reversal';
      amount: Amount;
      outcome: 'settled' | 'failed';
      partnerRef?: string;
      reason?: string;
    }> = [];
    for (const row of rows) {
      const amount = parseAmount(row.amount);
      try {
        const done = await this.partnerSettlement({
          authorization,
          sequence: row.sequence,
          kind: row.kind,
          amount,
          send: () =>
            row.kind === 'capture'
              ? partner.capture({ key: partnerCardKey('capture', authorization.id), holdKey, amount: formatAmount(amount) })
              : partner.release({ key: partnerCardKey('release', authorization.id), holdKey }),
        });
        resumed.push({ sequence: row.sequence, kind: row.kind, amount, outcome: 'settled', partnerRef: done.partnerRef });
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
    const report = await partner.holdState({ holdKey });
    if (!report) {
      throw new BankError(
        `The card partner has no record of the hold for ${authorization.authorizationRef}`,
        'bank.card_partner_hold_not_found',
      );
    }
    return { authorizationId: authorization.id, resumed, held: parseAmount(report.open) };
  }

  /**
   * A MERCHANT'S REFUND of a partner-held capture: the partner gives `amount` of what it captured back to the partner
   * balance, once under `card.partner.refund:<authorisation>`. One refund per authorisation. Above what was captured, the
   * partner refuses. Nothing posts to our ledger. On a custodial (ledger) authorisation a refund is not built: it refuses
   * `bank.card_refund_not_built`, as before (see WHAT IS NOT HERE at the top of this file).
   */
  async refund(input: { cardId: string; authorizationRef: string; amount: Amount }): Promise<PartnerRefundResult> {
    this.assertIssuerMayMutate();
    const card = await this.card(input.cardId);
    const authorization = await this.requireApprovedAuthorization(card, input.authorizationRef);
    if (authorization.heldBy !== 'partner') {
      throw new BankError('A refund on a card held in INTAFACED’s own ledger is not built. Nothing moved.', 'bank.card_refund_not_built');
    }
    if (input.amount <= 0n) {
      throw new BankError('A refund is an amount above zero. Nothing moved.', 'bank.card_refund_amount_conflict');
    }
    const [captured] = await this.sql<Array<{ n: number }>>`
      SELECT 1 AS n FROM bank.card_settlements
       WHERE authorization_id = ${authorization.id} AND sequence = 0 AND kind = 'capture' AND status = 'settled'
    `;
    if (!captured) {
      throw new BankError(`Authorisation ${input.authorizationRef} has no settled capture to refund`, 'bank.card_refund_nothing_captured');
    }
    const partner = this.requirePartnerHolds();
    const claim = await transaction(
      this.sql,
      async (tx) => {
        const fresh = await tx<Array<{ authorization_id: string }>>`
          INSERT INTO bank.card_partner_refunds (authorization_id, amount)
          VALUES (${authorization.id}, ${formatAmount(input.amount)}::numeric)
          ON CONFLICT (authorization_id) DO NOTHING
          RETURNING authorization_id
        `;
        if (fresh[0]) return { partnerRef: null };
        const [prior] = await tx<Array<{ amount: string; status: string; partner_ref: string | null }>>`
          SELECT amount::text AS amount, status, partner_ref FROM bank.card_partner_refunds
           WHERE authorization_id = ${authorization.id} FOR UPDATE
        `;
        if (prior!.status === 'rejected') {
          // The partner said no and nothing moved: this ask replaces it.
          await tx`
            UPDATE bank.card_partner_refunds
               SET amount = ${formatAmount(input.amount)}::numeric, status = 'pending', rejection_code = NULL
             WHERE authorization_id = ${authorization.id}
          `;
          return { partnerRef: null };
        }
        if (parseAmount(prior!.amount) !== input.amount) {
          throw new BankError(
            `This authorisation's refund was asked for ${prior!.amount}, not ${formatAmount(input.amount)}`,
            'bank.card_refund_amount_conflict',
          );
        }
        return { partnerRef: prior!.status === 'settled' ? prior!.partner_ref : null };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
    if (claim.partnerRef) {
      return { authorizationId: authorization.id, refunded: input.amount, partnerRef: claim.partnerRef, figures: null };
    }
    let answer: PartnerMoveAnswer;
    try {
      answer = await partner.refund({
        key: partnerCardKey('refund', authorization.id),
        holdKey: partnerCardKey('hold', authorization.id),
        amount: formatAmount(input.amount),
      });
    } catch (err) {
      if (err instanceof PartnerCardRefusal) {
        await this.sql`
          UPDATE bank.card_partner_refunds SET status = 'rejected', rejection_code = ${err.code}
           WHERE authorization_id = ${authorization.id} AND status = 'pending'
        `;
      }
      throw err;
    }
    if (parseAmount(answer.amount) !== input.amount) {
      throw new BankError(
        `The card partner refunded ${answer.amount} under this refund's key, not ${formatAmount(input.amount)}`,
        'bank.card_partner_key_conflict',
      );
    }
    await this.sql`
      UPDATE bank.card_partner_refunds SET status = 'settled', partner_ref = ${answer.partnerRef}, settled_at = now()
       WHERE authorization_id = ${authorization.id}
    `;
    return { authorizationId: authorization.id, refunded: input.amount, partnerRef: answer.partnerRef, figures: answer.figures };
  }

  /**
   * What the card partner reports for this card (J-bank-14's hold, capture and release steps): whose book a new
   * authorisation would be held in now, the partner's figures for the card's asset, and each partner-held authorisation
   * as the partner reports it now (held, captured, released by an instruction, or given back on expiry). Reads only:
   * nothing here is summed into a balance of ours, and a partner with no record of a hold reads null, never 0.
   */
  async partnerHeld(
    cardId: string,
    limit?: number,
  ): Promise<{ heldBy: MoneyHeldBy; figures: PartnerCardFigures | null; authorizations: PartnerHeldAuthorization[] }> {
    const card = await this.card(cardId);
    const page = assertCardAuthorizationsListLimit(limit);
    const heldBy = this.heldByOf(card.userId);
    const partner = this.partnerHolds;
    const rows = await this.sql<Array<{ id: string; authorization_ref: string; amount: string }>>`
      SELECT id, authorization_ref, amount::text AS amount FROM bank.card_authorizations
       WHERE card_id = ${card.id} AND money_book = 'partner' AND decision = 'approved' AND partner_hold_ref IS NOT NULL
       ORDER BY decided_at DESC
       LIMIT ${page}
    `;
    const authorizations: PartnerHeldAuthorization[] = await Promise.all(
      rows.map(async (row) => ({
        authorizationId: row.id,
        authorizationRef: row.authorization_ref,
        amount: parseAmount(row.amount),
        report: partner ? await partner.holdState({ holdKey: partnerCardKey('hold', row.id) }) : null,
      })),
    );
    return {
      heldBy,
      figures: partner ? await partner.figures({ userId: card.userId, assetId: card.assetId }) : null,
      authorizations,
    };
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
      /** On a partner-held authorisation: the partner's reference for the re-sent instruction. */
      partnerRef?: string;
      reason?: string;
    }>;
    held: Amount;
  }> {
    const card = await this.card(input.cardId);
    const authorization = await this.requireApprovedAuthorization(card, input.authorizationRef);
    if (authorization.heldBy === 'partner') return this.resumePartnerHeld(authorization);

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
    // A settled capture whose cashback was never claimed (the tier could not be read, or the tier had no rate then) is
    // earned now, once, at the rate in force now: `payCashback` claims the row on the authorisation's key.
    await this.earnMissingCashback(card, authorization);

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
    // The test stack's stand-in (J-bank-13 #7): the simulator pays, from the same pot and recipe, only when the boot-guarded
    // TEST switch is on and the card is the simulator's own. Never in production: the switch refuses to start there.
    if (this.simulatorPays && programme.id === 'card-sim' && card.issuer === 'card-sim') return true;
    if (programme.simulated || card.simulated) return false;
    if (programme.id === 'none' || programme.id === 'card-sim') return false;
    if (card.issuer === 'none' || card.issuer === 'card-sim') return false;
    return card.issuer === programme.id;
  }

  /**
   * The rate this capture earns (RC-bank-02). An operator's per-card rate wins when one was set; otherwise the owner's
   * rate for the person's rank card tier, on a card funded in the table's asset. Null means no rate applies (another
   * asset, no table): nothing is earned. A tier with no published rate, or no tier read, refuses by name.
   */
  private async cashbackRate(card: CardRecord): Promise<{ bps: number } | { refused: string }> {
    if (card.cashbackBps > 0) return { bps: card.cashbackBps };
    const rates = this.cashbackRates;
    if (!rates || rates.assetId !== card.assetId) return { bps: 0 };
    let tier: CardTier;
    try {
      tier = await this.rankTier.cardTierOf(card.userId);
    } catch (err) {
      return { refused: err instanceof BankError ? err.code : 'bank.rank_unavailable' };
    }
    const bps = rates.rates[tier];
    return bps === undefined ? { refused: 'bank.cashback_rate_unset' } : { bps };
  }

  private async payCashback(card: CardRecord, authorization: AuthorizationRecord, captured: Amount): Promise<CashbackOutcome> {
    type CashbackRow = { id: string; status: string; ledger_tx_id: string | null; amount: string; rejection_code: string | null };
    const readRow = async () =>
      (
        await this.sql<CashbackRow[]>`
          SELECT id, status, ledger_tx_id, amount::text AS amount, rejection_code
            FROM bank.card_cashback WHERE authorization_id = ${authorization.id}
        `
      )[0];

    // A row already claimed for this authorisation is the decision: its amount, never a re-rate.
    let row = await readRow();
    if (!row) {
      // No issuer pays (and no TEST stand-in): name that, before any call to identity for a tier that could not be paid.
      if (!this.rewardsIssuerConnected(card)) {
        const own = cashbackOn(captured, card.cashbackBps);
        const tierApplies = card.cashbackBps === 0 && this.cashbackRates?.assetId === card.assetId;
        if (own <= 0n && !tierApplies) return { status: 'none', amount: 0n };
        return { status: 'refused', amount: own, reason: 'bank.rewards_issuer_unset' };
      }
      const rate = await this.cashbackRate(card);
      if ('refused' in rate) return { status: 'refused', amount: 0n, reason: rate.refused };
      const amount = cashbackOn(captured, rate.bps);
      // Zero is not a refusal and not a payment. A card with no cashback rate, or
      // a purchase too small to earn one atomic unit at that rate, earns nothing —
      // and posting a zero-value transaction to say so would be noise in the book.
      if (amount <= 0n) return { status: 'none', amount: 0n };

      // No issuer is connected. Do not call rewardPay and do not write a cashback
      // row — that row would be a rewards balance. The capture already stands.
      if (!this.rewardsIssuerConnected(card)) {
        return { status: 'refused', amount, reason: 'bank.rewards_issuer_unset' };
      }

      await this.sql`
        INSERT INTO bank.card_cashback (authorization_id, rate_bps, amount)
        VALUES (${authorization.id}, ${rate.bps}, ${formatAmount(amount)}::numeric)
        ON CONFLICT (authorization_id) DO NOTHING
      `;
      row = (await readRow())!;
    }

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
  private async earnMissingCashback(card: CardRecord, authorization: AuthorizationRecord): Promise<void> {
    const [capture] = await this.sql<Array<{ amount: string }>>`
      SELECT s.amount::text AS amount FROM bank.card_settlements s
       WHERE s.authorization_id = ${authorization.id} AND s.sequence = 0 AND s.kind = 'capture' AND s.status = 'settled'
         AND NOT EXISTS (SELECT 1 FROM bank.card_cashback cb WHERE cb.authorization_id = s.authorization_id)
    `;
    if (capture) await this.payCashback(card, authorization, parseAmount(capture.amount));
  }

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

  /**
   * The person's cashback by rank card tier (RC-bank-02, J-bank-13 #7): their tier and its rate, every tier's rate, the
   * asset it is paid in, what was paid on their spend (summed from settled reward records, each a ledger transaction) and
   * what was earned and not paid (a short pot, or a post not yet through). Refuses `bank.cashback_rate_unset` with no
   * table, `bank.rank_unavailable` with no tier. `paying` says whether this programme pays at all.
   */
  async cashbackSummary(userId: string): Promise<{
    tier: CardTier;
    rateBps: number | null;
    assetId: string;
    rates: Array<{ tier: CardTier; bps: number }>;
    paid: Amount;
    /** Earned and still being posted: a later pass pays it on the same key. */
    unpaid: Amount;
    /** Earned and refused because the pot was short (`bank.cashback_pot_unfunded`); not retried. */
    refused: Amount;
    payments: Array<{
      authorizationId: string;
      cardId: string;
      amount: Amount;
      status: string;
      rejectionCode: string | null;
      ledgerTxId: string | null;
    }>;
    paying: boolean;
    simulated: boolean;
  }> {
    const rates = this.cashbackRates;
    if (!rates) throw new BankError('The owner has not published cashback rates by card tier', 'bank.cashback_rate_unset');
    const tier = await this.rankTier.cardTierOf(userId);
    const programme = this.issuer.programme;
    // The same rule a capture uses, asked of a card of this programme.
    const paying = this.rewardsIssuerConnected({ issuer: programme.id, simulated: programme.simulated } as CardRecord);
    const rows = await this.sql<
      Array<{
        authorization_id: string;
        card_id: string;
        amount: string;
        status: string;
        rejection_code: string | null;
        ledger_tx_id: string | null;
      }>
    >`
      SELECT cb.authorization_id, a.card_id, cb.amount::text AS amount, cb.status, cb.rejection_code, cb.ledger_tx_id
        FROM bank.card_cashback cb
        JOIN bank.card_authorizations a ON a.id = cb.authorization_id
        JOIN bank.cards c ON c.id = a.card_id
       WHERE c.user_id = ${userId} AND c.asset_id = ${rates.assetId}
       ORDER BY cb.created_at DESC
       LIMIT 50
    `;
    // The totals over every reward record, not the 50 listed.
    const [totals] = await this.sql<Array<{ paid: string; unpaid: string; refused: string }>>`
      SELECT COALESCE(SUM(cb.amount) FILTER (WHERE cb.status = 'settled'), 0)::text AS paid,
             COALESCE(SUM(cb.amount) FILTER (WHERE cb.status = 'pending'), 0)::text AS unpaid,
             COALESCE(SUM(cb.amount) FILTER (WHERE cb.status = 'rejected'), 0)::text AS refused
        FROM bank.card_cashback cb
        JOIN bank.card_authorizations a ON a.id = cb.authorization_id
        JOIN bank.cards c ON c.id = a.card_id
       WHERE c.user_id = ${userId} AND c.asset_id = ${rates.assetId}
    `;
    return {
      tier,
      rateBps: rates.rates[tier] ?? null,
      assetId: rates.assetId,
      rates: CARD_TIERS.filter((t) => rates.rates[t] !== undefined).map((t) => ({ tier: t, bps: rates.rates[t]! })),
      paid: parseAmount(totals?.paid ?? '0'),
      unpaid: parseAmount(totals?.unpaid ?? '0'),
      refused: parseAmount(totals?.refused ?? '0'),
      payments: rows.map((r) => ({
        authorizationId: r.authorization_id,
        cardId: r.card_id,
        amount: parseAmount(r.amount),
        status: r.status,
        rejectionCode: r.rejection_code,
        ledgerTxId: r.ledger_tx_id,
      })),
      paying,
      simulated: programme.simulated,
    };
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
             a.hold_ledger_tx_id, a.money_book, a.partner_hold_ref, a.partner_mode, a.decided_at,
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
             a.hold_ledger_tx_id, a.money_book, a.partner_hold_ref, a.partner_mode, a.decided_at,
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
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by, activated_at, uses_allowed, design_id, delivery_speed, residence_country FROM bank.cards WHERE issuer = ${issuer} AND issuer_ref = ${issuerRef}
    `;
    return rows[0];
  }

  private async authorizationByRef(cardId: string, authorizationRef: string): Promise<AuthorizationRecord | null> {
    const rows = await this.sql<AuthorizationRow[]>`
      SELECT a.id, a.card_id, a.authorization_ref, a.amount, a.merchant_category, a.channel, a.decision, a.decline_code, a.status,
             a.hold_ledger_tx_id, a.money_book, a.partner_hold_ref, a.partner_mode, a.decided_at,
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
    heldBy: 'ledger' | 'partner';
  }): Promise<AuthorizationRecord> {
    await transaction(
      this.sql,
      async (tx) => {
        let decision = input.decision;
        let declineCode = input.declineCode;
        const usesAllowed = input.card.usesAllowed ?? null;
        if (decision === 'approved' && usesAllowed !== null) {
          // A SINGLE-USE OR N-USE CARD (BK-cissue-02). Under the card's row lock, every approval that has not been given
          // back whole counts as a use: a captured payment, and a hold still open. So the last allowed use is held from
          // the moment it is approved, and a second authorisation in flight declines rather than racing it.
          await tx`SELECT id FROM bank.cards WHERE id = ${input.card.id} FOR UPDATE`;
          const [used] = await tx<Array<{ n: number }>>`
            SELECT count(*)::int AS n
              FROM bank.card_authorizations a
             WHERE a.card_id = ${input.card.id}
               AND a.decision = 'approved'
               AND NOT EXISTS (
                 SELECT 1 FROM bank.card_settlements s
                  WHERE s.authorization_id = a.id AND s.sequence = 0 AND s.kind = 'reversal' AND s.status = 'settled'
               )
          `;
          if (Number(used?.n ?? 0) >= usesAllowed) {
            decision = 'declined';
            declineCode = 'bank.card_use_limit_reached';
          }
        }
        const claimed = await tx<Array<{ id: string }>>`
          INSERT INTO bank.card_authorizations (card_id, authorization_ref, amount, merchant_category, channel, decision, decline_code, status, money_book)
          VALUES (
            ${input.card.id}, ${input.input.authorizationRef}, ${formatAmount(input.fundingAmount)}::numeric,
            ${input.input.merchantCategory ?? null}, ${input.input.channel}, ${decision}, ${declineCode},
            ${decision === 'approved' ? 'pending' : 'rejected'}, ${input.heldBy}
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
      SELECT id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, status, cashback_bps, per_authorization_limit::text AS per_authorization_limit, daily_limit::text AS daily_limit, monthly_limit::text AS monthly_limit, cash_limit::text AS cash_limit, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, replaced_by_card_id, replace_reason, frozen_by, activated_at, uses_allowed, design_id, delivery_speed, residence_country FROM bank.cards WHERE id = ${cardId}
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

  /**
   * A single-use or n-use card closes itself once its captured payments reach its limit (BK-cissue-02). Counted from the
   * capture records, never stored, so a crash before this runs leaves nothing to double count: the next capture, or the
   * use-limit decline on the next authorisation, holds the line, and a retry closes it once.
   */
  private async closeWhenUsedUp(card: CardRecord): Promise<void> {
    if (card.usesAllowed == null) return;
    if ((await this.usesMade(card.id)) < card.usesAllowed) return;
    const current = await this.card(card.id);
    if (current.status === 'closed') return;
    await this.issuer.setStatus({ cardId: current.id, issuerRef: current.issuerRef, status: 'closed' });
    await transaction(this.sql, async (tx) => {
      const changed = await this.updateStatus(tx, current.id, tx`status = 'closed', frozen_by = NULL`, 'closed');
      if (changed && this.onStatusChanged) {
        await this.onStatusChanged(tx, {
          cardId: current.id,
          ownerUserId: current.userId,
          actor: { userId: current.userId },
          status: 'closed',
        });
      }
    });
  }

  /** Captured payments on this card so far: what a single-use or n-use card has used. */
  async usesMade(cardId: string): Promise<number> {
    const [row] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM bank.card_settlements s
        JOIN bank.card_authorizations a ON a.id = s.authorization_id
       WHERE a.card_id = ${cardId} AND s.sequence = 0 AND s.kind = 'capture' AND s.status = 'settled'
    `;
    return Number(row?.n ?? 0);
  }

  /**
   * Every hold still open on a card, given back whole (BK-cissue-04, a lost or stolen card): an approval with its hold
   * posted and nothing settled on sequence 0 yet. Each goes through `reverse`, keyed on its authorisation, so a retried
   * report reverses nothing twice.
   */
  private async reverseOpenHolds(card: CardRecord): Promise<void> {
    const open = await this.sql<Array<{ authorization_ref: string; money_book: 'ledger' | 'partner' }>>`
      SELECT a.authorization_ref, a.money_book
        FROM bank.card_authorizations a
       WHERE a.card_id = ${card.id}
         AND a.decision = 'approved'
         AND (a.hold_ledger_tx_id IS NOT NULL OR a.partner_hold_ref IS NOT NULL)
         -- Any sequence-0 row means a capture or reversal already claimed this hold: a capture in flight finishes on its
         -- own key (or the recovery job re-drives it) and is never raced here.
         AND NOT EXISTS (SELECT 1 FROM bank.card_settlements s WHERE s.authorization_id = a.id AND s.sequence = 0)
       ORDER BY a.decided_at
    `;
    for (const row of open) {
      if (row.money_book === 'ledger') {
        await this.reverse({ cardId: card.id, authorizationRef: row.authorization_ref });
        continue;
      }
      // A partner-held hold is the partner's: closing a lost or stolen card never waits on its answer. A refusal is
      // recorded on the claim (`rejected`), anything else leaves it pending for the recovery job, and the partner gives an
      // uncaptured hold back on its own hold time either way.
      try {
        await this.reverse({ cardId: card.id, authorizationRef: row.authorization_ref });
      } catch {
        // Deliberately not rethrown: see above.
      }
    }
  }

  /** Activate a card that has not been activated (BK-cissue-04). Once is enough: activating again changes nothing. */
  async activate(input: { cardId: string; userId: string }): Promise<CardRecord> {
    this.assertModuleEnabled();
    this.assertIssuerMayMutate();
    const card = await this.ownedCard(input.cardId, input.userId);
    if (!cardInactive(card)) return card;
    if (card.status !== 'active') {
      throw new BankError(
        card.status === 'closed' ? 'A closed card cannot be activated' : 'Unfreeze this card before activating it',
        'bank.card_not_active',
      );
    }
    await this.sql`UPDATE bank.cards SET activated_at = ${this.clock()}, updated_at = now() WHERE id = ${card.id} AND activated_at IS NULL`;
    return this.card(card.id);
  }

  private async closeReplaced(card: CardRecord, replacementId: string, reason: CardReplaceReason): Promise<void> {
    const current = await this.card(card.id);
    if (current.replacedByCardId === replacementId && current.status === 'closed' && current.replaceReason === reason) return;
    if (current.replaceReason && current.replaceReason !== reason) {
      throw new BankError('This card was already replaced on different terms', 'bank.card_replace_conflict');
    }
    if (reason === 'lost' || reason === 'stolen') {
      // Frozen first, so nothing new is approved on it, then every open hold back to the person, then closed.
      if (current.status === 'active') await this.setStatus(current.id, 'frozen', current.userId);
      await this.reverseOpenHolds(current);
    }
    await this.issuer.setStatus({ cardId: current.id, issuerRef: current.issuerRef, status: 'closed' });
    await transaction(this.sql, async (tx) => {
      const changed = await this.updateStatus(
        tx,
        current.id,
        tx`status = 'closed', replaced_by_card_id = ${replacementId}, replace_reason = ${reason}, frozen_by = NULL`,
        'closed',
      );
      if (changed && this.onStatusChanged) {
        await this.onStatusChanged(tx, {
          cardId: current.id,
          ownerUserId: current.userId,
          actor: { userId: current.userId },
          status: 'closed',
          replacementCardId: replacementId,
        });
      }
    });
  }

  /**
   * Set a card's status under its row lock. True when the status it had differs from `status`: two callers making the
   * same change at once change it once, so a hook hears it once.
   */
  private async updateStatus(tx: Sql, cardId: string, set: PendingQuery<Row[]>, status: CardRecord['status']): Promise<boolean> {
    const [old] = await tx<Array<{ status: string }>>`
      UPDATE bank.cards c SET ${set}, updated_at = now()
        FROM (SELECT id, status FROM bank.cards WHERE id = ${cardId} FOR UPDATE) o
       WHERE c.id = o.id
      RETURNING o.status
    `;
    return !!old && old.status !== status;
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
  activated_at: Date | null;
  uses_allowed: number | null;
  design_id: string | null;
  delivery_speed: string | null;
  residence_country: string | null;
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
  money_book: 'ledger' | 'partner';
  partner_hold_ref: string | null;
  partner_mode: CardCustodyMode | null;
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
    frozenBy: row.frozen_by === 'owner' || row.frozen_by === 'holder' || row.frozen_by === 'operator' ? row.frozen_by : null,
    activatedAt: row.activated_at ?? null,
    usesAllowed: row.uses_allowed === null || row.uses_allowed === undefined ? null : Number(row.uses_allowed),
    designId: row.design_id ?? null,
    deliverySpeed: row.delivery_speed ?? null,
    residenceCountry: row.residence_country ?? null,
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

/** A stored delivery address, read back from its jsonb (an object, or the JSON text of one). */
export function toAddress(value: unknown): CardShippingAddress | null {
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
    heldBy: row.money_book,
    partnerHoldRef: row.partner_hold_ref,
    partnerMode: row.partner_mode,
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
