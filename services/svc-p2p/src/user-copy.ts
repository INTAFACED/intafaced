/**
 * User-visible offer / instrument refuse copy.
 *
 * Reasons on the wire are catalog keys resolved through `@intafaced/i18n`.
 * Mode is `prod` so a missing key cannot throw on a take or register path. A
 * key that is not in the catalog yet refuses as the key name — greppable,
 * never blank, never invented English. Catalog rows land in a separate PR;
 * this service must not wait on them or invent sentences here.
 */
import { createTranslator, type ParamValue } from '@intafaced/i18n';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

export const P2P_COPY = {
  takeRefused: 'p2p.take_refused',
  methodUnknown: 'p2p.instrument_method_unknown',
  offerMethodsRequired: 'p2p.offer_methods_required',
  offerMethodNoDestination: 'p2p.offer_method_no_destination',
  instrumentKmsRequired: 'p2p.instrument_kms_required',
  offerListLimitUnset: 'p2p.offer_list_limit_unset',
  disputeListLimitUnset: 'p2p.dispute_list_limit_unset',
  lateSettlementsListLimitUnset: 'p2p.late_settlements_list_limit_unset',
  tradeListLimitUnset: 'p2p.trade_list_limit_unset',
  sweepSettlementsLimitUnset: 'p2p.sweep_settlements_limit_unset',
  sweepDeadlinesLimitUnset: 'p2p.sweep_deadlines_limit_unset',
  instrumentListLimitUnset: 'p2p.instrument_list_limit_unset',
  methodSchemaListLimitUnset: 'p2p.method_schema_list_limit_unset',
  accessLogLimitUnset: 'p2p.access_log_limit_unset',
  purgeSnapshotsLimitUnset: 'p2p.purge_snapshots_limit_unset',
  merchantHistoryLimitUnset: 'p2p.merchant_history_limit_unset',
  reviewListLimitUnset: 'p2p.review_list_limit_unset',
} as const;

export function resolveP2pCopy(key: string, params: Readonly<Record<string, ParamValue>> = {}): string {
  return translator.tUnsafe(key, params);
}
