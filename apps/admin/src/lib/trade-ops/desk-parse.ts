/**
 * Parsers for the svc-trade operator procedures the Positions, Risk limits and Liquidations rooms read
 * (`admin.positions.*`, `admin.risk.*`, `admin.futures.*`). A body that is not the expected shape returns null, so the
 * edge call refuses it as trade_ops.unexpected_shape instead of showing half of it. Money and sizes stay decimal STRINGS.
 */

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const dec = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
const decOrNull = (v: unknown): v is string | null => v === null || dec(v);
const uint = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9]\d*)$/.test(v);

// ── Positions ───────────────────────────────────────────────────────────────

/** What `admin.positions.list/get` return per row. Mark, liquidation price, margin ratio and PnL are not served. */
export interface AdminPositionRow {
  readonly id: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: 'long' | 'short';
  /** trade.position_status: open, closing, closed, liquidated. Kept as the service's word. */
  readonly status: string;
  readonly size: string;
  readonly entryPrice: string;
  readonly openedAt: string;
}

export function parsePosition(v: unknown): AdminPositionRow | null {
  if (!rec(v) || !str(v.id) || !str(v.userId) || !str(v.marketId) || !str(v.status) || !str(v.openedAt)) return null;
  if (v.side !== 'long' && v.side !== 'short') return null;
  if (!dec(v.size) || !dec(v.entryPrice)) return null;
  return {
    id: v.id,
    userId: v.userId,
    marketId: v.marketId,
    side: v.side,
    status: v.status,
    size: v.size,
    entryPrice: v.entryPrice,
    openedAt: v.openedAt,
  };
}

export interface PositionsPage {
  readonly rows: readonly AdminPositionRow[];
  readonly nextCursor: string | null;
}

export function parsePositionsPage(raw: unknown): PositionsPage | null {
  if (!rec(raw) || !Array.isArray(raw.rows) || !strOrNull(raw.nextCursor ?? null)) return null;
  const rows = raw.rows.map(parsePosition);
  if (!rows.every((r): r is AdminPositionRow => r !== null)) return null;
  return { rows, nextCursor: (raw.nextCursor as string | null | undefined) ?? null };
}

// ── Operator risk limits ────────────────────────────────────────────────────

export interface RiskLimitValues {
  readonly collar: string | null;
  readonly fatFinger: string | null;
  readonly slippageCap: string | null;
  readonly throttle: string | null;
  readonly circuitBreaker: string | null;
  /** A futures market's largest open interest, in its base asset (D-margin-05). */
  readonly oiLimit: string | null;
  /** The largest share of `oiLimit` one account may hold, in basis points. */
  readonly oiShareBps: string | null;
  /** The widest a futures market's price band may go while the dynamic range widens it, a fraction (D-instruments-08). */
  readonly priceRangeMax: string | null;
  /** The premium of the futures book over the mark past which the band widens, a fraction. */
  readonly priceRangeTrigger: string | null;
  /** How often the band is worked out again, in whole seconds. */
  readonly priceRangeCadenceSeconds: string | null;
}

/** `admin.risk.get`: the current limits, version "0" and all null when none were ever set. */
export interface RiskCurrent extends RiskLimitValues {
  readonly marketId: string;
  readonly version: string;
}

/** One row of `admin.risk.history`: who changed it, who approved, why. */
export interface RiskVersionRow extends RiskCurrent {
  readonly operatorId: string;
  readonly approverId: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly createdAt: string;
}

