/**
 * D26-P1-G1 — agents.growth mount vs tracker honest gaps.
 *
 * Campaign proposals for humans only — never autonomous publication.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROWTH_TRACKER_ID = 'agents.growth' as const;

export const GROWTH_MOUNTED_DOORS = ['propose'] as const;

export const GROWTH_DONE_BAR_TEST_FILES = ['campaign-proposal.test.ts', 'growth-route.test.ts'] as const;

export const GROWTH_HONEST_GAPS = ['gap.incentive_budget_class_x', 'gap.warehouse_live_cubes'] as const;

function readAgentsRouterSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'router.ts'), 'utf8');
}

/** Text of the `growth: router({ ... })` object, or null when that mount is absent or unclosed. */
function growthRouterObjectBlock(src: string): string | null {
  const match = /^\s{4}growth:\s*router\(\{/m.exec(src);
  if (match === null) return null;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

export function growthDoorsInRouterSource(src: string = readAgentsRouterSource()): readonly (typeof GROWTH_MOUNTED_DOORS)[number][] {
  const block = growthRouterObjectBlock(src);
  if (block === null) return [];
  return GROWTH_MOUNTED_DOORS.filter((door) => new RegExp(`\\b${door}\\s*:`).test(block));
}

export function growthProposalHonestInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'campaign-proposal.ts'), 'utf8');
  return /isPublication:\s*false/.test(src) && /autonomous_publish/.test(src) && /returns_claim/.test(src);
}

export function growthDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return GROWTH_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function agentsGrowthTrackerBackendDoneBarMet(): boolean {
  return (
    growthDoorsInRouterSource().length === GROWTH_MOUNTED_DOORS.length && growthProposalHonestInSource() && growthDoneBarTestsPresent()
  );
}

export function agentsGrowthMountVsTrackerBoardCard(): {
  readonly tracker: typeof GROWTH_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  const mounted = growthDoorsInRouterSource();
  return {
    tracker: GROWTH_TRACKER_ID,
    doors: GROWTH_MOUNTED_DOORS.length,
    doorsMounted: mounted.length,
    gaps: GROWTH_HONEST_GAPS.length,
    backendDoneBarMet: agentsGrowthTrackerBackendDoneBarMet(),
  };
}
