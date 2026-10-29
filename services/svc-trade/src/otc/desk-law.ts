/**
 * OTC desk product law (D-S-02 / SPEC-OTC-RFQ-AND-EARN Part A).
 *
 * Spread bps, min stake, and whether we act as principal are DIRECTION §8 —
 * never defaulted. Blank / unpublished → refuse-closed.
 */

import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { OTC_DESK_LAW_RESIDUAL, OtcError } from './errors.js';
import { normalizeOtcAsset } from './mid-source.js';

export type OtcCounterpartyMode = 'platform' | 'maker';

export type OtcDeskLaw =
  | { readonly published: false }
  | {
      readonly published: true;
      /** Disclosed house spread on RFQ, bps of mid notional. Owner-published only. */
      readonly spreadBps: number;
      /** Minimum active stake (decimal string → Amount). Owner-published only. */
      readonly minStake: Amount;
      /** Platform principal vs routed maker — must be disclosed on the quote. */
      readonly counterparty: OtcCounterpartyMode;
      /** Quote TTL in ms. Owner-published only — never invent 30000. */
      readonly quoteTtlMs: number;
      /**
       * Max age of a mid observation, seconds. Owner-published only (DIRECTION §8).
       * Older than this → refuse quote rather than price off a memory.
       */
      readonly maxMidAgeSeconds: number;
      /**
       * How long an accepted quote may wait to be settled, ms from the accept (CB-otc-07). Owner-published only.
       * Null is blank: there is no deferral, so a bound quote settles only while its own quote is still firm.
       */
      readonly settleWindowMs?: number | null;
      /**
       * Smallest request the desk prices, as the notional the customer trades (after the spread), per quote asset (CB-otc-07). Owner-published
       * only. Null, or a quote asset left out, is blank: a request in that asset refuses `trade.rfq_size_not_set`.
       */
      readonly minNotional?: Readonly<Record<string, Amount>> | null;
    };

/** Production default — no invent. */
export const UNPUBLISHED_OTC_DESK_LAW: OtcDeskLaw = { published: false };

/**
 * Parse owner-published desk law from env JSON.
 * Empty / whitespace → unpublished. Invalid → throw (fail boot, do not invent).
 */
