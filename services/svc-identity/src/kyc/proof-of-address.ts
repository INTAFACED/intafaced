/**
 * Proof of address (I-kyc-compliance-11, J-identity-08 #5). Asked for once level Basic or higher is approved. The owner
 * lists per country which documents count and which never do (`IDENTITY_KYC_POA_TYPES_BY_COUNTRY`) and how recent one
 * must be (`IDENTITY_KYC_POA_MAX_AGE_DAYS`); both NO DEFAULT: an unset rule refuses `kyc.poa_rule_unset`, a country
 * with no list reads "not published" and refuses `kyc.poa_types_unset`. The person enters the date issued, which the
 * reviewer checks; older than the rule refuses `kyc.poa_too_old`. The file goes to the vault first, under the owner's
 * photo caps (I-kyc-compliance-08), and the row then refers to it. A document from another country than the residence
 * on the approved level is stored with `country_mismatch` for the reviewer. Nothing here is logged.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { KycPoaRead, KycPoaSubmission } from '@intafaced/contracts/identity-kyc-poa';
import type { KycProfileUploadCaps } from '@intafaced/contracts/identity-kyc-profile';
import { createHash } from 'node:crypto';
import type { KycDocumentVault } from './document-store.js';
import { assertWithinUploadCaps } from './profile.js';

export type KycPoaErrorCode =
  | 'kyc.poa_not_requested'
  | 'kyc.poa_rule_unset'
  | 'kyc.poa_types_unset'
  | 'kyc.poa_type_unlisted'
  | 'kyc.poa_type_refused'
  | 'kyc.poa_too_old'
  | 'kyc.poa_date_invalid'
  | 'kyc.poa_unconfigured';

export class KycPoaError extends Error {
  constructor(
    message: string,
    readonly code: KycPoaErrorCode,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'KycPoaError';
  }
}

type Listed = { type: string; label: string };
export type KycPoaTypeList = ReadonlyMap<string, { accepted: readonly Listed[]; rejected: readonly Listed[] }>;

const TYPE_ROW = /^[a-z][a-z0-9_]{1,63}$/;
const DAY = 86_400_000;

/** The owner's recency rule in whole days. Unset is no rule (submissions refuse); malformed stops the service. */
export function parseKycPoaMaxAgeDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1 || value > 3660)
    throw new Error('IDENTITY_KYC_POA_MAX_AGE_DAYS must be a whole number of days from 1 to 3660');
  return value;
}

/** `{"<country>": {"accepted": [{"type","label"}], "rejected": [...]}}`. Unset is none published; malformed stops the service. */
export function parseKycPoaTypes(raw: string | undefined): KycPoaTypeList | null {
  if (raw === undefined || raw.trim() === '') return null;
  const setting = 'IDENTITY_KYC_POA_TYPES_BY_COUNTRY';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${setting} must be JSON: {"<country>": {"accepted": [...], "rejected": [...]}}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${setting} must be a JSON object`);
  const rows = (country: string, list: unknown, which: string, seen: Set<string>): Listed[] => {
    if (!Array.isArray(list)) throw new Error(`${setting}: ${country}.${which} must be a list`);
    return list.map((row: unknown) => {
      const r = row as { type?: unknown; label?: unknown };
      if (typeof r.type !== 'string' || !TYPE_ROW.test(r.type) || seen.has(r.type))
        throw new Error(`${setting}: ${country} has a missing, malformed or repeated type`);
      if (typeof r.label !== 'string' || r.label.trim() === '' || r.label.length > 120)
        throw new Error(`${setting}: ${country} ${r.type} needs a label of 1 to 120 characters`);
      seen.add(r.type);
      return { type: r.type, label: r.label };
    });
  };
  const out = new Map<string, { accepted: Listed[]; rejected: Listed[] }>();
  for (const [country, value] of Object.entries(parsed)) {
    if (!/^[A-Z]{2}$/.test(country)) throw new Error(`${setting}: ${country} is not a two-letter country code`);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${setting}: ${country} must be {"accepted": [...], "rejected": [...]}`);
    const v = value as { accepted?: unknown; rejected?: unknown };
    const seen = new Set<string>();
    const accepted = rows(country, v.accepted, 'accepted', seen);
    if (accepted.length === 0) throw new Error(`${setting}: ${country} needs at least one accepted document`);
    out.set(country, { accepted, rejected: rows(country, v.rejected ?? [], 'rejected', seen) });
  }
  return out;
}

type Row = {
  id: string;
  type: string;
  country: string;
  issued_on: string;
  status: 'submitted' | 'accepted' | 'rejected';
  country_mismatch: boolean;
  created_at: Date;
};

const toView = (row: Row, label: string | null): KycPoaSubmission => ({
  id: row.id,
  type: row.type,
  label,
  country: row.country,
  issuedOn: row.issued_on,
  status: row.status,
  countryMismatch: row.country_mismatch,
  createdAt: row.created_at.toISOString(),
});

export class KycPoaDesk {
  constructor(
    private readonly sql: Sql,
    private readonly settings: {
      readonly maxAgeDays: number | null;
      readonly types: KycPoaTypeList | null;
      readonly uploadCaps: KycProfileUploadCaps | null;
      readonly vault: KycDocumentVault | undefined;
    },
  ) {}

  /** A submission with the owner's label for its type in its own country, or null when the list no longer has it. */
  private view(row: Row): KycPoaSubmission {
    const list = this.settings.types?.get(row.country);
    const found = list && [...list.accepted, ...list.rejected].find((r) => r.type === row.type);
    return toView(row, found ? found.label : null);
  }

