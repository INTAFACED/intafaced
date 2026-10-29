/**
 * Guided verification (I-kyc-compliance-08, J-identity-08 #2). One draft per person holds the level asked for, the step
 * to resume at and the fields entered so far, sealed under the KYC document key (`IDENTITY_KYC_DOC_KEY`); with the key
 * unset every door refuses `kyc.profile_unconfigured` and nothing is stored. The ID photo goes to the encrypted vault
 * first, under the owner's caps (`IDENTITY_KYC_UPLOAD_MAX_BYTES`, `IDENTITY_KYC_UPLOAD_TYPES`, NO DEFAULT; unset
 * refuses), and the draft then refers to its id. The accepted ID types per country are the owner's list
 * (`IDENTITY_KYC_DOCUMENT_TYPES_BY_COUNTRY`); a country with none published says so, never an empty list.
 * Sending opens the verification request through `submitKyc`, with the photo's id as its provider reference. The
 * automatic document check (`vendor.kyc`) is not connected, so every request goes to a person in our own queue.
 * Personal fields are never logged and never written outside the sealed column.
 */
import { createHash, createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  KYC_PROFILE_STEPS,
  kycProfileFieldsSchema,
  kycProfileStepFieldsSchemas,
  type KycDocumentTypes,
  type KycProfile,
  type KycProfileDraft,
  type KycProfileFieldStep,
  type KycProfileFields,
  type KycProfileUploadCaps,
} from '@intafaced/contracts/identity-kyc-profile';
import { decryptDocument, encryptDocument } from './document-crypto.js';
import type { KycDocumentVault } from './document-store.js';

type Tier = 'basic' | 'full' | 'institutional';

export type KycProfileErrorCode =
  | 'kyc.profile_unconfigured'
  | 'kyc.profile_unreadable'
  | 'kyc.profile_none'
  | 'kyc.profile_version'
  | 'kyc.profile_sent'
  | 'kyc.profile_request_open'
  | 'kyc.profile_incomplete'
  | 'kyc.profile_invalid'
  | 'kyc.document_types_unset'
  | 'kyc.document_type_unlisted'
  | 'kyc.upload_caps_unset'
  | 'kyc.upload_too_large'
  | 'kyc.upload_type';

export class KycProfileError extends Error {
  constructor(
    message: string,
    readonly code: KycProfileErrorCode,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'KycProfileError';
  }
}

export type KycDocumentTypeList = ReadonlyMap<string, KycDocumentTypes['types']>;

/**
 * The photo travels as base64 inside one JSON body (the edge's and the service's 1 MiB). Base64 is 4/3 of the bytes, and
 * the JSON around it needs room, so 760 KiB (1,037,654 characters encoded) is the most it can be.
 */
const UPLOAD_MAX_BYTES = 760 * 1024;
const TYPE_ROW = /^[a-z][a-z0-9_]{1,63}$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;

/** The owner's accepted ID types per country. Unset is none published anywhere; malformed stops the service. */
export function parseKycDocumentTypes(raw: string | undefined): KycDocumentTypeList | null {
  if (raw === undefined || raw.trim() === '') return null;
  const setting = 'IDENTITY_KYC_DOCUMENT_TYPES_BY_COUNTRY';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${setting} must be JSON: {"<country>": [{"type", "label", "originalRequired"}]}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${setting} must be a JSON object`);
  const out = new Map<string, KycDocumentTypes['types']>();
  for (const [country, rows] of Object.entries(parsed)) {
    if (!/^[A-Z]{2}$/.test(country)) throw new Error(`${setting}: ${country} is not a two-letter country code`);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${setting}: ${country} needs at least one document type`);
    const seen = new Set<string>();
    out.set(
      country,
      rows.map((row: unknown) => {
        const r = row as { type?: unknown; label?: unknown; originalRequired?: unknown };
        if (typeof r.type !== 'string' || !TYPE_ROW.test(r.type) || seen.has(r.type))
          throw new Error(`${setting}: ${country} has a missing, malformed or repeated type`);
        if (typeof r.label !== 'string' || r.label.trim() === '' || r.label.length > 120)
          throw new Error(`${setting}: ${country} ${r.type} needs a label of 1 to 120 characters`);
        if (typeof r.originalRequired !== 'boolean')
          throw new Error(`${setting}: ${country} ${r.type} needs originalRequired true or false`);
        seen.add(r.type);
        return { type: r.type, label: r.label, originalRequired: r.originalRequired };
      }),
    );
  }
  return out;
}

