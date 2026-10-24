import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  kybDocumentRowSchema,
  kybUploadRulesSchema,
  type KybDocumentChecklistView,
  type KybDocumentRow,
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
 * 32 bytes as base64 or 64 hex characters); without it the upload refuses. Nothing here reads bytes back out: the
 * checklist shows metadata only. The automatic document check is an outside service and is shown as not connected.
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