  /** The country on the person's highest approved, unexpired level; null when none is approved. */
  private async residence(sql: Sql, userId: string): Promise<string | null> {
    const [row] = await sql<Array<{ jurisdiction: string }>>`
      SELECT jurisdiction FROM kyc_records WHERE user_id = ${userId} AND status = 'approved'
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY array_position(ARRAY['basic','full','institutional']::text[], tier::text) DESC, reviewed_at DESC NULLS LAST LIMIT 1`;
    return row?.jurisdiction ?? null;
  }

  private lists(country: string | null) {
    const list = country ? this.settings.types?.get(country) : undefined;
    return list
      ? { country, published: true, accepted: [...list.accepted], rejected: [...list.rejected] }
      : { country, published: false, accepted: [], rejected: [] };
  }

  async read(userId: string, country?: string): Promise<KycPoaRead> {
    const residence = await this.residence(this.sql, userId);
    const [latest] = await this.sql<Row[]>`
      SELECT id, type, country, issued_on::text AS issued_on, status, country_mismatch, created_at
      FROM kyc_poa_submissions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
    return {
      requested: residence !== null,
      residence,
      maxAgeDays: this.settings.maxAgeDays,
      documents: this.lists(country ?? residence),
      latest: latest ? this.view(latest) : null,
      uploadCaps: this.settings.uploadCaps,
    };
  }

  /** Checks everything before the file is stored, then stores it in the vault, then the row that refers to it. */
  async submit(
    userId: string,
    input: { type: string; country: string; issuedOn: string; contentType: string; bytes: Buffer },
    now = new Date(),
  ): Promise<KycPoaSubmission> {
    const residence = await this.residence(this.sql, userId);
    if (!residence) throw new KycPoaError('Proof of address is asked for after level Basic is approved', 'kyc.poa_not_requested');
    const maxAgeDays = this.settings.maxAgeDays;
    if (!maxAgeDays) throw new KycPoaError('No recency rule is published for proof of address', 'kyc.poa_rule_unset');
    const list = this.settings.types?.get(input.country);
    if (!list)
      throw new KycPoaError(`No proof-of-address list is published for ${input.country}`, 'kyc.poa_types_unset', {
        country: input.country,
      });
    if (list.rejected.some((r) => r.type === input.type))
      throw new KycPoaError('That kind of document is not accepted as proof of address', 'kyc.poa_type_refused', { type: input.type });
    if (!list.accepted.some((r) => r.type === input.type))
      throw new KycPoaError(`That document is not listed for ${input.country}`, 'kyc.poa_type_unlisted', { country: input.country });
    const issued = new Date(`${input.issuedOn}T00:00:00Z`);
    // Today on the person's own calendar may already be tomorrow in UTC (up to UTC+14), so that much is allowed.
    if (
      Number.isNaN(issued.getTime()) ||
      issued.toISOString().slice(0, 10) !== input.issuedOn ||
      issued.getTime() > now.getTime() + 14 * 3_600_000
    )
      throw new KycPoaError('The date issued is not a real date in the past', 'kyc.poa_date_invalid');
    const ageDays = Math.max(0, Math.floor((now.getTime() - issued.getTime()) / DAY));
    if (ageDays > maxAgeDays) throw new KycPoaError(`The document is older than ${maxAgeDays} days`, 'kyc.poa_too_old', { maxAgeDays });
    const contentType = assertWithinUploadCaps(this.settings.uploadCaps, input.contentType, input.bytes);
    const vault = this.settings.vault;
    if (!vault) throw new KycPoaError('The document vault is not configured', 'kyc.poa_unconfigured');
    // The same document sent again (a retry, a second click) returns the pending submission it made.
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const [same] = await this.sql<Row[]>`
      SELECT id, type, country, issued_on::text AS issued_on, status, country_mismatch, created_at FROM kyc_poa_submissions
      WHERE user_id = ${userId} AND status = 'submitted' AND type = ${input.type} AND country = ${input.country}
        AND issued_on = ${input.issuedOn}::date AND file_sha256 = ${sha256}
      ORDER BY created_at DESC LIMIT 1`;
    if (same) return this.view(same);
    // The vault first: a crash after this leaves an unreferenced ciphertext row, never a submission pointing at nothing.
    const stored = await vault.put({ userId, contentType, bytes: input.bytes, storedBy: userId });
    try {
      return await transaction(this.sql, async (tx) => {
        const [row] = await tx<Row[]>`
          INSERT INTO kyc_poa_submissions (user_id, document_id, type, country, issued_on, country_mismatch, file_sha256)
          VALUES (${userId}, ${stored.id}, ${input.type}, ${input.country}, ${input.issuedOn}::date, ${input.country !== residence}, ${sha256})
          RETURNING id, type, country, issued_on::text AS issued_on, status, country_mismatch, created_at`;
        return this.view(row!);
      });
    } catch (err) {
      await vault.deleteFor(stored.id, { kind: 'owner', userId }).catch(() => undefined);
      throw err;
    }
  }

  /** Compliance: one person's submissions, newest first, with the flag. */
  async listFor(userId: string, limit: number): Promise<KycPoaSubmission[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, type, country, issued_on::text AS issued_on, status, country_mismatch, created_at
      FROM kyc_poa_submissions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((row) => this.view(row));
  }
}
