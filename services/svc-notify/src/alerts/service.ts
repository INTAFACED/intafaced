/**
 * AlertService — watchlist CRUD + evaluate-and-fire into the existing fan-out.
 *
 * §31: "Rides §9 notification fan-out" — we call NotifyService.create, which
 * already owns inbox insert + channel dispatch. No second delivery path.
 *
 * Idempotency key is `<alertId>:<canonical mark>` so a redelivery of the same
 * cross does not double-notify. The mark half is the spelling
 * `compareDecimalStrings` treats as equal (`100.50` and `100.5`), not the raw
 * feed text. A later cross at a different mark is a new fact only if the alert
 * were re-activated (MVP: one-shot fire).
 */

import type { CreateResult, NotifyService } from '../notify-service.js';
import { acceptAlertMark, outOfAppRequiredRefusal } from './accepted-mark.js';
import { canonicalDecimalString, isValidPositivePrice } from './decimal.js';
import {
  evaluatePortfolioAlert,
  evaluatePriceAlert,
  evaluateUnpublishedKind as unpublishedKindOutcome,
  evaluateWhaleAlert,
} from './evaluate.js';
import { AlertValidationError, type AlertStore } from './store.js';
import { directionOfCondition, EXTRA_CONDITIONS, isCrossingCondition, type AlertExtra } from './types.js';
import { createDarkWhaleMarkSource } from './whale-mark.js';
import {
  AlertKindUnpublishedError,
  AlertPortfolioUnpublishedError,
  type AlertCondition,
  type AlertEvalOutcome,
  type AlertRefuseCode,
  type CreatePortfolioAlertInput,
  type CreatePriceAlertInput,
  type CreateUnpublishedAlertInput,
  type MarkQuote,
  type MarkSource,
  type PriceAlert,
  type SourcedAlertKind,
  type UnpublishedAlertKind,
} from './types.js';

export const NOTIFY_PRICE_UNSET = 'notify.price_unset' as const;

/** Price alert target unpublished. Blank is not a number. */
export class NotifyPriceUnsetError extends Error {
  readonly code = NOTIFY_PRICE_UNSET;
  readonly missingPiece = 'price' as const;
  readonly slot = null;

  constructor() {
    super('A price alert is refused. The missing piece is price.');
    this.name = 'NotifyPriceUnsetError';
  }
}

/** Caller-supplied target. Blank stays blank — never invent a price. */
export function assertRealAlertPrice(targetPrice: string | null | undefined): string {
  if (typeof targetPrice !== 'string' || targetPrice.trim() === '') {
    throw new NotifyPriceUnsetError();
  }
  return targetPrice;
}

export const NOTIFY_ALERTS_LIST_LIMIT_UNSET = 'notify.alerts_list_limit_unset' as const;

/** `notify.alerts` page size unpublished. Blank is not 20. */
export class NotifyAlertsListLimitUnsetError extends Error {
  readonly code = NOTIFY_ALERTS_LIST_LIMIT_UNSET;
  readonly missingPiece = 'limit' as const;
  readonly slot = null;

  constructor() {
    super(NOTIFY_ALERTS_LIST_LIMIT_UNSET);
    this.name = 'NotifyAlertsListLimitUnsetError';
  }
}

/** Owner-published `notify.alerts` page size. Blank / non-finite / <1 refuses. Never invent 20. */
export function assertNotifyAlertsListLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new NotifyAlertsListLimitUnsetError();
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new NotifyAlertsListLimitUnsetError();
  }
  return Math.min(100, n);
}

export const NOTIFY_ALERT_EXPIRY_MAX_UNSET = 'notify.alert_expiry_max_unset' as const;
export const NOTIFY_ALERT_TEXT_LIMIT_UNSET = 'notify.alert_text_limit_unset' as const;
export const NOTIFY_ALERT_CONDITIONS_LIMIT_UNSET = 'notify.alert_conditions_limit_unset' as const;

