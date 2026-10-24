import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  kybInformationRequestSchema,
  type KybInformationRequest,
  type KybRequestFileBytes,
  type KybRequestsView,
  type KybUploadRules,
} from '@intafaced/contracts';
import { KybError } from './kyb-service.js';
import { decrypt, encrypt, type KybDocumentService } from './kyb-documents.js';
import type { KybMalwareScanner } from './kyb-malware-scan.js';

/**
 * INFORMATION REQUESTS (J-merchant-02 step 4, M-adv-org-access-07).
 *
 * A compliance reviewer asks a business for something more, with a due date; the business answers once, with a note, a
 * file, or both; a reviewer closes the request with a note the business reads. A file is scanned before anything is
 * kept: infected is refused and recorded without its bytes, and without a scanner a file answer refuses
 * `pay.kyb_scan_unconfigured`. Kept files are encrypted with the business-document key (`PAY_KYB_DOC_KEY`) and come
 * back out only to a compliance reviewer, each read recorded. The size cap and accepted types are the owner's document
 * upload rules. Every step is an append-only event in `pay.kyb_request_events`.
 */

interface RequestRow {
  id: string;
  merchant_id: string;
  request_key: string;
  text: string;
  due_at: Date;
  created_by: string;
  created_at: Date;
  state: 'open' | 'answered' | 'closed';
  closed_by: string | null;
  closed_at: Date | null;
  close_note: string | null;
  past_due: boolean;
  a_note: string | null;
  a_file_id: string | null;
  a_content_type: string | null;
  a_byte_length: number | null;
  a_sha256: string | null;
  a_created_at: Date | null;
}

const SELECT = `
  r.id, r.merchant_id, r.request_key, r.text, r.due_at, r.created_by, r.created_at, r.state, r.closed_by, r.closed_at,
  r.close_note, (r.state = 'open' AND r.due_at < now()) AS past_due,
  a.note AS a_note, a.file_id AS a_file_id, a.content_type AS a_content_type, a.byte_length AS a_byte_length,
  a.sha256 AS a_sha256, a.created_at AS a_created_at
`;

function toRequest(row: RequestRow): KybInformationRequest {
  return kybInformationRequestSchema.parse({
    id: row.id,
    merchantId: row.merchant_id,
    text: row.text,
    dueAt: row.due_at.toISOString(),
    state: row.state,
    pastDue: row.past_due,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    answer: row.a_created_at
      ? {
          note: row.a_note,
          file:
            row.a_file_id && row.a_content_type && row.a_byte_length && row.a_sha256
              ? { id: row.a_file_id, contentType: row.a_content_type, byteLength: row.a_byte_length, sha256: row.a_sha256 }
              : null,
          answeredAt: row.a_created_at.toISOString(),
        }
      : null,
    closedBy: row.closed_by,
    closedAt: row.closed_at?.toISOString() ?? null,
    closeNote: row.close_note,
  });
}

/** Binds a kept file to its request and contents: moved to another request or changed, it fails to open. */
function aad(requestId: string, sha256: string): Buffer {
  return Buffer.from(`kyb-request-answer:${requestId}:${sha256}`);
}

/** Canonical base64 only: a lenient decode would keep different bytes than the business sent. */
function decodeFile(bytesBase64: string): Buffer {
  const trimmed = bytesBase64.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
    throw new KybError('The file is not valid base64', 'pay.kyb_file_invalid');
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length < 1) throw new KybError('The file is empty', 'pay.kyb_document_empty');
  return bytes;
}

export class KybInformationRequestService {
  constructor(
    private readonly sql: Sql,
    private readonly documents: Pick<KybDocumentService, 'uploadRules'>,
    private readonly docKey: Buffer | null,
    private readonly scanner: KybMalwareScanner | null,
  ) {}

