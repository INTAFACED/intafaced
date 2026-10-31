import {
  createEdgeContext,
  inboundRawBodyOf,
  S2S_AUDIENCE_HEADER,
  S2S_BODY_HEADER,
  S2S_KID_HEADER,
  S2S_NONCE_HEADER,
  S2S_SIGNATURE_HEADER,
  S2S_TIMESTAMP_HEADER,
  verifyServiceHeaders,
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
  /**
   * svc-support's own pairwise secret for the guest verification door (ADR 2026-10-22 §3.5). Each pairwise secret names
   * only its own producer: the ops secret can only be svc-ops and this one only svc-support, so under the shared-secret
   * mode neither producer can pose as the other.
   */
  supportSecret?: string;
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
    const auth =
      config.opsSecret || config.s2s
        ? verifyServiceRequest(req, {
            verifier: config.s2s?.verifier,
            mode: config.s2s?.mode,
            legacySecret: config.opsSecret,
            bodyBindMode: 'require',
          })
        : null;
    // A per-service key names its owner. A pairwise secret's name is only a claim, so the ops secret may never name
    // svc-support, and svc-support's own secret names svc-support only. (`verifyServiceRequest` answers once per request,
    // so the second secret is checked on the headers directly.)
    if (auth?.service && !(auth.service === 'svc-support' && auth.scheme === 'shared')) return { ...context, service: auth.service };
    // A call that tried a per-service key and failed never falls back to a pairwise secret.
    const triedKey = [
      S2S_KID_HEADER,
      S2S_AUDIENCE_HEADER,
      S2S_TIMESTAMP_HEADER,
      S2S_NONCE_HEADER,
      S2S_BODY_HEADER,
      S2S_SIGNATURE_HEADER,
    ].some((header) => req.headers[header] !== undefined);
    if (config.supportSecret && config.s2s?.mode !== 'keypair' && !(triedKey && auth?.rejected)) {
      const support = verifyServiceHeaders(req.headers, config.supportSecret, { rawBody: inboundRawBodyOf(req), mode: 'require' });
      if (support.service === 'svc-support') return { ...context, service: support.service };
    }
    return { ...context, service: null };
  };
}
