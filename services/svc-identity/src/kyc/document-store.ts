import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { decryptDocument, encryptDocument, parseKycDocKey } from './document-crypto.js';

export class KycDocumentError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'kyc_doc.key_missing'
      | 'kyc_doc.too_large'
      | 'kyc_doc.not_found'
      | 'kyc_doc.decrypt_failed'
      | 'kyc_doc.bad_content_type'
      | 'kyc_doc.forbidden'
      | 'kyc_doc.reader_missing',
  ) {
    super(message);
    this.name = 'KycDocumentError';
  }
}

const MAX_BYTES = 10 * 1024 * 1024;

export type PutDocumentInput = {
  userId: string;
  contentType: string;
  bytes: Buffer;
  /**
   * Operator / tooling principal who put the document (compliance audit).
   * Required on the operator tRPC path; optional for internal tooling tests.
   */
  storedBy?: string | null;
};

export type StoredDocumentMeta = {
  id: string;
  userId: string;
  contentType: string;
  byteLength: number;
  /** Operator who stored ciphertext — never the document subject by default. */
  storedBy: string | null;
  createdAt: Date;
};

/**
 * Who may open document BYTES.
 *
 * - `owner` — only the subject whose user_id is on the row.
 * - `compliance` — operator holding admin:compliance (tooling / review).
 *
 * There is deliberately no free `get(id)`: an opaque uuid is not a capability.
 * §10 / Engine C — cross-user PII read is a product break, not a convenience.
 */
export type DocReader = { kind: 'owner'; userId: string } | { kind: 'compliance'; operatorId: string };

export type KycDocumentVault = {
  put(input: PutDocumentInput): Promise<StoredDocumentMeta>;
  /**
   * Decrypt only when the reader is allowed. Cross-user owner reads throw
   * `kyc_doc.not_found` (same as missing — no existence oracle).
   */
  getFor(id: string, reader: DocReader): Promise<{ meta: StoredDocumentMeta; bytes: Buffer }>;
  /** Meta only — never ciphertext, never plaintext. */
  listMetaForUser(userId: string): Promise<StoredDocumentMeta[]>;
  deleteFor(id: string, reader: DocReader): Promise<boolean>;
  /**
   * Opaque id for `kyc_records.provider_ref`. Refuses when the document is not
   * owned by `userId` (or missing). Returns meta only.
   */
  assertDocumentForUser(documentId: string, userId: string): Promise<StoredDocumentMeta>;
};

function assertReader(reader: DocReader | null | undefined): DocReader {
  if (!reader || (reader.kind !== 'owner' && reader.kind !== 'compliance')) {
    throw new KycDocumentError('Document read requires an owner or compliance principal', 'kyc_doc.reader_missing');
  }
  if (reader.kind === 'owner' && !reader.userId?.trim()) {
    throw new KycDocumentError('Document read requires an owner or compliance principal', 'kyc_doc.reader_missing');
  }
  if (reader.kind === 'compliance' && !reader.operatorId?.trim()) {
    throw new KycDocumentError('Document read requires an owner or compliance principal', 'kyc_doc.reader_missing');
  }
  return reader;
}

/**
 * Owner may only touch their row. Compliance may touch any row that exists.
 * Wrong-owner → not_found (no cross-user oracle). Missing → not_found.
 */
export function assertDocAccess(rowUserId: string, reader: DocReader): void {
  const r = assertReader(reader);
  if (r.kind === 'compliance') return;
  if (r.userId !== rowUserId) {
    throw new KycDocumentError('Document not found', 'kyc_doc.not_found');
  }
}

/**
 * §10 encrypted KYC document store (mechanism).
 *
 * - Bytes live only in identity.kyc_documents (ciphertext).
 * - Opaque id is what kyc_records.provider_ref may point at later.
 * - kyc.status / public API never returns bytes (no read procedure mounted).
 * - Live vendor webhook is Class X — not this module.
 * - Reads are principal-bound: no free get-by-id.
 */
export class KycDocumentStore implements KycDocumentVault {
  constructor(
    private readonly sql: Sql,
    private readonly keyMaterial: string | undefined,
    private readonly keyId = 'v1',
  ) {}

