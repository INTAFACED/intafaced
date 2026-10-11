/**
 * OTC RFQ desk service (trade.otc Stage — D-S-02 Part A).
 *
 * Default desk law is unpublished → every quote/accept/settle refuses with
 * DIRECTION §8 residual. When owner publishes law, quotes disclose counterparty,
 * size, expiry, and spread; accept binds the quoted price (no last look);
 * settle posts only via ledger-client recipes.
 */

import { randomUUID } from 'node:crypto';
import { parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { otcSettleIdsFor } from '../spot/ids.js';
import { otcDeskLawStatusLine, requirePublishedOtcDeskLaw, type OtcDeskLaw, UNPUBLISHED_OTC_DESK_LAW } from './desk-law.js';
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
import { assertOtcStakeGate, otcStakeGate } from './stake-gate.js';
import type { OtcStakeSource } from './stake-source.js';
import { MemoryOtcQuoteStore, type OtcQuoteStore } from './quote-store.js';
import { TradingControlError, type TradingAdmissionPort } from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';

export interface OtcDeskServiceOptions {
  accountAdmission?: TradingAdmissionPort;
  law?: OtcDeskLaw;
  /** Platform counterparty id disclosed when law.counterparty === 'platform'. */
  platformCounterpartyId?: string;
  /** Server-side reference mid. Absent → every quote refuses (never the caller's number). */
  midSource?: OtcMidSource;
  /** True when production installed the venue observation source (not the boot map). */
  liveObservationFeed?: boolean;
  /** Boot wiring honesty — separates flag-off from flag-on-but-unwired. */
  midFeedWiring?: OtcMidFeedWiringStatus;
  /** Durable quote table. Tests inject MemoryOtcQuoteStore; boot uses SQL. */
  store?: OtcQuoteStore;
  now?: () => Date;
}

export class OtcDeskService {
  private readonly accountAdmission: TradingAdmissionPort | undefined;
  private readonly store: OtcQuoteStore;
  private readonly law: OtcDeskLaw;
  private readonly platformCounterpartyId: string;
  private readonly midSource: OtcMidSource;
  private readonly liveObservationFeed: boolean;
  private readonly midFeedWiring: OtcMidFeedWiringStatus | null;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: LedgerClient,
    private readonly stakes: OtcStakeSource,
    options: OtcDeskServiceOptions = {},
  ) {
    this.accountAdmission = options.accountAdmission;
    this.law = options.law ?? UNPUBLISHED_OTC_DESK_LAW;
    this.platformCounterpartyId = options.platformCounterpartyId ?? 'platform:otc-desk';
    this.midSource = options.midSource ?? NO_OTC_MIDS;
    this.liveObservationFeed = options.liveObservationFeed === true;
    this.midFeedWiring = options.midFeedWiring ?? null;
    this.store = options.store ?? new MemoryOtcQuoteStore();
    this.now = options.now ?? (() => new Date());
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

  async quote(
    principal: Principal,
    input: {
      side: OtcSide;
      baseAsset: string;
      quoteAsset: string;
      qty: string;
      /** Maker id when counterparty mode is maker. */
      makerId?: string;
    },
  ) {
    const law = requirePublishedOtcDeskLaw(this.law);
    const qty = parseRequiredOtcSize(input.qty);

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

    let counterpartyId: string;
    if (law.counterparty === 'platform') {
      counterpartyId = this.platformCounterpartyId;
    } else {
      const makerId = (input.makerId ?? '').trim();
      if (!makerId) {
        throw new OtcError('Maker id required when desk routes to makers — refuse rather than invent', 'trade.otc_no_reference_price');
      }
      counterpartyId = makerId;
    }

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
  async rfqQuote(principal: Principal, input: { side: OtcSide; baseAsset: string; quoteAsset: string; qty: string; makerId?: string }) {
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
      return presentFirmRfq(stored.quote, { lifecycle: stored.lifecycle });
    }
    return presentFirmRfq(stored.quote, {
      lifecycle: stored.lifecycle,
      acceptedAt: stored.bound.acceptedAt,
      fillPrice: stored.bound.fillPrice,
    });
  }

  rfqAllocate(_principal: Principal, _input: { quoteId: string }): never {
    throw new OtcError(
      'Professional RFQ allocation is refuse-closed until owner law names sub-accounts, average price and breaks — never invent a split',
      'trade.rfq_allocation_refused',
      RFQ_ALLOCATION_RESIDUAL,
    );
  }

  rfqGiveUp(_principal: Principal, _input: { quoteId: string }): never {
    throw new OtcError(
      'Professional RFQ give-up is refuse-closed until owner law names carrying account, affirmation and settlement instruction — never invent a clearing map',
      'trade.rfq_give_up_refused',
      RFQ_GIVE_UP_RESIDUAL,
    );
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
