import { edgeTrustFromEnv } from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import type { Env } from './env.js';

/** Built before the listener opens: verifies the shared secret and, when set, the edge public key. */
export function buildEdgeContext(env: Env) {
  return createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });
}
