/**
 * v22.alerts types — sourced-mark watches plus named unpublished kinds.
 *
 * Law §31 / tracker `v22.alerts`: condition evaluation against a mark the
 * platform can source. Price, funding, and liquidation-proximity watches all
 * compare a user-named decimal target to the price mark. Whale watches compare
 * that target to a separate flow mark — never the price print, never an
 * invented volume. Dark / unpublished marks refuse, never fire.
 *
 * Intelligence stays unpublished (no sourced series). Portfolio stays
 * refuse-closed (`alert.portfolio_view_unpublished`) until ledger-client
 * publishes a view — notify never invents a second book (Doctrine §0.6) and
 * never fires on silence.
 *
 * Money discipline: every price / flow is a decimal *string*. Nothing is a
 * `number`. The portfolio refuse arm carries zero money fields.
 */

/** Watches evaluated against an injected mark source. */
export type SourcedAlertKind = 'price' | 'funding' | 'liquidation_proximity' | 'whale';

export const SOURCED_ALERT_KINDS = ['price', 'funding', 'liquidation_proximity', 'whale'] as const satisfies readonly SourcedAlertKind[];

/**
 * Kinds with no sourced series. Create never stores; evaluate never fires.
 * Intelligence stays here. Whale does not — it evaluates against the whale
 * mark or refuses `alerts.whale_mark_dark`.
 */
export type UnpublishedAlertKind = 'intelligence';

export const UNPUBLISHED_ALERT_KINDS = ['intelligence'] as const satisfies readonly UnpublishedAlertKind[];

export type AlertKind = SourcedAlertKind | 'portfolio' | UnpublishedAlertKind;

export function isSourcedAlertKind(kind: string | undefined): kind is SourcedAlertKind {
  return (SOURCED_ALERT_KINDS as readonly string[]).includes(kind ?? '');
}

/** Stable refuse until a ledger portfolio view exists. Never invent a balance. */
export const ALERT_PORTFOLIO_VIEW_UNPUBLISHED = 'alert.portfolio_view_unpublished' as const;

/** Stable refuse for kinds with no sourced series. Never fire, never store. */
export const ALERT_KIND_UNPUBLISHED = 'alert.kind_unpublished' as const;

/**
 * Whale flow mark is dark / missing. Never fire, never invent a volume.
 * Distinct from `alert.price_unavailable` — a live price print is not a flow.
 */
export const ALERTS_WHALE_MARK_DARK = 'alerts.whale_mark_dark' as const;

export class AlertKindUnpublishedError extends Error {
  readonly code: typeof ALERT_KIND_UNPUBLISHED = ALERT_KIND_UNPUBLISHED;
  readonly alertKind: UnpublishedAlertKind;
  constructor(alertKind: UnpublishedAlertKind) {
    super(`${ALERT_KIND_UNPUBLISHED}: ${alertKind} has no sourced series`);
    this.name = 'AlertKindUnpublishedError';
    this.alertKind = alertKind;
  }
}

export function isUnpublishedAlertKind(kind: string | undefined): kind is UnpublishedAlertKind {
  return (UNPUBLISHED_ALERT_KINDS as readonly string[]).includes(kind ?? '');
}

export type CreateUnpublishedAlertInput = {
  readonly kind: UnpublishedAlertKind;
  readonly userId: string;
};

export class AlertPortfolioUnpublishedError extends Error {
  readonly code: typeof ALERT_PORTFOLIO_VIEW_UNPUBLISHED = ALERT_PORTFOLIO_VIEW_UNPUBLISHED;
  constructor(detail = 'ledger portfolio view unpublished — notify holds no balance') {
    super(`${ALERT_PORTFOLIO_VIEW_UNPUBLISHED}: ${detail}`);
    this.name = 'AlertPortfolioUnpublishedError';
  }
}

/**
 * Create a portfolio watch — zero money fields on purpose.
 * Create always throws `AlertPortfolioUnpublishedError`; nothing is stored.
 */
export type CreatePortfolioAlertInput = {
  readonly kind: 'portfolio';
  readonly userId: string;
};

/** Above / below a target. Crossing fires once (status becomes `fired`). */
export type AlertDirection = 'above' | 'below';

export type AlertStatus = 'active' | 'fired' | 'cancelled' | 'expired';

/**
 * How a watch compares the mark with its target.
 *
 *   greater_than / less_than   a LEVEL: fires whenever the mark is at or above (below) the target. The only conditions that
 *                              existed before C-alerts-scan-01, stored as direction above / below.
 *   crossing_up / crossing_down / crossing   fire only on a CHANGE of side, seen between two sweeps. The side the mark was last
 *                              seen on is `lastSide`; a watch with no observation yet fires nothing and records one.
 */
