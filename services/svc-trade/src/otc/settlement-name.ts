/**
 * CB-otc-08's name match (J-copy-bots-otc-24 #3): a desk request may name the holder of the account its trade settles
 * to, and that name must be the trader's verified legal name, or nothing is priced.
 *
 * svc-trade sends the name and the account it is for to identity's `POST /internal/holder-name-check` and gets back only
 * whether it is the verified name (`holderNameCheckSchema`). The legal name never comes here, and the name given is
 * neither stored nor logged nor put in an error message. Anything but a clear match refuses before any stake read or
 * price lookup: a mismatch, no verified name, and identity not answering, refusing or answering out of shape alike.
 */
import {
  IDENTITY_HOLDER_NAME_CHECK_PATH,
  holderNameCheckSchema,
  serviceCallSigner,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { OtcError } from './errors.js';

export interface OtcSettlementNameCheck {
  /** Resolves when `name` is `userId`'s verified legal name; otherwise throws an OtcError naming why. */
  assertOwnName(userId: string, name: string): Promise<void>;
}

const FETCH_MS = 3_000;

const unverifiable = (why: string) =>
  new OtcError(
    `The settlement name could not be checked against your verified name (${why}). Nothing was priced or held.`,
    'trade.otc_name_unverifiable',
  );

/** Asks identity's own-name door, service-signed and body-bound like svc-p2p's caller of the same door. */
export function createIdentitySettlementNameCheck(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): OtcSettlementNameCheck {
  const url = `${baseUrl.replace(/\/+$/, '')}${IDENTITY_HOLDER_NAME_CHECK_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async assertOwnName(userId, name) {
      const body = JSON.stringify({ userId, name });
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          // A redirect would carry the signed body, and the name in it, somewhere else.
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            ...sign(body, { method: 'POST', url: new URL(url), contentType: 'application/json' }),
          },
          body,
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        throw unverifiable('identity did not answer');
      }
      if (!response.ok) throw unverifiable(`identity refused (${response.status})`);
      const parsed = holderNameCheckSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw unverifiable('identity answered out of shape');
      if (parsed.data.userId.toLowerCase() !== userId.toLowerCase()) throw unverifiable('identity answered for another account');
      switch (parsed.data.outcome) {
        case 'match':
          return;
        case 'mismatch':
          throw new OtcError(
            'The settlement account must be in your verified name, and the name given does not match it. Nothing was priced or held.',
            'trade.otc_name_mismatch',
          );
        case 'unverified':
          throw new OtcError(
            'Your account has no verified legal name, so a settlement name cannot be checked. Nothing was priced or held.',
            'trade.otc_name_unverified',
          );
        case 'inactive':
          throw unverifiable('this account is not active');
        case 'unconfigured':
          throw unverifiable('verified names cannot be read in this deployment');
      }
    },
  };
}

/** No identity to ask: every request that names a settlement account refuses, so a missing wire never reads as a match. */
export const UNWIRED_SETTLEMENT_NAME_CHECK: OtcSettlementNameCheck = {
  async assertOwnName() {
    throw unverifiable('the identity service is not connected');
  },
};

/**
 * The name a request gives for its settlement account, trimmed; null when none was given (the trade settles to the
 * trader's own account, held in their name by construction). A name longer than identity's door takes refuses here.
 */
export function settlementNameOf(raw: string | undefined): string | null {
  const name = raw?.trim() ?? '';
  if (name === '') return null;
  if (name.length > 200) {
    throw new OtcError('A settlement name is at most 200 characters. Nothing was priced or held.', 'trade.otc_name_invalid');
  }
  return name;
}
