/**
 * Selfie (I-kyc-compliance-09, J-identity-08 #3). The person takes a live selfie on this device, or on their phone
 * through a one-time hand-off link. The automatic face match and liveness check (`vendor.kyc`) are not connected, so
 * every selfie is kept for a person in our own queue to compare with the ID photo: it stays `provided` until then.
 * The frame goes to the vault first, under the owner's photo caps (I-kyc-compliance-08), and the row then refers to it.
 *
 * A hand-off link lasts the owner's `IDENTITY_KYC_HANDOFF_TTL_SECONDS` (NO DEFAULT: unset refuses `kyc.handoff_unset`),
 * is stored only as the SHA-256 of its token, works once (a second use refuses `kyc.handoff_used`) and only for the
 * account that made it (any other reads as unknown, so a token says nothing about whose it is). Times come from the
 * database clock. `IDENTITY_KYC_LIVENESS_RECHECK_FOR` names the actions that ask for a liveness re-check; unset is none.
 * Nothing here is logged.
 *
 * What the server cannot know: the page takes the frame from the live camera, but nothing here proves it was live, so
 * the compliance view says `captureCheck: 'not_checked'` and the reviewer treats `via` as what the device reported.
 * Kept bounded without an invented limit: a retake replaces a selfie nobody has decided yet (row and frame), and a new
 * phone link replaces the account's unused ones. A person decides a selfie once (`decide`, four-eyes at the door).
 */
import type { Sql } from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type {
  KycSelfie,
  KycSelfieDecision,
  KycSelfieForCompliance,
  KycSelfieHandoff,
  KycSelfieHandoffCheck,
  KycSelfieRead,
} from '@intafaced/contracts/identity-kyc-selfie';
import type { KycProfileUploadCaps } from '@intafaced/contracts/identity-kyc-profile';
import type { KycDocumentVault } from './document-store.js';
import { assertWithinUploadCaps } from './profile.js';

export type KycSelfieErrorCode =
  | 'kyc.selfie_type'
  | 'kyc.handoff_unset'
  | 'kyc.handoff_unknown'
  | 'kyc.handoff_used'
  | 'kyc.handoff_expired'
  | 'kyc.selfie_unconfigured'
  | 'kyc.selfie_unknown'
  | 'kyc.selfie_decided';

export class KycSelfieError extends Error {
  constructor(
    message: string,
    readonly code: KycSelfieErrorCode,
  ) {
    super(message);
    this.name = 'KycSelfieError';
  }
}

const ACTION = /^[a-z][a-z0-9_.]{1,63}$/;

/** The owner's hand-off link life in whole seconds. Unset is no hand-off (it refuses); malformed stops the service. */
export function parseKycHandoffTtlSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 60 || value > 3600)
    throw new Error('IDENTITY_KYC_HANDOFF_TTL_SECONDS must be a whole number of seconds from 60 to 3600');
  return value;
}

