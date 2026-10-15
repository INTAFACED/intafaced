import { mergeRouters } from '@intafaced/contracts';
import type { FounderAuthority } from '../founder-authority.js';
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
export function createPayNamespaces(deps: { founderAuthority: FounderAuthority }) {
  return mergeRouters(
    createMerchantControlRouter(),
    createMerchantMetricsRouter(),
    createFounderAdminRouter(deps.founderAuthority),
    createConversionRouter(),
    createPayHaltsRouter(deps.founderAuthority),
  );
}
export type PayNamespacesRouter = ReturnType<typeof createPayNamespaces>;
