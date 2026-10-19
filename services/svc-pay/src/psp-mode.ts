import type { Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from '@intafaced/db';
import { MAX_FEE_BPS } from './fee-bps-bound.js';

/**
 * PSP MODE — OWN THE MERCHANT, WITHOUT A THIRD-PARTY MONEY LIBRARY.
 *
 * D-S-10 ADR (`docs/adr/2026-08-04-pay-rails-and-psp-socket.md`): we do **not**
 * adopt Hyperswitch (or peer orchestrators) in the money path. Doctrine 5 —
 * no third-party connectivity library in the money path. `socket.psp-partners`
 * remains a commercial relationship (sponsor bank / acquiring BIN), not a
 * package install.
 *
 * This module seals two product-complete residuals under `pay.psp` that are
 * path-disjoint from settlement (#1694) and fraud (#1657):
 *
 *   1. Custom pricing durability — feeBps changes with who / when / why.
 *   2. A static refuse that svc-pay never depends on named third-party money
 *      connectivity libraries.
 *
 * It does **not** invent fee schedules, grants, or partner BINs.
 */

export class PspModeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PspModeError';
  }
}

/** psp.pricingHistory page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPricingHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new PspModeError(
      'psp.pricingHistory page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.psp_pricing_history_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new PspModeError(
      'psp.pricingHistory page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.psp_pricing_history_limit_unset',
    );
  }
  return Math.min(200, n);
}

/**
 * Package names (npm) that would put a third-party money / PSP orchestrator on
 * the connectivity path. Kept as a sealed list so the refuse is reviewable —
 * adding a name here is how we keep Doctrine 5 honest when a future PR tries
 * to "just wire Stripe".
 */
export const FORBIDDEN_THIRD_PARTY_MONEY_LIBS = [
  'hyperswitch',
  '@juspay/hyperswitch',
  'juspay',
  'stripe',
  '@stripe/stripe-js',
  'adyen-node-api-library',
  '@adyen/api-library',
  'braintree',
  'checkout-sdk-node',
  'square',
  'paypal-rest-sdk',
  '@paypal/checkout-server-sdk',
] as const;

export interface PricingEventRecord {
  id: string;
  seq: string;
  merchantId: string;
  fromFeeBps: number;
  toFeeBps: number;
  reason: string;
  actorId: string;
  actorScope: string;
  createdAt: Date;
}

interface PricingEventRow {
  id: string;
  seq: string;
  merchant_id: string;
  from_fee_bps: number;
  to_fee_bps: number;
  reason: string;
  actor_id: string;
  actor_scope: string;
  created_at: Date;
}

interface MerchantPricingRow {
  id: string;
  mode: 'gateway' | 'psp' | 'payfac';
  pricing: { feeBps?: number } & Record<string, unknown>;
}

function toPricingEvent(row: PricingEventRow): PricingEventRecord {
  return {
    id: row.id,
    seq: String(row.seq),
    merchantId: row.merchant_id,
    fromFeeBps: row.from_fee_bps,
    toFeeBps: row.to_fee_bps,
    reason: row.reason,
    actorId: row.actor_id,
    actorScope: row.actor_scope,
    createdAt: row.created_at,
  };
}

function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new PspModeError(`feeBps must be an integer between 0 and ${MAX_FEE_BPS}`, 'pay.merchant_pricing_invalid');
  }
}

/**
 * Reads svc-pay's own package.json and refuses if any forbidden money-lib
 * dependency is present. Pure — no I/O beyond the package file next to this
 * service. Called from the seal test and available at boot if desired.
 */
