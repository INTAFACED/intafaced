import { accountLimitOverrideReadSchema } from '@intafaced/contracts';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { createIdentityGet, type IdentityReadOptions } from './identity-get.js';

/**
 * A founder's limit override for one customer and asset (J-ops-console-04 #12), as identity answers it now. A `null`
 * figure keeps the base figure for the customer's tier; the override ends at `expiresAt`.
 */
export interface LimitOverride {
  readonly perTx: Amount | null;
  readonly rolling24h: Amount | null;
  readonly expiresAt: Date;
}

/** The override in force for a customer's withdrawals of one asset, or `null` for none. Throws when it cannot be read. */
export type LimitOverrideOf = (userId: string, assetId: string) => Promise<LimitOverride | null>;

/** The asset ids identity keeps overrides for. Any other id cannot carry one, so it is not asked about. */
const OVERRIDE_ASSET_ID = /^[A-Z0-9]{1,16}$/;

/**
 * Reads the override per request from svc-identity's `GET /internal/limit-override/:userId?rail=withdrawal&assetId=`
 * (the published `AccountLimitOverrideRead`), service-authenticated like the KYC tier read beside it. Nothing is cached
 * or copied: identity stops answering with an override at its stored end time, and this read also drops one whose end
 * time has passed by its own clock.
 *
 * Every failure THROWS: transport, timeout, 400, 401, 404, a body off the published contract, or a body for another
 * customer, rail or asset. The guard turns a throw into `pay.guard_unavailable`, so a limit is never applied without
 * knowing whether a founder changed it.
 */
export function createIdentityLimitOverrideClient(options: IdentityReadOptions & { now?: () => Date }): LimitOverrideOf {
  const get = createIdentityGet(options, 'identity limit override client');
  const now = options.now ?? (() => new Date());

  return async (userId, assetId) => {
    if (!OVERRIDE_ASSET_ID.test(assetId)) return null;
    // Identity keys customers by the lower-case id and answers with it, so ask and bind with that.
    const id = userId.toLowerCase();
    const body = await get(
      `/internal/limit-override/${encodeURIComponent(id)}?rail=withdrawal&assetId=${encodeURIComponent(assetId)}`,
      'limit override',
    );
    const parsed = accountLimitOverrideReadSchema.safeParse(body);
    if (!parsed.success) throw new Error('identity answered off the published limit override contract: limit override not read');
    // Bind the answer to what we asked, so a misrouted reply cannot set another customer's or asset's limit.
    const read = parsed.data;
    if (read.userId !== id || read.rail !== 'withdrawal' || read.assetId !== assetId) {
      throw new Error('identity answered for a different customer, rail or asset: limit override not read');
    }
    if (!read.override) return null;
    const expiresAt = new Date(read.override.expiresAt);
    if (expiresAt.getTime() <= now().getTime()) return null;
    return {
      perTx: read.override.perTx === null ? null : parseAmount(read.override.perTx),
      rolling24h: read.override.rolling24h === null ? null : parseAmount(read.override.rolling24h),
      expiresAt,
    };
  };
}
