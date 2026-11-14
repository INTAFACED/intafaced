import type { LedgerHistoryPages } from './activity-service.js';

/**
 * TEST only (J-home-ia-01 #5): `BANK_ACTIVITY_TEST_FAULT=on` makes every read of svc-ledger's history fail, so a journey
 * can see the activity list fail in the running product while the rest of the bank (balances, spaces) answers. Boot
 * refuses it outside an explicit dev or test process, as the statement render hold does.
 */
export function parseActivityTestFault(raw: unknown, env: { APP_ENV?: string; NODE_ENV?: string }): boolean {
  if (raw === undefined || raw === null || raw === '') return false;
  if (raw !== 'on') throw new Error(`BANK_ACTIVITY_TEST_FAULT is "${String(raw)}"; leave it unset, or set it to on`);
  if (!['dev', 'test'].includes(env.APP_ENV ?? '') || env.NODE_ENV === 'production')
    throw new Error('BANK_ACTIVITY_TEST_FAULT is a TEST fault and runs only with APP_ENV exactly dev or test');
  return true;
}

/** The history port with the TEST fault on: every page read fails, as an unreachable ledger would. */
export function failingHistoryPages(): LedgerHistoryPages {
  return {
    page: () => Promise.reject(new Error('BANK_ACTIVITY_TEST_FAULT: the ledger history read fails (TEST)')),
  };
}
