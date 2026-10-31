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
import { AlertQuotaReachedError, AlertValidationError, type AlertStore } from './store.js';
import {
  MemoryAlertTriggerLog,
  NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET,
  triggerOf,
  type AlertTrigger,
  type AlertTriggerLog,
} from './trigger-log.js';
import {
  ALERT_CONDITIONS,
  directionOfCondition,
  EXTRA_CONDITIONS,
  isAlertPriceSource,
  isCrossingCondition,
  type AlertPriceSource,
  type AlertEdit,
  type AlertEditState,
  type AlertExtra,
  type AlertFrequency,
} from './types.js';
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
export const NOTIFY_ALERT_QUOTA_UNSET = 'notify.alert_quota_unset' as const;
export const NOTIFY_ALERT_FREQUENCY_UNSET = 'notify.alert_frequency_unset' as const;

/** Owner settings an alert's expiry and text depend on. Blank (null) is never replaced by a default: the create refuses. */
export type AlertLimits = {
  /** Furthest an alert may expire, in days from now (`NOTIFY_ALERT_MAX_EXPIRY_DAYS`). */
  readonly maxExpiryDays: number | null;
  /** Longest an alert's name or message may be (`NOTIFY_ALERT_TEXT_MAX_LENGTH`). */
  readonly textMaxLength: number | null;
  /** Most conditions one alert may hold, the main one included (`NOTIFY_ALERT_MAX_CONDITIONS`). */
  readonly maxConditions: number | null;
  /** Days the trigger log keeps a row (`NOTIFY_ALERT_TRIGGER_LOG_DAYS`). Blank: no log is written and reading it refuses. */
  readonly triggerLogDays: number | null;
  /** Most price alerts one person may hold open, active or paused (`NOTIFY_ALERT_MAX_ACTIVE_PRICE`). Blank refuses a create. */
  readonly maxActivePrice: number | null;
  /** The repeating frequencies the owner allows (`NOTIFY_ALERT_FREQUENCIES`). Empty (blank) allows only `once`. */
  readonly repeatFrequencies: readonly AlertFrequency[];
  /** Burst auto-stop: more than `burstMaxTriggers` triggers of one alert inside `burstWindowMinutes` stops it. Both set arms the rule; either blank leaves it off. */
  readonly burstWindowMinutes: number | null;
  readonly burstMaxTriggers: number | null;
};

export const NO_ALERT_LIMITS: AlertLimits = {
  maxExpiryDays: null,
  textMaxLength: null,
  maxConditions: null,
  triggerLogDays: null,
  maxActivePrice: null,
  repeatFrequencies: [],
  burstWindowMinutes: null,
  burstMaxTriggers: null,
};

export type AlertLimitCode =
  | typeof NOTIFY_ALERT_EXPIRY_MAX_UNSET
  | typeof NOTIFY_ALERT_TEXT_LIMIT_UNSET
  | typeof NOTIFY_ALERT_CONDITIONS_LIMIT_UNSET
  | typeof NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET
  | typeof NOTIFY_ALERT_QUOTA_UNSET
  | typeof NOTIFY_ALERT_FREQUENCY_UNSET
  | 'alert.frequency_not_allowed'
  | 'alert.frequency_needs_crossing'
  | 'alert.quota_reached'
  | 'alert.too_many_conditions'
  | 'alert.extra_condition_invalid'
  | 'alert.expiry_in_past'
  | 'alert.expiry_too_far'
  | 'alert.text_too_long'
  | 'alert.message_placeholder_unknown';

/** An edit or pause refused because the alert has already triggered, expired or been cancelled. */
export class AlertNotEditableError extends Error {
  readonly code = 'alert.not_editable' as const;
  constructor(status: string) {
    super(`alert.not_editable: the alert is ${status}`);
    this.name = 'AlertNotEditableError';
  }
}

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

/** The price source an edit stores. Only the four named ones; anything else refuses and nothing is written. */
function assertAlertSource(source: AlertPriceSource): AlertPriceSource {
  if (!isAlertPriceSource(source)) throw new AlertValidationError('alert.invalid_source', `source=${String(source)}`);
  return source;
}

/**
 * The frequency a create or edit stores. `once` is always allowed. A repeating one needs the owner's list to name it (a blank list
 * refuses with `notify.alert_frequency_unset`) and a crossing condition, because a level that holds would trigger on every sweep.
 */
