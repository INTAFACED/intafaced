/**
 * OTC RFQ desk service (trade.otc Stage — D-S-02 Part A).
 *
 * Default desk law is unpublished → every quote/accept/settle refuses with
 * DIRECTION §8 residual. When owner publishes law, quotes disclose counterparty,
 * size, expiry, and spread; accept binds the quoted price (no last look);
 * settle posts only via ledger-client recipes.
 */

import { randomUUID } from 'node:crypto';
import { formatAmount, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { otcSettleIdsFor } from '../spot/ids.js';
import {
  otcDeskLawStatusLine,
  otcMinNotionalFor,
  requirePublishedOtcDeskLaw,
  type OtcDeskLaw,
  UNPUBLISHED_OTC_DESK_LAW,
} from './desk-law.js';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { OTC_DESK_LAW_RESIDUAL, OtcError, RFQ_ALLOCATION_RESIDUAL, RFQ_GIVE_UP_RESIDUAL } from './errors.js';
import { otcMakerRoutingStatus, OTC_MAKER_ROUTING_RESIDUAL } from './maker-routing.js';
import { otcMidFeedStatus, OTC_MID_FEED_RESIDUAL, type OtcMidFeedWiringStatus } from './mid-feed.js';
import { describeOtcPolicy } from './otc-policy.js';
import { NO_OTC_MIDS, normalizeOtcAsset, otcPairKey, type OtcMidSource } from './mid-source.js';
import {
  acceptOtcQuote,
  buildOtcQuote,
  expireOtcQuote,
  parseOtcMidPrice,
  parseRequiredOtcSize,
  presentBoundOtcFill,
  presentFirmRfq,
  presentOtcQuote,
  type BoundOtcFill,
  type OtcQuote,
  type OtcSide,
} from './rfq.js';
import { planOtcSettle, postOtcSettle } from './settle.js';
import {
  assertOtcConvertBounds,
  describeOtcConvertBounds,
  NO_OTC_CONVERT_BOUNDS,
  type OtcConvertBounds,
  type OtcConvertFlow,
} from './otc-convert-bounds.js';
import { assertOtcStakeGate, otcStakeGate } from './stake-gate.js';
import type { OtcStakeSource } from './stake-source.js';
import { MemoryOtcQuoteStore, type OtcQuoteStore, type OtcStoredQuote } from './quote-store.js';
import { listOtcMakers, selectOtcMakers, UNPUBLISHED_OTC_MAKER_DIRECTORY, type OtcMakerDirectory } from './maker-directory.js';
import { TradingControlError, type TradingAdmissionPort } from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';
import { assertEmailProved, type EmailProofSource } from '../spot/email-proof.js';

export interface OtcDeskServiceOptions {
  accountAdmission?: TradingAdmissionPort;
  /** Identity email-proof read (RC-identity-01). Unset refuses every new accept `trade.identity_unavailable`. */
  emailProof?: EmailProofSource;
  law?: OtcDeskLaw;
  /** Platform counterparty id disclosed when law.counterparty === 'platform'. */
  platformCounterpartyId?: string;
  /** Server-side reference mid. Absent → every quote refuses (never the caller's number). */
  midSource?: OtcMidSource;
  /** True when production installed the venue observation source (not the boot map). */
  liveObservationFeed?: boolean;
  /** Boot wiring honesty — separates flag-off from flag-on-but-unwired. */
  midFeedWiring?: OtcMidFeedWiringStatus;
  /** Owner amount bounds for one-click buy and convert at OTC pricing (CB-otc-12). Absent → both refuse. */
  convertBounds?: OtcConvertBounds;
  /** Durable quote table. Tests inject MemoryOtcQuoteStore; boot uses SQL. */
  store?: OtcQuoteStore;
  /** Owner provider directory (CB-otc-01). Absent → "No providers set" and requests refuse. */
  makerDirectory?: OtcMakerDirectory;
  now?: () => Date;
}

export class OtcDeskService {
  private readonly accountAdmission: TradingAdmissionPort | undefined;
  private readonly emailProof: EmailProofSource | undefined;
  private readonly store: OtcQuoteStore;
  private readonly convertBounds: OtcConvertBounds;
  private readonly law: OtcDeskLaw;
  private readonly platformCounterpartyId: string;
  private readonly midSource: OtcMidSource;
  private readonly liveObservationFeed: boolean;
  private readonly midFeedWiring: OtcMidFeedWiringStatus | null;
  private readonly makerDirectory: OtcMakerDirectory;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: LedgerClient,
    private readonly stakes: OtcStakeSource,
    options: OtcDeskServiceOptions = {},
  ) {
    this.accountAdmission = options.accountAdmission;
    this.emailProof = options.emailProof;
    this.law = options.law ?? UNPUBLISHED_OTC_DESK_LAW;
    this.platformCounterpartyId = options.platformCounterpartyId ?? 'platform:otc-desk';
    this.midSource = options.midSource ?? NO_OTC_MIDS;
    this.liveObservationFeed = options.liveObservationFeed === true;
    this.midFeedWiring = options.midFeedWiring ?? null;
    this.store = options.store ?? new MemoryOtcQuoteStore();
    this.makerDirectory = options.makerDirectory ?? UNPUBLISHED_OTC_MAKER_DIRECTORY;
    this.convertBounds = options.convertBounds ?? NO_OTC_CONVERT_BOUNDS;
    this.now = options.now ?? (() => new Date());
  }

  /** `trade.otc.makers.list` — the owner directory, or the honest empty state. */
  listMakers() {
    return listOtcMakers(this.makerDirectory);
  }

  /** `trade.otc.makers.select` — validates a provider pick against the list and the owner cap. */
  selectMakers(makerIds: readonly string[]) {
    return {
      makers: selectOtcMakers(this.makerDirectory, makerIds),
      selectCap: this.makerDirectory.published ? this.makerDirectory.selectCap : null,
    };
  }

  deskStatus() {
    return {
      published: this.law.published === true,
      statusLine: otcDeskLawStatusLine(this.law),
      residual: this.law.published === true ? null : OTC_DESK_LAW_RESIDUAL,
      /** SOCKET §13 — platform settle real; maker route refuse-closed. */
      makerRouting: otcMakerRoutingStatus(),
      /** SOCKET §13 — boot map age-gates unless venue observation source is installed. */
      midFeed: this.midFeedWiring ?? (this.liveObservationFeed ? otcMidFeedStatus(true) : describeOtcPolicy().bootMidFeedWiring),
      residuals: {
        deskLaw: this.law.published === true ? null : OTC_DESK_LAW_RESIDUAL,
        makerRouting: OTC_MAKER_ROUTING_RESIDUAL,
        midFeed: this.midFeedWiring?.residual ?? (this.liveObservationFeed ? null : OTC_MID_FEED_RESIDUAL),
      },
    };
  }

  /** Owner bounds for the two OTC-priced flows; null per flow when not set. */
  convertBoundsStatus() {
    return describeOtcConvertBounds(this.convertBounds);
  }

  /**
   * One-click large buy / convert at OTC pricing (CB-otc-12): the owner bounds
   * gate first, then the ordinary desk quote (same stake gate, mid, spread,
   * expiry). Accept and settle are the existing `trade.otc.accept` / `settle`.
   */
  async convertQuote(
    principal: Principal,
    input: { flow: OtcConvertFlow; side: OtcSide; baseAsset: string; quoteAsset: string; qty: string },
  ) {
    if (input.flow === 'oneClickBuy' && input.side !== 'buy') {
      throw new OtcError('One-click buy only buys; use convert to sell', 'trade.convert_flow_side_refused');
    }
    assertOtcConvertBounds(this.convertBounds, input.flow, parseRequiredOtcSize(input.qty));
    const quote = await this.quote(
      principal,
      {
        side: input.side,
        baseAsset: input.baseAsset,
        quoteAsset: input.quoteAsset,
        qty: input.qty,
      },
      // Convert and one-click buy are sized by their own owner bounds (CB-otc-12), checked above; the RFQ desk minimum
      // (CB-otc-07) and the provider pick (CB-otc-01) are for desk requests only.
      { desk: false },
    );
    return { flow: input.flow, ...quote };
  }

  async quote(
    principal: Principal,
    input: {
      side: OtcSide;
      baseAsset: string;
      quoteAsset: string;
      qty: string;
      /** Maker id when counterparty mode is maker. */
      makerId?: string;
      /** The providers a desk request asks (CB-otc-01): picked from the owner's list, at most its cap. */
      makerIds?: readonly string[];
    },
    options: { desk: boolean } = { desk: true },
  ) {
    const law = requirePublishedOtcDeskLaw(this.law);
    const qty = parseRequiredOtcSize(input.qty);

    // CB-otc-07: a desk request in a quote asset with no published minimum refuses on the law alone, before any stake
    // read or price lookup. The minimum itself is checked once the quote is priced, below.
    let minNotional: Amount | null = null;
    if (options.desk) {
      const asset = normalizeOtcAsset(input.quoteAsset);
      minNotional = asset == null ? null : otcMinNotionalFor(law, asset);
      if (asset != null && minNotional == null) {
        throw new OtcError(`The desk minimum for ${asset} requests is not set — the request refuses`, 'trade.rfq_size_not_set');
      }
    }

    // CB-otc-01: the providers come from the owner's list, never free text. A desk request always names them: a blank
    // list refuses "No providers set", an empty pick refuses otc_provider_required, a pick over the owner's cap refuses
    // naming the cap, and an unknown or outside provider refuses by name, all before any stake read or price lookup.
    // Convert and one-click buy name no providers; in maker mode they still pick their one maker from the list.
    let asked: readonly string[] = [];
    if (options.desk) {
      asked = selectOtcMakers(this.makerDirectory, input.makerIds ?? (input.makerId == null ? [] : [input.makerId])).map((m) => m.id);
    } else if (law.counterparty === 'maker') {
      asked = selectOtcMakers(this.makerDirectory, [input.makerId ?? '']).map((m) => m.id);
    }
    // In maker mode the quoting maker is one of the providers asked: the one picked, or the makerId named among them.
    // Both checks run here, before any stake read or price lookup.
    let quotingMaker: string | undefined;
    if (law.counterparty === 'maker') {
      quotingMaker = (input.makerId ?? (asked.length === 1 ? asked[0]! : '')).trim();
      if (!quotingMaker) {
        throw new OtcError('Name the one provider that quotes: more than one was asked', 'trade.otc_provider_required');
      }
      if (!asked.includes(quotingMaker)) {
        throw new OtcError(`Provider ${quotingMaker} is not one of the providers asked`, 'trade.otc_provider_unknown');
      }
    }

    // Access gate before price lookup: an unstaked caller learns nothing about
    // what the desk can price, and a mid source that costs a round trip is not
    // spent on a caller who was never eligible.
    const stake = await this.stakes.stakeOf(principal.userId);
    assertOtcStakeGate(otcStakeGate({ stake, minStake: law.minStake }));

    // The desk's own mid. There is deliberately no caller-supplied fallback:
    // a taker who can name the price can name it at 1 and take the inventory.
    //
    // The assets are carried forward in the SAME normalised form the mid was
    // looked up under. Trimming here while upper-casing only for the lookup
    // meant `baseAsset: 'btc'` found the mid published for `BTC/USDT` and then
    // settled against ledger asset `btc`, which does not exist — an unsettleable
    // quote the desk had already promised to honour.
    const baseAsset = normalizeOtcAsset(input.baseAsset);
    const quoteAsset = normalizeOtcAsset(input.quoteAsset);
    const pair = baseAsset && quoteAsset ? otcPairKey(baseAsset, quoteAsset) : null;
    if (baseAsset == null || quoteAsset == null || pair == null) {
      throw new OtcError('OTC asset pair is not a usable pair of ledger asset ids', 'trade.otc_no_reference_price');
    }
    const sourced = await this.midSource(pair);
    if (sourced == null || String(sourced.mid).trim() === '') {
      throw new OtcError(
        `No reference mid for ${pair} — the desk refuses rather than quote off a price it cannot source`,
        'trade.otc_no_reference_price',
      );
    }
    // Age gate: an observation older than owner maxMidAgeSeconds is a memory,
    // not a price. Clock skew into the future is the same refusal — otherwise
    // a bad clock defeats staleness. Number comes from published desk law only.
    const ageSeconds = (this.now().getTime() - sourced.asOf.getTime()) / 1_000;
    if (ageSeconds > law.maxMidAgeSeconds || ageSeconds < -30) {
      throw new OtcError(
        `Reference mid for ${pair} is not fresh (age ${Math.round(ageSeconds)}s, limit ${law.maxMidAgeSeconds}s) — refuse rather than invent`,
        'trade.otc_no_reference_price',
      );
    }
    const midPrice = parseOtcMidPrice(String(sourced.mid));

    const counterpartyId = law.counterparty === 'platform' ? this.platformCounterpartyId : quotingMaker!;

    const quote = buildOtcQuote({
      quoteId: randomUUID(),
      userId: principal.userId,
      side: input.side,
      baseAsset,
      quoteAsset,
      qty,
      midPrice,
      spreadBps: law.spreadBps,
      counterparty: law.counterparty,
      counterpartyId,
      now: this.now(),
      quoteTtlMs: law.quoteTtlMs,
    });

    // CB-otc-07: the minimum holds on what the customer trades (the notional after the disclosed spread), so a sell
    // never fills below it. Checked before the quote is saved, so a refused request records nothing.
    if (minNotional != null && quote.userNotional < minNotional) {
      throw new OtcError(`Below the desk minimum of ${formatAmount(minNotional)} ${quoteAsset}`, 'trade.rfq_below_minimum');
    }

    await this.store.saveOpen(quote);
    return presentOtcQuote(quote);
  }

  async accept(
    principal: Principal,
    input: { quoteId: string; /** Optional — if set must equal quoted price (last-look guard). */ assertedPrice?: string },
  ) {
    requirePublishedOtcDeskLaw(this.law);
    const stored = await this.store.load(input.quoteId);
    if (!stored) {
      throw new OtcError('OTC quote not found', 'trade.otc_quote_missing');
    }
    if (stored.quote.userId !== principal.userId) {
      throw new OtcError('OTC quote not found', 'trade.otc_quote_missing');
    }
    if (stored.lifecycle === 'settled') {
      throw new OtcError('OTC quote already settled', 'trade.otc_already_settled');
    }
    if (stored.lifecycle === 'expired') {
      throw new OtcError('OTC quote expired — refuse rather than requote', 'trade.otc_quote_expired');
    }
    if (stored.lifecycle === 'bound') {
      if (input.assertedPrice != null && input.assertedPrice.trim() !== '') {
        const asserted = parseAmount(input.assertedPrice);
        if (asserted !== stored.bound.fillPrice) {
          throw new OtcError('Last look is not permitted — accept must honour the quoted price', 'trade.otc_last_look_forbidden');
        }
      }
      return presentBoundOtcFill(stored.bound);
    }

    let asserted: Amount | null = null;
    if (input.assertedPrice != null && input.assertedPrice.trim() !== '') {
      asserted = parseAmount(input.assertedPrice);
    }

    if (!this.accountAdmission) throw new TradingControlError('authority.unavailable');
    const original = await this.accountAdmission.original(principal.userId, `otc:${stored.quote.quoteId}`);
    // RC-identity-01: an accepted quote settles against customer funds, so a new accept
    // needs a proved email. An admitted original was decided after this gate passed, so it finishes.
    if (!original) await assertEmailProved(this.emailProof, principal.userId);
    const saved = (original?.payload as { bound?: Record<string, unknown> } | undefined)?.bound;
    const bound = saved
      ? ({
          ...saved,
          qty: parseAmount(String(saved.qty)),
          fillPrice: parseAmount(String(saved.fillPrice)),
          fillNotional: parseAmount(String(saved.fillNotional)),
        } as unknown as BoundOtcFill)
      : acceptOtcQuote({ quote: stored.quote, now: this.now(), assertedPrice: asserted });
    if (asserted !== null && asserted !== bound.fillPrice)
      throw new OtcError('Last look is not permitted', 'trade.otc_last_look_forbidden');
    await this.accountAdmission.admit(
      principal,
      'order.place',
      `otc:${stored.quote.quoteId}`,
      original?.payload ?? businessPayload({ quote: stored.quote, bound }),
    );
    await this.store.saveBound(stored.quote, bound);
    return presentBoundOtcFill(bound);
  }

  /**
   * Settle a bound accept via ledger-client only.
   * Maker-routed mode refuses until owner publishes routing recipe.
   */
  async settle(principal: Principal, input: { quoteId: string }) {
    const law = requirePublishedOtcDeskLaw(this.law);
    const stored = await this.store.load(input.quoteId);
    if (!stored || stored.lifecycle === 'open' || stored.lifecycle === 'expired') {
      throw new OtcError('OTC bound fill not found — accept first', 'trade.otc_quote_missing');
    }
    if (stored.bound.userId !== principal.userId) {
      throw new OtcError('OTC bound fill not found — accept first', 'trade.otc_quote_missing');
    }

    // Derived from the quote, never minted: a retry after a partial post must
    // compute the same keys and find the ledger's original transaction.
    const { takerOrderId, makerOrderId, fillId } = otcSettleIdsFor(stored.bound.quoteId);
    if (stored.lifecycle === 'settled') {
      return {
        fillId,
        takerOrderId,
        makerOrderId,
        ...presentBoundOtcFill(stored.bound),
      };
    }
    const plan = planOtcSettle({
      law,
      bound: stored.bound,
      takerOrderId,
      makerOrderId,
      fillId,
    });
    // CB-otc-07: past the settle deadline a bound quote no longer settles. A settle that already began in time (its
    // first post, the house hold, is on the ledger) must still finish on retry, or the funds it held stay stranded.
    const deadline = otcSettleDeadline(law, stored);
    if (this.now().getTime() > deadline && !(await this.ledger.getTxByKey(plan.mmHold.idempotencyKey))) {
      throw new OtcError(
        `The settlement window for this quote closed at ${new Date(deadline).toISOString()} — nothing was settled or held`,
        'trade.rfq_window_passed',
      );
    }
    await postOtcSettle(this.ledger, plan);
    await this.store.saveSettled(stored.quote, stored.bound, this.now());
    return {
      fillId,
      takerOrderId,
      makerOrderId,
      ...presentBoundOtcFill(stored.bound),
    };
  }

  /**
   * Professional RFQ (PTX-M12) — firm quote/accept/expire on the OTC desk.
   * Size required; price is the desk mid (never invented, never caller-named).
   */
  async rfqQuote(
    principal: Principal,
    input: { side: OtcSide; baseAsset: string; quoteAsset: string; qty: string; makerId?: string; makerIds?: readonly string[] },
  ) {
    try {
      const quoted = await this.quote(principal, input);
      const stored = await this.store.load(quoted.quoteId);
      if (!stored) {
        throw new OtcError('OTC quote not found', 'trade.otc_quote_missing');
      }
      return presentFirmRfq(stored.quote, { lifecycle: stored.lifecycle });
    } catch (err) {
      if (err instanceof OtcError && err.code === 'trade.otc_no_reference_price') {
        throw new OtcError('Professional RFQ price is required — refuse rather than invent a mid', 'trade.rfq_missing_price');
      }
      throw err;
    }
  }

  async rfqAccept(principal: Principal, input: { quoteId: string; assertedPrice?: string }) {
    const bound = await this.accept(principal, input);
    const stored = await this.store.load(input.quoteId);
    if (!stored || (stored.lifecycle !== 'bound' && stored.lifecycle !== 'settled')) {
      throw new OtcError('OTC quote not found', 'trade.otc_quote_missing');
    }
    return presentFirmRfq(stored.quote, {
      lifecycle: stored.lifecycle,
      acceptedAt: bound.acceptedAt,
      fillPrice: stored.bound.fillPrice,
      ...this.settleWindowOf(stored),
    });
  }

  async rfqExpire(principal: Principal, input: { quoteId: string }) {
    const stored = await this.requireOwnedQuote(principal, input.quoteId);
    const next = expireOtcQuote({ lifecycle: stored.lifecycle });
    if (stored.lifecycle !== 'expired') {
      await this.store.saveExpired(stored.quote);
    }
    return presentFirmRfq(stored.quote, { lifecycle: next });
  }

  async rfqGet(principal: Principal, quoteId: string) {
    const stored = await this.requireOwnedQuote(principal, quoteId);
    if (stored.lifecycle === 'open' || stored.lifecycle === 'expired') {
      return presentFirmRfq(stored.quote, { lifecycle: this.openOrLapsed(stored) });
    }
    return presentFirmRfq(stored.quote, {
      lifecycle: stored.lifecycle,
      acceptedAt: stored.bound.acceptedAt,
      fillPrice: stored.bound.fillPrice,
      ...this.settleWindowOf(stored),
    });
  }

  /** When a bound quote stops settling, and the owner window it comes from (null: blank, "Not set"). */
  private settleWindowOf(stored: OtcStoredQuote): { settleBy: string | null; settleWindowMs: number | null } {
    if (this.law.published !== true || stored.lifecycle === 'open' || stored.lifecycle === 'expired') {
      return { settleBy: null, settleWindowMs: null };
    }
    return { settleBy: new Date(otcSettleDeadline(this.law, stored)).toISOString(), settleWindowMs: this.law.settleWindowMs ?? null };
  }

  rfqAllocate(_principal: Principal, _input: { quoteId: string }): never {
    logRefusalSpec('trade.rfq_allocation_refused');
    throw new OtcError(
      'Professional RFQ allocation is refuse-closed until owner law names sub-accounts, average price and breaks — never invent a split',
      'trade.rfq_allocation_refused',
      RFQ_ALLOCATION_RESIDUAL,
    );
  }

  rfqGiveUp(_principal: Principal, _input: { quoteId: string }): never {
    logRefusalSpec('trade.rfq_give_up_refused');
    throw new OtcError(
      'Professional RFQ give-up is refuse-closed until owner law names carrying account, affirmation and settlement instruction — never invent a clearing map',
      'trade.rfq_give_up_refused',
      RFQ_GIVE_UP_RESIDUAL,
    );
  }

  /**
   * An open quote read after its expiry reads as expired: `acceptOtcQuote` refuses it from then on, so "open" would be
   * false. Nothing is written here, so a read never races an accept that was admitted in time and saves after it.
   */
  private openOrLapsed(stored: Extract<OtcStoredQuote, { lifecycle: 'open' | 'expired' }>): 'open' | 'expired' {
    if (stored.lifecycle === 'expired') return 'expired';
    const expiresAt = Date.parse(stored.quote.expiresAt);
    return Number.isFinite(expiresAt) && this.now().getTime() <= expiresAt ? 'open' : 'expired';
  }

  private async requireOwnedQuote(principal: Principal, quoteId: string) {
    const stored = await this.store.load(quoteId);
    if (!stored) {
      throw new OtcError('OTC quote not found', 'trade.otc_quote_missing');
    }
    if (stored.quote.userId !== principal.userId) {
      throw new OtcError('OTC quote not found', 'trade.otc_quote_missing');
    }
    return stored;
  }
}

/**
 * When a bound quote stops settling (CB-otc-07): the owner window from the accept, or, with the window blank (no
 * deferral), the quote's own expiry. Unparseable times give 0, which refuses rather than settles without a deadline.
 */
export function otcSettleDeadline(
  law: Extract<OtcDeskLaw, { published: true }>,
  stored: Extract<OtcStoredQuote, { lifecycle: 'bound' | 'settled' }>,
): number {
  const from = law.settleWindowMs == null ? Date.parse(stored.quote.expiresAt) : Date.parse(stored.bound.acceptedAt) + law.settleWindowMs;
  return Number.isFinite(from) ? from : 0;
}
