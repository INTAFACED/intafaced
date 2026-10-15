import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { PayScreeningService } from './screening/service.js';

/**
 * DIGITAL KYB — THE LIVE OPERATOR PATH (`pay.psp`).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `PayService.submitKyb` / `decideKybStub` move `kyb_status`, but:
 *   · under live-only, `decideKybStub` refuses with `pay.kyb_operator_required`
 *   · neither path writes a history — a decision cannot be explained, dated, or
 *     attributed from the database
 *
 * Merchant *status* already has that durability (`merchant-state-service.ts`).
 * KYB is a different flag (compliance vs commercial suspension) and needs the
 * same shape: one transactional writer + append-only events.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * IT DOES NOT invent a KYB vendor response. An operator names approved|rejected
 * and a reason; no partner SDK, no Hyperswitch, no third-party money library
 * (D-S-10 ADR `docs/adr/2026-08-04-pay-rails-and-psp-socket.md`).
 *
 * IT DOES NOT own the money-door read of `kybStatus`. That lives in
 * `merchant-kyb-money-gate.ts` / `assertMerchantActive` (`pay.gateway` IN slice).
 * This file IS the dossier writer / approver surface.
 *
 * IT DOES NOT replace `decideKybStub` under allow-sandbox. The stub stays for
 * gateway tests; live / PSP product path is this service.
 */

export class KybError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KybError';
  }
}