export function assertNoThirdPartyMoneyLibrary(packageJsonPath?: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = packageJsonPath ?? join(here, '..', 'package.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = new Set([...Object.keys(raw.dependencies ?? {}), ...Object.keys(raw.devDependencies ?? {})]);
  const hits = FORBIDDEN_THIRD_PARTY_MONEY_LIBS.filter((n) => names.has(n));
  if (hits.length > 0) {
    throw new PspModeError(
      `svc-pay must not depend on third-party money / PSP orchestrator libraries (D-S-10 / Doctrine 5). Found: ${hits.join(', ')}`,
      'pay.psp_third_party_money_lib_forbidden',
      { hits },
    );
  }
}

/**
 * PSP mode owns the merchant: mode must be `psp`, and pricing must state feeBps
 * explicitly (create already requires it — this re-checks for durable writers).
 */
export function assertPspMerchant(row: { mode: string; pricing: Record<string, unknown> }): number {
  if (row.mode !== 'psp') {
    throw new PspModeError(`Merchant mode must be psp (is ${row.mode})`, 'pay.psp_mode_required', { mode: row.mode });
  }
  const raw = row.pricing['feeBps'];
  if (typeof raw !== 'number') {
    throw new PspModeError('PSP merchant pricing must state feeBps explicitly', 'pay.merchant_pricing_invalid');
  }
  assertFeeBps(raw);
  return raw;
}

export class PspModeService {
  constructor(private readonly sql: Sql) {}

  /**
   * Change a merchant's feeBps with an attributable reason. Does not invent a
   * schedule — only the integer the merchant row already carries.
   */
  async setPricing(input: {
    merchantId: string;
    feeBps: number;
    reason: string;
    actorId: string;
    actorScope: string;
  }): Promise<{ changed: boolean; feeBps: number; event: PricingEventRecord | null }> {
    assertFeeBps(input.feeBps);
    const reason = input.reason.trim();
    if (reason.length < 3) {
      throw new PspModeError(
        'A pricing change requires a reason (min 3 chars). "Why is this merchant on this feeBps" must be answerable from the database.',
        'pay.pricing_reason_required',
      );
    }

    return transaction(
      this.sql,
      async (tx) => {
        const [merchant] = await tx<MerchantPricingRow[]>`
          SELECT id, mode, pricing FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        if (!merchant) {
          throw new PspModeError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
        }

        const fromRaw = merchant.pricing?.feeBps;
        const fromFeeBps = typeof fromRaw === 'number' ? fromRaw : 0;
        if (fromFeeBps === input.feeBps) {
          return { changed: false, feeBps: fromFeeBps, event: null };
        }

        const nextPricing = { ...merchant.pricing, feeBps: input.feeBps };
        await tx`
          UPDATE pay.merchants
             SET pricing = ${tx.json(nextPricing as never)}, updated_at = now()
           WHERE id = ${input.merchantId}
        `;

        const [row] = await tx<PricingEventRow[]>`
          INSERT INTO pay.merchant_pricing_events (
            merchant_id, from_fee_bps, to_fee_bps, reason, actor_id, actor_scope
          ) VALUES (
            ${input.merchantId},
            ${fromFeeBps},
            ${input.feeBps},
            ${reason},
            ${input.actorId},
            ${input.actorScope}
          )
          RETURNING id, seq, merchant_id, from_fee_bps, to_fee_bps, reason, actor_id, actor_scope, created_at
        `;
        if (!row) {
          throw new PspModeError(
            `Merchant ${input.merchantId} pricing changed but the history row was not returned. Rolled back.`,
            'pay.pricing_history_not_written',
          );
        }

        return { changed: true, feeBps: input.feeBps, event: toPricingEvent(row) };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async pricingHistory(merchantId: string, limit?: number): Promise<PricingEventRecord[]> {
    const page = assertPricingHistoryLimit(limit);
    const rows = await this.sql<PricingEventRow[]>`
      SELECT id, seq, merchant_id, from_fee_bps, to_fee_bps, reason, actor_id, actor_scope, created_at
        FROM pay.merchant_pricing_events
       WHERE merchant_id = ${merchantId}
       ORDER BY seq DESC
       LIMIT ${page}
    `;
    return rows.map(toPricingEvent);
  }

  /**
   * Flip `merchants.mode` to `psp` when feeBps is already explicit.
   * Does not invent pricing — refuses if feeBps is missing.
   * Reason + actor are required so the operator call is attributable even
   * without a separate mode-events table (KYB + pricing histories cover the
   * tracker durability title; mode is a product flag, not a rate).
   */
  async enablePspMode(input: {
    merchantId: string;
    reason: string;
    actorId: string;
    actorScope: string;
  }): Promise<{ mode: 'psp'; feeBps: number; changed: boolean; reason: string; actorId: string }> {
    const reason = input.reason.trim();
    if (reason.length < 3) {
      throw new PspModeError('Enabling PSP mode requires a reason (min 3 chars)', 'pay.psp_mode_reason_required');
    }
    if (!input.actorId.trim()) {
      throw new PspModeError('Enabling PSP mode requires an actorId from the principal', 'pay.psp_mode_actor_required');
    }

    return transaction(
      this.sql,
      async (tx) => {
        const [merchant] = await tx<MerchantPricingRow[]>`
          SELECT id, mode, pricing FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        if (!merchant) {
          throw new PspModeError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
        }
        const raw = merchant.pricing?.feeBps;
        if (typeof raw !== 'number') {
          throw new PspModeError(
            'Cannot enable PSP mode without an explicit feeBps on the merchant (no invent fees)',
            'pay.merchant_pricing_invalid',
          );
        }
        assertFeeBps(raw);

        if (merchant.mode === 'psp') {
          return {
            mode: 'psp' as const,
            feeBps: raw,
            changed: false,
            reason,
            actorId: input.actorId,
          };
        }

        await tx`
          UPDATE pay.merchants
             SET mode = 'psp', updated_at = now()
           WHERE id = ${input.merchantId}
        `;
        return {
          mode: 'psp' as const,
          feeBps: raw,
          changed: true,
          reason,
          actorId: input.actorId,
        };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }
}