function limitValues(v: Record<string, unknown>): RiskLimitValues | null {
  if (!decOrNull(v.collar) || !decOrNull(v.fatFinger)) return null;
  if (!(v.slippageCap === null || uint(v.slippageCap)) || !(v.throttle === null || uint(v.throttle))) return null;
  if (!(v.circuitBreaker === null || uint(v.circuitBreaker))) return null;
  // A version written before the open-interest pair existed reads as unset, never as a number.
  const oiLimit = v.oiLimit === undefined ? null : v.oiLimit;
  const oiShareBps = v.oiShareBps === undefined ? null : v.oiShareBps;
  if (!decOrNull(oiLimit) || !(oiShareBps === null || uint(oiShareBps))) return null;
  // The same for a version written before the dynamic price range existed.
  const priceRangeMax = v.priceRangeMax === undefined ? null : v.priceRangeMax;
  const priceRangeTrigger = v.priceRangeTrigger === undefined ? null : v.priceRangeTrigger;
  const priceRangeCadenceSeconds = v.priceRangeCadenceSeconds === undefined ? null : v.priceRangeCadenceSeconds;
  if (!decOrNull(priceRangeMax) || !decOrNull(priceRangeTrigger)) return null;
  if (!(priceRangeCadenceSeconds === null || uint(priceRangeCadenceSeconds))) return null;
  return {
    collar: v.collar,
    fatFinger: v.fatFinger,
    slippageCap: v.slippageCap as string | null,
    throttle: v.throttle as string | null,
    circuitBreaker: v.circuitBreaker as string | null,
    oiLimit,
    oiShareBps: oiShareBps as string | null,
    priceRangeMax,
    priceRangeTrigger,
    priceRangeCadenceSeconds: priceRangeCadenceSeconds as string | null,
  };
}

export function parseRiskCurrent(raw: unknown): RiskCurrent | null {
  if (!rec(raw) || !str(raw.marketId) || !uint(raw.version)) return null;
  const limits = limitValues(raw);
  return limits ? { marketId: raw.marketId, version: raw.version, ...limits } : null;
}

export function parseRiskHistory(raw: unknown): readonly RiskVersionRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: RiskVersionRow[] = [];
  for (const item of raw) {
    const current = parseRiskCurrent(item);
    if (!current || !rec(item)) return null;
    if (!str(item.operatorId) || !str(item.approverId) || !str(item.reason) || !str(item.approvalId) || !str(item.createdAt)) return null;
    rows.push({
      ...current,
      operatorId: item.operatorId,
      approverId: item.approverId,
      reason: item.reason,
      approvalId: item.approvalId,
      createdAt: item.createdAt,
    });
  }
  return rows;
}

/** Why a futures market's band is what it is, as svc-trade's `futures.price_band` job records it. */
export type PriceBandReason = 'within_trigger' | 'widened' | 'capped' | 'inputs_missing';
const BAND_REASONS: readonly string[] = ['within_trigger', 'widened', 'capped', 'inputs_missing'];

/** One change of a futures market's band, newest first. */
export interface PriceBandChangeRow {
  readonly band: string;
  readonly previousBand: string | null;
  readonly staticBand: string;
  readonly premium: string | null;
  readonly reason: PriceBandReason;
  readonly riskVersion: string;
  readonly changedAt: string;
}

/**
 * `admin.risk.priceBand`: the band the job last worked out for the market (null while it never has) and each change.
 * The band new orders are held to is this one only while it is fresh and was worked for the limits in force; otherwise it
 * is the static band.
 */
export interface PriceBandView {
  readonly marketId: string;
  readonly current: {
    readonly band: string;
    readonly staticBand: string;
    readonly premium: string | null;
    readonly mark: string | null;
    readonly bookMid: string | null;
    readonly reason: PriceBandReason;
    readonly riskVersion: string;
    readonly checkedAt: string;
    readonly changedAt: string;
  } | null;
  readonly changes: readonly PriceBandChangeRow[];
}

/** The Risk limits room's read: the limits, every version, and on a futures market the band (or why it is not shown). */
export interface RiskRead {
  readonly current: RiskCurrent;
  readonly history: readonly RiskVersionRow[];
  readonly band: PriceBandView | null;
  readonly bandRefusal: string | null;
}

const bandReason = (v: unknown): v is PriceBandReason => typeof v === 'string' && BAND_REASONS.includes(v);

