import 'server-only';
import { searchTerm } from '@/lib/account-search/search';
import {
  parseCustomerLookup,
  parseFirstAccountId,
  parseOpsMetrics,
  parseQuoteDesk,
  type CustomerLookup,
  type OpsMetrics,
  type QuoteDesk,
} from './copy-bots-otc';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { ok, refused, type Outcome } from './outcome';

/**
 * The calls behind the copy, bots and OTC room. Server only: each is a real call to svc-trade (`admin.copyBotsOtc`) or
 * svc-identity (`accountDirectory.search`) through svc-edge with the signed-in founder's own token. Nothing is cached
 * or retried; svc-trade audits every lookup.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readOpsMetrics(ctx: TradeCtx): Promise<Outcome<OpsMetrics>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.copyBotsOtc.metrics', 'query', {}, parseOpsMetrics));
}

export function readQuoteDesk(ctx: TradeCtx): Promise<Outcome<QuoteDesk>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.copyBotsOtc.quoteDesk', 'query', {}, parseQuoteDesk));
}

/** An account id as typed, or the one account identity holds for a whole email address. */
async function resolveCustomer(ctx: TradeCtx, raw: string): Promise<Outcome<string>> {
  const value = raw.trim();
  if (UUID.test(value)) return ok(value.toLowerCase());
  const term = searchTerm(value);
  if ('error' in term || term.kind !== 'email')
    return refused('trade_ops.customer_term_invalid', 'Type a whole email address or an account id.', 400);
  const found = await edgeCall(ctx, trpcSpec('identity', 'accountDirectory.search', 'query', { email: term.value }, parseFirstAccountId));
  if (found.kind !== 'ok') return found;
  return found.data.id === null
    ? refused('trade_ops.customer_not_found', 'No account has this email address.', 404, null, found.asOf)
    : ok(found.data.id, found.asOf);
}

/** One customer's follows, bots and quotes. Needs the lookup scope; svc-trade writes the read to its operator audit. */
export async function lookupCustomer(ctx: TradeCtx, raw: string): Promise<Outcome<CustomerLookup>> {
  const who = await resolveCustomer(ctx, raw);
  if (who.kind !== 'ok') return who;
  return edgeCall(ctx, trpcSpec('trade', 'admin.copyBotsOtc.lookup', 'query', { userId: who.data }, parseCustomerLookup));
}