/** The owner's caps on the ID photo, set together or not at all. Unset refuses every upload. */
export function parseKycUploadCaps(env: {
  IDENTITY_KYC_UPLOAD_MAX_BYTES?: string;
  IDENTITY_KYC_UPLOAD_TYPES?: string;
}): KycProfileUploadCaps | null {
  const max = env.IDENTITY_KYC_UPLOAD_MAX_BYTES?.trim() ?? '';
  const types = env.IDENTITY_KYC_UPLOAD_TYPES?.trim() ?? '';
  if (!max && !types) return null;
  if (!max || !types) throw new Error('IDENTITY_KYC_UPLOAD_MAX_BYTES and IDENTITY_KYC_UPLOAD_TYPES are set together or not at all');
  const maxBytes = Number(max);
  if (!/^\d+$/.test(max) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > UPLOAD_MAX_BYTES)
    throw new Error(`IDENTITY_KYC_UPLOAD_MAX_BYTES must be a whole number of bytes from 1 to ${UPLOAD_MAX_BYTES}`);
  const contentTypes = [...new Set(types.split(',').map((t) => t.trim().toLowerCase()))];
  if (contentTypes.some((t) => !CONTENT_TYPE.test(t))) throw new Error('IDENTITY_KYC_UPLOAD_TYPES must be a comma list of content types');
  return { maxBytes, contentTypes };
}

const EMPTY: KycProfileFields = kycProfileFieldsSchema.parse({
  residence: null,
  nationality: null,
  legalName: null,
  localName: null,
  dateOfBirth: null,
  documentType: null,
  documentNumber: null,
  addressLine: null,
  city: null,
  postalCode: null,
  documentId: null,
});

type Row = {
  tier: Tier;
  step: number;
  version: number;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  last_save: string | null;
  record_id: string | null;
  updated_at: Date;
};

const stepNumber = (step: (typeof KYC_PROFILE_STEPS)[number]) => KYC_PROFILE_STEPS.indexOf(step) + 1;

export class KycProfileDesk {
  constructor(
    private readonly sql: Sql,
    private readonly key: Buffer | null,
    private readonly settings: {
      readonly documentTypes: KycDocumentTypeList | null;
      readonly uploadCaps: KycProfileUploadCaps | null;
      readonly vault: KycDocumentVault | undefined;
      /** Opens the verification request: `AuthService.submitKyc`, with its lockout and capability checks. */
      readonly submit: (input: {
        userId: string;
        tier: Tier;
        jurisdiction: string;
        providerRef?: string;
      }) => Promise<{ id: string; status: string; providerRef: string | null }>;
    },
  ) {}

  private requireKey(): Buffer {
    if (!this.key) throw new KycProfileError('Guided verification needs the KYC document key', 'kyc.profile_unconfigured');
    return this.key;
  }

  private seal(fields: KycProfileFields): { ciphertext: Buffer; nonce: Buffer } {
    return encryptDocument(this.requireKey(), Buffer.from(JSON.stringify(kycProfileFieldsSchema.parse(fields)), 'utf8'));
  }

  private unseal(row: Row): KycProfileFields {
    const key = this.requireKey();
    try {
      if (row.key_id !== 'v1') throw new Error('unknown key id');
      return kycProfileFieldsSchema.parse(JSON.parse(decryptDocument(key, row.ciphertext, row.nonce).toString('utf8')));
    } catch {
      // Never guessed at, never written over.
      throw new KycProfileError('This draft cannot be opened with the current key', 'kyc.profile_unreadable');
    }
  }

  /**
   * A keyed hash of one save, so a stored hash does not reveal what was entered. Keyed with a subkey derived from the
   * document key for this one job, never with the encryption key itself.
   */
  private fingerprint(kind: string, version: number, payload: unknown): string {
    const subkey = createHmac('sha256', this.requireKey()).update('kyc.profile.fingerprint:v1').digest();
    return createHmac('sha256', subkey).update(JSON.stringify({ kind, version, payload })).digest('hex');
  }

  /** The draft's fields, or null when the current key cannot open it. */
  private tryUnseal(row: Row): KycProfileFields | null {
    try {
      return this.unseal(row);
    } catch {
      return null;
    }
  }

  /** A step may be saved once the draft has reached it: going back is fine, skipping ahead is not. */
  private assertReached(row: Row, step: (typeof KYC_PROFILE_STEPS)[number]): void {
    if (stepNumber(step) > row.step)
      throw new KycProfileError(`Finish step ${row.step} first`, 'kyc.profile_incomplete', { step: KYC_PROFILE_STEPS[row.step - 1] });
  }