function parseBandChange(v: unknown): PriceBandChangeRow | null {
  if (!rec(v) || !dec(v.band) || !decOrNull(v.previousBand) || !dec(v.staticBand) || !decOrNull(v.premium)) return null;
  if (!bandReason(v.reason) || !uint(v.riskVersion) || !str(v.changedAt)) return null;
  return {
    band: v.band,
    previousBand: v.previousBand,
    staticBand: v.staticBand,
    premium: v.premium,
    reason: v.reason,
    riskVersion: v.riskVersion,
    changedAt: v.changedAt,
  };
}

export function parsePriceBandView(raw: unknown): PriceBandView | null {
  if (!rec(raw) || !str(raw.marketId) || !Array.isArray(raw.changes)) return null;
  const changes = raw.changes.map(parseBandChange);
  if (!changes.every((c): c is PriceBandChangeRow => c !== null)) return null;
  if (raw.current === null) return { marketId: raw.marketId, current: null, changes };
  const c = raw.current;
  if (!rec(c) || !dec(c.band) || !dec(c.staticBand) || !decOrNull(c.premium) || !decOrNull(c.mark) || !decOrNull(c.bookMid)) return null;
  if (!bandReason(c.reason) || !uint(c.riskVersion) || !str(c.checkedAt) || !str(c.changedAt)) return null;
  return {
    marketId: raw.marketId,
    current: {
      band: c.band,
      staticBand: c.staticBand,
      premium: c.premium,
      mark: c.mark,
      bookMid: c.bookMid,
      reason: c.reason,
      riskVersion: c.riskVersion,
      checkedAt: c.checkedAt,
      changedAt: c.changedAt,
    },
    changes,
  };
}

// ── Liquidation desk and insurance fund (D-ops-06) ──────────────────────────

