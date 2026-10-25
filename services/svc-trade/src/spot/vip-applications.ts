/**
 * VIP applications (SP-fees-vip-04, J-cex-spot-10 #7): a person asks for a VIP tier with a proof of their status
 * elsewhere (a statement from another venue, say), and compliance reviews it.
 *
 * What the owner sets, in the fee schedule's `tierProgram.application`: the proof file types accepted and the largest
 * file. No programme, or none of these rules, refuses every application (`vip.application_unset`): this file names no
 * type and no size. Only types this service can recognise from the file's own bytes may be named, so a file sent as a
 * PDF that is not one is refused as the type it is not.
 *
 * The proof is encrypted before it reaches the database with a key from the environment (`TRADE_VIP_PROOF_KEY`, 32 bytes
 * as base64 or 64 hex characters); without it every application refuses (`vip.proof_key_unset`). The person's reads
 * show metadata only. One application is open (pending) per person at a time. A request is keyed by the person's own
 * request id (`vip-application:<userId>:<requestId>`): the same request again answers the application it made, and the
 * same id with a different file refuses. Not money: an application moves nothing.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

export const VIP_PROOF_KEY_ENV = 'TRADE_VIP_PROOF_KEY';

/** The largest proof the owner may allow: the route reads at most this, base64-encoded, in one body. */
export const VIP_PROOF_MAX_BYTES_CEILING = 5 * 1024 * 1024;

/** The owner's rules for applications, from the fee schedule's tier programme. */
export interface VipApplicationRules {
  /** Accepted proof types, lower case, each one this service recognises from the file's bytes. */
  readonly proofTypes: readonly string[];
  /** The largest proof file, in bytes. */
  readonly maxBytes: number;
}

/** The proof types this service can tell from a file's first bytes. The owner chooses among these. */
export const RECOGNISED_PROOF_TYPES: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

export type VipErrorCode =
  | 'vip.application_unset'
  | 'vip.proof_key_unset'
  | 'vip.file_type_unsupported'
  | 'vip.file_not_its_type'
  | 'vip.file_too_large'
  | 'vip.file_empty'
  | 'vip.file_invalid'
  | 'vip.request_invalid'
  | 'vip.application_open'
  | 'vip.request_reused';

export class VipError extends Error {
  constructor(
    message: string,
    readonly code: VipErrorCode,
    readonly data?: Readonly<Record<string, string | number | readonly string[]>>,
  ) {
    super(message);
    this.name = 'VipError';
  }
}

/** HTTP status of each refusal: a rule the owner or operator has not set is 503, a request the person can fix is 4xx. */
export const VIP_ERROR_STATUS: Readonly<Record<VipErrorCode, number>> = {
  'vip.application_unset': 503,
  'vip.proof_key_unset': 503,
  'vip.file_type_unsupported': 400,
  'vip.file_not_its_type': 400,
  'vip.file_too_large': 413,
  'vip.file_empty': 400,
  'vip.file_invalid': 400,
  'vip.request_invalid': 400,
  'vip.application_open': 409,
  'vip.request_reused': 409,
};

/** A 32-byte AES key from the environment, or null when blank or malformed. No improvised key. */
export function parseVipProofKey(raw: string | undefined | null): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  return buf.length === 32 ? buf : null;
}

/** The ciphertext is bound to its application and contents: moved to another row, it fails to open. */
export const proofAad = (applicationId: string, sha256: string): Buffer => Buffer.from(`vip-proof:${applicationId}:${sha256}`);

function encrypt(key: Buffer, plaintext: Buffer, additional: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/** Open a kept proof: the AAD binds it to its row and contents, and the plaintext must hash to the kept SHA-256. */
export function openProof(key: Buffer, row: { id: string; sha256: string; ciphertext: Buffer; nonce: Buffer }): Buffer {
  if (row.ciphertext.length < 16) throw new Error('vip proof is shorter than its tag');
  const tag = row.ciphertext.subarray(row.ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, { authTagLength: 16 });
  decipher.setAAD(proofAad(row.id, row.sha256));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)), decipher.final()]);
  if (createHash('sha256').update(plaintext).digest('hex') !== row.sha256) throw new Error('vip proof does not match its digest');
  return plaintext;
}