/** Owner settings an alert's expiry and text depend on. Blank (null) is never replaced by a default: the create refuses. */
export type AlertLimits = {
  /** Furthest an alert may expire, in days from now (`NOTIFY_ALERT_MAX_EXPIRY_DAYS`). */
  readonly maxExpiryDays: number | null;
  /** Longest an alert's name or message may be (`NOTIFY_ALERT_TEXT_MAX_LENGTH`). */
  readonly textMaxLength: number | null;
  /** Most conditions one alert may hold, the main one included (`NOTIFY_ALERT_MAX_CONDITIONS`). */
  readonly maxConditions: number | null;
};

export const NO_ALERT_LIMITS: AlertLimits = { maxExpiryDays: null, textMaxLength: null, maxConditions: null };

export type AlertLimitCode =
  | typeof NOTIFY_ALERT_EXPIRY_MAX_UNSET
  | typeof NOTIFY_ALERT_TEXT_LIMIT_UNSET
  | typeof NOTIFY_ALERT_CONDITIONS_LIMIT_UNSET
  | 'alert.too_many_conditions'
  | 'alert.extra_condition_invalid'
  | 'alert.expiry_in_past'
  | 'alert.expiry_too_far'
  | 'alert.text_too_long'
  | 'alert.message_placeholder_unknown';

/** A create refused for its expiry or text: a blank owner setting, or a value outside it. Nothing is stored. */
export class AlertLimitError extends Error {
  readonly code: AlertLimitCode;
  constructor(code: AlertLimitCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AlertLimitError';
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
export const ALERT_PLACEHOLDERS = ['market', 'price', 'condition', 'time'] as const;
const CONDITION_WORDS: Record<AlertCondition, string> = {
  crossing: 'crossing',
  crossing_up: 'crossing up',
  crossing_down: 'crossing down',
  greater_than: 'at or above',
  less_than: 'at or below',
};

/** Fill the message placeholders. The values are the alert's own facts and the mark that fired it; nothing is invented. */
export function renderAlertMessage(template: string, alert: PriceAlert, markPrice: string, at: Date): string {
  const values: Record<(typeof ALERT_PLACEHOLDERS)[number], string> = {
    market: alert.marketId,
    price: markPrice,
    condition: `${CONDITION_WORDS[alert.condition]} ${alert.targetPrice}`,
    time: at.toISOString(),
  };
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) =>
    (ALERT_PLACEHOLDERS as readonly string[]).includes(key) ? values[key as keyof typeof values] : whole,
  );
}

function assertAlertText(label: 'name' | 'message', text: string | null | undefined, limits: AlertLimits): string | null {
  if (text === undefined || text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (limits.textMaxLength === null) throw new AlertLimitError(NOTIFY_ALERT_TEXT_LIMIT_UNSET, `${label} needs the owner's length setting`);
  if (trimmed.length > limits.textMaxLength) throw new AlertLimitError('alert.text_too_long', `${label} is over ${limits.textMaxLength}`);
  if (label === 'message') {
    for (const m of trimmed.matchAll(/\{([a-z]+)\}/g)) {
      if (!(ALERT_PLACEHOLDERS as readonly string[]).includes(m[1]!)) {
        throw new AlertLimitError('alert.message_placeholder_unknown', `{${m[1]}} is not a placeholder`);
      }
    }
  }
  return trimmed;
}

function assertAlertExtras(extras: readonly AlertExtra[] | undefined, limits: AlertLimits): readonly AlertExtra[] {
  if (extras === undefined || extras.length === 0) return [];
  if (limits.maxConditions === null) {
    throw new AlertLimitError(NOTIFY_ALERT_CONDITIONS_LIMIT_UNSET, "added conditions need the owner's condition limit");
  }
  // The main condition counts toward the limit.
  if (extras.length + 1 > limits.maxConditions) {
    throw new AlertLimitError('alert.too_many_conditions', `an alert may hold ${limits.maxConditions} conditions`);
  }
  return extras.map((extra) => {
    if (!(EXTRA_CONDITIONS as readonly string[]).includes(extra.condition) || !isValidPositivePrice(extra.targetPrice)) {
      throw new AlertLimitError('alert.extra_condition_invalid', 'an added condition is a level with a positive decimal price');
    }
    return { condition: extra.condition, targetPrice: extra.targetPrice.trim() };
  });
}

function assertAlertExpiry(expiresAt: Date | null | undefined, limits: AlertLimits, now: Date): Date | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (limits.maxExpiryDays === null) throw new AlertLimitError(NOTIFY_ALERT_EXPIRY_MAX_UNSET, "expiry needs the owner's maximum");
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new AlertLimitError('alert.expiry_in_past', 'expiry must be in the future');
  }
  if (expiresAt.getTime() > now.getTime() + limits.maxExpiryDays * DAY_MS) {
    throw new AlertLimitError('alert.expiry_too_far', `expiry is more than ${limits.maxExpiryDays} days away`);
  }
  return expiresAt;
}

