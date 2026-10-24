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

const POSTERS: readonly ServiceName[] = LEDGER_CALLER_SERVICES;
const READERS: readonly ServiceName[] = [...POSTERS, ...READERS_WITHOUT_POSTS];

export const LEDGER_DOOR_CALLERS = {
  post: POSTERS,
  balance: READERS,
  balances: READERS,
  txByKey: READERS,
  txById: READERS,
  history: READERS,
  historyPage: READERS,
  /** What one owner holds now and how it moved since a point in time: svc-bank's value-over-time read (J-portfolio-05). */
  holdingsHistory: ['svc-bank'],
  /** The asset and network registry (W-balances-05): read by every service that reads balances. */
  assetsList: READERS,
  assetsGet: READERS,
  /** svc-ops reads fee revenue for the venue report and calls no other door. */
  feeRevenue: ['svc-ops'],
  /** svc-ops reads the chain tip for the joint restore and calls no other door. */
  restoreWatermark: ['svc-ops'],
  portfolio: [],
  statementPnl: [],
  reportExport: [],
  custody: [],
  financeClose: [],
  resilience: [],
} as const satisfies Record<string, readonly ServiceName[]>;

export type LedgerDoor = keyof typeof LEDGER_DOOR_CALLERS;
