/**
 * Parsers for the Fees and convert room's finance reads (J-cex-spot-17 #4, #7, #8): svc-trade's snapshot runs, Convert's
 * owner values and quotes, and svc-bank's fiat buy quotes. Each returns null for a body that is not the expected shape, so
 * the room refuses it rather than half-show it. Amounts stay the decimal strings the services sent. No network, no clock.
 */

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const DECIMAL = /^-?\d+(\.\d+)?$/;
const dec = (v: unknown): v is string => str(v) && DECIMAL.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Parse an array whose every item must parse; one bad item refuses the whole list. */
function listOf<T>(raw: unknown, item: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(item);
  return out.every((x): x is T => x !== null) ? out : null;
}

export interface SnapshotRun {
  readonly instant: string;
  readonly scheduleVersion: string;
  readonly accounts: number;
  readonly aboveRegular: number;
  readonly countedVolume: string;
  readonly completedAt: string;
}

export const parseSnapshotRuns = (raw: unknown): SnapshotRun[] | null =>
  listOf(raw, (v) =>
    rec(v) &&
    str(v.instant) &&
    str(v.scheduleVersion) &&
    count(v.accounts) &&
    count(v.aboveRegular) &&
    dec(v.countedVolume) &&
    str(v.completedAt)
      ? {
          instant: v.instant,
          scheduleVersion: v.scheduleVersion,
          accounts: v.accounts,
          aboveRegular: v.aboveRegular,
          countedVolume: v.countedVolume,
          completedAt: v.completedAt,
        }
      : null,
  );

export interface DeskBounds {
  readonly minQty: string;
  readonly maxQty: string;
}

export interface ConvertSettings {
  readonly paused: boolean;
  readonly assets: ReadonlyArray<{
    readonly asset: string;
    readonly maxPerConvert: { readonly amount: string; readonly asset: string } | null;
  }>;
  readonly restricted: readonly string[];
  readonly spreadBps: string | null;
  /** Set but refused by Convert: the code every quote refuses with. */
  readonly spreadRefusal: string | null;
  readonly quoteTtlMs: string | null;
  readonly quoteTtlRefusal: string | null;
  readonly deskBounds: { readonly convert: DeskBounds | null; readonly oneClickBuy: DeskBounds | null };
}

const boundsOf = (v: unknown): DeskBounds | null | undefined =>
  v === null ? null : rec(v) && dec(v.minQty) && dec(v.maxQty) ? { minQty: v.minQty, maxQty: v.maxQty } : undefined;
const wholeOrNull = (v: unknown): string | null | undefined => (v === null ? null : str(v) && /^\d+$/.test(v) ? v : undefined);
const codeOrNull = (v: unknown): string | null | undefined => (v === null ? null : str(v) && v.length > 0 ? v : undefined);

export function parseConvertSettings(raw: unknown): ConvertSettings | null {
  if (!rec(raw) || typeof raw.paused !== 'boolean' || !rec(raw.deskBounds)) return null;
  const assets = listOf(raw.assets, (v) => {
    if (!rec(v) || !str(v.asset)) return null;
    if (v.maxPerConvert === null) return { asset: v.asset, maxPerConvert: null };
    const m = v.maxPerConvert;
    return rec(m) && dec(m.amount) && str(m.asset) ? { asset: v.asset, maxPerConvert: { amount: m.amount, asset: m.asset } } : null;
  });
  const restricted = listOf(raw.restricted, (v) => (str(v) ? v : null));
  const spreadBps = wholeOrNull(raw.spreadBps);
  const quoteTtlMs = wholeOrNull(raw.quoteTtlMs);
  const spreadRefusal = codeOrNull(raw.spreadRefusal);
  const quoteTtlRefusal = codeOrNull(raw.quoteTtlRefusal);
  const convert = boundsOf(raw.deskBounds.convert);
  const oneClickBuy = boundsOf(raw.deskBounds.oneClickBuy);
  if (
    !assets ||
    !restricted ||
    spreadBps === undefined ||
    quoteTtlMs === undefined ||
    spreadRefusal === undefined ||
    quoteTtlRefusal === undefined ||
    convert === undefined ||
    oneClickBuy === undefined
  )
    return null;
  return {
    paused: raw.paused,
    assets,
    restricted,
    spreadBps,
    spreadRefusal,
    quoteTtlMs,
    quoteTtlRefusal,
    deskBounds: { convert, oneClickBuy },
  };
}

