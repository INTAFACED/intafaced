import type { Blocker } from './outcome';

/**
 * The gaps between this desk and the services, named once. A control whose service is missing shows one of these
 * (owner + sentence + requirement id) instead of pretending to work. Each also has a line in
 * ~/.codex/context/work/tasks/TROPS-BACKEND-NEEDS.md.
 */
const b = (key: string, owner: string, text: string, need: string): Blocker => ({ key, owner, text, need });

export const BLOCKERS = {
  mass_cancel_operator_missing: b(
    'mass_cancel_operator_missing',
    'svc-trade',
    'Mass cancel only exists for the signed-in account. There is no operator-scoped cancel by market or by account.',
    'TRD-0052',
  ),
  market_rules_no_operator_api: b(
    'market_rules_no_operator_api',
    'svc-trade',
    'Tick size, lot size, minimum and maximum quantity, minimum notional and the listing fee bps are the market record. svc-trade has no operator procedure to change them; the operator risk limits above are the ones it lets you set.',
    'TRD-0054, TRD-0117',
  ),
  orders_by_id_cross_user_missing: b(
    'orders_by_id_cross_user_missing',
    'svc-trade',
    'Order lookup by id works only for the order owner. Operators can list open orders but cannot open any order by id.',
    'TRD-0093, TRD-0203',
  ),
  export_missing: b(
    'export_missing',
    'svc-trade',
    'There is no server-side export of orders, fills or positions. Only the rows already on this screen can be saved.',
    'TRD-0085',
  ),
  audit_feed_missing: b(
    'audit_feed_missing',
    'svc-trade / svc-identity',
    'Audit exists per user (restriction history) and for kill switches, but there is no combined operator audit feed.',
    'TRD-0055, TRD-0205',
  ),
  surveillance_adjudicate_not_exposed: b(
    'surveillance_adjudicate_not_exposed',
    'svc-edge',
    'Reading cases works. Recording a decision or a fine is not exposed to operators: svc-edge registers no adjudicate or fine route, by design, so no sanction can be set from this desk.',
    'TRD-0049',
  ),
  mm_seed_setter_missing: b(
    'mm_seed_setter_missing',
    'svc-trade',
    'Orders carry a seeded flag, but there is no operator control or report for market-maker seed settings.',
    'TRD-0017, TRD-0029',
  ),
  restriction_no_four_eyes: b(
    'restriction_no_four_eyes',
    'svc-identity / svc-trade',
    'A trading restriction is applied by one operator. There is no two-person action type for it, so this desk will not apply it from a single click here.',
    'TRD-0036, TRD-0117',
  ),
  reconcile_route_missing: b(
    'reconcile_route_missing',
    'svc-trade',
    'Order reconcile runs as a sweep inside svc-trade; there is no route to start or read it.',
    'TRD-0209',
  ),
} as const satisfies Record<string, Blocker>;

export type BlockerKey = keyof typeof BLOCKERS;
