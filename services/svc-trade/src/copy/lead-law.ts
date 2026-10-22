/**
 * Lead trader owner values (CB-copy-12). JSON in TRADE_COPY_LEAD_LAW, or empty.
 *
 * Every value is the owner's. A blank value is null and refuses the step that
 * needs it with a typed code; nothing here defaults (blank never means "no
 * requirement").
 *
 * Shape: {"spotMarkets":["BTC/USDT"],"futuresMarkets":[],"verificationLevel":"full",
 *   "balanceAsset":"USDT","balanceThreshold":"1000","resubmitDays":30,
 *   "missionTransferMinimum":"500","missionDaysToList":14}
 */

import { parseAmount } from '@intafaced/ledger-client';

export type CopyLeadLaw = {
  readonly spotMarkets: readonly string[] | null;
  readonly futuresMarkets: readonly string[] | null;
  readonly verificationLevel: string | null;
  readonly balanceAsset: string | null;
  readonly balanceThreshold: string | null;
  readonly resubmitDays: number | null;
  readonly missionTransferMinimum: string | null;
  readonly missionDaysToList: number | null;
};

export const BLANK_COPY_LEAD_LAW: CopyLeadLaw = {
  spotMarkets: null,
  futuresMarkets: null,
  verificationLevel: null,
  balanceAsset: null,
  balanceThreshold: null,
  resubmitDays: null,
  missionTransferMinimum: null,
  missionDaysToList: null,
};

function text(v: unknown, key: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`TRADE_COPY_LEAD_LAW.${key} must be a string`);
  const t = v.trim();
  return t ? t : null;
}

function amount(v: unknown, key: string): string | null {
  const t = text(v, key);
  if (t === null) return null;
  if (!/^\d+(\.\d{1,18})?$/.test(t)) throw new Error(`TRADE_COPY_LEAD_LAW.${key} must be an unsigned decimal string`);
  parseAmount(t);
  return t;
}

function days(v: unknown, key: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 3650) {
    throw new Error(`TRADE_COPY_LEAD_LAW.${key} must be a whole number of days 0..3650`);
  }
  return v;
}

function markets(v: unknown, key: string): readonly string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((m) => typeof m !== 'string')) throw new Error(`TRADE_COPY_LEAD_LAW.${key} must be an array of symbols`);
  const list = (v as string[]).map((m) => m.trim()).filter(Boolean);
  return list.length ? list : null;
}

/** Parse the env value. Empty means every value is blank. Malformed JSON fails boot. */
export function parseCopyLeadLawJson(raw: string | undefined | null): CopyLeadLaw {
  const t = (raw ?? '').trim();
  if (!t) return BLANK_COPY_LEAD_LAW;
  const o = JSON.parse(t) as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('TRADE_COPY_LEAD_LAW must be a JSON object');
  return {
    spotMarkets: markets(o.spotMarkets, 'spotMarkets'),
    futuresMarkets: markets(o.futuresMarkets, 'futuresMarkets'),
    verificationLevel: text(o.verificationLevel, 'verificationLevel'),
    balanceAsset: text(o.balanceAsset, 'balanceAsset'),
    balanceThreshold: amount(o.balanceThreshold, 'balanceThreshold'),
    resubmitDays: days(o.resubmitDays, 'resubmitDays'),
    missionTransferMinimum: amount(o.missionTransferMinimum, 'missionTransferMinimum'),
    missionDaysToList: days(o.missionDaysToList, 'missionDaysToList'),
  };
}
