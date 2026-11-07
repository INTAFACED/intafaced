/**
 * The account's own email, once proved, read from svc-identity's `GET /internal/proved-email/:userId` per send.
 *
 * The email channel falls back to it when the person confirmed no email address in notify: the address they proved at
 * sign-up is theirs. Nothing is copied. FAILS CLOSED: identity down, a refusal, an unknown user, an off-contract body
 * or an answer about another user all throw, and the dispatcher reads a throw as no address.
 */
import { provedEmailSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

const READ_TIMEOUT_MS = 3_000;

export class AccountEmailUnavailableError extends Error {
  readonly code = 'notify.account_email_unavailable';
  constructor(why: string) {
    super(`The account email could not be read: ${why}`);
    this.name = 'AccountEmailUnavailableError';
  }
}

/** Null when the account's email is not proved; throws when identity cannot answer for this user. */
export type ProvedAccountEmail = (userId: string) => Promise<string | null>;

export function createProvedAccountEmailClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ProvedAccountEmail {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-notify', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return async (userId) => {
    const target = `${base}/internal/proved-email/${encodeURIComponent(userId)}`;
    let response: Response;
    try {
      response = await fetchFn(target, {
        method: 'GET',
        // A redirect would carry the signed request somewhere else.
        redirect: 'error',
        headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      throw new AccountEmailUnavailableError('identity did not answer');
    }
    if (!response.ok) throw new AccountEmailUnavailableError(`identity refused (${response.status})`);
    const body = provedEmailSchema.safeParse(await response.json().catch(() => null));
    if (!body.success) throw new AccountEmailUnavailableError('identity answered out of shape');
    if (body.data.userId.toLowerCase() !== userId.toLowerCase())
      throw new AccountEmailUnavailableError('identity answered for another user');
    return body.data.email;
  };
}

/** Wired when IDENTITY_URL and the shared service secret are set; otherwise null, and there is no fallback. */
export function provedAccountEmailFromProcessEnv(s2s?: { signer: ServiceSigner; mode: ServiceAuthMode }): ProvedAccountEmail | null {
  const url = process.env.IDENTITY_URL?.trim() ?? '';
  const secret = process.env.INTERNAL_SERVICE_SECRET?.trim() ?? '';
  if (!url || secret.length < 32) return null;
  try {
    void new URL(url);
  } catch {
    return null;
  }
  return createProvedAccountEmailClient(url, secret, s2s);
}
