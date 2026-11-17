/**
 * J-academy-07 — whose wallet pays. A purchase counts a payment by its payer address, so the payer must be the buyer's
 * own: a wallet the account linked by its own signature in identity (`wallet_identities`, one account per address).
 * Academy asks identity (`POST /internal/linked-wallets`, service credentials) each time a purchase is opened, so a
 * wallet linked to someone else, or unlinked since, is never named as a payer.
 */
import {
  LINKED_WALLETS_PATH,
  linkedWalletsSchema,
  serviceCallSigner,
  type LinkedWallets,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';

/** Identity's list of the wallets an account linked, or null when identity could not be asked or read. */
export interface LinkedWalletsPort {
  read(userId: string): Promise<LinkedWallets | null>;
}

const FETCH_MS = 3_000;

export function createIdentityLinkedWallets(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): LinkedWalletsPort {
  const target = `${baseUrl.replace(/\/+$/, '')}${LINKED_WALLETS_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-academy', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async read(userId) {
      const raw = JSON.stringify({ userId });
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...sign(raw, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body: raw,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      const parsed = linkedWalletsSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data : null;
    },
  };
}
