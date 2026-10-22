/**
 * S2S producer payout door — pay accrued affiliate commission for one fee event.
 *
 * Accrue (`/internal/affiliates/accrue`) writes durable rows and posts nothing.
 * This door is the money half: planAffiliatePayout + postAffiliatePayout through
 * ledger-client. Refuse-closed on unset / unpublished rates and frozen
 * beneficiaries. No invented rates. Does not wire trade/pay callers.
 */

import type { FastifyInstance } from 'fastify';
import { rawBodyOf, retainRawBody, verifyServiceHeaders } from '@intafaced/contracts';
import type { LedgerClient } from '@intafaced/ledger-client';
import { z } from 'zod';
import { AffiliatePayoutRefuseError, AFFILIATE_PAYOUT_RESIDUAL } from './admin-tree-read.js';
import type { AccrualStore } from './accrual-store.js';
import type { AccrualTierLaw } from './commission-rate-law.js';
import { UNPUBLISHED_ACCRUAL_TIER_LAW } from './commission-rate-law.js';
import { AFFILIATE_PRODUCER_SOURCE_BY_SERVICE, type AffiliateProducerService } from './producer-accrue.js';
import { assertPayoutRateProvenance, planAffiliatePayout, postAffiliatePayout } from './payout-engine.js';

export const AFFILIATE_PRODUCER_PAYOUT_PATH = '/internal/affiliates/payout';

const bodySchema = z.object({ feeEventId: z.string().min(1).max(120) }).strict();

export type AffiliateProducerPayoutDeps = {
  readonly internalSecret: string;
  readonly freeze: { frozenIds(): Promise<ReadonlySet<string>> };
  readonly accruals: AccrualStore;
  readonly accrualTierLaw: AccrualTierLaw | undefined;
  readonly ledger: Pick<LedgerClient, 'post'> | undefined;
};

function httpStatus(code: AffiliatePayoutRefuseError['code']): number {
  if (code === 'affiliate.payout.ledger_unwired') return 503;
  if (code === 'affiliate.payout.invalid') return 400;
  return 412;
}

export function registerAffiliateProducerPayout(app: FastifyInstance, deps: AffiliateProducerPayoutDeps): void {
  retainRawBody(app);

  app.post(AFFILIATE_PRODUCER_PAYOUT_PATH, async (req, reply) => {
    const { service, rejected } = verifyServiceHeaders(req.headers, deps.internalSecret, {
      rawBody: rawBodyOf(req),
      mode: 'require',
    });
    if (service === null) {
      return reply.code(401).send({
        error: 'service credentials required',
        code: 'identity.unauthenticated',
        rejected: rejected ?? 'unauthenticated',
      });
    }

    if (AFFILIATE_PRODUCER_SOURCE_BY_SERVICE[service as AffiliateProducerService] === undefined) {
      return reply.code(403).send({
        error: `service ${service} is not an affiliate fee producer`,
        code: 'affiliate.payout.producer_forbidden',
      });
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => i.message).join('; '),
        code: 'identity.validation_failed',
      });
    }

    const feeEventId = parsed.data.feeEventId.trim();
    const law = deps.accrualTierLaw ?? UNPUBLISHED_ACCRUAL_TIER_LAW;

    try {
      assertPayoutRateProvenance([], law);

      if (!deps.ledger) {
        throw new AffiliatePayoutRefuseError(
          'Affiliate payout cannot post — no ledger client is wired into this deployment',
          'affiliate.payout.ledger_unwired',
          AFFILIATE_PAYOUT_RESIDUAL,
        );
      }

      const rows = await deps.accruals.listByFeeEvent(feeEventId);
      const frozen = await deps.freeze.frozenIds();
      const plan = planAffiliatePayout({
        feeEventId,
        rows,
        law,
        frozenBeneficiaryIds: frozen,
      });
      const receipt = await postAffiliatePayout(deps.ledger, plan);
      return reply.code(200).send({
        posted: true as const,
        feeEventId: receipt.feeEventId,
        asset: receipt.asset,
        totalCommission: receipt.totalCommission,
        legCount: receipt.legCount,
        beneficiaryCount: receipt.beneficiaryCount,
        idempotencyKeys: receipt.idempotencyKeys,
      });
    } catch (err) {
      if (err instanceof AffiliatePayoutRefuseError) {
        return reply.code(httpStatus(err.code)).send({
          error: err.message,
          code: err.code,
          residual: err.residual,
        });
      }
      throw err;
    }
  });
}
