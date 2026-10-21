import type { z } from 'zod';
import { serviceAuthHeadersForBody } from './service-auth.js';
import {
  PAY_CUSTODY_DEPOSIT_ADDRESS_PATH,
  PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH,
  PAY_CUSTODY_DEPOSIT_RECORDS_PATH,
  payCustodyDepositAddressInputSchema,
  payCustodyDepositAddressReplySchema,
  payCustodyDepositCatalogueSchema,
  payCustodyDepositRecordsInputSchema,
  payCustodyDepositRecordsReplySchema,
  type PayCustodyDepositPort,
} from './pay-custody-deposit.js';

const UNAVAILABLE = { state: 'unavailable', code: 'pay.custody_deposit_unavailable' } as const;

/**
 * svc-bank's client for svc-pay's custody deposit paths. One bounded request per call, signed over its body with the shared
 * service secret. A missing or malformed URL, a secret under 32 characters, a non-2xx reply, a reply that does not parse, a
 * timeout and a thrown fetch all answer `unavailable`: no address or catalogue entry is ever assumed.
 */
export function createPayCustodyDepositClient(options: {
  payUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): PayCustodyDepositPort {
  let base: string | null = null;
  try {
    const url = new URL(options.payUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing or invalid transport cannot issue anything. */
  }

  async function post<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T | null> {
    if (base === null || !options.secret || options.secret.length < 32) return null;
    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
    try {
      const response = await (options.fetcher ?? fetch)(`${base}${path}`, {
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
      const answer = schema.safeParse(await response.json());
      return answer.success ? answer.data : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async catalogue() {
      const catalogue = await post(PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH, {}, payCustodyDepositCatalogueSchema);
      return catalogue === null ? UNAVAILABLE : { state: 'ok', catalogue };
    },
    async address(raw) {
      const parsed = payCustodyDepositAddressInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      return (await post(PAY_CUSTODY_DEPOSIT_ADDRESS_PATH, parsed.data, payCustodyDepositAddressReplySchema)) ?? UNAVAILABLE;
    },
    async records(raw) {
      const parsed = payCustodyDepositRecordsInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const records = await post(PAY_CUSTODY_DEPOSIT_RECORDS_PATH, parsed.data, payCustodyDepositRecordsReplySchema);
      return records === null ? UNAVAILABLE : { state: 'ok', records };
    },
  };
}
