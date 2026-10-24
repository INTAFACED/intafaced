import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { KycDocumentError, type KycDocumentVault, type StoredDocumentMeta } from './document-store.js';

export class ProviderRefBindError extends Error {
  constructor(
    message: string,
    readonly code:
      'kyc_bind.record_not_found' | 'kyc_bind.record_not_pending' | 'kyc_bind.doc_mismatch' | 'kyc_bind.already_set' | 'kyc_bind.invalid',
  ) {
    super(message);
    this.name = 'ProviderRefBindError';
  }
}

export type BindProviderRefInput = {
  /** Pending kyc_records row. */
  recordId: string;
  /** Opaque id from the encrypted document vault. */
  documentId: string;
  /** Operator performing the bind (audit only; not stored on provider_ref). */
  operatorId: string;
};

export type BindProviderRefResult = {
  recordId: string;
  userId: string;
  /** Opaque pointer only — never document bytes. */
  providerRef: string;
  document: StoredDocumentMeta;
};

/**
 * Attach an encrypted-store document id as kyc_records.provider_ref.
 *
 * §10: the pointer is opaque. This refuses:
 * - document owned by a different user than the KYC record
 * - non-pending records (approve/reject already settled the grant)
 * - empty / non-uuid shapes at the call boundary (router zod)
 *
 * Runs under a transaction so FOR UPDATE actually serialises concurrent binds.
 * Does NOT return document bytes. Live vendor webhook remains Class X.
 */
export async function bindProviderRefToDocument(
  sql: Sql,
  vault: KycDocumentVault,
  input: BindProviderRefInput,
): Promise<BindProviderRefResult> {
  if (!input.recordId?.trim() || !input.documentId?.trim() || !input.operatorId?.trim()) {
    throw new ProviderRefBindError('recordId, documentId, and operatorId are required', 'kyc_bind.invalid');
  }

  return transaction(sql, async (tx) => {
    const records = await tx<Array<{ id: string; user_id: string; status: string; provider_ref: string | null }>>`
      SELECT id, user_id, status, provider_ref
        FROM kyc_records
       WHERE id = ${input.recordId}
       FOR UPDATE
    `;
    const record = records[0];
    if (!record) {
      throw new ProviderRefBindError('KYC record not found', 'kyc_bind.record_not_found');
    }
    if (record.status !== 'pending') {
      throw new ProviderRefBindError('Only pending KYC records accept a document pointer', 'kyc_bind.record_not_pending');
    }
    if (record.provider_ref !== null && record.provider_ref !== input.documentId) {
      throw new ProviderRefBindError('provider_ref already set to a different pointer', 'kyc_bind.already_set');
    }

    let document: StoredDocumentMeta;
    try {
      document = await vault.assertDocumentForUser(input.documentId, record.user_id);
    } catch (err) {
      if (err instanceof KycDocumentError && err.code === 'kyc_doc.not_found') {
        throw new ProviderRefBindError('Document does not belong to this KYC subject (or does not exist)', 'kyc_bind.doc_mismatch');
      }
      throw err;
    }

    if (record.provider_ref === input.documentId) {
      // Idempotent re-bind of the same pointer.
      return {
        recordId: record.id,
        userId: record.user_id,
        providerRef: input.documentId,
        document,
      };
    }

    const updated = await tx<Array<{ id: string }>>`
      UPDATE kyc_records
         SET provider_ref = ${input.documentId}
       WHERE id = ${input.recordId}
         AND status = 'pending'
         AND provider_ref IS NULL
       RETURNING id
    `;
    if (updated.length === 0) {
      // Race: another bind won, or status flipped inside the transaction window.
      const again = await tx<Array<{ provider_ref: string | null; status: string }>>`
        SELECT provider_ref, status FROM kyc_records WHERE id = ${input.recordId}
      `;
      const row = again[0];
      if (row?.provider_ref === input.documentId) {
        return {
          recordId: record.id,
          userId: record.user_id,
          providerRef: input.documentId,
          document,
        };
      }
      if (row && row.status !== 'pending') {
        throw new ProviderRefBindError('Only pending KYC records accept a document pointer', 'kyc_bind.record_not_pending');
      }
      throw new ProviderRefBindError('provider_ref already set to a different pointer', 'kyc_bind.already_set');
    }

    return {
      recordId: record.id,
      userId: record.user_id,
      providerRef: input.documentId,
      document,
    };
  });
}

/** A KYC record's review state, as one of its subject's documents shows it. An approval past its expiry reads `expired`. */
export type DocumentReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type DocumentReview = { recordId: string; tier: 'none' | 'basic' | 'full' | 'institutional'; status: DocumentReviewStatus };

/**
 * For each of one subject's documents, the newest KYC record of that same subject that points at it
 * (`kyc_records.provider_ref`). A document no record points at is absent from the map. Ids only: no bytes, no PII.
 */
export async function documentReviews(sql: Sql, userId: string, documentIds: readonly string[]): Promise<Map<string, DocumentReview>> {
  if (documentIds.length === 0) return new Map();
  const rows = await sql<Array<{ id: string; provider_ref: string; tier: DocumentReview['tier']; status: DocumentReviewStatus }>>`
    SELECT DISTINCT ON (provider_ref)
           id,
           provider_ref,
           tier,
           CASE WHEN status = 'approved' AND expires_at IS NOT NULL AND expires_at <= now() THEN 'expired' ELSE status::text END AS status
      FROM kyc_records
     WHERE user_id = ${userId}
       AND provider_ref IN ${sql(documentIds)}
     ORDER BY provider_ref, created_at DESC
  `;
  return new Map(rows.map((r) => [r.provider_ref, { recordId: r.id, tier: r.tier, status: r.status }]));
}
