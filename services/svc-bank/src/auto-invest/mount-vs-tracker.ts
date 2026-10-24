/**
 * D26-P1-B4 — bank.auto-invest mount vs tracker honest gaps.
 *
 * F-plane threshold sweep + card round-up; DCA refuses without convert wire.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTO_INVEST_TRACKER_ID = 'bank.auto-invest' as const;

export const AUTO_INVEST_MOUNTED_DOORS = ['policy', 'list', 'createThresholdSweep', 'createRoundUp', 'createDca', 'cancel'] as const;

export const AUTO_INVEST_DONE_BAR_TEST_FILES = [
  'auto-invest-policy.test.ts',
  'auto-invest.test.ts',
  'auto-invest.reachable.test.ts',
] as const;

export const AUTO_INVEST_HONEST_GAPS = ['gap.convert_port_trade_wire', 'gap.session_key_allowance_protocol'] as const;

export function autoInvestDoorsInRouterSource(): readonly (typeof AUTO_INVEST_MOUNTED_DOORS)[number][] {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'router', 'auto-invest.router.ts'), 'utf8');
  const start = src.search(/^export function createAutoInvestRouter\(/m);
  if (start === -1) return [];
  const block = src.slice(start);
  return AUTO_INVEST_MOUNTED_DOORS.filter((door) => new RegExp(`\\b${door}\\s*:`).test(block));
}

export function autoInvestPolicyHonestInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'auto-invest-policy.ts'), 'utf8');
  return /describeAutoInvestPolicy/.test(src) && /AUTO_INVEST_RATE_UNSET/.test(src) && /inventsRates:\s*false/.test(src);
}

export function autoInvestRunDueMountedInOps(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'router', 'ops.router.ts'), 'utf8');
  return /\brunAutoInvest\s*:/.test(src) && /autoInvest\.runDue/.test(src);
}

export function autoInvestDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return AUTO_INVEST_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function bankAutoInvestTrackerBackendDoneBarMet(): boolean {
  return (
    autoInvestDoorsInRouterSource().length === AUTO_INVEST_MOUNTED_DOORS.length &&
    autoInvestPolicyHonestInSource() &&
    autoInvestRunDueMountedInOps() &&
    autoInvestDoneBarTestsPresent()
  );
}

export function bankAutoInvestMountVsTrackerBoardCard(): {
  readonly tracker: typeof AUTO_INVEST_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const mounted = autoInvestDoorsInRouterSource();
  return {
    tracker: AUTO_INVEST_TRACKER_ID,
    doors: AUTO_INVEST_MOUNTED_DOORS.length,
    doorsMounted: mounted.length,
    gaps: AUTO_INVEST_HONEST_GAPS.length,
    backendDoneBarMet: bankAutoInvestTrackerBackendDoneBarMet(),
  };
}