export interface DeskRung {
  readonly rungId: string;
  readonly positionId: string;
  readonly liquidationId: string;
  readonly kind: string;
  readonly state: string;
  readonly fromSize: string;
  readonly fromMargin: string;
  readonly fromInsurance: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeskNearThreshold {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: string;
  readonly size: string;
  readonly markPrice: string | null;
  readonly liqPrice: string | null;
  /** Basis points between mark and liquidation price; null with `reason` when either price is missing. */
  readonly distanceBps: number | null;
  readonly reason: string | null;
}

export interface DeskAdlPair {
  readonly pairId: string;
  readonly bankruptPositionId: string;
  readonly candidatePositionId: string;
  readonly size: string;
  readonly bankruptcyPrice: string;
  readonly candidateProfit: string;
  readonly state: string;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}

export interface OwedPayout {
  readonly assetId: string;
  readonly owed: string;
  readonly count: number;
}

export interface LiquidationDesk {
  readonly rungs: readonly DeskRung[];
  readonly parked: readonly string[];
  readonly nearThreshold: readonly DeskNearThreshold[];
  readonly adlPairs: readonly DeskAdlPair[];
  readonly owedPayouts: readonly OwedPayout[];
}

function all<T>(raw: unknown, one: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(one);
  return out.every((x): x is T => x !== null) ? out : null;
}

function parseRung(v: unknown): DeskRung | null {
  if (!rec(v) || !str(v.rungId) || !str(v.positionId) || !str(v.liquidationId) || !str(v.kind) || !str(v.state)) return null;
  if (!dec(v.fromSize) || !dec(v.fromMargin) || !decOrNull(v.fromInsurance ?? null) || !str(v.createdAt) || !str(v.updatedAt)) return null;
  return {
    rungId: v.rungId,
    positionId: v.positionId,
    liquidationId: v.liquidationId,
    kind: v.kind,
    state: v.state,
    fromSize: v.fromSize,
    fromMargin: v.fromMargin,
    fromInsurance: (v.fromInsurance as string | null | undefined) ?? null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function parseNear(v: unknown): DeskNearThreshold | null {
  if (!rec(v) || !str(v.positionId) || !str(v.userId) || !str(v.marketId) || !str(v.side) || !dec(v.size)) return null;
  const mark = v.markPrice ?? null;
  const liq = v.liqPrice ?? null;
  const dist = v.distanceBps ?? null;
  if (!decOrNull(mark) || !decOrNull(liq) || !(dist === null || (typeof dist === 'number' && Number.isInteger(dist)))) return null;
  if (!strOrNull(v.reason ?? null)) return null;
  return {
    positionId: v.positionId,
    userId: v.userId,
    marketId: v.marketId,
    side: v.side,
    size: v.size,
    markPrice: mark,
    liqPrice: liq,
    distanceBps: dist,
    reason: (v.reason as string | null | undefined) ?? null,
  };
}

function parseAdl(v: unknown): DeskAdlPair | null {
  if (!rec(v) || !str(v.pairId) || !str(v.bankruptPositionId) || !str(v.candidatePositionId) || !str(v.state) || !str(v.createdAt))
    return null;
  if (!dec(v.size) || !dec(v.bankruptcyPrice) || !dec(v.candidateProfit) || !strOrNull(v.appliedAt ?? null)) return null;
  return {
    pairId: v.pairId,
    bankruptPositionId: v.bankruptPositionId,
    candidatePositionId: v.candidatePositionId,
    size: v.size,
    bankruptcyPrice: v.bankruptcyPrice,
    candidateProfit: v.candidateProfit,
    state: v.state,
    createdAt: v.createdAt,
    appliedAt: (v.appliedAt as string | null | undefined) ?? null,
  };
}

function parseOwed(v: unknown): OwedPayout | null {
  if (!rec(v) || !str(v.assetId) || !dec(v.owed) || typeof v.count !== 'number') return null;
  return { assetId: v.assetId, owed: v.owed, count: v.count };
}

export function parseLiquidationDesk(raw: unknown): LiquidationDesk | null {
  if (!rec(raw)) return null;
  const rungs = all(raw.rungs, parseRung);
  const nearThreshold = all(raw.nearThreshold, parseNear);
  const adlPairs = all(raw.adlPairs, parseAdl);
  const owedPayouts = all(raw.owedPayouts, parseOwed);
  if (!rungs || !nearThreshold || !adlPairs || !owedPayouts) return null;
  if (!Array.isArray(raw.parked) || !raw.parked.every(str)) return null;
  return { rungs, parked: raw.parked as string[], nearThreshold, adlPairs, owedPayouts };
}

export interface InsuranceDraw {
  readonly rungId: string;
  readonly positionId: string;
  readonly amount: string;
  readonly at: string;
}

export interface InsuranceHistory {
  readonly asset: string;
  /** value null carries the reason the balance could not be read. */
  readonly balance: { readonly value: string | null; readonly reason: string | null };
  readonly draws: readonly InsuranceDraw[];
  /** Top-ups are never booked by this service; the reason says so. */
  readonly topUps: { readonly reason: string };
}

export function parseInsuranceHistory(raw: unknown): InsuranceHistory | null {
  if (!rec(raw) || !str(raw.asset) || !rec(raw.balance) || !rec(raw.topUps)) return null;
  if (!decOrNull(raw.balance.value ?? null) || !strOrNull(raw.balance.reason ?? null) || !str(raw.topUps.reason)) return null;
  const draws = all(raw.draws, (d): InsuranceDraw | null =>
    rec(d) && str(d.rungId) && str(d.positionId) && dec(d.amount) && str(d.at)
      ? { rungId: d.rungId, positionId: d.positionId, amount: d.amount, at: d.at }
      : null,
  );
  if (!draws) return null;
  return {
    asset: raw.asset,
    balance: {
      value: (raw.balance.value as string | null | undefined) ?? null,
      reason: (raw.balance.reason as string | null | undefined) ?? null,
    },
    draws,
    topUps: { reason: raw.topUps.reason },
  };
}
