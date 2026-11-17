/**
 * How a person pays for agent usage, read from svc-bank over S2S (`POST /internal/agents/usage-payment`; J-agents-01).
 *
 * At launch INTAFACED holds no customer money (OWNER 226): a sealed usage window is earned in our ledger as owed by the
 * person, and the person's partner collects it from them. svc-agents never reads svc-bank's tables or the partner; it
 * asks this door. A failed read throws `UsagePaymentUnavailable`, never "no payment method"; a refused collect is an
 * answer naming why, and the window stays owed.
 */
import {
  AGENTS_USAGE_PAYMENT_PATH,
  agentsUsagePaymentCollectSchema,
  agentsUsagePaymentReadSchema,
  serviceCallSigner,
  type AgentsUsagePaymentCollect,
  type AgentsUsagePaymentRead,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { formatAmount, type Amount } from '@intafaced/ledger-client';

export interface UsagePaymentPort {
  /** With `businessId` (a team run), how the business pays, not the member (`userId`). */
  read(userId: string, assetId: string, businessId?: string): Promise<AgentsUsagePaymentRead>;
  collect(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    chargeKey: string;
    businessId?: string;
  }): Promise<AgentsUsagePaymentCollect>;
}

export class UsagePaymentUnavailable extends Error {
  readonly code = 'agents.payment_unavailable' as const;
  constructor() {
    super('How this person pays could not be read from svc-bank');
    this.name = 'UsagePaymentUnavailable';
  }
}

/** Every person on the custodial layer: the window is charged on the ledger, exactly as before. No BANK_URL is this. */
export const ledgerOnlyPayment: UsagePaymentPort = Object.freeze({
  read: async () => ({ heldBy: 'ledger' as const }),
  collect: async () => ({ ok: false as const, reason: 'not_partner_held' as const }),
});

export type HttpUsagePaymentOptions = {
  readonly bankUrl: string;
  readonly internalSecret: string;
  readonly s2s?: { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };
  readonly fetchImpl?: typeof fetch;
};

export function createHttpUsagePaymentPort(options: HttpUsagePaymentOptions): UsagePaymentPort {
  const target = new URL(`${options.bankUrl.replace(/\/$/, '')}${AGENTS_USAGE_PAYMENT_PATH}`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sign = serviceCallSigner({ service: 'svc-agents', audience: 'svc-bank', legacySecret: options.internalSecret, s2s: options.s2s });
  const call = async (payload: object): Promise<unknown> => {
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }),
        },
        body,
      });
    } catch {
      throw new UsagePaymentUnavailable();
    }
    if (!response.ok) throw new UsagePaymentUnavailable();
    return response.json().catch(() => null);
  };
  return {
    async read(userId, assetId, businessId) {
      const parsed = agentsUsagePaymentReadSchema.safeParse(
        await call({ action: 'read', userId, assetId, ...(businessId ? { businessId } : {}) }),
      );
      if (!parsed.success) throw new UsagePaymentUnavailable();
      return parsed.data;
    },
    async collect({ userId, assetId, amount, chargeKey, businessId }) {
      const parsed = agentsUsagePaymentCollectSchema.safeParse(
        await call({ action: 'collect', userId, assetId, amount: formatAmount(amount), chargeKey, ...(businessId ? { businessId } : {}) }),
      );
      if (!parsed.success) throw new UsagePaymentUnavailable();
      // The partner's answer must be for the amount asked; any other is not this window's payment.
      if (parsed.data.ok && parsed.data.amount !== formatAmount(amount)) throw new UsagePaymentUnavailable();
      return parsed.data;
    },
  };
}
