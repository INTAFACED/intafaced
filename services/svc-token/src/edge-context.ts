import { edgeTrustFromEnv } from '@intafaced/config';
import type { ServiceAuthMode, ServiceVerifier } from '@intafaced/contracts';
import { createEdgeContext } from '@intafaced/contracts/edge';
import type { Env } from './env.js';

/** Built before the listener opens: verifies the shared secret and, when set, the edge public key. */
export function buildEdgeContext(env: Env, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }) {
  const internalSecret = env.INTERNAL_SERVICE_SECRET;
  return createEdgeContext({
    secret: env.EDGE_PRINCIPAL_SECRET,
    ...edgeTrustFromEnv(env),
    serviceName: env.SERVICE_NAME,
    ...(internalSecret && internalSecret.length >= 32 ? { internalSecret } : {}),
    ...(s2s ? { serviceVerifier: s2s.verifier, s2sMode: s2s.mode } : {}),
  });
}
