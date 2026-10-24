import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  kybDocumentRowSchema,
  kybUploadRulesSchema,
  type KybDocumentChecklistView,
  type KybDocumentFile,
  type KybDocumentReviewView,
  type KybDocumentRow,
  type KybDocumentVerdict,
  type KybUploadRules,
} from '@intafaced/contracts';
import { KybError } from './kyb-service.js';
import type { KybEntityTypeService } from './kyb-entity-types.js';

/**
 * THE DOCUMENT CHECKLIST AND UPLOAD OF A BUSINESS APPLICATION (I-kyc-compliance-22).
 *
 * Which documents a type needs is the owner's published list (`kyb-entity-types.ts`). The size cap and accepted content
 * types are the owner's upload rules (`pay.kyb_upload_rules`); blank rules refuse the upload, this file supplies no
 * number. Bytes are encrypted before they reach the database with a key from the environment (`PAY_KYB_DOC_KEY`,
 * 32 bytes as base64 or 64 hex characters); without it the upload refuses. The checklist shows metadata only; the
 * bytes come back out only to a compliance reviewer (`file`), and each such read is recorded. A reviewer gives each
 * upload one verdict (`review`). The automatic document check is an outside service and is shown as not connected.
 * Uploads at or below the application's `documents_after_seq` (set by a restart or a type change) no longer count.
 */

export const KYB_DOC_KEY_ENV = 'PAY_KYB_DOC_KEY';

/** A 32-byte AES key from the environment, or null when blank or malformed. No improvised key. */
export function parseKybDocKey(raw: string | undefined | null): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  return buf.length === 32 ? buf : null;
}

/** The ciphertext is bound to its row: swapped between applications, keys or contents it fails to open. */
function aad(applicationId: string, documentKey: string, sha256: string): Buffer {
  return Buffer.from(`kyb-document:${applicationId}:${documentKey}:${sha256}`);
}

