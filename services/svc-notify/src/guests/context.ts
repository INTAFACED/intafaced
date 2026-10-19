import { createEdgeContext, inboundRawBodyOf, verifyServiceHeaders, type Context, type EdgeContextOptions } from '@intafaced/contracts';

/** The installed Fastify tRPC adapter retains JSON as the exact raw string and
 * replaces the normal JSON parser. Never reconstruct bytes from a parsed object. */
export function createGuestIngressContext(config: {
  edgeSecret: string;
  /** Optional edge public key and limits (`edgeTrustFromEnv`): verify the edge's public-key signature as well. */
  edgeTrust?: Pick<EdgeContextOptions, 'edgePublicKey' | 'principalLimits'>;
  opsSecret?: string;
}) {
  const edge = createEdgeContext({ secret: config.edgeSecret, ...config.edgeTrust, serviceName: 'svc-notify' });
  return (req: { headers: Record<string, string | string[] | undefined>; id?: string | number; body?: unknown }): Context => {
    const context = edge(req);
    // `inboundRawBodyOf` takes the adapter's raw string first. Otherwise
    // `rawBodyOf` reports the retained bytes, and reports an announced body that
    // no parser kept as unread (never as "empty") — the old onRequest marker
    // alone said "empty" for a nonempty tRPC POST.
    const rawBody = inboundRawBodyOf(req);
    return {
      ...context,
      service: config.opsSecret ? verifyServiceHeaders(req.headers, config.opsSecret, { mode: 'require', rawBody }).service : null,
    };
  };
}