  private requireKey(): Buffer {
    const key = parseKycDocKey(this.keyMaterial);
    if (!key) {
      throw new KycDocumentError('IDENTITY_KYC_DOC_KEY is not set to a 32-byte key (base64 or hex)', 'kyc_doc.key_missing');
    }
    return key;
  }

  async put(input: PutDocumentInput): Promise<StoredDocumentMeta> {
    // Refuse before any validation write-up — no invented key, no ciphertext.
    const key = this.requireKey();
    if (!input.contentType || input.contentType.length > 128 || /[\r\n]/.test(input.contentType)) {
      throw new KycDocumentError('Invalid content type', 'kyc_doc.bad_content_type');
    }
    if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) {
      throw new KycDocumentError(`Document must be 1..${MAX_BYTES} bytes`, 'kyc_doc.too_large');
    }
    const storedBy = input.storedBy?.trim() ? input.storedBy.trim() : null;
    const { ciphertext, nonce } = encryptDocument(key, input.bytes);

    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        content_type: string;
        byte_length: number;
        stored_by: string | null;
        created_at: Date;
      }>
    >`
      INSERT INTO kyc_documents (user_id, content_type, byte_length, ciphertext, nonce, key_id, stored_by)
      VALUES (
        ${input.userId},
        ${input.contentType},
        ${input.bytes.length},
        ${ciphertext},
        ${nonce},
        ${this.keyId},
        ${storedBy}
      )
      RETURNING id, user_id, content_type, byte_length, stored_by, created_at
    `;
    const row = rows[0]!;
    return {
      id: row.id,
      userId: row.user_id,
      contentType: row.content_type,
      byteLength: row.byte_length,
      storedBy: row.stored_by,
      createdAt: row.created_at,
    };
  }

  async getFor(id: string, reader: DocReader): Promise<{ meta: StoredDocumentMeta; bytes: Buffer }> {
    // Refuse before reader or row — no invented key, no plaintext.
    const key = this.requireKey();
    assertReader(reader);
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        content_type: string;
        byte_length: number;
        stored_by: string | null;
        ciphertext: Buffer;
        nonce: Buffer;
        created_at: Date;
      }>
    >`
      SELECT id, user_id, content_type, byte_length, stored_by, ciphertext, nonce, created_at
        FROM kyc_documents WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) throw new KycDocumentError('Document not found', 'kyc_doc.not_found');
    assertDocAccess(row.user_id, reader);
    try {
      const bytes = decryptDocument(key, Buffer.from(row.ciphertext), Buffer.from(row.nonce));
      return {
        meta: {
          id: row.id,
          userId: row.user_id,
          contentType: row.content_type,
          byteLength: row.byte_length,
          storedBy: row.stored_by,
          createdAt: row.created_at,
        },
        bytes,
      };
    } catch (err) {
      if (err instanceof KycDocumentError) throw err;
      throw new KycDocumentError('Document decrypt failed', 'kyc_doc.decrypt_failed');
    }
  }

  async listMetaForUser(userId: string): Promise<StoredDocumentMeta[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        content_type: string;
        byte_length: number;
        stored_by: string | null;
        created_at: Date;
      }>
    >`
      SELECT id, user_id, content_type, byte_length, stored_by, created_at
        FROM kyc_documents
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
    `;
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      contentType: row.content_type,
      byteLength: row.byte_length,
      storedBy: row.stored_by,
      createdAt: row.created_at,
    }));
  }

  async deleteFor(id: string, reader: DocReader): Promise<boolean> {
    assertReader(reader);
    // Ownership check before delete — compliance may delete any; owner only self.
    const rows = await this.sql<Array<{ id: string; user_id: string }>>`
      SELECT id, user_id FROM kyc_documents WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) return false;
    assertDocAccess(row.user_id, reader);
    const deleted = await this.sql<Array<{ id: string }>>`
      DELETE FROM kyc_documents WHERE id = ${id} RETURNING id
    `;
    return deleted.length > 0;
  }

  async assertDocumentForUser(documentId: string, userId: string): Promise<StoredDocumentMeta> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        content_type: string;
        byte_length: number;
        stored_by: string | null;
        created_at: Date;
      }>
    >`
      SELECT id, user_id, content_type, byte_length, stored_by, created_at
        FROM kyc_documents WHERE id = ${documentId}
    `;
    const row = rows[0];
    if (!row || row.user_id !== userId) {
      throw new KycDocumentError('Document not found', 'kyc_doc.not_found');
    }
    return {
      id: row.id,
      userId: row.user_id,
      contentType: row.content_type,
      byteLength: row.byte_length,
      storedBy: row.stored_by,
      createdAt: row.created_at,
    };
  }
}

