import { feeSaverAnswerSchema, type FeeSaverAnswer } from '@intafaced/contracts/campaigns-catalogue';
import { serviceCallSigner, unwrapTrpcData, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * svc-campaigns' fee-saver coupons (`service.feeSaver`; J-campaigns-09 #2 #3, CM-vouchers-coupons-02), asked when the
 * venue door prices our builder fee on an order. Services never read each other's tables, so this is the one door.
 *
 * `quote` names the coupon that would be taken and writes nothing; `take` takes one use of it for this order, once per
 * order key; `read` returns the use an order already took. The answer is the coupon, or `null` for none. `undefined`
 * means svc-campaigns could not be asked or answered outside the contract: the order then carries our normal builder
 * fee (the journey's words: "if the campaigns service is down the order carries the normal builder fee"), never a guess.
 */
export type FeeSaverCoupon = NonNullable<FeeSaverAnswer['coupon']>;

export interface FeeSaverSource {
  ask(userId: string, orderKey: string, mode: 'quote' | 'take' | 'read'): Promise<FeeSaverCoupon | null | undefined>;
}

export const FEE_SAVER_PATH = '/trpc/service.feeSaver';
const FETCH_MS = 3_000;

export function createFeeSaverClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): FeeSaverSource {
  const target = `${baseUrl.replace(/\/+$/, '')}${FEE_SAVER_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-campaigns', legacySecret: internalSecret, s2s });
  return {
    async ask(userId, orderKey, mode) {
      const raw = JSON.stringify({ accountId: userId, orderKey, mode });
      try {
        const response = await fetchFn(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...sign(raw, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body: raw,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
        if (!response.ok) return undefined;
        const parsed = feeSaverAnswerSchema.safeParse(unwrapTrpcData(await response.json()));
        return parsed.success ? parsed.data.coupon : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** A fixed source, for tests: every ask answers from `coupons` by mode and is recorded. */
export class FixedFeeSaver implements FeeSaverSource {
  readonly calls: Array<{ userId: string; orderKey: string; mode: string }> = [];
  private readonly taken = new Map<string, FeeSaverCoupon>();
  constructor(
    public coupon: Omit<FeeSaverCoupon, 'sequence'> | null | undefined,
    public usesLeft = 1,
  ) {}
  async ask(userId: string, orderKey: string, mode: 'quote' | 'take' | 'read') {
    this.calls.push({ userId, orderKey, mode });
    if (this.coupon === undefined) return undefined;
    const had = this.taken.get(orderKey);
    if (had) return had;
    if (mode === 'read' || !this.coupon || this.usesLeft <= 0) return null;
    if (mode === 'quote') return { ...this.coupon, sequence: null };
    this.usesLeft -= 1;
    const use = { ...this.coupon, sequence: this.taken.size + 1 };
    this.taken.set(orderKey, use);
    return use;
  }
}
