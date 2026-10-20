/**
 * Public @handle for a user id. Identity owns the row. Bank stores a snapshot
 * on the send so a later rename does not rewrite a receipt.
 *
 * Unset is not "no handle". A deployment without IDENTITY_URL cannot name
 * either party, and the receipt says so.
 */
import { z } from 'zod';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export class PartyHandleUnavailableError extends Error {
  constructor(message = 'identity did not answer a handle lookup') {
    super(message);
    this.name = 'PartyHandleUnavailableError';
  }
}

export interface PartyHandlePort {
  /** The stored handle, null when identity has no such account, or throws when identity did not answer. */
  handleOf(userId: string): Promise<string | null>;
}

const handleBody = z.object({ userId: z.string(), handle: z.string().min(1) });

export function memoryPartyHandles(handles: Readonly<Record<string, string>>): PartyHandlePort {
  const table = new Map(Object.entries(handles));
  return {
    async handleOf(userId) {
      return table.get(userId) ?? null;
    },
  };
}

export function createIdentityPartyHandles(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): PartyHandlePort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async handleOf(userId) {
      const id = userId.trim();
      if (!id) return null;
      let response: Response;
      try {
        const target = `${base}/internal/handle/${encodeURIComponent(id)}`;
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        throw new PartyHandleUnavailableError();
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new PartyHandleUnavailableError(`identity refused the handle lookup (${response.status})`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PartyHandleUnavailableError('identity returned an unreadable handle');
      }
      const parsed = handleBody.safeParse(body);
      if (!parsed.success || parsed.data.userId !== id) {
        throw new PartyHandleUnavailableError('identity returned an unreadable handle');
      }
      return parsed.data.handle;
    },
  };
}
