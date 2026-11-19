import { eachWorkKindOnce, homeConfigReplySchema } from './home-work-items.js';
import { outreachPublicSettingsSchema } from './outreach-public.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { everyPriceAboveZero, onePricePerAsset, valuationPricesReplySchema } from './valuation-prices.js';

/**
 * svc-ops' public reads, one record per call: what a signed-out visitor or any customer screen reads from the ops desk.
 * svc-ops mounts each from here (`mountRecord`), and the customer app calls each through `api.call(RECORD, …)`.
 */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc', kind: 'query', access: { caller: 'public' } } as const;

/** Home's owner values (work-list cap and order, search cap, notice strip and recent-activity counts); blank is null. */
export const OPS_HOME_CONFIG = defineProcedure({
  ...base,
  name: 'ops.home.config',
  path: 'home.config',
  refusals: {},
  input: NO_INPUT,
  output: homeConfigReplySchema,
  accept: { eachKindOnce: { says: 'no kind appears twice in workListOrder', holds: eachWorkKindOnce } },
  samples: [{ verdict: 'accept' }],
});

/** The prices Home and Assets value holdings with: `published: false` with `valuation.prices_unset` until a source is named. */
export const OPS_VALUATION_PRICES = defineProcedure({
  ...base,
  name: 'ops.valuation.prices',
  path: 'valuation.prices',
  refusals: {},
  input: NO_INPUT,
  output: valuationPricesReplySchema,
  accept: {
    aboveZero: { says: 'every published price is greater than zero', holds: everyPriceAboveZero },
    onePerAsset: { says: 'no asset is priced twice', holds: onePricePerAsset },
  },
  samples: [{ verdict: 'accept' }],
});

/** The partner page's join address and terms and /app's store link, set by the founders; a blank value is null. */
export const OPS_OUTREACH_PUBLIC_SETTINGS = defineProcedure({
  ...base,
  name: 'ops.outreach.publicSettings',
  path: 'outreach.publicSettings',
  refusals: { 'ops.crm.storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: outreachPublicSettingsSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_PUBLIC_PROCEDURES = [OPS_HOME_CONFIG, OPS_VALUATION_PRICES, OPS_OUTREACH_PUBLIC_SETTINGS] as const;