const FIRE_COPY: Record<
  SourcedAlertKind,
  { readonly kind: string; readonly titleKey: string; readonly bodyKey: string; readonly sourceSubject: string }
> = {
  price: {
    kind: 'alert.price.crossed',
    titleKey: 'notify.alert.price.crossed.title',
    bodyKey: 'notify.alert.price.crossed.body',
    sourceSubject: 'intafaced.notify.alert.price.crossed',
  },
  funding: {
    kind: 'alert.funding.crossed',
    titleKey: 'notify.alert.funding.crossed.title',
    bodyKey: 'notify.alert.funding.crossed.body',
    sourceSubject: 'intafaced.notify.alert.funding.crossed',
  },
  liquidation_proximity: {
    kind: 'alert.liquidation_proximity.crossed',
    titleKey: 'notify.alert.liquidation_proximity.crossed.title',
    bodyKey: 'notify.alert.liquidation_proximity.crossed.body',
    sourceSubject: 'intafaced.notify.alert.liquidation_proximity.crossed',
  },
  whale: {
    kind: 'alert.whale.crossed',
    titleKey: 'notify.alert.whale.crossed.title',
    bodyKey: 'notify.alert.whale.crossed.body',
    sourceSubject: 'intafaced.notify.alert.whale.crossed',
  },
};

/**
 * How often the mounted sweep evaluates every market holding an active watch.
 *
 * A constant, not an environment variable, for the reason
 * `DEFAULT_POSITION_NOTIFY_POLICY` is a constant: whether a watch is evaluated
 * at all is not something a deployment should be able to differ on quietly. An
 * operator who wants alerts stopped has the fan-out kill-switch, which stops the
 * write rather than the read.
 */
export const ALERT_SWEEP_INTERVAL_MS = 60_000;

/**
 * What the deployment is able to say about whether a watch can fire.
 *
 * This is a USER-FACING answer, and it exists because of D-S-13: a watch the
 * platform cannot evaluate is a promise with no delivery, and the disclosure has
 * to be in code at the surface a user reads — not in a comment.
 */
export type AlertEvaluationStatus = {
  /** Wiring, not weather. See `MarkSource.kind`. */
  readonly markSource: 'dark' | 'live';
  /**
   * False when nothing this deployment holds can fire, whatever the price does.
   *
   * True is never a promise that a given cross WILL produce a message — delivery
   * is best-effort on every channel (§8) and a quote may still be unavailable at
   * the moment of the sweep. It only says the wiring is not missing.
   */
  readonly canFire: boolean;
  /** The refusal every evaluation would record right now, or null. */
  readonly code: Extract<
    AlertRefuseCode,
    'alert.price_unavailable' | 'alerts.whale_mark_dark' | 'channel.not_configured' | 'channel.disabled'
  > | null;
};

/** One pass of the sweep, in the shape `/ready` reports and a test asserts. */
export type AlertSweepReport = {
  /** Markets that held at least one active watch this pass. */
  readonly markets: number;
  readonly fired: number;
  readonly held: number;
  readonly refused: number;
  /** Refusals counted by code, so "nothing fired" always says why. */
  readonly refusals: Readonly<Record<string, number>>;
};

export type EvaluateMarketReport = {
  readonly marketId: string;
  readonly mark: string | null;
  readonly results: readonly {
    readonly alertId: string;
    readonly userId: string;
    readonly outcome: AlertEvalOutcome;
    readonly notificationId: string | null;
  }[];
};

