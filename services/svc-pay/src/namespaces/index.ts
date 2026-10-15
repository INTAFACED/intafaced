import { mergeRouters } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import type { FounderAuthority } from '../founder-authority.js';
import type { MetricsRuntime } from '../metrics/index.js';
import type { RegistriesMountDeps } from '../registries/index.js';
import { createFounderOpsRouter, createMerchantOpsRouter } from '../merchant-ops/index.js';
import { createConversionRouter } from './conversion.js';
import { createFounderAdminRouter } from './founder-admin.js';
import { createMerchantControlRouter } from './merchant-control.js';
import { createMerchantMetricsRouter } from './merchant-metrics.js';
import { createPayHaltsRouter } from './pay-halts.js';

export { findUnguardedFounderProcedures, founderProcedure, isFounderGuarded } from './founder-procedure.js';
export { notBuilt, PayNotBuiltError } from './errors.js';

/** Path prefixes that must sit behind founder authority (checked by the static inventory test). */
export const FOUNDER_ONLY_PREFIXES = ['founderAdmin.', 'payHalts.set', 'payHalts.history'] as const;

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
}) {
  const opsDeps = { founderAuthority: deps.founderAuthority, sql: deps.sql };
  return mergeRouters(
    createMerchantControlRouter(),
    createMerchantMetricsRouter(deps.metrics),
    createFounderAdminRouter(deps.founderAuthority, {
      metrics: deps.metrics,
      registries: deps.registries,
      ops: createFounderOpsRouter(opsDeps),
    }),
    createConversionRouter(),
    createPayHaltsRouter(deps.founderAuthority),
    createMerchantOpsRouter(opsDeps), // W15: merchantOps.*  (founderAdmin.ops.* is mounted via createFounderAdminRouter above)
  );
}
export type PayNamespacesRouter = ReturnType<typeof createPayNamespaces>;