/**
 * In-memory vault for unit tests (same ACL surface as SQL store).
 * Ciphertext still sealed so tests prove decrypt path, not plaintext rows.
 */
export class MemoryKycDocumentStore implements KycDocumentVault {
  private readonly rows = new Map<
    string,
    {
      id: string;
      userId: string;
      contentType: string;
      byteLength: number;
      storedBy: string | null;
      ciphertext: Buffer;
      nonce: Buffer;
      createdAt: Date;
    }
  >();

  constructor(
    private readonly keyMaterial: string | undefined,
    private readonly keyId = 'v1',
  ) {}

  private requireKey(): Buffer {
    const key = parseKycDocKey(this.keyMaterial);
    if (!key) {
      throw new KycDocumentError('IDENTITY_KYC_DOC_KEY is not set to a 32-byte key (base64 or hex)', 'kyc_doc.key_missing');
    }
    return key;
  }

  async put(input: PutDocumentInput): Promise<StoredDocumentMeta> {
    // Refuse before any validation write-up — no invented key, no ciphertext.
    const key = this.requireKey();
    if (!input.contentType || input.contentType.length > 128 || /[\r\n]/.test(input.contentType)) {
      throw new KycDocumentError('Invalid content type', 'kyc_doc.bad_content_type');
    }
    if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) {
      throw new KycDocumentError(`Document must be 1..${MAX_BYTES} bytes`, 'kyc_doc.too_large');
    }
    const storedBy = input.storedBy?.trim() ? input.storedBy.trim() : null;
    const { ciphertext, nonce } = encryptDocument(key, input.bytes);
    const id = randomUUID();
    const createdAt = new Date();
    this.rows.set(id, {
      id,
      userId: input.userId,
      contentType: input.contentType,
      byteLength: input.bytes.length,
      storedBy,
      ciphertext,
      nonce,
      createdAt,
    });
    return {
      id,
      userId: input.userId,
      contentType: input.contentType,
      byteLength: input.bytes.length,
      storedBy,
      createdAt,
    };
  }

  async getFor(id: string, reader: DocReader): Promise<{ meta: StoredDocumentMeta; bytes: Buffer }> {
    // Refuse before reader or row — no invented key, no plaintext.
    const key = this.requireKey();
    assertReader(reader);
    const row = this.rows.get(id);
    if (!row) throw new KycDocumentError('Document not found', 'kyc_doc.not_found');
    assertDocAccess(row.userId, reader);
    try {
      const bytes = decryptDocument(key, row.ciphertext, row.nonce);
      return {
        meta: {
          id: row.id,
          userId: row.userId,
          contentType: row.contentType,
          byteLength: row.byteLength,
          storedBy: row.storedBy,
          createdAt: row.createdAt,
        },
        bytes,
      };
    } catch (err) {
      if (err instanceof KycDocumentError) throw err;
      throw new KycDocumentError('Document decrypt failed', 'kyc_doc.decrypt_failed');
    }
  }

  async listMetaForUser(userId: string): Promise<StoredDocumentMeta[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        contentType: r.contentType,
        byteLength: r.byteLength,
        storedBy: r.storedBy,
        createdAt: r.createdAt,
      }));
  }

  async deleteFor(id: string, reader: DocReader): Promise<boolean> {
    assertReader(reader);
    const row = this.rows.get(id);
    if (!row) return false;
    assertDocAccess(row.userId, reader);
    this.rows.delete(id);
    return true;
  }

  async assertDocumentForUser(documentId: string, userId: string): Promise<StoredDocumentMeta> {
    const row = this.rows.get(documentId);
    if (!row || row.userId !== userId) {
      throw new KycDocumentError('Document not found', 'kyc_doc.not_found');
    }
    return {
      id: row.id,
      userId: row.userId,
      contentType: row.contentType,
      byteLength: row.byteLength,
      storedBy: row.storedBy,
      createdAt: row.createdAt,
    };
  }
}
