import type { AccountState } from '@intafaced/contracts';
import type { CommissionRow } from './commission.js';

/** Reads one account's state; null for an unknown user. `AuthService.accountState` is the one implementation. */
export type AccountStandingReader = { accountState(userId: string): Promise<AccountState | null> };

/**
 * The beneficiaries of these rows whose account cannot take a credit: frozen, closed, archived, or unknown (an unread
 * account never reads as one in good standing). The payout plan refuses on any of them before a single post.
 */
export async function beneficiariesWhoCannotReceive(
  accounts: AccountStandingReader,
  rows: readonly Pick<CommissionRow, 'beneficiaryId'>[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(rows.map((r) => r.beneficiaryId))];
  const states = await Promise.all(ids.map(async (id) => [id, await accounts.accountState(id)] as const));
  return new Set(states.filter(([, s]) => !s || s.status !== 'active' || s.archived).map(([id]) => id));
}
