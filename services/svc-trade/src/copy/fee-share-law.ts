/**
 * Copy fee-share + jurisdiction product law (D-S-03 / SPEC-SOVEREIGN…).
 *
 * `leader_share_bps` (D26-P0-02) and the served-jurisdiction list (D26-P0-15)
 * are DIRECTION §8 — never defaulted. Blank / unpublished → refuse-closed.
 *
 * Jurisdiction seal (D26-P0-15):
 * `docs/adr/2026-08-12-copy-jurisdiction-refuse-closed.md` — no invent geo
 * list; owner publishes `TRADE_COPY_JURISDICTION_LAW` or follow stays closed.
 *
 * Spec formula (no P&L): leader earnings = share of protocol trading fee
 * on follower fill notional. Follower pays the same fee as solo trading.
 */

import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, COPY_LAW_RESIDUAL, CopyError } from './errors.js';

export type CopyFeeShareLaw =
  | { readonly published: false }
  | {
      readonly published: true;
      /**
       * Share of *our* protocol fee paid to the leader (bps of the fee,
       * not a markup on the follower). Owner-published only. 0..10_000.
       */
      readonly leaderShareBps: number;
      /** Cap leader earnings per follower per period (decimal string scaled later). */
      readonly earningsCapPerFollower: string;
      /** Round-trips per period before rate decay applies. */
      readonly decayRoundTrips: number;
      /** Decay rate as bps of the full share (remaining share after decay). */
      readonly decayShareBps: number;
    };

export type CopyJurisdictionLaw =
  | { readonly published: false }
  | {
      readonly published: true;
      /** ISO-like region codes owner allows. Empty array = serve none (fail closed). */
      readonly allowedRegions: readonly string[];
    };

/** Production default — no invent. */
export const UNPUBLISHED_COPY_FEE_SHARE_LAW: CopyFeeShareLaw = { published: false };
export const UNPUBLISHED_COPY_JURISDICTION_LAW: CopyJurisdictionLaw = { published: false };

/**
 * Parse owner-published fee-share law from env JSON.
 * Empty / whitespace → unpublished. Invalid → throw (fail boot, do not invent).
 */
