import {
  s2sFromEnv,
  serviceCallSigner,
  type S2sEnv,
  type ServiceAuthMode,
  type ServiceName,
  type ServiceSigner,
} from '@intafaced/contracts';

/**
 * svc-edge's own service key (S2S v3), used for the service calls the edge makes with a dedicated shared secret and
 * for the proxy forward. Unset `S2S_AUTH_MODE` gives `undefined` here, and every call is then signed exactly as it
 * was.
 */
export interface EdgeS2s {
  readonly signer: ServiceSigner;
  readonly mode: ServiceAuthMode;
}

export function edgeS2sFromEnv(env: S2sEnv): EdgeS2s | undefined {
  const built = s2sFromEnv(env, 'svc-edge');
  return built.signer && built.s2sMode ? { signer: built.signer, mode: built.s2sMode } : undefined;
}

/**
 * Headers for one call to svc-identity. The signature binds the method, the path and query, the exact body string
 * and the content type. `secret` is the dedicated shared secret for that call and rides along only until `keypair`.
 */
export function identityCallHeaders(
  secret: string,
  s2s: EdgeS2s | undefined,
  call: { method: string; target: string; body: string; contentType: string },
): Record<string, string> {
  return serviceCallSigner({ service: 'svc-edge', audience: 'svc-identity', legacySecret: secret, s2s })(call.body, {
    method: call.method,
    // Without a key the request is not read, and a bad target must still fail inside the caller's fetch as it did.
    url: s2s ? new URL(call.target) : UNUSED_URL,
    contentType: call.contentType,
  });
}

const UNUSED_URL = new URL('http://unused.invalid/');

/** The service behind each proxied module. A module with no S2S role (blueprint, dex, indexer, protocol) is absent. */
const AUDIENCE_BY_MODULE: Readonly<Record<string, ServiceName>> = {
  identity: 'svc-identity',
  trade: 'svc-trade',
  token: 'svc-token',
  agents: 'svc-agents',
  bank: 'svc-bank',
  p2p: 'svc-p2p',
  pay: 'svc-pay',
  notify: 'svc-notify',
  academy: 'svc-academy',
  'mining-pool': 'svc-mining-pool',
  support: 'svc-support',
  market: 'svc-market',
  execution: 'svc-execution',
  tax: 'svc-tax',
  quant: 'svc-quant',
  'core-ops': 'svc-ops',
};

export function proxyAudience(module: string): ServiceName | undefined {
  return AUDIENCE_BY_MODULE[module];
}

/**
 * The headers the proxy forwards, plus the key signature for the exact request it is about to send: method, the
 * upstream path and query as sent, the body bytes, and the context digest (content type, the forwarded principal
 * with its signature, and the region). Returns `headers` itself when S2S is off or the module has no S2S role. The
 * edge holds no shared secret for the upstream services, so `dual` and `keypair` both send the key signature alone.
 */
export function signProxyHeaders(
  s2s: EdgeS2s | undefined,
  module: string,
  request: { method: string; url: string; headers: Record<string, string>; body: Buffer | string | undefined },
): Record<string, string> {
  const audience = proxyAudience(module);
  if (!s2s || !audience) return request.headers;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  // fetch adds this content type to a string body that has none; sign what will actually go on the wire.
  if (typeof request.body === 'string' && headers['content-type'] === undefined) headers['content-type'] = 'text/plain;charset=UTF-8';
  return {
    ...headers,
    ...s2s.signer.headers({
      audience,
      method: request.method,
      url: new URL(request.url),
      body: request.body,
      context: {
        principal: headers['x-intafaced-principal'],
        principalSignature: headers['x-intafaced-principal-sig'],
        region: headers['x-intafaced-region'],
        contentType: headers['content-type'],
      },
    }),
  };
}
