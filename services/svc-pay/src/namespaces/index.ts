import { mergeRouters } from '@intafaced/contracts';
import type { Sql } from 'postgres';
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

export { findUnguardedFounderProcedures, founderProcedure, isFounderGuarded } from './founder-procedure.js';
export { notBuilt, PayNotBuiltError } from './errors.js';

/** Path prefixes that must sit behind founder authority (checked by the static inventory test). */
export const FOUNDER_ONLY_PREFIXES = [
  'founderAdmin.',
  'founderAdmin.approvals.destination',
  'payHalts.set',
  'payHalts.history',
  'payHalts.operatorStatus',
  'payHalts.pendingClears',
] as const;

/**
 * W0 namespaces, mounted as stubs. Each file below is owned by one stream, which
 * replaces the stub bodies there and nowhere else:
 *   merchantControl W1 · merchantMetrics W2 · founderAdmin W2/W4 · conversion W6 · payHalts W5
 */
export function createPayNamespaces(deps: {
  founderAuthority: FounderAuthority;
  metrics?: MetricsRuntime;
  registries?: RegistriesMountDeps;
  sql?: Sql;
  payHalts?: PayHaltsDeps;
  treasury?: FounderTreasuryDeps;
  control?: ControlService;
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
    }),
    createConversionRouter(),
    createPayHaltsRouter(deps.founderAuthority, deps.payHalts),
    createMerchantOpsRouter(opsDeps), // W15: merchantOps.*  (founderAdmin.ops.* is mounted via createFounderAdminRouter above)
  );
}
export type PayNamespacesRouter = ReturnType<typeof createPayNamespaces>;
