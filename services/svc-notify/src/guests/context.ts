import { createEdgeContext, rawBodyOf, verifyServiceHeaders, type Context } from '@intafaced/contracts';

/** The installed Fastify tRPC adapter retains JSON as the exact raw string and
 * replaces the normal JSON parser. Never reconstruct bytes from a parsed object. */
export function createGuestIngressContext(config: { edgeSecret: string; opsSecret?: string }) {
  const edge = createEdgeContext({ secret: config.edgeSecret, serviceName: 'svc-notify' });
  return (req: { headers: Record<string, string | string[] | undefined>; id?: string | number; body?: unknown }): Context => {
    const context = edge(req);
    const retained = rawBodyOf(req);
    // The onRequest marker survives parser replacement and reports an empty
    // buffer even for a nonempty tRPC POST. Its original raw string takes
    // precedence. A parsed object without retained nonempty bytes refuses.
    let rawBody = retained;
    if (typeof req.body === 'string') rawBody = { retained: true, bytes: Buffer.from(req.body, 'utf8') };
    else if (!(retained.retained && (retained.bytes.length > 0 || req.body === undefined))) rawBody = { retained: false };
    return {
      ...context,
      service: config.opsSecret ? verifyServiceHeaders(req.headers, config.opsSecret, { mode: 'require', rawBody }).service : null,
    };
  };
}
