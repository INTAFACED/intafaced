import type { ServiceName } from '@intafaced/contracts';
import { LEDGER_CALLER_SERVICES } from './caller-allowlist.js';

/**
 * Which services may call each door on svc-ledger's service port. A blank list
 * refuses every caller: those doors have no caller in this repo yet, so none is
 * named until one exists.
 *
 * `post` is the services that hold a recipe grant (`caller-allowlist.ts`), which
 * then judges the recipe and module. The read doors add the services that read
 * balances or history without posting.
 */
const READERS_WITHOUT_POSTS = ['svc-matching', 'svc-tax'] as const satisfies readonly ServiceName[];
/**
 * Posters that read nothing but their own keys (ADR 2026-10-22 service-access-calls rule 5): a new poster does not
 * become a ledger reader. `txByKey` answers identifying fields only and resolves the poster's own unknown outcomes.
 * svc-campaigns posts task rewards and pot sweeps (J-campaigns-02) and reads back only its own keys.
 */
const POSTERS_WITHOUT_READS = ['svc-ops', 'svc-campaigns'] as const satisfies readonly ServiceName[];

const POSTERS: readonly ServiceName[] = LEDGER_CALLER_SERVICES;
const READERS: readonly ServiceName[] = [
  ...POSTERS.filter((s) => !(POSTERS_WITHOUT_READS as readonly ServiceName[]).includes(s)),
  ...READERS_WITHOUT_POSTS,
];

export const LEDGER_DOOR_CALLERS = {
  post: POSTERS,
  balance: READERS,
  balances: READERS,
  txByKey: [...READERS, ...POSTERS_WITHOUT_READS],
  txById: READERS,
  history: READERS,
  historyPage: READERS,
  /** What one owner holds now and how it moved since a point in time: svc-bank's value-over-time read (J-portfolio-05). */
  holdingsHistory: ['svc-bank'],
  /** The asset and network registry (W-balances-05): read by every service that reads balances. */
  assetsList: READERS,
  assetsGet: READERS,
  /** svc-ops reads fee revenue for the venue report; besides this and the chain tip it only posts its staff holds and reads their keys. */
  feeRevenue: ['svc-ops'],
  /** svc-ops reads the chain tip for the joint restore. */
  restoreWatermark: ['svc-ops'],
  /** svc-ops reads finished reconciliation evaluations for its alert store (OPS-reconciliation-03). */
  reconciliationEvaluations: ['svc-ops'],
  portfolio: [],
  statementPnl: [],
  reportExport: [],
  custody: [],
  financeClose: [],
  resilience: [],
} as const satisfies Record<string, readonly ServiceName[]>;

export type LedgerDoor = keyof typeof LEDGER_DOOR_CALLERS;