function encrypt(key: Buffer, plaintext: Buffer, additional: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

function decrypt(key: Buffer, sealed: Buffer, nonce: Buffer, additional: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(additional);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

export interface DocumentRow {
  id: string;
  document_key: string;
  content_type: string;
  byte_length: number;
  sha256: string;
  state: 'provided' | 'accepted' | 'rejected';
  rejection_reason: string | null;
  created_at: Date;
}

/**
 * The current upload of each document key of an application: the latest row per key above the boundary a restart or
 * type change set. Read with the caller's connection, so a transaction sees its own view.
 */
export async function currentDocuments(q: Sql, applicationId: string, afterSeq: string | number): Promise<DocumentRow[]> {
  return q<DocumentRow[]>`
    SELECT DISTINCT ON (document_key) id, document_key, content_type, byte_length, sha256, state, rejection_reason, created_at
      FROM pay.kyb_documents WHERE application_id = ${applicationId} AND seq > ${afterSeq}
     ORDER BY document_key, seq DESC
  `;
}

const VENDOR_CHECK = { status: 'not_connected', notConnected: 'vendor.kyc' } as const;

function toRow(key: string, doc: DocumentRow | undefined): KybDocumentRow {
  if (!doc) return kybDocumentRowSchema.parse({ key, state: 'missing', rejectionReason: null, document: null });
  return kybDocumentRowSchema.parse({
    key,
    state: doc.state,
    rejectionReason: doc.rejection_reason,
    document: {
      id: doc.id,
      contentType: doc.content_type,
      byteLength: doc.byte_length,
      sha256: doc.sha256,
      uploadedAt: doc.created_at.toISOString(),
    },
  });
}

export class KybDocumentService {
  constructor(
    private readonly sql: Sql,
    private readonly entityTypes: Pick<KybEntityTypeService, 'requirements'>,
    private readonly docKey: Buffer | null,
  ) {}

  /** The owner's upload rules, or null while they are unpublished. */
  async uploadRules(): Promise<KybUploadRules | null> {
    const [row] = await this.sql<Array<{ max_bytes: number; content_types: string[] }>>`
      SELECT max_bytes, content_types FROM pay.kyb_upload_rules WHERE singleton
    `;
    return row ? kybUploadRulesSchema.parse({ maxBytes: row.max_bytes, contentTypes: row.content_types }) : null;
  }

  /** Every document the type requires, with the latest upload's state. Refuses when the type's requirements are no longer published. */
  async checklist(applicationId: string): Promise<KybDocumentChecklistView> {
    const app = await this.application(applicationId);
    const requirements = await this.entityTypes.requirements(app.entity_type, app.country);
    const docs = await currentDocuments(this.sql, applicationId, app.documents_after_seq);
    const latest = new Map(docs.map((d) => [d.document_key, d]));
    return {
      applicationId,
      uploadRules: await this.uploadRules(),
      rows: requirements.documentKeys.map((key) => toRow(key, latest.get(key))),
      vendorCheck: VENDOR_CHECK,
    };
  }

  /**
   * Store one document for a required key of an open draft. Refusals, in order: rules unset, key unset, application
   * submitted, key not on the type's list, content type not accepted, bytes over the cap. Sending the bytes that are
   * already the key's latest returns that row; any other bytes, including an earlier file sent again, become the new
   * latest. The application row is read under a share lock, so a submit in flight either finishes first (refused) or
   * waits for this upload; a lock per (application, key) serialises uploads of one document.
   */
  async upload(input: {
    applicationId: string;
    key: string;
    contentType: string;
    bytesBase64: string;
    actorId: string;
  }): Promise<KybDocumentRow> {
    const rules = await this.uploadRules();
    if (!rules) {
      throw new KybError('Document upload rules are not published', 'pay.kyb_upload_rules_unset');
    }
    if (!this.docKey) {
      throw new KybError('The document encryption key is not set', 'pay.kyb_doc_key_unset');
    }
    const app = await this.application(input.applicationId);
    if (app.state !== 'draft') {
      throw new KybError('The application is submitted and cannot be changed', 'pay.kyb_application_submitted');
    }
    const requirements = await this.entityTypes.requirements(app.entity_type, app.country);
    if (!requirements.documentKeys.includes(input.key)) {
      throw new KybError(`${input.key} is not a document ${app.entity_type} is asked for`, 'pay.kyb_document_key_unknown', {
        key: input.key,
      });
    }
    const contentType = input.contentType.toLowerCase();
    if (!rules.contentTypes.some((t) => t.toLowerCase() === contentType)) {
      throw new KybError(`${contentType} is not an accepted document type`, 'pay.kyb_document_type_refused', {
        contentTypes: rules.contentTypes,
      });
    }
    const bytes = Buffer.from(input.bytesBase64, 'base64');
    if (bytes.length < 1) throw new KybError('The document is empty', 'pay.kyb_document_empty');
    if (bytes.length > rules.maxBytes) {
      throw new KybError(`The document is over the ${rules.maxBytes} byte limit`, 'pay.kyb_document_too_large', {
        maxBytes: rules.maxBytes,
      });
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { ciphertext, nonce } = encrypt(this.docKey, bytes, aad(input.applicationId, input.key, sha256));
    return transaction(
      this.sql,
      async (tx) => {
        const [open] = await tx<Array<{ state: 'draft' | 'submitted'; entity_type: string; country: string; documents_after_seq: string }>>`
          SELECT state, entity_type, country, documents_after_seq FROM pay.kyb_applications WHERE id = ${input.applicationId} FOR SHARE
        `;
        if (!open) throw new KybError('No such application', 'pay.kyb_application_not_found');
        if (open.state !== 'draft') {
          throw new KybError('The application is submitted and cannot be changed', 'pay.kyb_application_submitted');
        }
        // A type change or restart that committed after the checks above cleared what this upload was picked for.
        if (
          open.entity_type !== app.entity_type ||
          open.country !== app.country ||
          String(open.documents_after_seq) !== String(app.documents_after_seq)
        ) {
          throw new KybError('The application was changed while the document was being sent', 'pay.kyb_application_changed');
        }
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`kyb-document:${input.applicationId}:${input.key}`}, 0))`;
        const [latest] = await tx<DocumentRow[]>`
          SELECT id, document_key, content_type, byte_length, sha256, state, rejection_reason, created_at
            FROM pay.kyb_documents
           WHERE application_id = ${input.applicationId} AND document_key = ${input.key} AND seq > ${open.documents_after_seq}
           ORDER BY seq DESC LIMIT 1
        `;
        if (latest && latest.sha256 === sha256) return toRow(input.key, latest);
        const [stored] = await tx<DocumentRow[]>`
          INSERT INTO pay.kyb_documents (application_id, document_key, content_type, byte_length, sha256, ciphertext, nonce, uploaded_by)
          VALUES (${input.applicationId}, ${input.key}, ${contentType}, ${bytes.length}, ${sha256}, ${ciphertext}, ${nonce}, ${input.actorId})
          RETURNING id, document_key, content_type, byte_length, sha256, state, rejection_reason, created_at
        `;
        if (!stored) throw new KybError('The document was not stored', 'pay.kyb_document_not_written');
        return toRow(input.key, stored);
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
  }

  /**
   * For compliance: a merchant's current application (its open draft, else the latest sent) and every document its type
   * asks for, with who gave each verdict and when. A type no longer published still lists the keys that were sent.
   */
  async reviewView(merchantId: string): Promise<KybDocumentReviewView> {
    const [merchant] = await this.sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE id = ${merchantId}`;
    if (!merchant) throw new KybError(`No merchant ${merchantId}`, 'pay.merchant_not_found');
    const [app] = await this.sql<
      Array<{
        id: string;
        entity_type: never;
        country: string;
        state: 'draft' | 'submitted';
        documents_after_seq: string;
        submitted_at: Date | null;
      }>
    >`
      SELECT id, entity_type, country, state, documents_after_seq, submitted_at FROM pay.kyb_applications
       WHERE merchant_id = ${merchantId}
       ORDER BY (state = 'draft') DESC, created_at DESC
       LIMIT 1
    `;
    if (!app) return { merchantId, application: null, rows: [], vendorCheck: VENDOR_CHECK };
    const docs = await currentDocuments(this.sql, app.id, app.documents_after_seq);
    let published: string[] = [];
    try {
      published = (await this.entityTypes.requirements(app.entity_type, app.country)).documentKeys;
    } catch (err) {
      if (!(err instanceof KybError)) throw err;
    }
    const keys = [...new Set([...published, ...docs.map((d) => d.document_key)])];
    const reviews = docs.length
      ? await this.sql<Array<{ document_id: string; actor_id: string; created_at: Date }>>`
          SELECT document_id, actor_id, created_at FROM pay.kyb_document_reviews WHERE document_id IN ${this.sql(docs.map((d) => d.id))}
        `
      : [];
    const latest = new Map(docs.map((d) => [d.document_key, d]));
    const reviewOf = new Map(reviews.map((r) => [r.document_id, r]));
    return {
      merchantId,
      application: {
        applicationId: app.id,
        entityType: app.entity_type,
        country: app.country,
        state: app.state,
        submittedAt: app.submitted_at?.toISOString() ?? null,
      },
      rows: keys.map((key) => {
        const doc = latest.get(key);
        const review = doc ? reviewOf.get(doc.id) : undefined;
        return { ...toRow(key, doc), reviewedBy: review?.actor_id ?? null, reviewedAt: review?.created_at.toISOString() ?? null };
      }),
      vendorCheck: VENDOR_CHECK,
    };
  }

  /**
   * One verdict on the upload `documentId`, by a compliance reviewer. The upload must still be its key's current one
   * (a newer file or a restart makes it `pay.kyb_document_not_current`). The same verdict and reason again return the
   * row unchanged; any other verdict on a reviewed upload is `pay.kyb_document_already_reviewed`.
   */
  async review(input: {
    applicationId: string;
    documentId: string;
    verdict: KybDocumentVerdict;
    reason: string | null;
    actorId: string;
  }): Promise<KybDocumentRow> {
    const reason = input.verdict === 'rejected' ? (input.reason?.trim() ?? '') : null;
    if (input.verdict === 'rejected' && (!reason || reason.length < 3)) {
      throw new KybError('A rejection needs the reason the business reads', 'pay.kyb_review_reason_required');
    }
    return transaction(
      this.sql,
      async (tx) => {
        const [app] = await tx<Array<{ documents_after_seq: string }>>`
          SELECT documents_after_seq FROM pay.kyb_applications WHERE id = ${input.applicationId} FOR SHARE
        `;
        if (!app) throw new KybError('No such application', 'pay.kyb_application_not_found');
        const [doc] = await tx<Array<DocumentRow & { seq: string }>>`
          SELECT id, seq, document_key, content_type, byte_length, sha256, state, rejection_reason, created_at
            FROM pay.kyb_documents WHERE id = ${input.documentId} AND application_id = ${input.applicationId}
           FOR UPDATE
        `;
        if (!doc) throw new KybError('No such document on this application', 'pay.kyb_document_not_found');
        const current = (await currentDocuments(tx, input.applicationId, app.documents_after_seq)).find(
          (d) => d.document_key === doc.document_key,
        );
        if (current?.id !== doc.id) {
          throw new KybError('A newer file replaced this one, or the application was cleared', 'pay.kyb_document_not_current');
        }
        if (doc.state !== 'provided') {
          if (doc.state === input.verdict && doc.rejection_reason === reason) return toRow(doc.document_key, doc);
          throw new KybError('This document already has a verdict', 'pay.kyb_document_already_reviewed', { state: doc.state });
        }
        const [updated] = await tx<DocumentRow[]>`
          UPDATE pay.kyb_documents SET state = ${input.verdict}, rejection_reason = ${reason}
           WHERE id = ${doc.id}
          RETURNING id, document_key, content_type, byte_length, sha256, state, rejection_reason, created_at
        `;
        await tx`
          INSERT INTO pay.kyb_document_reviews (document_id, application_id, verdict, reason, actor_id, actor_scope)
          VALUES (${doc.id}, ${input.applicationId}, ${input.verdict}, ${reason}, ${input.actorId}, 'admin:compliance')
        `;
        if (!updated) throw new KybError('The verdict was not written', 'pay.kyb_document_not_written');
        return toRow(updated.document_key, updated);
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
  }

  /** The bytes of one upload for a compliance reviewer, checked against the stored digest. The read is recorded first. */
  async file(input: { applicationId: string; documentId: string; actorId: string }): Promise<KybDocumentFile> {
    if (!this.docKey) throw new KybError('The document encryption key is not set', 'pay.kyb_doc_key_unset');
    const [doc] = await this.sql<Array<{ document_key: string; content_type: string; sha256: string; ciphertext: Buffer; nonce: Buffer }>>`
      SELECT document_key, content_type, sha256, ciphertext, nonce FROM pay.kyb_documents
       WHERE id = ${input.documentId} AND application_id = ${input.applicationId}
    `;
    if (!doc) throw new KybError('No such document on this application', 'pay.kyb_document_not_found');
    await this.sql`
      INSERT INTO pay.kyb_document_reads (document_id, actor_id, actor_scope) VALUES (${input.documentId}, ${input.actorId}, 'admin:compliance')
    `;
    let bytes: Buffer;
    try {
      bytes = decrypt(this.docKey, doc.ciphertext, doc.nonce, aad(input.applicationId, doc.document_key, doc.sha256));
    } catch {
      throw new KybError('The document does not open with the current key', 'pay.kyb_document_unreadable');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) {
      throw new KybError('The document does not match its digest', 'pay.kyb_document_unreadable');
    }
    return {
      documentId: input.documentId,
      key: doc.document_key,
      contentType: doc.content_type,
      sha256: doc.sha256,
      bytesBase64: bytes.toString('base64'),
    };
  }

  private async application(
    applicationId: string,
  ): Promise<{ entity_type: never; country: string; state: 'draft' | 'submitted'; documents_after_seq: string }> {
    const [app] = await this.sql<Array<{ entity_type: never; country: string; state: 'draft' | 'submitted'; documents_after_seq: string }>>`
      SELECT entity_type, country, state, documents_after_seq FROM pay.kyb_applications WHERE id = ${applicationId}
    `;
    if (!app) throw new KybError('No such application', 'pay.kyb_application_not_found');
    return app;
  }
}