export function parseOtcDeskLawJson(raw: string | null | undefined): OtcDeskLaw {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_OTC_DESK_LAW;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new OtcError('TRADE_OTC_DESK_LAW is not valid JSON', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new OtcError('TRADE_OTC_DESK_LAW must be an object', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_OTC_DESK_LAW;
  if (obj.published !== true) {
    throw new OtcError('TRADE_OTC_DESK_LAW.published must be true or false', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }

  const spreadBps = obj.spreadBps;
  if (typeof spreadBps !== 'number' || !Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps > 5000) {
    throw new OtcError('TRADE_OTC_DESK_LAW.spreadBps must be an integer 0..5000', 'trade.otc_bad_spread', OTC_DESK_LAW_RESIDUAL);
  }

  if (typeof obj.minStake !== 'string' || !obj.minStake.trim()) {
    throw new OtcError('TRADE_OTC_DESK_LAW.minStake must be a decimal string', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }
  let minStake: Amount;
  try {
    minStake = parseAmount(obj.minStake);
  } catch {
    throw new OtcError('TRADE_OTC_DESK_LAW.minStake is not a valid amount', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }
  if (minStake < 0n) {
    throw new OtcError('TRADE_OTC_DESK_LAW.minStake must be non-negative', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }

  const counterparty = obj.counterparty;
  if (counterparty !== 'platform' && counterparty !== 'maker') {
    throw new OtcError('TRADE_OTC_DESK_LAW.counterparty must be platform|maker', 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }

  // No default — inventing TTL is inventing how long a quote may bind the desk.
  // Owner must name quoteTtlMs (30000 is legal if they publish it), or refuse.
  const quoteTtlMs = obj.quoteTtlMs;
  if (typeof quoteTtlMs !== 'number' || !Number.isInteger(quoteTtlMs) || quoteTtlMs < 1_000 || quoteTtlMs > 3_600_000) {
    throw new OtcError(
      'TRADE_OTC_DESK_LAW.quoteTtlMs must be an integer 1000..3600000 — refuse rather than invent 30000',
      'trade.otc_desk_law_blank',
      OTC_DESK_LAW_RESIDUAL,
    );
  }

  // No default — inventing a staleness window is inventing when the desk may
  // still move money. Owner must name the number, or the law is unpublished.
  const maxMidAgeSeconds = obj.maxMidAgeSeconds;
  if (typeof maxMidAgeSeconds !== 'number' || !Number.isInteger(maxMidAgeSeconds) || maxMidAgeSeconds < 1 || maxMidAgeSeconds > 86_400) {
    throw new OtcError(
      'TRADE_OTC_DESK_LAW.maxMidAgeSeconds must be an integer 1..86400 — refuse rather than invent mid freshness',
      'trade.otc_desk_law_blank',
      OTC_DESK_LAW_RESIDUAL,
    );
  }

  // Optional: absent or null is blank (no deferral), never a default window.
  const settleWindowMs = obj.settleWindowMs ?? null;
  if (
    settleWindowMs !== null &&
    (typeof settleWindowMs !== 'number' || !Number.isInteger(settleWindowMs) || settleWindowMs < 1_000 || settleWindowMs > 86_400_000)
  ) {
    throw new OtcError(
      'TRADE_OTC_DESK_LAW.settleWindowMs must be an integer 1000..86400000, or left out for no deferral',
      'trade.otc_desk_law_blank',
      OTC_DESK_LAW_RESIDUAL,
    );
  }

  // Optional: absent or null is blank, and a blank minimum refuses each request in its asset, never a default size.
  const minNotional = parseMinNotional(obj.minNotional ?? null);

  return { published: true, spreadBps, minStake, counterparty, quoteTtlMs, maxMidAgeSeconds, settleWindowMs, minNotional };
}

/** `{ "USDT": "1000" }`: quote asset to minimum notional, each a non-negative decimal string. */
function parseMinNotional(raw: unknown): Readonly<Record<string, Amount>> | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) refuseMinNotional('must be an object of quote asset to decimal string, or left out');
  const out: Record<string, Amount> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const asset = normalizeOtcAsset(key);
    if (asset == null) refuseMinNotional(`has an unusable asset id ${JSON.stringify(key)}`);
    if (Object.hasOwn(out, asset)) refuseMinNotional(`names ${asset} twice`);
    if (typeof value !== 'string' || !value.trim()) refuseMinNotional(`.${asset} must be a decimal string`);
    let amount: Amount;
    try {
      amount = parseAmount(value);
    } catch {
      refuseMinNotional(`.${asset} is not a valid amount`);
    }
    if (amount < 0n) refuseMinNotional(`.${asset} must be non-negative`);
    out[asset] = amount;
  }
  return out;
}

function refuseMinNotional(why: string): never {
  throw new OtcError(`TRADE_OTC_DESK_LAW.minNotional ${why}`, 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
}

/** The desk minimum for requests in `quoteAsset`, or null when the owner has not set one. */
export function otcMinNotionalFor(law: Extract<OtcDeskLaw, { published: true }>, quoteAsset: string): Amount | null {
  const table = law.minNotional ?? null;
  return table != null && Object.hasOwn(table, quoteAsset) ? (table[quoteAsset] ?? null) : null;
}

/** Require published law or throw refuse-closed. */
export function requirePublishedOtcDeskLaw(law: OtcDeskLaw | null | undefined): Extract<OtcDeskLaw, { published: true }> {
  if (!law || law.published !== true) {
    logRefusalSpec('trade.otc_desk_law_blank');
    throw new OtcError(OTC_DESK_LAW_RESIDUAL, 'trade.otc_desk_law_blank', OTC_DESK_LAW_RESIDUAL);
  }
  return law;
}

export function otcDeskLawStatusLine(law: OtcDeskLaw): string {
  if (law.published !== true) {
    logRefusalSpec('trade.otc_desk_law_blank');
    return 'published=0 residual=otc_desk_law_unset';
  }
  return `published=1 spreadBps=${law.spreadBps} counterparty=${law.counterparty} ttlMs=${law.quoteTtlMs} maxMidAgeSeconds=${law.maxMidAgeSeconds} settleWindowMs=${law.settleWindowMs ?? 'unset'} minStake=${formatAmount(law.minStake)} minNotional=${minNotionalLabel(law.minNotional ?? null)}`;
}

function minNotionalLabel(table: Readonly<Record<string, Amount>> | null): string {
  const entries = Object.entries(table ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? 'unset' : entries.map(([asset, amount]) => `${asset}:${formatAmount(amount)}`).join(',');
}