  private view(row: Row, fields: KycProfileFields): KycProfileDraft {
    return {
      tier: row.tier,
      step: row.step,
      version: row.version,
      fields,
      recordId: row.record_id,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async row(sql: Sql, userId: string, lock: boolean): Promise<Row | undefined> {
    const [row] = await sql<Row[]>`SELECT tier, step, version, ciphertext, nonce, key_id, last_save, record_id, updated_at
      FROM kyc_profile_drafts WHERE user_id = ${userId} ${lock ? sql`FOR UPDATE` : sql``}`;
    return row;
  }

  /** A draft the current key cannot open reads as none, flagged, so the person can start again (`start` replaces it). */
  async read(userId: string): Promise<KycProfile> {
    this.requireKey();
    const row = await this.row(this.sql, userId, false);
    const fields = row ? this.tryUnseal(row) : null;
    return {
      draft: row && fields ? this.view(row, fields) : null,
      unreadableDraft: Boolean(row && !fields),
      uploadCaps: this.settings.uploadCaps,
      documentCheck: 'not_connected',
    };
  }

  documentTypes(country: string): KycDocumentTypes {
    const types = this.settings.documentTypes?.get(country);
    return types ? { country, published: true, types: [...types] } : { country, published: false, types: [] };
  }

  /**
   * Opens a draft at step 1, or returns the unsent one (with the level now asked for). A sent draft starts over, and so
   * does one the current key cannot open: nothing in it can be read, so nothing readable is lost.
   */
  async start(userId: string, tier: Tier): Promise<KycProfileDraft> {
    this.requireKey();
    return transaction(this.sql, async (tx) => {
      const row = await this.row(tx, userId, true);
      if (row && !row.record_id && this.tryUnseal(row)) {
        if (row.tier === tier) return this.view(row, this.unseal(row));
        const [moved] = await tx<
          Row[]
        >`UPDATE kyc_profile_drafts SET tier = ${tier}, version = version + 1, last_save = NULL, updated_at = now()
          WHERE user_id = ${userId} RETURNING tier, step, version, ciphertext, nonce, key_id, last_save, record_id, updated_at`;
        return this.view(moved!, this.unseal(moved!));
      }
      const { ciphertext, nonce } = this.seal(EMPTY);
      const [fresh] = await tx<Row[]>`
        INSERT INTO kyc_profile_drafts (user_id, tier, step, version, ciphertext, nonce)
        VALUES (${userId}, ${tier}, 1, 1, ${ciphertext}, ${nonce})
        ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, step = 1, version = kyc_profile_drafts.version + 1,
          ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_id = 'v1', last_save = NULL, record_id = NULL, updated_at = now()
        RETURNING tier, step, version, ciphertext, nonce, key_id, last_save, record_id, updated_at`;
      return this.view(fresh!, EMPTY);
    });
  }

  /**
   * Saves one step's fields and moves the draft on past it; going back to fix an earlier step keeps the later ones. `version` is the draft it was made from: a stale
   * one refuses `kyc.profile_version`, and the same save sent twice returns the draft it made.
   */
  async saveStep(
    userId: string,
    input: { step: KycProfileFieldStep; version: number; fields: Record<string, unknown> },
  ): Promise<KycProfileDraft> {
    this.requireKey();
    const parsed = kycProfileStepFieldsSchemas[input.step].safeParse(input.fields);
    if (!parsed.success)
      throw new KycProfileError(`The ${input.step} step is incomplete or malformed`, 'kyc.profile_invalid', {
        step: input.step,
        fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(Boolean),
      });
    const values = parsed.data as Partial<KycProfileFields>;
    return transaction(this.sql, async (tx) => {
      const row = await this.row(tx, userId, true);
      if (!row) throw new KycProfileError('Start guided verification first', 'kyc.profile_none');
      if (row.record_id) throw new KycProfileError('This draft was already sent', 'kyc.profile_sent');
      const hash = this.fingerprint(input.step, input.version, values);
      if (row.version === input.version + 1 && row.last_save === hash) return this.view(row, this.unseal(row));
      if (row.version !== input.version) throw new KycProfileError('The draft changed since this step was opened', 'kyc.profile_version');
      this.assertReached(row, input.step);
      const fields = { ...this.unseal(row), ...values };
      if (input.step === 'document') this.assertListed(fields.residence, fields.documentType);
      const { ciphertext, nonce } = this.seal(fields);
      const [saved] = await tx<Row[]>`
        UPDATE kyc_profile_drafts SET step = GREATEST(step, ${stepNumber(input.step) + 1}), version = version + 1, ciphertext = ${ciphertext},
          nonce = ${nonce}, key_id = 'v1', last_save = ${hash}, updated_at = now()
        WHERE user_id = ${userId} RETURNING tier, step, version, ciphertext, nonce, key_id, last_save, record_id, updated_at`;
      return this.view(saved!, fields);
    });
  }

  private assertListed(country: string | null, type: string | null): void {
    if (!country) throw new KycProfileError('Choose where you live first', 'kyc.profile_incomplete', { step: 'residence' });
    const types = this.settings.documentTypes?.get(country);
    if (!types) throw new KycProfileError(`No accepted ID list is published for ${country}`, 'kyc.document_types_unset', { country });
    if (!types.some((t) => t.type === type))
      throw new KycProfileError(`That ID type is not accepted for ${country}`, 'kyc.document_type_unlisted', { country });
  }

  /** Stores the ID photo in the vault, then the draft refers to it and moves on to review. */
  async upload(userId: string, input: { version: number; contentType: string; bytes: Buffer }): Promise<KycProfileDraft> {
    this.requireKey();
    const caps = this.settings.uploadCaps;
    if (!caps) throw new KycProfileError('No size and type limits are published for ID photos', 'kyc.upload_caps_unset');
    const contentType = input.contentType.trim().toLowerCase();
    if (!caps.contentTypes.includes(contentType))
      throw new KycProfileError('That file type is not accepted', 'kyc.upload_type', { contentTypes: caps.contentTypes });
    if (input.bytes.length === 0 || input.bytes.length > caps.maxBytes)
      throw new KycProfileError(`The file is over the ${caps.maxBytes}-byte limit`, 'kyc.upload_too_large', { maxBytes: caps.maxBytes });
    const vault = this.settings.vault;
    if (!vault) throw new KycProfileError('The document vault is not configured', 'kyc.profile_unconfigured');
    const hash = this.fingerprint('upload', input.version, { contentType, sha256: createHash('sha256').update(input.bytes).digest('hex') });
    const before = await this.row(this.sql, userId, false);
    if (!before) throw new KycProfileError('Start guided verification first', 'kyc.profile_none');
    if (before.record_id) throw new KycProfileError('This draft was already sent', 'kyc.profile_sent');
    if (before.version === input.version + 1 && before.last_save === hash) return this.view(before, this.unseal(before));
    if (before.version !== input.version) throw new KycProfileError('The draft changed since this step was opened', 'kyc.profile_version');
    this.assertReached(before, 'upload');
    // The vault first: a crash after this leaves an unreferenced ciphertext row, never a draft pointing at nothing.
    const stored = await vault.put({ userId, contentType, bytes: input.bytes, storedBy: userId });
    const owner = { kind: 'owner' as const, userId };
    let replaced: string | null = null;
    let saved: KycProfileDraft;
    try {
      saved = await transaction(this.sql, async (tx) => {
        const row = await this.row(tx, userId, true);
        if (!row || row.record_id || row.version !== input.version)
          throw new KycProfileError('The draft changed since this step was opened', 'kyc.profile_version');
        const previous = this.unseal(row);
        replaced = previous.documentId;
        const fields = { ...previous, documentId: stored.id };
        const { ciphertext, nonce } = this.seal(fields);
        const [next] = await tx<Row[]>`
          UPDATE kyc_profile_drafts SET step = ${stepNumber('review')}, version = version + 1, ciphertext = ${ciphertext},
            nonce = ${nonce}, key_id = 'v1', last_save = ${hash}, updated_at = now()
          WHERE user_id = ${userId} RETURNING tier, step, version, ciphertext, nonce, key_id, last_save, record_id, updated_at`;
        return this.view(next!, fields);
      });
    } catch (err) {
      // Lost the race (or the draft was sent meanwhile): the photo it stored refers to nothing, so it goes.
      await vault.deleteFor(stored.id, owner).catch(() => undefined);
      throw err;
    }
    // A replaced photo is no longer part of any draft or request.
    // A request that already carries it (a send that crashed before the draft recorded it) keeps it.
    if (replaced) {
      const [held] = await this.sql`SELECT 1 FROM kyc_records WHERE user_id = ${userId} AND provider_ref = ${replaced} LIMIT 1`;
      if (!held) await vault.deleteFor(replaced, owner).catch(() => undefined);
    }
    return saved;
  }

  /**
   * Sends the draft: every step complete, the ID type still listed for the country, the photo the person's own. The
   * request opens through `submitKyc` (its lockout and capability checks apply); sending again returns the same one.
   *
   * Three short steps, so no connection is held while `submitKyc` takes its own (a held one waiting for a second
   * deadlocks the pool under load): check and claim the draft (its version moves on, so an edit made from the version
   * the person sent refuses), open the request, then record it on the draft if the draft still says what was sent. A
   * crash between the last two leaves a pending request that carries this photo, which the next send finds as its own.
   */
  async submit(userId: string, version: number): Promise<{ recordId: string; documentCheck: 'not_connected' }> {
    this.requireKey();
    const vault = this.settings.vault;
    const claimed = await transaction(this.sql, async (tx) => {
      const row = await this.row(tx, userId, true);
      if (!row) throw new KycProfileError('Start guided verification first', 'kyc.profile_none');
      if (row.record_id) return { kind: 'sent', recordId: row.record_id } as const;
      if (row.version !== version) throw new KycProfileError('The draft changed since it was opened', 'kyc.profile_version');
      const fields = this.unseal(row);
      for (const step of Object.keys(kycProfileStepFieldsSchemas) as KycProfileFieldStep[]) {
        if (!kycProfileStepFieldsSchemas[step].safeParse(pick(fields, step)).success)
          throw new KycProfileError(`The ${step} step is not complete`, 'kyc.profile_incomplete', { step });
      }
      const documentId = fields.documentId;
      if (!documentId) throw new KycProfileError('Add a photo of your ID first', 'kyc.profile_incomplete', { step: 'upload' });
      this.assertListed(fields.residence, fields.documentType);
      // A request already open at this level, or a level already held, is not this draft's: sending would only return
      // it, without this photo. Only a pending request that carries this photo (a send that crashed after it) is ours.
      const [open] = await tx<Array<{ id: string; status: string; provider_ref: string | null }>>`
        SELECT id, status, provider_ref FROM kyc_records WHERE user_id = ${userId} AND (
          (status = 'pending' AND tier = ${row.tier}) OR (status = 'approved' AND (expires_at IS NULL OR expires_at > now())
            AND array_position(ARRAY['none','basic','full','institutional']::text[], tier::text) >= array_position(ARRAY['none','basic','full','institutional']::text[], ${row.tier}::text)))
        ORDER BY created_at DESC LIMIT 1`;
      if (open && !(open.status === 'pending' && open.provider_ref === documentId))
        throw new KycProfileError('A request at this level is already open or approved', 'kyc.profile_request_open', {
          status: open.status,
        });
      const [moved] = await tx<Array<{ version: number }>>`
        UPDATE kyc_profile_drafts SET version = version + 1, last_save = NULL, updated_at = now() WHERE user_id = ${userId} RETURNING version`;
      return { kind: 'claimed', tier: row.tier, residence: fields.residence!, documentId, version: moved!.version } as const;
    });
    if (claimed.kind === 'sent') return { recordId: claimed.recordId, documentCheck: 'not_connected' };
    if (!vault) throw new KycProfileError('The document vault is not configured', 'kyc.profile_unconfigured');
    await vault.assertDocumentForUser(claimed.documentId, userId);
    const record = await this.settings.submit({
      userId,
      tier: claimed.tier,
      jurisdiction: claimed.residence,
      providerRef: claimed.documentId,
    });
    if (record.status !== 'pending' || record.providerRef !== claimed.documentId)
      throw new KycProfileError('A request at this level is already open or approved', 'kyc.profile_request_open', {
        status: record.status,
      });
    return transaction(this.sql, async (tx) => {
      const row = await this.row(tx, userId, true);
      if (row?.record_id === record.id) return { recordId: record.id, documentCheck: 'not_connected' as const };
      const fields = row && !row.record_id ? this.tryUnseal(row) : null;
      // Changed in between (another tab saved from the claimed version): the request stands with what was sent, and the
      // draft keeps the newer entry; sending it finds that request open and says so.
      if (!row || row.version !== claimed.version || fields?.documentId !== claimed.documentId || fields.residence !== claimed.residence)
        throw new KycProfileError('The draft changed while it was being sent', 'kyc.profile_version');
      await tx`UPDATE kyc_profile_drafts SET record_id = ${record.id}, version = version + 1, updated_at = now() WHERE user_id = ${userId}`;
      return { recordId: record.id, documentCheck: 'not_connected' as const };
    });
  }
}

function pick(fields: KycProfileFields, step: KycProfileFieldStep): Record<string, unknown> {
  const keys = Object.keys(kycProfileStepFieldsSchemas[step].shape) as Array<keyof KycProfileFields>;
  return Object.fromEntries(keys.map((k) => [k, fields[k]]));
}
