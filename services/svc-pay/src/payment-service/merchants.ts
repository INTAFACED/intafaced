/**
 * Merchants and KYB: create, read, submit and decide.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import type { Sql } from 'postgres';
import { kybBindingMatches, loadKybDecisionBinding } from '../kyb-decision-binding.js';
import { transaction } from '@intafaced/db';
import { cleanMerchantName, MERCHANT_NAME_MAX, resolveMerchantNames } from '../merchant-names.js';
import type { KybActor, MerchantRecord, MerchantRow, PayService, PayServiceInternal } from '../payment-service.js';
import { PayError, assertFeeBps, kybDecisionReason, recordKybEvent, toMerchant } from './internal.js';

// ── Merchants ──────────────────────────────────────────────────────────────
export async function createMerchant(
  svc: PayServiceInternal,
  input: {
    userId: string;
    mode?: MerchantRecord['mode'];
    tier?: number;
    kybStatus?: MerchantRecord['kybStatus'];
    status?: MerchantRecord['status'];
    /** A rate is required at onboarding. There is no implicit free processing. */
    pricing: { feeBps: number };
    settlementPrefs?: Record<string, unknown>;
    /** Optional trading name and registered name (0071). Stored on first creation only. */
    displayName?: string | null;
    legalName?: string | null;
  },
): Promise<MerchantRecord> {
  assertFeeBps(input.pricing.feeBps);
  // The router already refuses a bad explicit name; this guards every other caller of the service.
  for (const [field, value] of [
    ['displayName', input.displayName],
    ['legalName', input.legalName],
  ] as const) {
    if (value != null && cleanMerchantName(value) === null) {
      throw new PayError(`${field} must be 1–${MERCHANT_NAME_MAX} characters with no control characters`, 'pay.merchant_name_invalid');
    }
  }
  const names = resolveMerchantNames(input);

  // Keyed on the user: onboarding is retried more than almost anything else
  // in a payments product, and a second merchant row for one account makes
  // "settle this account's takings" ambiguous forever after.
  await svc.sql`
    INSERT INTO pay.merchants (user_id, mode, tier, kyb_status, status, pricing, settlement_prefs, display_name, legal_name)
    VALUES (
      ${input.userId}, ${input.mode ?? 'gateway'}, ${input.tier ?? 0}, ${input.kybStatus ?? 'none'},
      ${input.status ?? 'active'}, ${svc.sql.json(input.pricing as never)},
      ${svc.sql.json((input.settlementPrefs ?? {}) as never)},
      ${names.displayName}, ${names.legalName}
    )
    ON CONFLICT (user_id) DO NOTHING
  `;

  const rows = await svc.sql<Array<MerchantRow & { parent_merchant_id: string | null }>>`
    SELECT id, user_id, parent_merchant_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
      FROM pay.merchants WHERE user_id = ${input.userId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Merchant for user ${input.userId} not found after insert`, 'pay.merchant_not_found');
  if (row.parent_merchant_id) {
    throw new PayError(
      'This account already belongs to another merchant. Opening an account does not adopt that row.',
      'pay.merchant_parent_present',
    );
  }
  return toMerchant(row);
}

export async function getMerchant(svc: PayServiceInternal, merchantId: string, connection: Sql = svc.sql): Promise<MerchantRecord> {
  const rows = await connection<MerchantRow[]>`
    SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
      FROM pay.merchants WHERE id = ${merchantId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
  return toMerchant(row);
}

/** Serialize eligibility reads with KYB/status writers in the money-door transaction. */
export async function lockMerchantEligibility(svc: PayServiceInternal, sql: Sql, merchantId: string): Promise<MerchantRecord> {
  const rows = await sql<MerchantRow[]>`
    SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
      FROM pay.merchants WHERE id = ${merchantId} FOR SHARE
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
  return toMerchant(row);
}

export async function getMerchantByUserId(svc: PayServiceInternal, userId: string): Promise<MerchantRecord | null> {
  const rows = await svc.sql<MerchantRow[]>`
    SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
      FROM pay.merchants WHERE user_id = ${userId}
  `;
  const row = rows[0];
  return row ? toMerchant(row) : null;
}

/**
 * KYB stub — merchant submits a dossier reference. Moves `none|rejected → pending`.
 * Does NOT invent a partner decision. Digital KYB / KYB vendors are `pay.psp`.
 * Records the change in `merchant_kyb_events` in the same transaction, so the portal's
 * verification history shows it.
 */
