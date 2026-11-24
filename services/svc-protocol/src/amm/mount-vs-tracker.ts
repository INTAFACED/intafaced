/**
 * D26-P1-A2 — protocol.amm mount vs tracker honest gaps.
 *
 * Constant-product pools: math + on-chain swap calldata mounted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AMM_TRACKER_ID = 'protocol.amm' as const;

export const AMM_MOUNTED_DOORS = ['quoteFromPool', 'buildSwapExactIn'] as const;

export const AMM_DONE_BAR_TEST_FILES = [
  'invariants.test.ts',
  'math.test.ts',
  'mint-swap-onchain.test.ts',
  'pool-factory-onchain.test.ts',
] as const;

export const AMM_HONEST_GAPS = ['gap.external_contract_audit', 'gap.live_chain_rpc_nitro'] as const;

export function ammDoorsInRouterSource(): readonly (typeof AMM_MOUNTED_DOORS)[number][] {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'router.ts'), 'utf8');
  const start = src.search(/^\s{4}amm:\s*router\(\{/m);
  if (start === -1) return [];
  const next = src.slice(start + 1).search(/^\s{4}launch:\s*router\(\{/m);
  const block = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  return AMM_MOUNTED_DOORS.filter((door) => new RegExp(`\\b${door}\\s*:`).test(block));
}

export function ammBuildHonestInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'build.ts'), 'utf8');
  return /buildSwapExactIn/.test(src) && /quoteExactIn/.test(src);
}

export function ammDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return AMM_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function protocolAmmTrackerBackendDoneBarMet(): boolean {
  return ammDoorsInRouterSource().length === AMM_MOUNTED_DOORS.length && ammBuildHonestInSource() && ammDoneBarTestsPresent();
}

export function protocolAmmMountVsTrackerBoardCard(): {
  readonly tracker: typeof AMM_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const mounted = ammDoorsInRouterSource();
  return {
    tracker: AMM_TRACKER_ID,
    doors: AMM_MOUNTED_DOORS.length,
    doorsMounted: mounted.length,
    gaps: AMM_HONEST_GAPS.length,
    backendDoneBarMet: protocolAmmTrackerBackendDoneBarMet(),
  };
}