export type AlertCondition = 'crossing' | 'crossing_up' | 'crossing_down' | 'greater_than' | 'less_than';
export const ALERT_CONDITIONS = [
  'crossing',
  'crossing_up',
  'crossing_down',
  'greater_than',
  'less_than',
] as const satisfies readonly AlertCondition[];

/** Which side of the target the mark was last seen on. At the target counts as `at_or_above`. */
export type AlertSide = 'below' | 'at_or_above';

export function isCrossingCondition(condition: AlertCondition): boolean {
  return condition === 'crossing' || condition === 'crossing_up' || condition === 'crossing_down';
}

/** The stored direction for a condition. `crossing` has no direction of its own; `above` is a placeholder the evaluator ignores. */
export function directionOfCondition(condition: AlertCondition): AlertDirection {
  return condition === 'less_than' || condition === 'crossing_down' ? 'below' : 'above';
}

export function conditionOfDirection(direction: AlertDirection): AlertCondition {
  return direction === 'above' ? 'greater_than' : 'less_than';
}

export type PriceAlert = {
  readonly id: string;
  readonly userId: string;
  readonly marketId: string;
  /** Sourced-mark kind. Unpublished kinds never become a row. */
  readonly kind: SourcedAlertKind;
  readonly direction: AlertDirection;
  /** Decimal string target. Never a JS number. */
  readonly targetPrice: string;
  readonly status: AlertStatus;
  readonly firedAt: Date | null;
  readonly createdAt: Date;
  readonly condition: AlertCondition;
  /** The person's own label and message; `{market}`, `{price}`, `{condition}` and `{time}` are filled in when it fires. */
  readonly name: string | null;
  readonly message: string | null;
  /** Open-ended when null. An active watch past this time is expired by the next sweep and never fires. */
  readonly expiresAt: Date | null;
  /** Internal state of a crossing watch; never on the wire. */
  readonly lastSide: AlertSide | null;
  /** Further level conditions on the same market. The alert fires only when the main condition AND every one of these holds. */
  readonly extras: readonly AlertExtra[];
};

/** An added condition: a level only (crossing needs a remembered side, which an added condition does not have). */
export const EXTRA_CONDITIONS = ['greater_than', 'less_than'] as const;
export type AlertExtra = { readonly condition: (typeof EXTRA_CONDITIONS)[number]; readonly targetPrice: string };

export type CreatePriceAlertInput = {
  readonly userId: string;
  readonly marketId: string;
  readonly kind?: SourcedAlertKind;
  readonly direction: AlertDirection;
  readonly targetPrice: string;
  readonly condition?: AlertCondition;
  readonly name?: string | null;
  readonly message?: string | null;
  readonly expiresAt?: Date | null;
  readonly extras?: readonly AlertExtra[];
};

/**
 * What the platform is willing to say about a market's price right now.
 *
 * `unavailable` is the honesty constraint from the marks work: if we cannot
 * source a price, we refuse the evaluation rather than fire on a stale or
 * invented number (`accepted-mark` vocabulary, transferred to alerts).
 */
export type MarkQuote =
  | { readonly kind: 'ok'; readonly price: string; readonly at: Date }
  | { readonly kind: 'unavailable'; readonly reason: 'dark' | 'stale' | 'refused'; readonly detail?: string };

/**
 * Injected port — svc-notify never reads trade tables (§2).
 *
 * `kind` is CONFIGURATION, not momentary availability, and it is required rather
 * than optional on purpose.
 *
 *   dark   nothing is wired. Every quote is `unavailable`, so no watch this
 *          deployment holds can ever fire, and the user surface has to say so.
 *   live   a real feed is wired. Individual quotes may still come back
 *          `unavailable` (stale, refused) — `live` is a claim about the wiring,
 *          never a promise about the next quote.
 *
 * It is required because the alternative — an optional field defaulting to one of
 * the two — is how a dark source silently claims to be live. A new mark source
 * must state which it is, and the type system asks the question at the only
 * moment anyone can answer it.
 */
export type MarkSource = {
  readonly kind: 'dark' | 'live';
  quote(marketId: string, at?: Date): Promise<MarkQuote>;
};

export type AlertRefuseCode =
  | 'alert.price_unavailable'
  | 'alert.not_active'
  | 'alert.invalid_price'
  | 'alert.portfolio_view_unpublished'
  | 'alert.kind_unpublished'
  | 'alerts.whale_mark_dark'
  | 'channel.not_configured'
  | 'channel.disabled';

export type AlertEvalOutcome =
  | { readonly kind: 'hold'; readonly markPrice: string; readonly side?: AlertSide }
  | { readonly kind: 'fire'; readonly markPrice: string; readonly side?: AlertSide }
  | {
      readonly kind: 'refuse';
      readonly code: AlertRefuseCode;
      readonly detail: string;
    };