/** Public-door evaluate — one watch, named refuse, never a fake last. */
export type EvaluateAlertReport = {
  readonly alert: PriceAlert | null;
  readonly outcome: AlertEvalOutcome;
  readonly evaluation: AlertEvaluationStatus;
  readonly notificationId: string | null;
};

export class AlertService {
  constructor(
    private readonly store: AlertStore,
    private readonly marks: MarkSource,
    private readonly notify: NotifyService,
    private readonly whaleMarks: MarkSource = createDarkWhaleMarkSource(),
    private readonly limits: AlertLimits = NO_ALERT_LIMITS,
  ) {}

  async create(
    input: Omit<CreatePriceAlertInput, 'targetPrice'> & { readonly targetPrice?: string | null },
    now: Date = new Date(),
  ): Promise<PriceAlert> {
    const kind = input.kind ?? 'price';
    const targetPrice = kind === 'price' ? assertRealAlertPrice(input.targetPrice) : input.targetPrice;
    if (typeof targetPrice !== 'string') {
      throw new AlertValidationError('alert.invalid_price', 'targetPrice required');
    }
    const name = assertAlertText('name', input.name, this.limits);
    const message = assertAlertText('message', input.message, this.limits);
    const expiresAt = assertAlertExpiry(input.expiresAt, this.limits, now);
    const extras = assertAlertExtras(input.extras, this.limits);
    return this.store.create({ ...input, kind, targetPrice, name, message, expiresAt, extras });
  }

  /**
   * Portfolio watches are refuse-closed. Nothing is stored, no balance is read,
   * and silence is not a fire. Callers must not invent a second book here.
   */
  createPortfolio(_input: CreatePortfolioAlertInput): never {
    throw new AlertPortfolioUnpublishedError();
  }

  /**
   * Unpublished kinds never become an active watch. No store write, no fire.
   */
  createUnpublishedKind(input: CreateUnpublishedAlertInput): never {
    throw new AlertKindUnpublishedError(input.kind);
  }

  /**
   * Same refuse as create — evaluate never fires a portfolio watch and never
   * carries a money field. The sweep does not call this; there is no stored row.
   */
  evaluatePortfolio(): AlertEvalOutcome {
    return evaluatePortfolioAlert();
  }

  /**
   * Same refuse as create — no invented intelligence series.
   * Whale evaluates as a stored sourced-mark watch against the whale mark.
   */
  evaluateUnpublishedKind(kind: UnpublishedAlertKind): AlertEvalOutcome {
    return unpublishedKindOutcome(kind);
  }

  list(userId: string, limit?: number): Promise<readonly PriceAlert[]> {
    return this.store.list(userId, limit);
  }

  cancel(userId: string, id: string): Promise<PriceAlert | null> {
    return this.store.cancel(userId, id);
  }

  /**
   * Whether a watch this deployment holds can fire at all.
   *
   * Read by the router so the answer reaches the person who created the watch.
   */
  evaluationStatus(): AlertEvaluationStatus {
    if (this.marks.kind !== 'live') {
      return {
        markSource: 'dark',
        canFire: false,
        code: 'alert.price_unavailable',
      };
    }
    const ooa = this.namedOutOfAppRefusal();
    if (ooa) {
      return {
        markSource: 'live',
        canFire: false,
        code: ooa.code,
      };
    }
    return { markSource: 'live', canFire: true, code: null };
  }

  /**
   * Whether a whale watch this deployment holds can fire at all.
   *
   * Separate from `evaluationStatus()` on purpose: a live price print is not a
   * flow. Dark whale wiring refuses `alerts.whale_mark_dark` even when the
   * price mark is live.
   */
  whaleEvaluationStatus(): AlertEvaluationStatus {
    if (this.whaleMarks.kind !== 'live') {
      return {
        markSource: 'dark',
        canFire: false,
        code: 'alerts.whale_mark_dark',
      };
    }
    const ooa = this.namedOutOfAppRefusal();
    if (ooa) {
      return {
        markSource: 'live',
        canFire: false,
        code: ooa.code,
      };
    }
    return { markSource: 'live', canFire: true, code: null };
  }

