/**
 * The public @handle for a user id, from identity's `/internal/handle/:userId` (the door svc-bank's receipts use).
 * `reputation.get` names the other side of an order by it (J-p2p-02 #2, #5: "Release to" never shows an account id).
 *
 * Identity owns the handle; svc-p2p never stores it. 404 is "no such account" (null). Identity not answering throws,
 * so a missing name is never read as "this person has none". The door carries no member-since date, so none is claimed.
 */
import { z } from 'zod';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export type PublicProfileLookup = {
  lookup(userId: string): Promise<{ handle: string; memberSince: string | null; verificationLevel?: string | null } | null>;
};

const handleBody = z.object({ userId: z.string(), handle: z.string().min(1) });

export function createIdentityPublicProfile(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): PublicProfileLookup {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-p2p', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async lookup(userId) {
      const target = `${base}/internal/handle/${encodeURIComponent(userId)}`;
      const response = await fetchFn(target, {
        method: 'GET',
        headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`identity refused the handle lookup (${response.status})`);
      const body = handleBody.parse(await response.json());
      if (body.userId !== userId) throw new Error('identity answered the handle lookup for another account');
      return { handle: body.handle, memberSince: null };
    },
  };
}
