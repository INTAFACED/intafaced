import {
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  serviceCallSigner,
  type CurrentAuthorityInput,
  type CurrentAuthorityResult,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { assertLiveCredential, createIdentityOwnershipClient, type LiveCredentialInput } from './live-credential.js';

/** Private-read snapshot only. This port never supplies trading admission. */
export interface CurrentAuthorityPort {
  read(subject: CurrentAuthorityInput, signal: AbortSignal, policy?: LiveCredentialInput): Promise<CurrentAuthorityResult>;
}

export function createIdentityAuthorityClient(options: {
  baseUrl: string;
  secret: string;
  fetch?: typeof globalThis.fetch;
  /** svc-ws's own key. With it the identity reads are key-signed; `dual` also sends the dedicated-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}): CurrentAuthorityPort {
  const url = new URL(options.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    options.secret.trim().length < 32
  )
    throw new Error('Private identity authority unconfigured');
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sign = serviceCallSigner({ service: 'svc-ws', audience: 'svc-identity', legacySecret: options.secret, s2s: options.s2s });
  return {
    async read(raw, signal, policy) {
      const subject = currentAuthorityInputSchema.parse(raw);
      const body = JSON.stringify(subject);
      const target = `${base}/trpc/accountControls.currentAuthority`;
      const request = {
        method: 'POST',
        redirect: 'error' as const,
        cache: 'no-store',
        body,
        signal,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
        },
      };
      const response = await fetchImpl(target, request);
      if (!response.ok) throw new Error('Private identity authority unavailable');
      const envelope: unknown = await response.json();
      const data = envelope as { result?: { data?: unknown } } | null;
      const result = currentAuthorityResultSchema.parse(data?.result?.data);
      if (result.status === 'eligible' && subject.credential.kind === 'api_key') {
        // The authority contract proves ownership/revocation. Existing key
        // IP/origin/product/account policies remain identity-owned metadata.
        if (!policy) throw new Error('Private key policy context missing');
        const ownership = createIdentityOwnershipClient({
          baseUrl: base,
          // Each read signs its own URL; no content-type goes out on these GETs, so none is signed.
          headers: (url) => sign('', { method: 'GET', url, contentType: '' }),
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('cache-control', 'no-store');
            const request = { ...init, headers, signal, redirect: 'error' as const, cache: 'no-store' };
            return fetchImpl(input, request);
          },
        });
        await assertLiveCredential({ getSession: ownership.getSession, getApiKey: ownership.getApiKey }, policy);
      }
      return result;
    },
  };
}