export interface ConvertQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly inAsset: string;
  readonly inAmount: string;
  readonly outAsset: string;
  readonly outAmount: string;
  readonly avgPrice: string;
  readonly spreadAmount: string;
  readonly spreadAsset: string;
  readonly spreadBps: number;
  readonly lifecycle: string;
  readonly createdAt: string;
}

export const parseConvertQuotes = (raw: unknown): ConvertQuote[] | null =>
  listOf(raw, (v) =>
    rec(v) &&
    str(v.quoteId) &&
    str(v.userId) &&
    str(v.symbol) &&
    str(v.inAsset) &&
    dec(v.inAmount) &&
    str(v.outAsset) &&
    dec(v.outAmount) &&
    dec(v.avgPrice) &&
    dec(v.spreadAmount) &&
    str(v.spreadAsset) &&
    count(v.spreadBps) &&
    str(v.lifecycle) &&
    str(v.createdAt)
      ? {
          quoteId: v.quoteId,
          userId: v.userId,
          symbol: v.symbol,
          inAsset: v.inAsset,
          inAmount: v.inAmount,
          outAsset: v.outAsset,
          outAmount: v.outAmount,
          avgPrice: v.avgPrice,
          spreadAmount: v.spreadAmount,
          spreadAsset: v.spreadAsset,
          spreadBps: v.spreadBps,
          lifecycle: v.lifecycle,
          createdAt: v.createdAt,
        }
      : null,
  );

export interface OnrampQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly method: string;
  readonly payAmount: string;
  readonly fee: string;
  readonly rate: string;
  readonly payCurrency: string;
  readonly simulated: boolean;
  readonly createdAt: string;
}

export const parseOnrampQuotes = (raw: unknown): OnrampQuote[] | null =>
  listOf(raw, (v) =>
    rec(v) &&
    str(v.quoteId) &&
    str(v.userId) &&
    str(v.assetId) &&
    dec(v.amount) &&
    str(v.method) &&
    dec(v.payAmount) &&
    dec(v.fee) &&
    dec(v.rate) &&
    str(v.payCurrency) &&
    typeof v.simulated === 'boolean' &&
    str(v.createdAt)
      ? {
          quoteId: v.quoteId,
          userId: v.userId,
          assetId: v.assetId,
          amount: v.amount,
          method: v.method,
          payAmount: v.payAmount,
          fee: v.fee,
          rate: v.rate,
          payCurrency: v.payCurrency,
          simulated: v.simulated,
          createdAt: v.createdAt,
        }
      : null,
  );

/** A notice row as svc-notify answers a draft: its id, kind and the time it takes effect. */
export interface FeeNotice {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly version: number;
  readonly startsAt: string | null;
}

export function parseFeeNotice(raw: unknown): FeeNotice | null {
  if (!rec(raw) || !str(raw.id) || !str(raw.kind) || !str(raw.status) || typeof raw.version !== 'number') return null;
  const startsAt = raw.startsAt === null || raw.startsAt === undefined ? null : str(raw.startsAt) ? raw.startsAt : undefined;
  if (startsAt === undefined) return null;
  return { id: raw.id, kind: raw.kind, status: raw.status, version: raw.version, startsAt };
}

/** What identity's approval for a notice publish must carry, as svc-notify states it. */
export interface NoticeProposal {
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly payloadHash: string;
}

export function parseNoticeProposal(raw: unknown): NoticeProposal | null {
  if (!rec(raw) || !str(raw.actionType) || !str(raw.targetService) || !str(raw.targetId) || !str(raw.payloadHash)) return null;
  const expectedVersion = str(raw.expectedVersion)
    ? raw.expectedVersion
    : typeof raw.expectedVersion === 'number'
      ? String(raw.expectedVersion)
      : null;
  if (expectedVersion === null) return null;
  return {
    actionType: raw.actionType,
    targetService: raw.targetService,
    targetId: raw.targetId,
    expectedVersion,
    payloadHash: raw.payloadHash,
  };
}