  /**
   * THE SWEEP — the thing that makes `evaluateMarket` a job path rather than a
   * method nobody calls.
   *
   * Until this existed, `router.ts` said evaluation "is an internal job path"
   * and no such path was mounted: `notify.createAlert` returned a watch with
   * `status: 'active'` and nothing anywhere would ever look at it again. That is
   * D-S-13 Class B exactly — a user holds a belief the missing wiring would have
   * to deliver — and it is the same shape as `bankMarginCalled`, whose consumer
   * was complete and parked while borrowers went untold.
   *
   * It sweeps from `activeMarkets()` rather than from a market list, so a watch
   * on a market nobody thought to enumerate is still evaluated.
   *
   * UNDER A DARK MARK SOURCE THIS WRITES NOTHING, and that is the correct
   * outcome rather than a disappointing one: `evaluatePriceAlert` refuses on an
   * unavailable quote, no alert is marked fired, and no inbox row is created. The
   * sweep's value while the source is dark is that it is REAL — the day an owner
   * injects a feed, watches fire, because the driver is already mounted and
   * proven rather than waiting to be discovered missing.
   */
  async evaluateDueAlerts(at: Date = new Date()): Promise<AlertSweepReport> {
    await this.store.expireDue(at);
    const markets = await this.store.activeMarkets();
    let fired = 0;
    let held = 0;
    let refused = 0;
    const refusals: Record<string, number> = {};

    for (const marketId of markets) {
      const report = await this.evaluateMarket(marketId, at);
      for (const result of report.results) {
        if (result.outcome.kind === 'fire') {
          fired += 1;
          continue;
        }
        if (result.outcome.kind === 'hold') {
          held += 1;
          continue;
        }
        refused += 1;
        refusals[result.outcome.code] = (refusals[result.outcome.code] ?? 0) + 1;
      }
    }

    return { markets: markets.length, fired, held, refused, refusals };
  }

  /**
   * Evaluate every active alert on a market against the injected mark source.
   * Dark / stale marks refuse every alert by name — nothing is invented.
   *
   * FIRE ORDER — notify first, then mark the watch fired.
   *
   * The previous order (`markFired` then `fireNotification`) permanently burned
   * a watch when the create path wrote nothing: fan-out kill returns
   * `{ inserted: false, notification: null }` without throwing, and a crash
   * after mark-before-insert left `status: 'fired'` with an empty inbox. Either
   * way the one-shot never retried. That is the same kill-lie the bus path
   * already refuses (`fanout-off-pin`): a kill must write nothing, not invent a
   * finished delivery.
   *
   * Notify first. `sourceIdempotencyKey` is `<alertId>:<canonical mark>`, so a
   * redelivery after insert-before-mark reuses the same inbox row when the feed
   * reprints `100.50` as `100.5`. The delivery claim stops a second channel
   * send. Only when create produced or recovered a row do we retire the watch.
   * Fan-out off leaves the watch active for a later pass.
   */
  async evaluateMarket(marketId: string, at: Date = new Date()): Promise<EvaluateMarketReport> {
    await this.store.expireDue(at);
    const quote = await this.sourcedQuote(marketId, at);
    const whaleQuote = await this.sourcedWhaleQuote(marketId, at);
    const actives = await this.store.listActiveByMarket(marketId);
    const results: EvaluateMarketReport['results'][number][] = [];

    for (const alert of actives) {
      const applied = await this.applyEvaluation(alert, alert.kind === 'whale' ? whaleQuote : quote, at);
      results.push({
        alertId: alert.id,
        userId: alert.userId,
        outcome: applied.outcome,
        notificationId: applied.notificationId,
      });
    }

    return {
      marketId,
      mark: quote.kind === 'ok' ? quote.price : null,
      results,
    };
  }