export async function submitKyb(
  svc: PayServiceInternal,
  input: { merchantId: string; kybRef: string; actor: KybActor },
): Promise<MerchantRecord> {
  const ref = input.kybRef.trim();
  if (!ref || ref.length > 128) {
    throw new PayError('kybRef must be 1–128 characters', 'pay.kyb_invalid');
  }
  return transaction(svc.sql, async (tx) => {
    const rows = await tx<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${input.merchantId} not found`, 'pay.merchant_not_found');
    const merchant = toMerchant(row);
    if (merchant.kybStatus === 'pending' || merchant.kybStatus === 'approved') {
      throw new PayError(`Merchant KYB is already ${merchant.kybStatus}`, 'pay.kyb_invalid', {
        kybStatus: merchant.kybStatus,
      });
    }
    const [updated] = await tx<MerchantRow[]>`
      UPDATE pay.merchants
         SET kyb_status = 'pending', kyb_ref = ${ref}, updated_at = now()
       WHERE id = ${input.merchantId}
         AND kyb_status IN ('none'::pay.kyb_status, 'rejected'::pay.kyb_status)
       RETURNING id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
    `;
    if (!updated) {
      throw new PayError(`Merchant KYB is already ${merchant.kybStatus}`, 'pay.kyb_invalid', {
        kybStatus: merchant.kybStatus,
      });
    }
    await recordKybEvent(tx, {
      merchantId: input.merchantId,
      from: merchant.kybStatus,
      to: 'pending',
      kybRef: ref,
      reason: 'Verification reference sent',
      actor: input.actor,
    });
    return toMerchant(updated);
  });
}

/**
 * Operator digital-KYB decide (`pay.psp`). Works under live-only.
 * Writes `merchants.kyb_status` pending → approved|rejected.
 * Does not invent a vendor webhook, fee bps, or `pay:*` scopes (Layer A).
 */
export async function decideKyb(
  svc: PayServiceInternal,
  input: {
    merchantId: string;
    decision: 'approved' | 'rejected';
    identityHash: string;
    /**
     * Runs under the merchant row lock after the live identity matches
     * `identityHash`, and before the status write. The KYB routers consume
     * the founder approval here so a mismatch refuses without consuming it.
     */
    beforeWrite?: () => Promise<void>;
    actor: KybActor;
  },
): Promise<MerchantRecord> {
  return svc.writeKybDecision(input.merchantId, input.decision, input.actor, kybDecisionReason(input.decision), {
    identityHash: input.identityHash,
    beforeWrite: input.beforeWrite,
  });
}

/**
 * KYB stub decide — sandbox/dev path only under `allow-sandbox` valueMovement.
 * Under live-only this refuses: use `merchant.decideKyb` (operator `admin:compliance`).
 * Never invents an external KYB vendor response.
 */
export async function decideKybStub(
  svc: PayServiceInternal,
  input: { merchantId: string; decision: 'approved' | 'rejected'; actor: KybActor },
): Promise<MerchantRecord> {
  if (svc.valueMovement === 'live-only') {
    throw new PayError(
      'KYB decide stub is disabled under live-only; use merchant.decideKyb (operator admin:compliance) or kyb.decide',
      'pay.kyb_operator_required',
    );
  }
  // Says what it was: the merchant's own sandbox decision, not a review, so the history never reads it as one.
  const reason = input.decision === 'approved' ? 'Approved through the sandbox stub, not reviewed' : 'Rejected through the sandbox stub';
  return svc.writeKybDecision(input.merchantId, input.decision, input.actor, reason);
}

export async function writeKybDecision(
  svc: PayServiceInternal,
  merchantId: string,
  decision: 'approved' | 'rejected',
  actor: KybActor,
  reason: string,
  binding?: { identityHash: string; beforeWrite?: () => Promise<void> },
): Promise<MerchantRecord> {
  return transaction(svc.sql, async (tx) => {
    const rows = await tx<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
    const merchant = toMerchant(row);
    if (merchant.kybStatus !== 'pending') {
      throw new PayError(`Merchant KYB must be pending to decide (is ${merchant.kybStatus})`, 'pay.kyb_invalid', {
        kybStatus: merchant.kybStatus,
      });
    }
    if (binding) {
      const live = await loadKybDecisionBinding(tx, merchantId);
      if (!live || !binding.identityHash || !kybBindingMatches(live, { identityHash: binding.identityHash })) {
        throw new PayError('KYB decision was reviewed against a different merchant identity', 'pay.kyb_identity_changed');
      }
      if (binding.beforeWrite) await binding.beforeWrite();
    }
    const [updated] = await tx<MerchantRow[]>`
      UPDATE pay.merchants
         SET kyb_status = ${decision}, updated_at = now()
       WHERE id = ${merchantId}
         AND kyb_status = 'pending'::pay.kyb_status
       RETURNING id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
    `;
    if (!updated) {
      throw new PayError(`Merchant KYB must be pending to decide (is ${merchant.kybStatus})`, 'pay.kyb_invalid', {
        kybStatus: merchant.kybStatus,
      });
    }
    await recordKybEvent(tx, {
      merchantId,
      from: merchant.kybStatus,
      to: decision,
      kybRef: merchant.kybRef,
      reason,
      actor,
    });
    return toMerchant(updated);
  });
}
