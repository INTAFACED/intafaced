import {
  createEdgeContext,
  verifyServiceRequest,
  type Context,
  type EdgeContextOptions,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

/** The installed Fastify tRPC adapter retains JSON as the exact raw string and
 * replaces the normal JSON parser. Never reconstruct bytes from a parsed object. */
export function createGuestIngressContext(config: {
  edgeSecret: string;
  /** Optional edge public key and limits (`edgeTrustFromEnv`): verify the edge's public-key signature as well. */
  edgeTrust?: Pick<EdgeContextOptions, 'edgePublicKey' | 'principalLimits'>;
  opsSecret?: string;
  /** Per-service keys (S2S v3): the producer is named from its own key. Unset keeps the pairwise secret alone. */
  s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
}) {
  const edge = createEdgeContext({ secret: config.edgeSecret, ...config.edgeTrust, serviceName: 'svc-notify' });
  return (req: {
    headers: Record<string, string | string[] | undefined>;
    id?: string | number;
    body?: unknown;
    method?: string;
    url?: string;
  }): Context => {
    const context = edge(req);
    // `verifyServiceRequest` reads the adapter's raw string first. Otherwise it reports the retained bytes, and
    // reports an announced body that no parser kept as unread (never as "empty") — the old onRequest marker
    // alone said "empty" for a nonempty tRPC POST. A failed key-signed call never falls back to the pairwise secret.
    const named =
      config.opsSecret || config.s2s
        ? verifyServiceRequest(req, {
            verifier: config.s2s?.verifier,
            mode: config.s2s?.mode,
            legacySecret: config.opsSecret,
            bodyBindMode: 'require',
          }).service
        : null;
    return { ...context, service: named };
  };
}
