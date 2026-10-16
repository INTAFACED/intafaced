import { mergeRouters } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import type { ConversionService } from '../conversion/service.js';
import type { ControlService } from '../control/service.js';
import type { FounderAuthority } from '../founder-authority.js';
import type { MetricsRuntime } from '../metrics/index.js';
import type { RegistriesMountDeps } from '../registries/index.js';
import { createFounderOpsRouter, createMerchantOpsRouter } from '../merchant-ops/index.js';
import { createConversionRouter } from './conversion.js';
import { createFounderAdminRouter, type FounderTreasuryDeps } from './founder-admin.js';
import { createMerchantControlRouter } from './merchant-control.js';
import { createMerchantMetricsRouter } from './merchant-metrics.js';
import { createPayHaltsRouter, type PayHaltsDeps } from './pay-halts.js';
import { createB2bRampRouter } from '../b2b-ramp/router.js';

export { findUnguardedFounderProcedures, founderProcedure, isFounderGuarded } from './founder-procedure.js';
export { notBuilt, PayNotBuiltError } from './errors.js';

/**
 * Path prefixes that must sit behind founder authority (checked by the static inventory test).
 * `b2bRamp.founderStatus` is founder-only. The isolation suite's live founder
 * sweep includes it and expects `pay.b2b_ramp_off` while the ramp flag is off.
 */
export const FOUNDER_ONLY_PREFIXES = [
  'founderAdmin.',
  'payHalts.set',
  'payHalts.history',
  'payHalts.operatorStatus',
  'payHalts.pendingClears',
  'b2bRamp.founderStatus',
] as const;

/**
 * W0 namespaces, mounted as stubs. Each file below is owned by one stream, which
 * replaces the stub bodies there and nowhere else:
 *   merchantControl W1 · merchantMetrics W2 · founderAdmin W2/W4 · conversion W6 · payHalts W5
 *   b2bRamp W10 (switched off; routes refuse until the flag is on)
 */
export function createPayNamespaces(deps: {
  founderAuthority: FounderAuthority;
  metrics?: MetricsRuntime;
  registries?: RegistriesMountDeps;
  sql?: Sql;
  payHalts?: PayHaltsDeps;
  treasury?: FounderTreasuryDeps;
  control?: ControlService;
  conversion?: ConversionService;
}) {
  const opsDeps = { founderAuthority: deps.founderAuthority, sql: deps.sql };
  return mergeRouters(
    createMerchantControlRouter(deps.control),
    createMerchantMetricsRouter(deps.metrics),
    createFounderAdminRouter(deps.founderAuthority, {
      metrics: deps.metrics,
      registries: deps.registries,
      ops: createFounderOpsRouter(opsDeps),
      treasury: deps.treasury,
      control: deps.control,
      halts: deps.payHalts?.store,
    }),
    createConversionRouter(deps.conversion),
    createPayHaltsRouter(deps.founderAuthority, deps.payHalts),
    createMerchantOpsRouter(opsDeps), // W15: merchantOps.*  (founderAdmin.ops.* is mounted via createFounderAdminRouter above)
    // W10: b2bRamp.* refuses while pay.b2b_ramp is off, including a direct caller.
    createB2bRampRouter({ founderAuthority: deps.founderAuthority, sql: deps.sql }),
  );
}
export type PayNamespacesRouter = ReturnType<typeof createPayNamespaces>;
