/**
 * §25:710 — stored video is tier- and stake-gated. Blank owner numbers refuse
 * closed (no invented magnitudes). Unsigned / failed gate is not a grant.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';

/** Same rungs as auth `TIER_ORDER` — copied so this module does not invent magnitudes. */
const TIER_ORDER = { none: 0, basic: 1, full: 2, institutional: 3 } as const;

export type VideoGateConfig = {
  /** Principal tier name. Blank → unpublished, refuse-closed. */
  readonly minTier: string;
  /** Decimal string threshold. Blank → unpublished, refuse-closed. */
  readonly minStake: string;
};

export type VideoCaller = {
  readonly userId: string;
  readonly tier: keyof typeof TIER_ORDER;
};

const TIER_NAMES = new Set<string>(Object.keys(TIER_ORDER));

export function isVideoGatePublished(gate: VideoGateConfig): boolean {
  return gate.minTier.trim().length > 0 && gate.minStake.trim().length > 0;
}

export function assertVideoGatePublished(gate: VideoGateConfig): void {
  if (!isVideoGatePublished(gate)) {
    throw new AcademyError(
      'Video entitlement magnitudes are unset — owner must publish min tier and min stake; no invent',
      'academy.video_grant_required',
    );
  }
}

/**
 * Whether the gate needs the caller's stake read at all: not when the gate is unpublished (it refuses anyway) and not
 * when the published minimum is zero (every stake meets it), so playback does not depend on the stake source then.
 */
export function videoGateNeedsStake(gate: VideoGateConfig): boolean {
  if (!isVideoGatePublished(gate)) return false;
  try {
    return parseAmount(gate.minStake.trim()) > 0n;
  } catch {
    return false;
  }
}

export function assertVideoEntitled(input: { readonly gate: VideoGateConfig; readonly caller: VideoCaller; readonly stake: Amount }): void {
  assertVideoGatePublished(input.gate);
  const wantTier = input.gate.minTier.trim();
  if (!TIER_NAMES.has(wantTier)) {
    throw new AcademyError('Video min tier is not a known verification tier', 'academy.video_grant_required');
  }
  const need = TIER_ORDER[wantTier as keyof typeof TIER_ORDER];
  if (!Object.hasOwn(TIER_ORDER, input.caller.tier)) {
    throw new AcademyError('Video caller tier is not a known verification tier', 'academy.video_grant_required');
  }
  const have = TIER_ORDER[input.caller.tier];
  if (have < need) {
    throw new AcademyError('Video playback requires a higher verification tier', 'academy.video_grant_required');
  }
  let threshold: Amount;
  try {
    threshold = parseAmount(input.gate.minStake.trim());
  } catch {
    throw new AcademyError('Video min stake is not a decimal amount', 'academy.video_grant_required');
  }
  if (input.stake < threshold) {
    throw new AcademyError('Video playback requires a stake at or above the published threshold', 'academy.video_grant_required');
  }
}