/** kyb.history page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertKybHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new KybError(
      'kyb.history page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.kyb_history_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new KybError(
      'kyb.history page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.kyb_history_limit_unset',
    );
  }
  return Math.min(200, n);
}

export type KybStatus = 'none' | 'pending' | 'approved' | 'rejected';

export const KYB_STATUSES: readonly KybStatus[] = ['none', 'pending', 'approved', 'rejected'];

export interface KybEventRecord {
  id: string;
  seq: string;
  merchantId: string;
  fromStatus: KybStatus;
  toStatus: KybStatus;
  kybRef: string | null;
  reason: string;
  actorId: string;
  actorScope: string;
  createdAt: Date;
}

interface KybEventRow {
  id: string;
  seq: string;
  merchant_id: string;
  from_status: KybStatus;
  to_status: KybStatus;
  kyb_ref: string | null;
  reason: string;
  actor_id: string;
  actor_scope: string;
  created_at: Date;
}

interface MerchantKybRow {
  id: string;
  kyb_status: KybStatus;
  kyb_ref: string | null;
  mode: 'gateway' | 'psp' | 'payfac';
}

function toEvent(row: KybEventRow): KybEventRecord {
  return {
    id: row.id,
    seq: String(row.seq),
    merchantId: row.merchant_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    kybRef: row.kyb_ref,
    reason: row.reason,
    actorId: row.actor_id,
    actorScope: row.actor_scope,
    createdAt: row.created_at,
  };
}

function requireReason(reason: string, code: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new KybError(
      'A KYB transition requires a reason. "Why was this merchant approved or rejected" must be answerable from the database.',
      code,
    );
  }
  return trimmed;
}

export class KybService {
  constructor(
    private readonly sql: Sql,
    private readonly screening = new PayScreeningService({ sql }),
  ) {}

  /**
   * Merchant submits a dossier reference. Moves `none|rejected → pending`.
   * Records who submitted and why (the dossier itself is the substance; reason
   * defaults to a fixed phrase so the history row is never blank).
   */
  async submit(input: {
    merchantId: string;
    kybRef: string;
    actorId: string;
    actorScope: string;
    reason?: string;
  }): Promise<{ changed: boolean; kybStatus: KybStatus; kybRef: string; event: KybEventRecord | null }> {
    const ref = input.kybRef.trim();
    if (!ref || ref.length > 128) {
      throw new KybError('kybRef must be 1–128 characters', 'pay.kyb_invalid');
    }
    const reason = requireReason(input.reason ?? 'merchant submitted KYB dossier', 'pay.kyb_reason_required');
    await this.screening.beforeKybSubmit(input);

    return transaction(
      this.sql,
      async (tx) => {
        const [merchant] = await tx<MerchantKybRow[]>`
          SELECT id, kyb_status, kyb_ref, mode FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        if (!merchant) {
          throw new KybError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
        }
        if (merchant.kyb_status === 'pending' || merchant.kyb_status === 'approved') {
          throw new KybError(`Merchant KYB is already ${merchant.kyb_status}`, 'pay.kyb_invalid', {
            kybStatus: merchant.kyb_status,
          });
        }

        await tx`
          UPDATE pay.merchants
             SET kyb_status = 'pending', kyb_ref = ${ref}, updated_at = now()
           WHERE id = ${input.merchantId}
        `;

        const [row] = await tx<KybEventRow[]>`
          INSERT INTO pay.merchant_kyb_events (
            merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope
          ) VALUES (
            ${input.merchantId},
            ${merchant.kyb_status}::pay.kyb_status,
            'pending'::pay.kyb_status,
            ${ref},
            ${reason},
            ${input.actorId},
            ${input.actorScope}
          )
          RETURNING id, seq, merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope, created_at
        `;
        if (!row) {
          throw new KybError(
            `Merchant ${input.merchantId} KYB submitted but the history row was not returned. Rolled back.`,
            'pay.kyb_history_not_written',
          );
        }

        return { changed: true, kybStatus: 'pending' as const, kybRef: ref, event: toEvent(row) };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * Operator decide — works under live-only. This is the digital KYB path the
   * stub points at when it refuses. Scope belongs on the router (`admin:compliance`).
   */
  async decide(input: {
    merchantId: string;
    decision: 'approved' | 'rejected';
    reason: string;
    actorId: string;
    actorScope: string;
  }): Promise<{ changed: boolean; kybStatus: KybStatus; event: KybEventRecord | null }> {
    const reason = requireReason(input.reason, 'pay.kyb_reason_required');
    if (reason.length < 3) {
      throw new KybError('KYB decide reason must be at least 3 characters', 'pay.kyb_reason_required');
    }

    return transaction(
      this.sql,
      async (tx) => {
        const [merchant] = await tx<MerchantKybRow[]>`
          SELECT id, kyb_status, kyb_ref, mode FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        if (!merchant) {
          throw new KybError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
        }
        if (merchant.kyb_status !== 'pending') {
          throw new KybError(`Merchant KYB must be pending to decide (is ${merchant.kyb_status})`, 'pay.kyb_invalid', {
            kybStatus: merchant.kyb_status,
          });
        }

        await tx`
          UPDATE pay.merchants
             SET kyb_status = ${input.decision}::pay.kyb_status, updated_at = now()
           WHERE id = ${input.merchantId}
        `;

        const [row] = await tx<KybEventRow[]>`
          INSERT INTO pay.merchant_kyb_events (
            merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope
          ) VALUES (
            ${input.merchantId},
            ${merchant.kyb_status}::pay.kyb_status,
            ${input.decision}::pay.kyb_status,
            ${merchant.kyb_ref},
            ${reason},
            ${input.actorId},
            ${input.actorScope}
          )
          RETURNING id, seq, merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope, created_at
        `;
        if (!row) {
          throw new KybError(
            `Merchant ${input.merchantId} KYB decided but the history row was not returned. Rolled back.`,
            'pay.kyb_history_not_written',
          );
        }

        return { changed: true, kybStatus: input.decision, event: toEvent(row) };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Newest first — "why was this merchant's KYB rejected". Page size is owner-published — omit is not 50. */
  async history(merchantId: string, limit?: number): Promise<KybEventRecord[]> {
    const page = assertKybHistoryLimit(limit);
    const rows = await this.sql<KybEventRow[]>`
      SELECT id, seq, merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope, created_at
        FROM pay.merchant_kyb_events
       WHERE merchant_id = ${merchantId}
       ORDER BY seq DESC
       LIMIT ${page}
    `;
    return rows.map(toEvent);
  }

  async currentStatus(merchantId: string): Promise<{ kybStatus: KybStatus; kybRef: string | null; mode: MerchantKybRow['mode'] }> {
    const [row] = await this.sql<MerchantKybRow[]>`
      SELECT id, kyb_status, kyb_ref, mode FROM pay.merchants WHERE id = ${merchantId}
    `;
    if (!row) throw new KybError(`No merchant ${merchantId}`, 'pay.merchant_not_found');
    return { kybStatus: row.kyb_status, kybRef: row.kyb_ref, mode: row.mode };
  }
}
