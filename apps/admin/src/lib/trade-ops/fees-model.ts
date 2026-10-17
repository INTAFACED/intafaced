import type { Outcome } from './outcome';

/**
 * The fees customers are actually charged, as svc-trade's operator read (GET /api/v1/admin/fees) reports them: the owner
 * TRADE_FEE_SCHEDULE resolved per market kind, before any per-customer rank discount. The listing-row maker/taker numbers
 * on the market record are metadata and are not charged. Bps are decimal strings; percentages are built from them with
 * integer string maths, never a float. No network and no clock: safe in tests.
 */

export type FeeProduct = 'spot' | 'perpetual';

export interface MarketFee {
  readonly symbol: string;
  readonly kind: 'spot' | 'futures' | 'options';
  readonly product: FeeProduct | null;
  readonly charged: { readonly makerBps: string; readonly takerBps: string; readonly makerRate: string; readonly takerRate: string } | null;
  readonly refusal: string | null;
}

export interface EffectiveFees {
  readonly source: string;
  readonly version: string;
  readonly markets: readonly MarketFee[];
}

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const BPS = /^\d{1,4}$/;
const RATE = /^\d+(\.\d+)?$/;

function parseCharged(v: unknown): MarketFee['charged'] | undefined {
  if (v === null) return null;
  if (!rec(v)) return undefined;
  const { makerBps, takerBps, makerRate, takerRate } = v;
  if (typeof makerBps !== 'string' || !BPS.test(makerBps) || typeof takerBps !== 'string' || !BPS.test(takerBps)) return undefined;
  if (typeof makerRate !== 'string' || !RATE.test(makerRate) || typeof takerRate !== 'string' || !RATE.test(takerRate)) return undefined;
  return { makerBps, takerBps, makerRate, takerRate };
}

function parseMarketFee(v: unknown): MarketFee | null {
  if (!rec(v) || typeof v.symbol !== 'string') return null;
  if (v.kind !== 'spot' && v.kind !== 'futures' && v.kind !== 'options') return null;
  if (v.product !== null && v.product !== 'spot' && v.product !== 'perpetual') return null;
  const charged = parseCharged(v.charged);
  if (charged === undefined) return null;
  if (v.refusal !== null && typeof v.refusal !== 'string') return null;
  // A row is either charged or refused, never both and never neither: a blank must name its refusal.
  if ((charged === null) === (v.refusal === null)) return null;
  return { symbol: v.symbol, kind: v.kind, product: v.product, charged, refusal: v.refusal };
}

/** Parse the operator fee read. A body that is not the expected shape returns null (the caller refuses it, never half-shows it). */
export function parseEffectiveFees(raw: unknown): EffectiveFees | null {
  if (!rec(raw) || typeof raw.source !== 'string' || typeof raw.version !== 'string' || !Array.isArray(raw.markets)) return null;
  const markets = raw.markets.map(parseMarketFee);
  return markets.every((m): m is MarketFee => m !== null) ? { source: raw.source, version: raw.version, markets } : null;
}

/** Integer bps as a percent, exact: "8" → "0.08%", "10" → "0.10%", "125" → "1.25%". */
export function bpsToPercent(bps: string): string {
  const n = BigInt(bps);
  const whole = n / 100n;
  const frac = String(n % 100n).padStart(2, '0');
  return `${whole}.${frac}%`;
}

/** What one market's fee cell shows. */
export type FeeCell =
  | { readonly kind: 'charged'; readonly product: FeeProduct; readonly makerBps: string; readonly takerBps: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unread' };

/** Resolve a market's fee cell from the read. A refused read refuses every cell with the service's code; an unreached one shows a dash. */
export function feeCellFor(fees: Outcome<EffectiveFees>, symbol: string): FeeCell {
  if (fees.kind === 'refused') return { kind: 'refused', code: fees.code };
  if (fees.kind === 'unknown') return { kind: 'unread' };
  const row = fees.data.markets.find((m) => m.symbol === symbol);
  if (!row) return { kind: 'unread' };
  if (!row.charged || !row.product) return { kind: 'refused', code: row.refusal ?? 'trade.fee_product_unpublished' };
  return { kind: 'charged', product: row.product, makerBps: row.charged.makerBps, takerBps: row.charged.takerBps };
}

/** The cell as plain text: "0.08% / 0.10%", "Refused (trade.fee_schedule_blank)" or "—". */
export function feeCellText(cell: FeeCell): string {
  switch (cell.kind) {
    case 'charged':
      return `${bpsToPercent(cell.makerBps)} / ${bpsToPercent(cell.takerBps)}`;
    case 'refused':
      return `Refused (${cell.code})`;
    case 'unread':
      return '—';
  }
}

/** Sort key for the cell: the maker bps as an integer string, or null when there is no charged number. */
export function feeCellSortValue(cell: FeeCell): string | null {
  return cell.kind === 'charged' ? cell.makerBps : null;
}
