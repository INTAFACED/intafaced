import { myLeadSchema } from '../../screens/trade/copybots/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';

/**
 * Whether the signed-in person is a listed lead, and so whether an order ticket shows the Lead trade switch
 * (J-copy-bots-otc-04 #4 to #7). Read from `copy.myLead`; anyone else, or a failed read, sees no switch.
 */
export function useLeadMode(): { readonly isLead: boolean; readonly instruments: readonly string[] } {
  const { api, userId } = useSession();
  const { resource } = useResource(
    (signal) =>
      userId ? api.query('trade', 'copy.myLead', undefined, myLeadSchema, { signal }) : Promise.resolve({ ok: true as const, data: null }),
    `lead-mode:${userId ?? 'out'}`,
  );
  const lead = resource.status === 'ready' ? resource.data : null;
  return lead && lead.state === 'listed' ? { isLead: true, instruments: lead.instruments } : { isLead: false, instruments: [] };
}

/**
 * The words for a lead trade's refusal codes (J-copy-bots-otc-04 #5 to #7; svc-trade copy/lead-trading.ts), shown on the
 * order ticket and in the Copy room, each with the code as its reference.
 */
export const LEAD_ORDER_REFUSALS: Readonly<Record<string, { readonly title: string; readonly body: string }>> = {
  'trade.copy_lead_not_listed': {
    title: 'You are not a listed lead',
    body: 'Only an approved lead places a lead trade. Turn Lead trade off to place this as your own order.',
  },
  'trade.copy_leader_instruments_not_set': {
    title: 'No leading instrument list',
    body: 'The platform has not set the instruments you may lead, so the leading instrument list is empty. Nothing was placed.',
  },
  'trade.copy_lead_instrument_unlisted': {
    title: 'Not on your leading instruments',
    body: 'This pair is not on your leading instrument list. Nothing was placed.',
  },
  'trade.copy_lead_price_required': {
    title: 'A lead trade needs a price',
    body: 'Place a lead trade as a limit order, so it can be counted against your lead limits.',
  },
  'trade.copy_pair_limit_not_set': {
    title: 'No holding limit for this pair',
    body: 'The platform has not set a lead holding limit for this pair, so it can’t be led. Nothing was placed.',
  },
  'trade.copy_pair_holding_limit': {
    title: 'Over your holding limit',
    body: 'This buy would take your lead holding in this pair over its limit. Nothing was placed.',
  },
  'trade.copy_leader_limit_not_set': {
    title: 'A lead limit is not set',
    body: 'The platform has not set every lead limit, so a lead trade can’t be counted. Nothing was placed.',
  },
  'trade.copy_daily_buy_cap': {
    title: 'Daily buy cap reached',
    body: 'Your lead buys today would pass the daily buy cap. It resets at the start of the next day. Nothing was placed.',
  },
  'trade.copy_leader_equity_below_min': {
    title: 'Under the lead equity minimum',
    body: 'Your venue account holds less than a lead needs, as the venue reports it. Nothing was placed.',
  },
  'trade.copy_not_lead_order': {
    title: 'Not a lead trade',
    body: 'The leader marked this order as not a lead trade, so it is not copied.',
  },
};