export function parseCopyFeeShareLawJson(raw: string | null | undefined): CopyFeeShareLaw {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_COPY_FEE_SHARE_LAW;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CopyError('TRADE_COPY_FEE_SHARE_LAW is not valid JSON', 'trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CopyError('TRADE_COPY_FEE_SHARE_LAW must be an object', 'trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_COPY_FEE_SHARE_LAW;
  if (obj.published !== true) {
    throw new CopyError('TRADE_COPY_FEE_SHARE_LAW.published must be true or false', 'trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
  }

  const leaderShareBps = obj.leaderShareBps;
  if (typeof leaderShareBps !== 'number' || !Number.isInteger(leaderShareBps) || leaderShareBps < 0 || leaderShareBps > 10_000) {
    throw new CopyError(
      'TRADE_COPY_FEE_SHARE_LAW.leaderShareBps must be an integer 0..10000',
      'trade.copy_fee_share_blank',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }

  if (typeof obj.earningsCapPerFollower !== 'string' || !obj.earningsCapPerFollower.trim()) {
    throw new CopyError(
      'TRADE_COPY_FEE_SHARE_LAW.earningsCapPerFollower must be a decimal string',
      'trade.copy_fee_share_blank',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }

  const earningsCapRaw = obj.earningsCapPerFollower.trim();
  let earningsCap: Amount;
  try {
    earningsCap = parseAmount(earningsCapRaw);
  } catch {
    throw new CopyError(
      'TRADE_COPY_FEE_SHARE_LAW.earningsCapPerFollower must be a non-negative decimal string',
      'trade.copy_fee_share_blank',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }
  if (earningsCap < 0n) {
    throw new CopyError(
      'TRADE_COPY_FEE_SHARE_LAW.earningsCapPerFollower must be a non-negative decimal string',
      'trade.copy_fee_share_blank',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }

  const decayRoundTrips = obj.decayRoundTrips ?? 0;
  if (typeof decayRoundTrips !== 'number' || !Number.isInteger(decayRoundTrips) || decayRoundTrips < 0) {
    throw new CopyError(
      'TRADE_COPY_FEE_SHARE_LAW.decayRoundTrips must be a non-negative integer',
      'trade.copy_fee_share_blank',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }

  const decayShareBps = obj.decayShareBps ?? leaderShareBps;
  if (typeof decayShareBps !== 'number' || !Number.isInteger(decayShareBps) || decayShareBps < 0 || decayShareBps > 10_000) {
    throw new CopyError(
      'TRADE_COPY_FEE_SHARE_LAW.decayShareBps must be an integer 0..10000',
      'trade.copy_fee_share_blank',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }

  return {
    published: true,
    leaderShareBps,
    // Owner spelling. formatAmount('1000.00') is '1000' and would rewrite the shipped cap.
    earningsCapPerFollower: earningsCapRaw,
    decayRoundTrips,
    decayShareBps,
  };
}

/**
 * Parse owner-published jurisdiction allowlist from env JSON.
 * Empty → unpublished (refuse-closed — never invent regions).
 */
export function parseCopyJurisdictionLawJson(raw: string | null | undefined): CopyJurisdictionLaw {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_COPY_JURISDICTION_LAW;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CopyError('TRADE_COPY_JURISDICTION_LAW is not valid JSON', 'trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CopyError('TRADE_COPY_JURISDICTION_LAW must be an object', 'trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_COPY_JURISDICTION_LAW;
  if (obj.published !== true) {
    throw new CopyError(
      'TRADE_COPY_JURISDICTION_LAW.published must be true or false',
      'trade.copy_jurisdiction_blank',
      COPY_JURISDICTION_RESIDUAL,
    );
  }

  if (!Array.isArray(obj.allowedRegions)) {
    throw new CopyError(
      'TRADE_COPY_JURISDICTION_LAW.allowedRegions must be an array of region codes',
      'trade.copy_jurisdiction_blank',
      COPY_JURISDICTION_RESIDUAL,
    );
  }

  const allowedRegions: string[] = [];
  for (const r of obj.allowedRegions) {
    if (typeof r !== 'string' || !r.trim()) {
      throw new CopyError(
        'TRADE_COPY_JURISDICTION_LAW.allowedRegions entries must be non-empty strings',
        'trade.copy_jurisdiction_blank',
        COPY_JURISDICTION_RESIDUAL,
      );
    }
    allowedRegions.push(r.trim().toUpperCase());
  }

  return { published: true, allowedRegions };
}

export function requirePublishedCopyFeeShareLaw(law: CopyFeeShareLaw | null | undefined): Extract<CopyFeeShareLaw, { published: true }> {
  if (!law || law.published !== true) {
    logRefusalSpec('trade.copy_fee_share_blank');
    throw new CopyError(COPY_FEE_SHARE_RESIDUAL, 'trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
  }
  return law;
}

export function requirePublishedCopyJurisdictionLaw(
  law: CopyJurisdictionLaw | null | undefined,
): Extract<CopyJurisdictionLaw, { published: true }> {
  if (!law || law.published !== true) {
    logRefusalSpec('trade.copy_jurisdiction_blank');
    throw new CopyError(COPY_JURISDICTION_RESIDUAL, 'trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
  }
  return law;
}

/** Combined status — both blanks named (P0-02 rates · P0-15 jurisdictions). */
export function copyLawStatusLine(fee: CopyFeeShareLaw, jurisdiction: CopyJurisdictionLaw): string {
  if (fee.published !== true) logRefusalSpec('trade.copy_fee_share_blank');
  if (jurisdiction.published !== true) logRefusalSpec('trade.copy_jurisdiction_blank');
  const feePart = fee.published === true ? `feeShare=1 leaderShareBps=${fee.leaderShareBps}` : 'feeShare=0 residual=leader_fee_share_unset';
  const jurPart =
    jurisdiction.published === true
      ? `jurisdiction=1 regions=${jurisdiction.allowedRegions.length}`
      : 'jurisdiction=0 residual=served_regions_unset';
  return `${feePart} ${jurPart}`;
}

export function copyLawResidual(fee: CopyFeeShareLaw, jurisdiction: CopyJurisdictionLaw): string | null {
  if (fee.published !== true && jurisdiction.published !== true) return COPY_LAW_RESIDUAL;
  if (fee.published !== true) return COPY_FEE_SHARE_RESIDUAL;
  if (jurisdiction.published !== true) return COPY_JURISDICTION_RESIDUAL;
  return null;
}