  /**
   * Public evaluate door. Dark / missing marks refuse by name and never mark
   * the watch fired — even when the port quotes a last (invented live).
   */
  async evaluateAlert(userId: string, alertId: string, at: Date = new Date()): Promise<EvaluateAlertReport> {
    await this.store.expireDue(at);
    const alert = await this.store.get(userId, alertId);
    if (!alert) {
      return {
        alert: null,
        outcome: { kind: 'refuse', code: 'alert.not_active', detail: 'alert.not_found' },
        evaluation: this.evaluationStatus(),
        notificationId: null,
      };
    }
    const evaluation = alert.kind === 'whale' ? this.whaleEvaluationStatus() : this.evaluationStatus();
    const quote = alert.kind === 'whale' ? await this.sourcedWhaleQuote(alert.marketId, at) : await this.sourcedQuote(alert.marketId, at);
    const applied = await this.applyEvaluation(alert, quote, at);
    const refreshed = (await this.store.get(userId, alertId)) ?? alert;
    return {
      alert: refreshed,
      outcome: applied.outcome,
      evaluation,
      notificationId: applied.notificationId,
    };
  }

  private async sourcedQuote(marketId: string, at: Date): Promise<MarkQuote> {
    const raw = await this.marks.quote(marketId, at);
    return acceptAlertMark(this.marks, raw, at);
  }

  private async sourcedWhaleQuote(marketId: string, at: Date): Promise<MarkQuote> {
    const raw = await this.whaleMarks.quote(marketId, at);
    return acceptAlertMark(this.whaleMarks, raw, at);
  }

  private async applyEvaluation(
    alert: PriceAlert,
    quote: MarkQuote,
    at: Date,
  ): Promise<{ outcome: AlertEvalOutcome; notificationId: string | null }> {
    const ooa = this.namedOutOfAppRefusal();
    let outcome = alert.kind === 'whale' ? evaluateWhaleAlert(alert, quote) : evaluatePriceAlert(alert, quote);
    if (outcome.kind === 'fire' && ooa) {
      outcome = { kind: 'refuse', code: ooa.code, detail: ooa.detail };
    }
    let notificationId: string | null = null;

    // A crossing watch remembers the side it saw, so the next sweep can tell a real crossing from a level it was already past.
    if (outcome.kind === 'hold' && outcome.side !== undefined && outcome.side !== alert.lastSide) {
      await this.store.setLastSide(alert.userId, alert.id, outcome.side);
    }

    if (outcome.kind === 'fire') {
      const created = await this.fireNotification(alert, outcome.markPrice, at);
      const reachedInbox = created.notification !== null || created.dispatch !== null;
      if (reachedInbox) {
        await this.store.markFired(alert.userId, alert.id, at);
        notificationId = created.notification?.id ?? null;
      }
    }

    return { outcome, notificationId };
  }

  private async fireNotification(alert: PriceAlert, markPrice: string, at: Date): Promise<CreateResult> {
    const copy = FIRE_COPY[alert.kind];
    return this.notify.create({
      userId: alert.userId,
      kind: copy.kind,
      // The person's own name and message replace the stock copy when they wrote them.
      titleKey: alert.name ? 'notify.alert.price.crossed.named.title' : copy.titleKey,
      bodyKey: alert.message ? 'notify.alert.price.crossed.message.body' : copy.bodyKey,
      params: {
        alertId: alert.id,
        alertKind: alert.kind,
        marketId: alert.marketId,
        direction: alert.direction,
        condition: alert.condition,
        targetPrice: alert.targetPrice,
        markPrice,
        ...(alert.name ? { name: alert.name } : {}),
        ...(alert.message ? { message: renderAlertMessage(alert.message, alert, markPrice, at) } : {}),
      },
      href: `/markets/${alert.marketId}`,
      severity: 'action',
      sourceSubject: copy.sourceSubject,
      sourceIdempotencyKey: `${alert.id}:${canonicalDecimalString(markPrice)}`,
    });
  }

  /** Inbox-only NotifyService stubs may omit channelStatus — that means nothing OOA was required. */
  private namedOutOfAppRefusal() {
    const status = typeof this.notify.channelStatus === 'function' ? this.notify.channelStatus() : [];
    return outOfAppRequiredRefusal(status);
  }
}
