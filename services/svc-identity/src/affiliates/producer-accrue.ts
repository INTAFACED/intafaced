/**
 * D26-P1-O2 residual — S2S producer accrue door.
 *
 * Trade/pay already post fees into `houseFees(<module>)`. Accrual rows were
 * operator-supplied via `affiliates.accrue` (`admin:write`). Producers cannot
 * hold that scope. This route is the same durable accrue (no ledger post)
 * behind service credentials, so a fill/fee can claim commission without
 * inventing rates.
 *
 * Path fence: does not wire svc-trade / svc-pay callers (one service per PR).
 * Does not invent IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON.
 */

import type { FastifyInstance } from 'fastify';
import { retainRawBody } from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { z } from 'zod';
import { accrueTreeUnderRateAuthority } from './accrual-tree-authority.js';
import type { AccrualStore } from './accrual-store.js';
import { AccrualRateRefuseError } from './commission-rate-law.js';
import type { AccrualTierLaw } from './commission-rate-law.js';
import { CommissionError } from './commission.js';

/** Callers that own a live fee pool this mountain may accrue from. */
export const AFFILIATE_PRODUCER_SOURCE_BY_SERVICE = {
  'svc-trade': 'trade',
  'svc-pay': 'pay',
} as const;

export type AffiliateProducerService = keyof typeof AFFILIATE_PRODUCER_SOURCE_BY_SERVICE;

export const AFFILIATE_PRODUCER_PATH = '/internal/affiliates/accrue';

const UUID = z.string().uuid();
const FEE_AMOUNT = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/);
const SOURCE_MODULE = z.enum(['trade', 'pay']);

const bodySchema = z
  .object({
    feeEventId: z.string().min(1).max(120),
    userId: UUID,
    feeAmount: FEE_AMOUNT,
    asset: z.string().min(1).max(32),
    sourceModule: SOURCE_MODULE,
  })
  .strict();

export type AffiliateProducerAccrueDeps = {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset keeps the shared secret alone. */
  readonly s2s?: IdentityS2s;
  readonly referral: { loadParentMap(): Promise<ReadonlyMap<string, string>> };
  readonly freeze: { frozenIds(): Promise<ReadonlySet<string>> };
  readonly accruals: AccrualStore;
  readonly accrualTierLaw: AccrualTierLaw | undefined;
  /** Stamps the payer's latest fee event for the referral lapse (CM-referral-01 RF-4), whether or not it earns commission. */
  readonly activity?: { recordFeeEvent(userId: string): Promise<void> };
};

/**
 * POST /internal/affiliates/accrue — durable tree accrue for fee producers.
 *
 * `retainRawBody` lives here so the route is reachable in tests without
 * booting `index.ts` (same reason as pay subscription cycle routes).
 */
export function registerAffiliateProducerAccrue(app: FastifyInstance, deps: AffiliateProducerAccrueDeps): void {
  retainRawBody(app);

  app.post(AFFILIATE_PRODUCER_PATH, async (req, reply) => {
    const { service, rejected } = serviceOfRequest(req, deps.internalSecret, 'require', deps.s2s);
    if (service === null) {
      return reply.code(401).send({
        error: 'service credentials required',
        code: 'identity.unauthenticated',
        rejected: rejected ?? 'unauthenticated',
      });
    }

    const expectedModule = AFFILIATE_PRODUCER_SOURCE_BY_SERVICE[service as AffiliateProducerService];
    if (expectedModule === undefined) {
      return reply.code(403).send({
        error: `service ${service} is not an affiliate fee producer`,
        code: 'affiliate.accrual.producer_forbidden',
      });
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => i.message).join('; '),
        code: 'identity.validation_failed',
      });
    }

    const body = parsed.data;
    if (body.sourceModule !== expectedModule) {
      return reply.code(403).send({
        error: `sourceModule ${body.sourceModule} does not match producer ${service} (expected ${expectedModule})`,
        code: 'affiliate.accrual.producer_module_mismatch',
      });
    }

    try {
      // A fee event is activity even when it earns nothing (rates unset, a frozen referrer, a zero rate).
      await deps.activity?.recordFeeEvent(body.userId);
      const parent = await deps.referral.loadParentMap();
      const frozen = await deps.freeze.frozenIds();
      const out = accrueTreeUnderRateAuthority({
        fee: {
          feeEventId: body.feeEventId,
          userId: body.userId,
          feeAmount: body.feeAmount,
          asset: body.asset,
          sourceModule: body.sourceModule,
          at: new Date(),
        },
        parent,
        law: deps.accrualTierLaw ?? { published: false },
        frozenBeneficiaryIds: frozen,
        mode: 'durable',
      });
      const inserted = await deps.accruals.saveRows(out.rows);
      const stored = await deps.accruals.listByFeeEvent(body.feeEventId);
      return reply.code(200).send({
        inserted,
        frozenSkipped: out.frozenSkipped,
        rows: stored.map((r) => ({
          feeEventId: r.feeEventId,
          beneficiaryId: r.beneficiaryId,
          payerId: r.payerId,
          hop: r.hop,
          rate: r.rate,
          feeAmount: r.feeAmount,
          commissionAmount: r.commissionAmount,
          asset: r.asset,
          accruedAt: r.accruedAt.toISOString(),
          sourceModule: r.sourceModule,
        })),
      });
    } catch (err) {
      if (err instanceof AccrualRateRefuseError) {
        return reply.code(412).send({
          error: err.message,
          code: err.code,
          residual: err.residual,
        });
      }
      if (err instanceof CommissionError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });
}
