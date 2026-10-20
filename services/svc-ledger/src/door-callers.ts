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
  /** svc-ops reads fee revenue for the venue report and calls no other door. */
  feeRevenue: ['svc-ops'],
  portfolio: [],
  statementPnl: [],
  reportExport: [],
  custody: [],
  financeClose: [],
  resilience: [],
} as const satisfies Record<string, readonly ServiceName[]>;

export type LedgerDoor = keyof typeof LEDGER_DOOR_CALLERS;
