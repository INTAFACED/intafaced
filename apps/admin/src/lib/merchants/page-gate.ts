import 'server-only';
import { requireFounderPage } from '@/lib/founder-page';
import type { PayCallContext } from './pay-call';

/**
 * Second line of every Merchants page, after `requireModulePage('merchants')` (the ADMIN_MODULES gate). The founder gate (sealed
 * cookie, live entitlement, MFA) runs before any data is read; no founder cookie redirects to /login.
 */
export async function requireMerchantsFounder(): Promise<PayCallContext> {
  const { session, config } = await requireFounderPage();
  return { session, config };
}