function assertAlertFrequency(frequency: AlertFrequency | undefined, condition: AlertCondition, limits: AlertLimits): AlertFrequency {
  if (frequency === undefined || frequency === 'once') return 'once';
  if (limits.repeatFrequencies.length === 0) {
    throw new AlertLimitError(NOTIFY_ALERT_FREQUENCY_UNSET, "a repeating alert needs the owner's list of allowed frequencies");
  }
  if (!limits.repeatFrequencies.includes(frequency)) {
    throw new AlertLimitError('alert.frequency_not_allowed', `${frequency} is not an allowed frequency`);
  }
  if (!isCrossingCondition(condition)) {
    throw new AlertLimitError('alert.frequency_needs_crossing', 'only a crossing alert can repeat');
  }
  return frequency;
}

/** An edit that names a frequency is checked like a create; one that does not keeps the stored one, which must still be a crossing. */
function editedFrequency(
  named: AlertFrequency | undefined,
  stored: AlertFrequency,
  condition: AlertCondition,
  limits: AlertLimits,
): AlertFrequency {
  if (named !== undefined) return assertAlertFrequency(named, condition, limits);
  if (stored !== 'once' && !isCrossingCondition(condition)) {
    throw new AlertLimitError('alert.frequency_needs_crossing', 'only a crossing alert can repeat');
  }
  return stored;
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
    private readonly triggerLog: AlertTriggerLog = new MemoryAlertTriggerLog(),
  ) {}

  /** The person's trigger log, newest first. Refuses while the owner has not set how long it is kept. */
  async triggers(
    userId: string,
    opts: { alertId?: string; limit: number },
    now: Date = new Date(),
  ): Promise<{ retentionDays: number; triggers: readonly AlertTrigger[] }> {
    const days = this.limits.triggerLogDays;
    if (days === null) {
      throw new AlertLimitError(NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET, 'the owner has not set how long the trigger log is kept');
    }
    const since = new Date(now.getTime() - days * 86_400_000);
    const triggers = await this.triggerLog.list(userId, { ...opts, since });
    return { retentionDays: days, triggers };
  }

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
    const frequency = assertAlertFrequency(input.frequency, input.condition ?? 'greater_than', this.limits);
    // Only price alerts have a quota setting. A blank one refuses the create, as every other blank owner limit does.
    let maxOpen: number | undefined;
    if (kind === 'price') {
      if (this.limits.maxActivePrice === null) {
        throw new AlertLimitError(NOTIFY_ALERT_QUOTA_UNSET, 'the owner has not set how many price alerts a person may hold');
      }
      maxOpen = this.limits.maxActivePrice;
      // An alert past its time is not open, so it must not use up a place.
      await this.store.expireDue(now);
    }
    try {
      return await this.store.create({
        ...input,
        kind,
        targetPrice,
        name,
        message,
        expiresAt,
        extras,
        frequency,
        ...(maxOpen !== undefined ? { maxOpen } : {}),
      });
    } catch (err) {
      if (err instanceof AlertQuotaReachedError) {
        throw new AlertLimitError('alert.quota_reached', `a person may hold ${err.limit} open price alerts`);
      }
      throw err;
    }
  }

  /**
   * A watchlist alert: the same price rule on each of several markets, one alert per market, all or none. Each is checked and
   * stored exactly as a single create is. The number of markets is held to the price-alert quota: if the person's open alerts
   * plus these would pass it, nothing is created. A market named twice is created once.
   */
  async createMany(
    input: Omit<CreatePriceAlertInput, 'targetPrice' | 'marketId' | 'kind' | 'maxOpen'> & {
      readonly marketIds: readonly string[];
      readonly targetPrice?: string | null;
    },
    now: Date = new Date(),
  ): Promise<readonly PriceAlert[]> {
    const { marketIds, ...rule } = input;
    const markets = [...new Set(marketIds.map((id) => id.trim()).filter((id) => id !== ''))];
    if (markets.length === 0) throw new AlertValidationError('alert.invalid_market', 'at least one market is needed');
    const targetPrice = assertRealAlertPrice(rule.targetPrice);
    const name = assertAlertText('name', rule.name, this.limits);
    const message = assertAlertText('message', rule.message, this.limits);
    const expiresAt = assertAlertExpiry(rule.expiresAt, this.limits, now);
    const extras = assertAlertExtras(rule.extras, this.limits);
    const frequency = assertAlertFrequency(rule.frequency, rule.condition ?? 'greater_than', this.limits);
    if (this.limits.maxActivePrice === null) {
      throw new AlertLimitError(NOTIFY_ALERT_QUOTA_UNSET, 'the owner has not set how many price alerts a person may hold');
    }
    await this.store.expireDue(now);
    try {
      return await this.store.createMany(
        markets.map((marketId) => ({
          ...rule,
          kind: 'price' as const,
          marketId,
          targetPrice,
          name,
          message,
          expiresAt,
          extras,
          frequency,
        })),
        this.limits.maxActivePrice,
      );
    } catch (err) {
      if (err instanceof AlertQuotaReachedError) {
        throw new AlertLimitError(
          'alert.quota_reached',
          err.wanted === undefined
            ? `a person may hold ${err.limit} open price alerts`
            : `a person may hold ${err.limit} open price alerts; ${err.held} are open and ${err.wanted} more were asked for`,
        );
      }
      throw err;
    }
  }

  /** The burst rule when both owner values are set, else `null`: the rule is off and nothing is stopped for triggering often. */
  burstRule(): { readonly windowMs: number; readonly max: number } | null {
    const { burstWindowMinutes, burstMaxTriggers } = this.limits;
    return burstWindowMinutes !== null && burstMaxTriggers !== null
      ? { windowMs: burstWindowMinutes * 60_000, max: burstMaxTriggers }
      : null;
  }

  /** How many price alerts the person holds open and the owner's cap (`null` while it is blank). */
  async quota(
    userId: string,
    now: Date = new Date(),
  ): Promise<{
    readonly kind: 'price';
    readonly used: number;
    readonly max: number | null;
    readonly burst: { readonly windowMinutes: number; readonly maxTriggers: number } | null;
    /** Most conditions one alert may hold, the main one included (`NOTIFY_ALERT_MAX_CONDITIONS`). `null` while blank. */
    readonly maxConditions: number | null;
  }> {
    await this.store.expireDue(now);
    const { burstWindowMinutes, burstMaxTriggers } = this.limits;
    return {
      kind: 'price',
      used: await this.store.countOpen(userId, 'price'),
      max: this.limits.maxActivePrice,
      burst:
        burstWindowMinutes !== null && burstMaxTriggers !== null
          ? { windowMinutes: burstWindowMinutes, maxTriggers: burstMaxTriggers }
          : null,
      maxConditions: this.limits.maxConditions,
    };
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

  get(userId: string, id: string): Promise<PriceAlert | null> {
    return this.store.get(userId, id);
  }

  cancel(userId: string, id: string): Promise<PriceAlert | null> {
    return this.store.cancel(userId, id);
  }

  /**
   * Change an alert that is active or stopped. The edit is merged over what is stored and checked exactly as a create is, so an
   * owner setting that is blank still refuses, and nothing is written unless every part passes. A changed alert forgets the side
   * a crossing was last seen on. `null` when the alert is not the person's.
   */
  async edit(userId: string, id: string, edit: AlertEdit, now: Date = new Date()): Promise<PriceAlert | null> {
    await this.store.expireDue(now);
    const row = await this.store.get(userId, id);
    if (!row) return null;
    if (row.status !== 'active' && row.status !== 'stopped') throw new AlertNotEditableError(row.status);
    const condition = edit.condition ?? row.condition;
    if (!(ALERT_CONDITIONS as readonly string[]).includes(condition)) {
      throw new AlertLimitError('alert.extra_condition_invalid', `condition=${String(condition)}`);
    }
    const targetPrice = edit.targetPrice === undefined ? row.targetPrice : assertRealAlertPrice(edit.targetPrice).trim();
    if (!isValidPositivePrice(targetPrice)) throw new AlertLimitError('alert.extra_condition_invalid', `targetPrice=${targetPrice}`);
    const next: AlertEditState = {
      direction: condition === 'crossing' ? row.direction : directionOfCondition(condition),
      targetPrice,
      condition,
      name: edit.name === undefined ? row.name : assertAlertText('name', edit.name, this.limits),
      message: edit.message === undefined ? row.message : assertAlertText('message', edit.message, this.limits),
      expiresAt: edit.expiresAt === undefined ? row.expiresAt : assertAlertExpiry(edit.expiresAt, this.limits, now),
      extras: edit.extras === undefined ? row.extras : assertAlertExtras(edit.extras, this.limits),
      // A repeating alert keeps repeating unless the edit says otherwise, and must still be a crossing after the edit.
      frequency: editedFrequency(edit.frequency, row.frequency, condition, this.limits),
      source: edit.source === undefined ? row.source : assertAlertSource(edit.source),
    };
    return this.store.replace(userId, id, next, now);
  }

  /**
   * Pause an active alert or resume a stopped one. Pausing twice or resuming twice is harmless and returns the alert as it is.
   * A stopped alert whose expiry has passed is expired, not resumed. `null` when the alert is not the person's.
   */
  async setActive(userId: string, id: string, active: boolean, now: Date = new Date()): Promise<PriceAlert | null> {
    await this.store.expireDue(now);
    return this.store.setStopped(userId, id, !active, now);
  }

  /** Delete an alert whatever its state. True when there was one. */
  remove(userId: string, id: string): Promise<boolean> {
    return this.store.remove(userId, id);
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
    if (this.limits.triggerLogDays !== null) {
      await this.triggerLog.prune(new Date(at.getTime() - this.limits.triggerLogDays * 86_400_000));
    }
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
    // One quote per price source a price alert here chose, within this pass. `mark` is the quote above, shared by every other kind.
    const bySource = new Map<AlertPriceSource, MarkQuote>([['mark', quote]]);
    for (const alert of actives) {
      if (alert.kind !== 'price' || bySource.has(alert.source)) continue;
      bySource.set(alert.source, await this.sourcedQuote(marketId, at, alert.source));
    }

    for (const alert of actives) {
      const ownQuote = alert.kind === 'whale' ? whaleQuote : alert.kind === 'price' ? (bySource.get(alert.source) ?? quote) : quote;
      const applied = await this.applyEvaluation(alert, ownQuote, at);
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
    const quote =
      alert.kind === 'whale'
        ? await this.sourcedWhaleQuote(alert.marketId, at)
        : await this.sourcedQuote(alert.marketId, at, alert.kind === 'price' ? alert.source : 'mark');
    const applied = await this.applyEvaluation(alert, quote, at);
    const refreshed = (await this.store.get(userId, alertId)) ?? alert;
    return {
      alert: refreshed,
      outcome: applied.outcome,
      evaluation,
      notificationId: applied.notificationId,
    };
  }

  private async sourcedQuote(marketId: string, at: Date, source: AlertPriceSource = 'mark'): Promise<MarkQuote> {
    // `mark` is quoted exactly as before the source existed, so a port that predates it sees the same call.
    const raw = source === 'mark' ? await this.marks.quote(marketId, at) : await this.marks.quote(marketId, at, source);
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
      // A repeating alert numbers its triggers, so each crossing is its own inbox row even at the same mark.
      const repeating = alert.frequency === 'every_crossing';
      const seq = repeating ? alert.fireCount + 1 : 1;
      const created = await this.fireNotification(alert, outcome.markPrice, at, repeating ? seq : null);
      const reachedInbox = created.notification !== null || created.dispatch !== null;
      if (reachedInbox) {
        notificationId = created.notification?.id ?? null;
        // Logged after the inbox has it and before the watch is counted or marked fired: a crash between the two retries and
        // the (alert id, number) key makes the second record a no-op. A blank retention writes no log; the alert fires regardless.
        if (this.limits.triggerLogDays !== null) {
          await this.triggerLog.record(triggerOf(alert, outcome.markPrice, at, notificationId, seq));
        }
        // Known limit: a crash between the inbox write above and this count leaves the count and the remembered side as they
        // were. The retry sends nothing new (same key). If the mark has fallen back across the level before that retry, the
        // next crossing reuses this number and its inbox key, so that one crossing goes unannounced. It takes a crash inside
        // this window and a reversal inside one sweep; the trigger log and the count still agree.
        if (repeating)
          await this.store.recordRepeat(alert.userId, alert.id, alert.fireCount, at, outcome.side ?? null, this.burstRule() ?? undefined);
        else await this.store.markFired(alert.userId, alert.id, at);
      }
    }

    return { outcome, notificationId };
  }

  private async fireNotification(alert: PriceAlert, markPrice: string, at: Date, repeatNumber: number | null): Promise<CreateResult> {
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
        ...(repeatNumber !== null ? { fireNumber: repeatNumber } : {}),
        ...(alert.name ? { name: alert.name } : {}),
        ...(alert.message ? { message: renderAlertMessage(alert.message, alert, markPrice, at) } : {}),
      },
      href: `/markets/${alert.marketId}`,
      severity: 'action',
      sourceSubject: copy.sourceSubject,
      sourceIdempotencyKey: repeatNumber === null ? `${alert.id}:${canonicalDecimalString(markPrice)}` : `${alert.id}:n${repeatNumber}`,
    });
  }

  /** Inbox-only NotifyService stubs may omit channelStatus — that means nothing OOA was required. */
  private namedOutOfAppRefusal() {
    const status = typeof this.notify.channelStatus === 'function' ? this.notify.channelStatus() : [];
    return outOfAppRequiredRefusal(status);
  }
}