/** Comma-separated action names that ask for a liveness re-check. Unset is none; malformed stops the service. */
export function parseKycLivenessRecheckFor(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const names = raw.split(',').map((name) => name.trim());
  if (names.some((name) => !ACTION.test(name)) || new Set(names).size !== names.length)
    throw new Error('IDENTITY_KYC_LIVENESS_RECHECK_FOR must be distinct action names such as withdraw.crypto, comma-separated');
  return names;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

type Row = { id: string; via: 'this_device' | 'handoff'; status: 'provided' | 'accepted' | 'rejected'; created_at: Date };
type ComplianceRow = Row & { user_id: string; document_id: string; decided_at: Date | null };
type HandoffRow = { user_id: string; expires_at: Date; used_at: Date | null; open: boolean };

const toView = (row: Row): KycSelfie => ({ id: row.id, status: row.status, via: row.via, createdAt: row.created_at.toISOString() });
const toComplianceView = (row: ComplianceRow): KycSelfieForCompliance => ({
  ...toView(row),
  documentId: row.document_id,
  captureCheck: 'not_checked',
  decidedAt: row.decided_at?.toISOString() ?? null,
});

export class KycSelfieDesk {
  constructor(
    private readonly sql: Sql,
    private readonly settings: {
      readonly handoffTtlSeconds: number | null;
      readonly recheckFor: readonly string[] | null;
      readonly uploadCaps: KycProfileUploadCaps | null;
      readonly vault: KycDocumentVault | undefined;
    },
  ) {}

  async read(userId: string): Promise<KycSelfieRead> {
    const [latest] = await this.sql<Row[]>`
      SELECT id, via, status, created_at FROM kyc_selfies WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
    return {
      latest: latest ? toView(latest) : null,
      faceCheck: 'not_connected',
      liveness: { check: 'not_connected', recheckFor: this.settings.recheckFor ? [...this.settings.recheckFor] : null },
      handoffTtlSeconds: this.settings.handoffTtlSeconds,
      uploadCaps: this.settings.uploadCaps,
    };
  }

  /** A new one-time link for the person's phone. Only the token's hash is kept; the token is returned once. */
  async startHandoff(userId: string): Promise<KycSelfieHandoff> {
    const ttl = this.settings.handoffTtlSeconds;
    if (!ttl) throw new KycSelfieError('No hand-off link life is set, so a phone hand-off is refused', 'kyc.handoff_unset');
    const token = randomBytes(32).toString('base64url');
    return await transaction(this.sql, async (tx) => {
      // The newest link replaces the account's unused ones, and a used one whose selfie was replaced goes with them.
      await tx`DELETE FROM kyc_selfie_handoffs WHERE user_id = ${userId} AND (used_at IS NULL OR selfie_id IS NULL)`;
      const [row] = await tx<Array<{ expires_at: Date }>>`
        INSERT INTO kyc_selfie_handoffs (token_sha256, user_id, expires_at)
        VALUES (${tokenHash(token)}, ${userId}, now() + make_interval(secs => ${ttl}))
        RETURNING expires_at`;
      return { token, expiresAt: row!.expires_at.toISOString() };
    });
  }

  /** The link's state for the account that made it; any other account, or no such link, refuses as unknown. */
  async checkHandoff(userId: string, token: string): Promise<KycSelfieHandoffCheck> {
    const row = await this.handoff(this.sql, userId, token, false);
    return { state: row.used_at ? 'used' : row.open ? 'open' : 'expired', expiresAt: row.expires_at.toISOString() };
  }

  private async handoff(sql: Sql, userId: string, token: string, lock: boolean): Promise<HandoffRow> {
    const [row] = await sql<HandoffRow[]>`
      SELECT user_id, expires_at, used_at, expires_at > now() AS open FROM kyc_selfie_handoffs
      WHERE token_sha256 = ${tokenHash(token)} AND user_id = ${userId} ${lock ? sql`FOR UPDATE` : sql``}`;
    if (!row) throw new KycSelfieError('That hand-off link is not known', 'kyc.handoff_unknown');
    return row;
  }

  private assertUsable(row: HandoffRow): void {
    if (row.used_at) throw new KycSelfieError('That hand-off link was already used', 'kyc.handoff_used');
    if (!row.open) throw new KycSelfieError('That hand-off link has expired', 'kyc.handoff_expired');
  }

  /**
   * Checks the frame and the link before anything is stored, then stores the frame in the vault, then (with the link
   * locked and checked again, so two sends of one link store one selfie) the row that refers to it. A selfie nobody has
   * decided yet is replaced: its row goes in the same transaction and its frame leaves the vault after commit.
   */
  async submit(userId: string, input: { contentType: string; bytes: Buffer; handoff?: string }): Promise<KycSelfie> {
    const contentType = assertWithinUploadCaps(this.settings.uploadCaps, input.contentType, input.bytes);
    if (!contentType.startsWith('image/')) throw new KycSelfieError('A selfie must be a photo', 'kyc.selfie_type');
    const vault = this.settings.vault;
    if (!vault) throw new KycSelfieError('The document vault is not configured', 'kyc.selfie_unconfigured');
    const handoff = input.handoff;
    if (handoff) this.assertUsable(await this.handoff(this.sql, userId, handoff, false));
    // The vault first: a crash after this leaves an unreferenced ciphertext row, never a selfie pointing at nothing.
    const stored = await vault.put({ userId, contentType, bytes: input.bytes, storedBy: userId });
    let replaced: string[] = [];
    let view: KycSelfie;
    try {
      view = await transaction(this.sql, async (tx) => {
        if (handoff) this.assertUsable(await this.handoff(tx, userId, handoff, true));
        const gone = await tx<Array<{ document_id: string }>>`
          DELETE FROM kyc_selfies WHERE user_id = ${userId} AND status = 'provided' RETURNING document_id`;
        replaced = gone.map((r) => r.document_id);
        const [row] = await tx<Row[]>`
          INSERT INTO kyc_selfies (user_id, document_id, via)
          VALUES (${userId}, ${stored.id}, ${handoff ? 'handoff' : 'this_device'})
          RETURNING id, via, status, created_at`;
        if (handoff)
          await tx`UPDATE kyc_selfie_handoffs SET used_at = now(), selfie_id = ${row!.id} WHERE token_sha256 = ${tokenHash(handoff)}`;
        return toView(row!);
      });
    } catch (err) {
      await vault.deleteFor(stored.id, { kind: 'owner', userId }).catch(() => undefined);
      throw err;
    }
    // After commit: a crash here leaves an unreferenced ciphertext row, never a selfie pointing at nothing.
    for (const id of replaced) await vault.deleteFor(id, { kind: 'owner', userId }).catch(() => undefined);
    return view;
  }

  /** Compliance: one person's selfies, newest first, each with the vault id of its frame for the manual comparison. */
  async listFor(userId: string, limit: number): Promise<KycSelfieForCompliance[]> {
    const rows = await this.sql<ComplianceRow[]>`
      SELECT id, user_id, document_id, via, status, created_at, decided_at FROM kyc_selfies
      WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(toComplianceView);
  }

  /**
   * The checks `decide` makes, run at the door before the approval is spent: the selfie exists and is not already
   * decided the other way. Returns whose selfie it is, so the door can refuse a reviewer's own.
   */
  async assertDecidable(selfieId: string, decision: KycSelfieDecision): Promise<string> {
    const [row] = await this.sql<Array<{ user_id: string; status: Row['status'] }>>`
      SELECT user_id, status FROM kyc_selfies WHERE id = ${selfieId}`;
    if (!row) throw new KycSelfieError('That selfie is not known', 'kyc.selfie_unknown');
    if (row.status !== 'provided' && row.status !== decision)
      throw new KycSelfieError('That selfie was already decided', 'kyc.selfie_decided');
    return row.user_id;
  }

  /**
   * A person's decision after comparing the selfie with the ID photo. Once only: the same decision again returns the
   * stored one, the other refuses `kyc.selfie_decided`. A replaced selfie is gone and refuses `kyc.selfie_unknown`.
   */
  async decide(input: { selfieId: string; decision: KycSelfieDecision; reviewerId: string }): Promise<KycSelfieForCompliance> {
    return await transaction(this.sql, async (tx) => {
      const [row] = await tx<ComplianceRow[]>`
        SELECT id, user_id, document_id, via, status, created_at, decided_at FROM kyc_selfies WHERE id = ${input.selfieId} FOR UPDATE`;
      if (!row) throw new KycSelfieError('That selfie is not known', 'kyc.selfie_unknown');
      if (row.status === input.decision) return toComplianceView(row);
      if (row.status !== 'provided') throw new KycSelfieError('That selfie was already decided', 'kyc.selfie_decided');
      const [updated] = await tx<ComplianceRow[]>`
        UPDATE kyc_selfies SET status = ${input.decision}, decided_by = ${input.reviewerId}, decided_at = now()
        WHERE id = ${input.selfieId}
        RETURNING id, user_id, document_id, via, status, created_at, decided_at`;
      return toComplianceView(updated!);
    });
  }
}
