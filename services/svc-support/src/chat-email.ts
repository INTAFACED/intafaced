/**
 * Continuing a support chat by email (J-support-public-05 #7, SP-email-02). svc-identity holds the customer's address, so
 * svc-support names the account and identity mails its own proved address (`POST /internal/mail`, purpose
 * `support-chat-email`); svc-support never sees the address. The business key is the chat and the UTC day, so a repeat
 * the same day answers with the first mail and sends nothing more.
 *
 * Without a mailbox (`SUPPORT_CHAT_EMAIL` blank, or identity with no mail transport) the chat answers `vendor.email`, as
 * it did before a mailbox existed.
 */
import {
  SERVICE_MAIL_PATH,
  serviceCallSigner,
  serviceMailAcceptedSchema,
  type ServiceAuthMode,
  type ServiceMailRequest,
  type ServiceSigner,
} from '@intafaced/contracts';
import { SupportError } from './support-service.js';

export const SUPPORT_CHAT_EMAIL_UNPROVED = 'support.chat_email_unproved';
export const SUPPORT_CHAT_EMAIL_UNAVAILABLE = 'support.chat_email_unavailable';

/** The chat mail as svc-support asks for it. `null` from `send` means no mailbox is connected (`vendor.email`). */
export interface ChatMailPort {
  send(request: ServiceMailRequest): Promise<{ mailId: string } | null>;
}

/** No mailbox: every ask answers `vendor.email`. */
export const NO_CHAT_MAIL: ChatMailPort = { send: async () => null };

/** One ask per chat per UTC day, with the link shown valid to the end of the seventh day. Identity caps it at seven days. */
export function chatMailRequest(input: { sessionId: string; userId: string; now: Date }): ServiceMailRequest {
  const day = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()));
  return {
    key: `support-chat-email:${input.sessionId}:${day.toISOString().slice(0, 10)}`,
    userId: input.userId,
    purpose: 'support-chat-email',
    token: input.sessionId,
    detail: 'support chat',
    expiresAt: new Date(day.getTime() + 7 * 86_400_000).toISOString(),
  };
}

const FETCH_MS = 5_000;

export function createIdentityChatMail(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ChatMailPort {
  const target = `${baseUrl.replace(/\/+$/, '')}${SERVICE_MAIL_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const unavailable = (why: string) => new SupportError(`The chat could not be mailed: ${why}`, SUPPORT_CHAT_EMAIL_UNAVAILABLE);
  return {
    async send(request) {
      const body = JSON.stringify(request);
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: {
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
            'content-type': 'application/json',
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch (err) {
        throw unavailable(`identity did not answer (${err instanceof Error ? err.name : 'unknown'})`);
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        throw unavailable(`identity answered ${response.status} with no readable body`);
      }
      if (!response.ok) {
        const code = (answer as { code?: unknown } | null)?.code;
        if (code === 'identity.mail_unwired') return null;
        if (code === 'identity.email_unproved' || code === 'identity.account_not_active')
          throw new SupportError('Your account has no confirmed email address, so this chat cannot be mailed', SUPPORT_CHAT_EMAIL_UNPROVED);
        throw unavailable(`identity refused (${response.status}${typeof code === 'string' ? ` ${code}` : ''})`);
      }
      const parsed = serviceMailAcceptedSchema.safeParse(answer);
      if (!parsed.success) throw unavailable('identity answered without a mail id');
      return { mailId: parsed.data.mailId };
    },
  };
}