export type VipApplicationStatus = 'pending' | 'approved' | 'approved_no_trial' | 'rejected';

/** An application as its owner reads it: metadata, never the file. */
export interface VipApplicationView {
  readonly id: string;
  readonly requestId: string;
  readonly status: VipApplicationStatus;
  readonly proof: { readonly fileName: string; readonly contentType: string; readonly byteLength: number; readonly sha256: string };
  readonly note: string | null;
  readonly scheduleVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApplicationRow {
  id: string;
  request_id: string;
  status: VipApplicationStatus;
  proof_file_name: string;
  proof_content_type: string;
  proof_byte_length: number;
  proof_sha256: string;
  note: string | null;
  schedule_version: string;
  created_at: Date;
  updated_at: Date;
}

export const VIEW_COLUMNS = `id, request_id, status, proof_file_name, proof_content_type, proof_byte_length, proof_sha256, note,
  schedule_version, created_at, updated_at`;

export function toView(row: ApplicationRow): VipApplicationView {
  return {
    id: row.id,
    requestId: row.request_id,
    status: row.status,
    proof: {
      fileName: row.proof_file_name,
      contentType: row.proof_content_type,
      byteLength: row.proof_byte_length,
      sha256: row.proof_sha256,
    },
    note: row.note,
    scheduleVersion: row.schedule_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;
/** Control characters, and the direction overrides that could make a name read as another to a reviewer. */
const NAME_UNSAFE = /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/;
/** A note may break lines; any other control character or direction override refuses. */
const NOTE_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** Canonical base64 only: a lenient decode would keep different bytes than the person sent. */
function decodeProof(base64: string): Buffer {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new VipError('The file is not valid base64', 'vip.file_invalid');
  return bytes;
}

export interface VipApplicationInput {
  readonly requestId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytesBase64: string;
  readonly note?: string | null;
}

const noteOf = (input: VipApplicationInput): string | null => (input.note == null ? null : input.note.trim() || null);

/** Whether a kept application is the one this input asks for: the same bytes, type, name and note. */
function sameRequest(row: ApplicationRow, input: VipApplicationInput, sha256: string): boolean {
  return (
    row.proof_sha256 === sha256 &&
    row.proof_content_type === input.contentType.trim().toLowerCase() &&
    row.proof_file_name === input.fileName.trim() &&
    (row.note ?? null) === noteOf(input)
  );
}

/** The checks that need no database, in the order a person can fix them. Returns the bytes and their type. */
export function checkProof(
  rules: VipApplicationRules | null,
  key: Buffer | null,
  input: VipApplicationInput,
): { bytes: Buffer; contentType: string; sha256: string; fileName: string; note: string | null } {
  if (!rules) {
    throw new VipError(
      'VIP applications are not open: the owner has not published which proof files are accepted',
      'vip.application_unset',
    );
  }
  if (!key) throw new VipError('VIP applications are not open: the proof file key is not set', 'vip.proof_key_unset');
  if (!REQUEST_ID.test(input.requestId)) throw new VipError('requestId must be 8 to 64 letters, digits or ._:-', 'vip.request_invalid');
  const fileName = input.fileName.trim();
  if (fileName.length < 1 || fileName.length > 200 || NAME_UNSAFE.test(fileName)) {
    throw new VipError('fileName must be 1 to 200 characters with no path, control or direction characters', 'vip.request_invalid');
  }
  const note = noteOf(input);
  if (note !== null && ([...note].length > 1000 || NOTE_UNSAFE.test(note))) {
    throw new VipError('note must be at most 1000 characters with no control or direction characters', 'vip.request_invalid');
  }
  const contentType = input.contentType.trim().toLowerCase();
  if (!rules.proofTypes.includes(contentType)) {
    throw new VipError(`${input.contentType} is not an accepted proof file type`, 'vip.file_type_unsupported', {
      accepted: rules.proofTypes,
    });
  }
  const bytes = decodeProof(input.bytesBase64);
  if (bytes.length < 1) throw new VipError('The proof file is empty', 'vip.file_empty');
  if (bytes.length > rules.maxBytes) {
    throw new VipError(`The proof file is over the ${rules.maxBytes} byte limit`, 'vip.file_too_large', { maxBytes: rules.maxBytes });
  }
  if (!RECOGNISED_PROOF_TYPES[contentType]?.(bytes)) {
    throw new VipError(`The file sent as ${contentType} is not one`, 'vip.file_not_its_type', { accepted: rules.proofTypes });
  }
  return { bytes, contentType, sha256: createHash('sha256').update(bytes).digest('hex'), fileName, note };
}

export class VipApplicationStore {
  constructor(
    private readonly sql: Sql,
    private readonly key: Buffer | null,
  ) {}

  /** False without a usable proof key: every application would refuse `vip.proof_key_unset`, so reads say so first. */
  get keyed(): boolean {
    return this.key !== null;
  }

  /**
   * Keep one application. The same request again answers the application it made, even after the owner's rules
   * change; the same request id with another file, name or note refuses; a second while one is pending refuses. Under
   * a lock per person, so two requests at once cannot both open one.
   */
  async submit(
    userId: string,
    rules: VipApplicationRules | null,
    scheduleVersion: string,
    input: VipApplicationInput,
  ): Promise<{ application: VipApplicationView; created: boolean }> {
    const requestKey = `vip-application:${userId}:${input.requestId}`;
    // A retry of a request already kept is answered before the rules: they may have changed since it was kept.
    if (REQUEST_ID.test(input.requestId)) {
      const replay = await this.replayOf(this.sql, requestKey, input);
      if (replay) return { application: replay, created: false };
    }
    const proof = checkProof(rules, this.key, input);
    const key = this.key!;
    return (await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`trade.vip_application:${userId}`}, 0))`;
      const replay = await this.replayOf(tx, requestKey, input);
      if (replay) return { application: replay, created: false };
      const [open] = await tx<Array<{ id: string }>>`
        SELECT id FROM trade.vip_applications WHERE user_id = ${userId} AND status = 'pending' LIMIT 1
      `;
      if (open) throw new VipError('An application is already waiting for review', 'vip.application_open', { applicationId: open.id });
      // The row id, not a key: the request is keyed by `request_key`. It is known before the insert so the ciphertext
      // can be bound to it.
      const id = randomUUID();
      const { ciphertext, nonce } = encrypt(key, proof.bytes, proofAad(id, proof.sha256));
      const [row] = await tx<ApplicationRow[]>`
        INSERT INTO trade.vip_applications (
          id, user_id, request_id, request_key, status, proof_file_name, proof_content_type, proof_byte_length,
          proof_sha256, proof_ciphertext, proof_nonce, note, schedule_version
        ) VALUES (
          ${id}, ${userId}, ${input.requestId}, ${requestKey}, 'pending', ${proof.fileName}, ${proof.contentType},
          ${proof.bytes.length}, ${proof.sha256}, ${ciphertext}, ${nonce}, ${proof.note}, ${scheduleVersion}
        )
        RETURNING ${tx.unsafe(VIEW_COLUMNS)}
      `;
      await tx`
        INSERT INTO trade.vip_application_events (application_id, status, actor_id, actor_role)
        VALUES (${id}, 'pending', ${userId}, 'applicant')
      `;
      return { application: toView(row!), created: true };
    })) as { application: VipApplicationView; created: boolean };
  }

  /** The application this request already made, or null; the same request id for anything else refuses. */
  private async replayOf(sql: Sql | TransactionSql, requestKey: string, input: VipApplicationInput): Promise<VipApplicationView | null> {
    const [same] = await sql<ApplicationRow[]>`
      SELECT ${sql.unsafe(VIEW_COLUMNS)} FROM trade.vip_applications WHERE request_key = ${requestKey}
    `;
    if (!same) return null;
    const bytes = Buffer.from(input.bytesBase64, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.toString('base64') !== input.bytesBase64 || !sameRequest(same, input, sha256)) {
      throw new VipError('This request id was already used for another application', 'vip.request_reused');
    }
    return toView(same);
  }

  /** The person's own applications, newest first, metadata only. */
  async listOwn(userId: string, limit = 20): Promise<VipApplicationView[]> {
    const rows = await this.sql<ApplicationRow[]>`
      SELECT ${this.sql.unsafe(VIEW_COLUMNS)} FROM trade.vip_applications
       WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(toView);
  }
}
