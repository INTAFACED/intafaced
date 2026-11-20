import { s2sFromEnv, serviceCallSigner, type S2sEnv, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * svc-edge's own service key (S2S v3), used for the service calls the edge makes with a dedicated shared secret, never
 * for the proxy forward. The forward's only authority is the edge-signed user principal (or none, for an anonymous
 * request): signed as svc-edge, any caller would reach a door that accepts any service or svc-edge, and every door that
 * needs a signed-in person would refuse the user it carries. `proxy-s2s-keys.test.ts` holds that. Unset `S2S_AUTH_MODE` gives `undefined` here, and every call is then signed exactly as it
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
