/**
 * The public @handle for a user id, from identity's `/internal/handle/:userId` (the door svc-bank's receipts use).
 * `reputation.get` names the other side of an order by it (J-p2p-02 #2, #5: "Release to" never shows an account id).
 *
 * Identity owns the handle; svc-p2p never stores it. 404 is "no such account" (null). Identity not answering, refusing
 * or answering out of shape refuses `p2p.public_profile_unavailable`, so a missing name is never read as "this person has
 * none". The door carries no member-since date, so none is claimed.
 */
import { z } from 'zod';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { P2pError } from './p2p-service.js';

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
      const unavailable = (why: string) =>
        new P2pError(`The other side's handle could not be read: ${why}`, 'p2p.public_profile_unavailable');
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          // A redirect would carry the signed request somewhere else: refuse it, as the other identity reads do.
          redirect: 'error',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        throw unavailable('identity did not answer');
      }
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable(`identity refused (${response.status})`);
      const body = handleBody.safeParse(await response.json().catch(() => null));
      if (!body.success) throw unavailable('identity answered out of shape');
      if (body.data.userId.toLowerCase() !== userId.toLowerCase()) throw unavailable('identity answered for another account');
      return { handle: body.data.handle, memberSince: null };
    },
  };
}
