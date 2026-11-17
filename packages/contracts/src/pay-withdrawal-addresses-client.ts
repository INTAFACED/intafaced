import { serviceAuthHeadersForBody } from './service-auth.js';
import {
  PAY_WITHDRAWAL_ADDRESSES_PATH,
  payWithdrawalAddressesInputSchema,
  payWithdrawalAddressesReplySchema,
  type PayWithdrawalAddressesPort,
} from './pay-withdrawal-addresses.js';

/**
 * svc-bank's client for svc-pay's withdrawal addresses path. One bounded request per call, signed over its body with the
 * shared service secret. A missing or malformed URL, a secret under 32 characters, a non-2xx reply, a reply that does not
 * parse, a timeout and a thrown fetch all answer `null`: no address is ever assumed. No ids asks nothing and answers empty.
 */
export function createPayWithdrawalAddressesClient(options: {
  payUrl?: string | undefined;
  secret?: string | undefined;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): PayWithdrawalAddressesPort {
  let base: string | null = null;
  try {
    const url = new URL(options.payUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing or invalid transport cannot answer anything. */
  }

  return {
    async addressesFor(userId, withdrawalIds) {
      if (withdrawalIds.length === 0) return new Map();
      if (base === null || !options.secret || options.secret.length < 32) return null;
      const input = payWithdrawalAddressesInputSchema.safeParse({ userId, withdrawalIds: [...new Set(withdrawalIds)] });
      if (!input.success) return null;
      const body = JSON.stringify(input.data);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
      try {
        const response = await (options.fetcher ?? fetch)(`${base}${PAY_WITHDRAWAL_ADDRESSES_PATH}`, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...serviceAuthHeadersForBody('svc-bank', options.secret, body),
          },
          body,
        });
        if (!response.ok) return null;
        const answer = payWithdrawalAddressesReplySchema.safeParse(await response.json());
        if (!answer.success) return null;
        const asked = new Set(input.data.withdrawalIds);
        // Only ids that were asked: an answer naming any other is not trusted at all.
        if (answer.data.addresses.some((a) => !asked.has(a.withdrawalId))) return null;
        return new Map(answer.data.addresses.map((a) => [a.withdrawalId, a.address]));
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
