/**
 * P-ads-merchant-18, the own-name rule: a payment destination is in the person's own name.
 *
 * svc-p2p sends the holder name typed for a destination to identity's `POST /internal/holder-name-check` and gets back
 * only whether it is the account's verified legal name (`holderNameCheckSchema`). The legal name never comes here, and
 * the typed name is not logged. Anything but a clear match refuses before the destination is stored: a mismatch, no
 * verified name, and identity not answering, refusing or answering out of shape alike. There is no "rule off": a looser
 * tolerance or switching the rule off is a recorded compliance decision this service does not have.
 */
import {
  IDENTITY_HOLDER_NAME_CHECK_PATH,
  holderNameCheckSchema,
  serviceCallSigner,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { InstrumentError } from './instruments.js';

export interface HolderNameRule {
  /** Resolves when `name` is `userId`'s verified legal name; otherwise throws an InstrumentError naming why. */
  assertOwnName(userId: string, name: string): Promise<void>;
}

const FETCH_MS = 3_000;

const unverifiable = (why: string) =>
  new InstrumentError(`Your name on this account could not be checked (${why}); nothing was saved`, 'p2p.holder_name_unverifiable');

export function createIdentityHolderNameRule(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): HolderNameRule {
  const url = `${baseUrl.replace(/\/+$/, '')}${IDENTITY_HOLDER_NAME_CHECK_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-p2p', audience: 'svc-identity', legacySecret: internalSecret, s2s });
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
          throw new InstrumentError(
            'The account holder must be you: the name does not match your verified name, so nothing was saved',
            'p2p.holder_name_mismatch',
          );
        case 'unverified':
          throw new InstrumentError(
            'Your legal name is not verified yet, so an account in your name cannot be checked; nothing was saved',
            'p2p.holder_name_unverified',
          );
        case 'inactive':
          throw unverifiable('this account is not active');
        case 'unconfigured':
          throw unverifiable('verified names cannot be read in this deployment');
      }
    },
  };
}

/** No identity to ask: every destination with a holder-name field refuses, so a missing wire never reads as "any name". */
export function unwiredHolderNameRule(): HolderNameRule {
  return {
    async assertOwnName() {
      throw unverifiable('the identity service is not connected');
    },
  };
}
