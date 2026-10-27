/**
 * D26-P1-T1 — trade.futures mount vs tracker honest gaps.
 *
 * Backend product-complete: isolated margin ladder, funding, ADL disclosure, gap-series marks,
 * isolated live re-leverage (ledger delta, sealed 10×). Owner ladder JSON still refuse-closed
 * when unset; TRADE_FUTURES_MAX_LEVERAGE empty is DIRECTION 10× (D26-P0-07), not refuse-unset.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { futuresOwnerComposeGapsClosed } from './futures-compose-wiring.js';

export const FUTURES_TRACKER_ID = 'trade.futures' as const;

export const FUTURES_MOUNTED_DOORS = ['policy'] as const;

export const FUTURES_DONE_BAR_TEST_FILES = [
  'futures-policy.test.ts',
  'mark-gap-series-honesty.test.ts',
  'adl-disclosure.test.ts',
  'funding-settlement.test.ts',
  'futures-leverage-p0-07-default.test.ts',
  'futures-ladder-owner-gate.test.ts',
  'futures-compose-wiring.test.ts',
  'futures-leverage-501-notsupported.test.ts',
  'futures-live-releverage.test.ts',
] as const;

/** Owner ladder/funding compose wired; live re-leverage is a working path, not a 501 residual. */
export const FUTURES_HONEST_GAPS = [] as const;

export function futuresOwnerEnvComposeGapsClosed(): boolean {
  return futuresOwnerComposeGapsClosed();
}

/** POST leverage is the live isolated path (ledger add/release), not the 501 helper. */
export function futuresLiveReleverageMounted(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const rest = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');
  const service = readFileSync(join(here, 'position-service.ts'), 'utf8');
  const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  const setLev = service.match(/async setLeverage\([\s\S]*?^  async addIsolatedMargin/m)?.[0] ?? '';
  return (
    /app\.post\('\/api\/v1\/positions\/leverage',\s*async/.test(rest) &&
    !/app\.post\('\/api\/v1\/positions\/leverage',\s*derivativesNotSupported\('setLeverage'/.test(rest) &&
    /deps\.setLeverage\(/.test(rest) &&
    /typeof body\.leverage === 'string'/.test(rest) &&
    /async setLeverage\(/.test(setLev) &&
    /recipes\.futuresMarginAdd\(/.test(setLev) &&
    /recipes\.futuresMarginRelease\(/.test(setLev) &&
    !/notSupported\(/.test(setLev) &&
    /positions\.setLeverage\(/.test(index)
  );
}

export function futuresDoorsInRouterSource(): readonly (typeof FUTURES_MOUNTED_DOORS)[number][] {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'router.ts'), 'utf8');
  const start = src.search(/^\s{4}futures:\s*router\(\{/m);
  if (start === -1) return [];
  const next = src.slice(start + 1).search(/^\s{4}[a-zA-Z]+:\s*router\(\{/m);
  const block = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  return FUTURES_MOUNTED_DOORS.filter((door) => new RegExp(`\\b${door}\\s*:`).test(block));
}

export function futuresPolicyHonestInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'futures-policy.ts'), 'utf8');
  return (
    /describeFuturesPolicy/.test(src) &&
    /insuranceEmptyBlocksLiveList/.test(src) &&
    /^\s{4}adlDisclosure:\s*\{/m.test(src) &&
    /jobsDefault:\s*false/.test(src)
  );
}

export function futuresDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return FUTURES_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function futuresTrackerBackendDoneBarMet(): boolean {
  return (
    futuresDoorsInRouterSource().length === FUTURES_MOUNTED_DOORS.length &&
    futuresPolicyHonestInSource() &&
    futuresDoneBarTestsPresent() &&
    futuresLiveReleverageMounted()
  );
}

export function futuresMountVsTrackerBoardCard(): {
  readonly tracker: typeof FUTURES_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const mounted = futuresDoorsInRouterSource();
  return {
    tracker: FUTURES_TRACKER_ID,
    doors: FUTURES_MOUNTED_DOORS.length,
    doorsMounted: mounted.length,
    gaps: FUTURES_HONEST_GAPS.length,
    backendDoneBarMet: futuresTrackerBackendDoneBarMet(),
  };
}
