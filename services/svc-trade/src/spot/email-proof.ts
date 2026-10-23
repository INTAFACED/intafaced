import { emailProofSchema, serviceCallSigner, type EmailProof, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { TradeError } from './types.js';

/**
 * EMAIL OWNERSHIP PROOF GATE (RC-identity-01, J-identity-01 step 8).
 *
 * A custodial order needs a proved email: someone who never showed they own
 * the address must not put funds at risk on the book. Identity owns the fact
 * (`users.email_verified_at`); svc-trade reads it per request and keeps no
 * copy, so a confirmed email unblocks at once.
 *
 * FAILS CLOSED. Identity down, an unknown user, an off-contract body or an
 * answer about another user all refuse `trade.identity_unavailable` before
 * any hold. Cancel and reduce-only never come here, so nobody is trapped.
 */
const READ_TIMEOUT_MS = 5_000;

export interface EmailProofSource {
  /** Throws TradeError `trade.identity_unavailable` when the answer cannot be trusted. */
  get(userId: string): Promise<EmailProof['emailProof']>;
}

/**
 * HTTP client for svc-identity `GET /internal/email-proof/:userId`.
 * Service-signed like the sub-account client. Every non-success refuses.
 */
export function createEmailProofClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): EmailProofSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const authHeaders = (target: string) => sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' });

  return {
    async get(userId: string) {
      let response: Response;
      try {
        const target = `${url}/internal/email-proof/${encodeURIComponent(userId)}`;
        response = await fetch(target, {
          method: 'GET',
          headers: { 'content-type': 'application/json', ...authHeaders(target) },
          // A hung identity must refuse, not hold the order open.
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
      } catch (err) {
        throw new TradeError(`email proof unavailable: ${(err as Error).message}`, 'trade.identity_unavailable');
      }
      if (!response.ok) {
        throw new TradeError(`email proof unavailable (${response.status})`, 'trade.identity_unavailable');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new TradeError('email proof answer was not JSON', 'trade.identity_unavailable');
      }
      const parsed = emailProofSchema.safeParse(body);
      if (!parsed.success) {
        throw new TradeError('email proof answer did not match the published contract', 'trade.identity_unavailable');
      }
      // Bound to the asked user: an answer about anyone else is not an answer.
      if (parsed.data.userId.toLowerCase() !== userId.toLowerCase()) {
        throw new TradeError('email proof answer named another user', 'trade.identity_unavailable');
      }
      return parsed.data.emailProof;
    },
  };
}

/** Refuse a new custodial order until the user's email is proved. Call before any hold. */
export async function assertEmailProved(source: EmailProofSource | undefined, userId: string): Promise<void> {
  if (!source) throw new TradeError('email proof source is not wired', 'trade.identity_unavailable');
  if ((await source.get(userId)) !== 'accepted') {
    throw new TradeError('prove your email before placing an order', 'trade.email_proof_required');
  }
}