  /** The merchant that owns a request, or null when there is no such request. */
  async merchantOf(requestId: string): Promise<string | null> {
    const [row] = await this.sql<Array<{ merchant_id: string }>>`
      SELECT merchant_id FROM pay.kyb_information_requests WHERE id = ${requestId}
    `;
    return row?.merchant_id ?? null;
  }

  /** One merchant's requests, newest first, with the upload rules and whether a scanner is connected. */
  async list(merchantId: string): Promise<KybRequestsView> {
    const [merchant] = await this.sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE id = ${merchantId}`;
    if (!merchant) throw new KybError(`No merchant ${merchantId}`, 'pay.merchant_not_found');
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.sql.unsafe(SELECT)}
        FROM pay.kyb_information_requests r LEFT JOIN pay.kyb_request_answers a ON a.request_id = r.id
       WHERE r.merchant_id = ${merchantId}
       ORDER BY r.created_at DESC, r.id
    `;
    return {
      merchantId,
      requests: rows.map(toRequest),
      uploadRules: await this.documents.uploadRules(),
      scanner: this.scanner ? { status: 'connected' } : { status: 'not_connected', notConnected: 'vendor.malware_scan' },
    };
  }

  /**
   * A reviewer asks the merchant for more. The same `requestKey` with the same words and due date returns the same
   * request; with anything else it is `pay.kyb_request_key_conflict`. The due date must be in the future.
   */
  async create(input: {
    merchantId: string;
    requestKey: string;
    text: string;
    dueAt: string;
    actorId: string;
  }): Promise<KybInformationRequest> {
    const text = input.text.trim();
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw new KybError('The due date is not a date', 'pay.kyb_request_due_invalid');
    return transaction(
      this.sql,
      async (tx) => {
        const [merchant] = await tx<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE id = ${input.merchantId}`;
        if (!merchant) throw new KybError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`kyb-request:${input.requestKey}`}, 0))`;
        const [existing] = await tx<Array<{ id: string; merchant_id: string; text: string; due_at: Date }>>`
          SELECT id, merchant_id, text, due_at FROM pay.kyb_information_requests WHERE request_key = ${input.requestKey}
        `;
        if (existing) {
          if (existing.merchant_id !== input.merchantId || existing.text !== text || existing.due_at.getTime() !== dueAt.getTime()) {
            throw new KybError('That request key was used for another request', 'pay.kyb_request_key_conflict');
          }
          return this.readIn(tx, existing.id);
        }
        const [{ future } = { future: false }] = await tx<Array<{ future: boolean }>>`SELECT ${dueAt} > now() AS future`;
        if (!future) throw new KybError('The due date has passed', 'pay.kyb_request_due_past');
        const [created] = await tx<Array<{ id: string }>>`
          INSERT INTO pay.kyb_information_requests (merchant_id, request_key, text, due_at, created_by)
          VALUES (${input.merchantId}, ${input.requestKey}, ${text}, ${dueAt}, ${input.actorId})
          RETURNING id
        `;
        if (!created) throw new KybError('The request was not written', 'pay.kyb_request_not_written');
        await tx`
          INSERT INTO pay.kyb_request_events (request_id, kind, actor_id, actor_scope, detail)
          VALUES (${created.id}, 'created', ${input.actorId}, 'admin:compliance', ${tx.json({ dueAt: dueAt.toISOString() })})
        `;
        return this.readIn(tx, created.id);
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
  }

  /**
   * The business answers an open request once. A file is checked against the upload rules and scanned before anything
   * is kept; an infected file is refused (`pay.kyb_answer_file_infected`) and recorded without its bytes. The same
   * answer again returns the request unchanged; any other answer to an answered request is
   * `pay.kyb_request_already_answered`, and a closed request is `pay.kyb_request_closed`.
   */
  async answer(input: {
    requestId: string;
    note: string | null;
    file: { contentType: string; bytesBase64: string } | null;
    actorId: string;
  }): Promise<KybInformationRequest> {
    const note = input.note?.trim() || null;
    let file: { contentType: string; bytes: Buffer; sha256: string; rules: KybUploadRules } | null = null;
    if (input.file) {
      const rules = await this.documents.uploadRules();
      if (!rules) throw new KybError('Document upload rules are not published', 'pay.kyb_upload_rules_unset');
      if (!this.docKey) throw new KybError('The document encryption key is not set', 'pay.kyb_doc_key_unset');
      if (!this.scanner) throw new KybError('No malware scanner is connected', 'pay.kyb_scan_unconfigured');
      const contentType = input.file.contentType.trim().toLowerCase();
      if (!rules.contentTypes.some((t) => t.toLowerCase() === contentType)) {
        throw new KybError(`${contentType} is not an accepted document type`, 'pay.kyb_document_type_refused', {
          contentTypes: rules.contentTypes,
        });
      }
      const bytes = decodeFile(input.file.bytesBase64);
      if (bytes.length > rules.maxBytes) {
        throw new KybError(`The file is over the ${rules.maxBytes} byte limit`, 'pay.kyb_document_too_large', { maxBytes: rules.maxBytes });
      }
      file = { contentType, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), rules };
    }
    if (!note && !file) throw new KybError('An answer needs a note or a file', 'pay.kyb_answer_empty');

    const [request] = await this.sql<
      Array<{ state: string }>
    >`SELECT state FROM pay.kyb_information_requests WHERE id = ${input.requestId}`;
    if (!request) throw new KybError('No such request', 'pay.kyb_request_not_found');
    if (request.state === 'open' && file) {
      let verdict: 'clean' | 'infected';
      try {
        verdict = await this.scanner!.scan(file.bytes);
      } catch {
        throw new KybError('The malware scanner did not answer', 'pay.kyb_scan_failed');
      }
      if (verdict !== 'clean') {
        // Recorded on its own: the refusal stays in the history although nothing of the file is kept.
        await this.sql`
          INSERT INTO pay.kyb_request_events (request_id, kind, actor_id, actor_scope, detail)
          VALUES (${input.requestId}, 'file_refused', ${input.actorId}, 'pay:onboard', ${this.sql.json({ sha256: file.sha256, verdict })})
        `;
        throw new KybError('The file was refused by the malware scan', 'pay.kyb_answer_file_infected');
      }
    }

    return transaction(
      this.sql,
      async (tx) => {
        const [locked] = await tx<Array<{ state: 'open' | 'answered' | 'closed' }>>`
          SELECT state FROM pay.kyb_information_requests WHERE id = ${input.requestId} FOR UPDATE
        `;
        if (!locked) throw new KybError('No such request', 'pay.kyb_request_not_found');
        if (locked.state !== 'open') {
          const [kept] = await tx<Array<{ note: string | null; sha256: string | null }>>`
            SELECT note, sha256 FROM pay.kyb_request_answers WHERE request_id = ${input.requestId}
          `;
          if (kept && kept.note === note && kept.sha256 === (file?.sha256 ?? null)) return this.readIn(tx, input.requestId);
          if (locked.state === 'closed') throw new KybError('The request is closed', 'pay.kyb_request_closed');
          throw new KybError('The request is already answered', 'pay.kyb_request_already_answered');
        }
        const sealed = file ? encrypt(this.docKey!, file.bytes, aad(input.requestId, file.sha256)) : null;
        await tx`
          INSERT INTO pay.kyb_request_answers (request_id, note, file_id, content_type, byte_length, sha256, ciphertext, nonce, answered_by)
          VALUES (
            ${input.requestId}, ${note}, ${file ? randomUUID() : null}, ${file?.contentType ?? null},
            ${file?.bytes.length ?? null}, ${file?.sha256 ?? null}, ${sealed?.ciphertext ?? null}, ${sealed?.nonce ?? null},
            ${input.actorId}
          )
        `;
        await tx`UPDATE pay.kyb_information_requests SET state = 'answered' WHERE id = ${input.requestId}`;
        await tx`
          INSERT INTO pay.kyb_request_events (request_id, kind, actor_id, actor_scope, detail)
          VALUES (${input.requestId}, 'answered', ${input.actorId}, 'pay:onboard', ${tx.json({ file: file?.sha256 ?? null })})
        `;
        return this.readIn(tx, input.requestId);
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
  }

  /** A reviewer closes an open or answered request with a note the business reads. The same note again changes nothing. */
  async close(input: { requestId: string; note: string; actorId: string }): Promise<KybInformationRequest> {
    const note = input.note.trim();
    return transaction(
      this.sql,
      async (tx) => {
        const [locked] = await tx<Array<{ state: string; close_note: string | null }>>`
          SELECT state, close_note FROM pay.kyb_information_requests WHERE id = ${input.requestId} FOR UPDATE
        `;
        if (!locked) throw new KybError('No such request', 'pay.kyb_request_not_found');
        if (locked.state === 'closed') {
          if (locked.close_note === note) return this.readIn(tx, input.requestId);
          throw new KybError('The request is closed', 'pay.kyb_request_closed');
        }
        await tx`
          UPDATE pay.kyb_information_requests
             SET state = 'closed', closed_by = ${input.actorId}, closed_at = now(), close_note = ${note}
           WHERE id = ${input.requestId}
        `;
        await tx`
          INSERT INTO pay.kyb_request_events (request_id, kind, actor_id, actor_scope, detail)
          VALUES (${input.requestId}, 'closed', ${input.actorId}, 'admin:compliance', ${tx.json({ from: locked.state })})
        `;
        return this.readIn(tx, input.requestId);
      },
      { isolation: 'read committed', maxAttempts: 3 },
    );
  }

  /** The bytes of an answer's file for a compliance reviewer, checked against the stored digest. The read is recorded first. */
  async file(input: { requestId: string; actorId: string }): Promise<KybRequestFileBytes> {
    if (!this.docKey) throw new KybError('The document encryption key is not set', 'pay.kyb_doc_key_unset');
    const [kept] = await this.sql<
      Array<{ content_type: string | null; sha256: string | null; ciphertext: Buffer | null; nonce: Buffer | null }>
    >`
      SELECT content_type, sha256, ciphertext, nonce FROM pay.kyb_request_answers WHERE request_id = ${input.requestId}
    `;
    if (!kept?.sha256 || !kept.ciphertext || !kept.nonce || !kept.content_type) {
      throw new KybError('This request has no answer file', 'pay.kyb_request_file_not_found');
    }
    await this.sql`
      INSERT INTO pay.kyb_request_events (request_id, kind, actor_id, actor_scope, detail)
      VALUES (${input.requestId}, 'file_read', ${input.actorId}, 'admin:compliance', ${this.sql.json({ sha256: kept.sha256 })})
    `;
    let bytes: Buffer;
    try {
      bytes = decrypt(this.docKey, kept.ciphertext, kept.nonce, aad(input.requestId, kept.sha256));
    } catch {
      throw new KybError('The file does not open with the current key', 'pay.kyb_document_unreadable');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== kept.sha256) {
      throw new KybError('The file does not match its digest', 'pay.kyb_document_unreadable');
    }
    return { requestId: input.requestId, contentType: kept.content_type, sha256: kept.sha256, bytesBase64: bytes.toString('base64') };
  }

  private async readIn(q: Sql, requestId: string): Promise<KybInformationRequest> {
    const [row] = await q<RequestRow[]>`
      SELECT ${q.unsafe(SELECT)}
        FROM pay.kyb_information_requests r LEFT JOIN pay.kyb_request_answers a ON a.request_id = r.id
       WHERE r.id = ${requestId}
    `;
    if (!row) throw new KybError('No such request', 'pay.kyb_request_not_found');
    return toRequest(row);
  }
}
