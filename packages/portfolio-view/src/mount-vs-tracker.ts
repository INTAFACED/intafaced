/**
 * D26-P1-P2 — ops.portfolio mount vs tracker honest gaps.
 *
 * Custodial ledger view mounted. Indexer composite is present-or-named-unwired.
 * House half remains Class X.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPS_PORTFOLIO_TRACKER_ID = 'ops.portfolio' as const;

export const PORTFOLIO_LEDGER_DOORS = ['portfolio'] as const;

export const PORTFOLIO_DONE_BAR_TEST_FILES = ['portfolio-view.test.ts'] as const;

export const PORTFOLIO_HONEST_GAPS = ['gap.house_half_class_x'] as const;

/** svc-ledger is the Rust crate: its door serves every route in `ROUTES` (crates/svc-ledger/src/door/mod.rs). */
export function portfolioDoorInLedgerRouterSource(): boolean {
  const routesPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'crates', 'svc-ledger', 'src', 'door', 'mod.rs');
  const src = readFileSync(routesPath, 'utf8');
  return /s2s\(\s*"portfolio",\s*"\/trpc\/portfolio",/.test(src);
}

export function portfolioViewHonestInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'portfolio-view.ts'), 'utf8');
  return (
    /PORTFOLIO_INDEXER_UNWIRED/.test(src) &&
    /portfolioViewFromLedgerBalances/.test(src) &&
    /indexerPresentSchema/.test(src) &&
    /resolveIndexerHalf/.test(src)
  );
}

/** The crate answers `portfolio` (crates/svc-ledger/src/balances.rs), the indexer half named unwired when absent. */
export function portfolioS2sDoorPresent(): boolean {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'crates', 'svc-ledger', 'src', 'balances.rs');
  const src = readFileSync(path, 'utf8');
  return /"portfolio"\s*=>/.test(src) && /indexer\.portfolio_positions_unwired/.test(src);
}

export function portfolioDoneBarTestsPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return PORTFOLIO_DONE_BAR_TEST_FILES.every((file) => existsSync(join(here, file)));
}

export function opsPortfolioTrackerBackendDoneBarMet(): boolean {
  return (
    portfolioDoorInLedgerRouterSource() && portfolioViewHonestInSource() && portfolioS2sDoorPresent() && portfolioDoneBarTestsPresent()
  );
}

export function opsPortfolioMountVsTrackerBoardCard(): {
  readonly tracker: typeof OPS_PORTFOLIO_TRACKER_ID;
  readonly doors: number;
  readonly doorsMounted: number;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
} {
  return {
    tracker: OPS_PORTFOLIO_TRACKER_ID,
    doors: PORTFOLIO_LEDGER_DOORS.length,
    doorsMounted: portfolioDoorInLedgerRouterSource() ? PORTFOLIO_LEDGER_DOORS.length : 0,
    gaps: PORTFOLIO_HONEST_GAPS.length,
    backendDoneBarMet: opsPortfolioTrackerBackendDoneBarMet(),
  };
}
