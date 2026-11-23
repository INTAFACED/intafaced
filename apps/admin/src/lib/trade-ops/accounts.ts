import 'server-only';
import { type FounderCallContext, founderRecordRead, partFrom } from '@/lib/desk';
import type { Part } from '@/lib/part';
import { TRADE_ADMIN_VENUE_ACCOUNTS_GET } from '@intafaced/contracts/trade-admin-procedures';
import { BANK_OPS_CUSTOMER_PARTNER_BALANCES } from '@intafaced/contracts/bank-ops-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';

/**
 * One person's accounts side by side (J-derivatives-26 #8, /trade-ops/accounts), read-only, as the signed-in founder:
 * their venue accounts with the margin now and its ratio history from svc-trade (every figure the venue's, with its
 * as-of time), and their spending balances as the partner reports them from svc-bank (each with the partner's label and
 * as-of time). Each side is read on its own: one service down refuses its own side, never the other. Both services log
 * the read, naming the founder and the person, before they read.
 */

export type VenueAccounts = ProcedureOutput<typeof TRADE_ADMIN_VENUE_ACCOUNTS_GET>;
export type PartnerBalances = ProcedureOutput<typeof BANK_OPS_CUSTOMER_PARTNER_BALANCES>;

export interface AccountsView {
  readonly userId: string;
  readonly readAt: string;
  readonly venue: Part<VenueAccounts>;
  readonly partner: Part<PartnerBalances>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user id the founder typed, or null when it is not one. */
export function accountsUserId(raw: string | string[] | undefined): string | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return UUID.test(v) ? v.toLowerCase() : null;
}

export async function readAccounts(ctx: FounderCallContext, userId: string): Promise<AccountsView> {
  const [venue, partner] = await Promise.all([
    founderRecordRead(ctx, TRADE_ADMIN_VENUE_ACCOUNTS_GET, { userId }, (d) => d),
    founderRecordRead(ctx, BANK_OPS_CUSTOMER_PARTNER_BALANCES, { userId }, (d) => d),
  ]);
  return {
    userId,
    readAt: new Date().toISOString(),
    venue: partFrom(venue, (d) => d, {
      service: 'svc-trade',
      forbiddenMessage: 'svc-trade did not accept this founder session for venue accounts. It needs the operator permission admin:read.',
    }),
    partner: partFrom(partner, (d) => d, {
      service: 'svc-bank',
      forbiddenMessage: 'svc-bank did not accept this founder session for partner balances. It needs the operator permission admin:read.',
    }),
  };
}
