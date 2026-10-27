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
 */
import type { Sql } from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { KycSelfie, KycSelfieHandoff, KycSelfieHandoffCheck, KycSelfieRead } from '@intafaced/contracts/identity-kyc-selfie';
import type { KycProfileUploadCaps } from '@intafaced/contracts/identity-kyc-profile';
import type { KycDocumentVault } from './document-store.js';
import { assertWithinUploadCaps } from './profile.js';

export type KycSelfieErrorCode =
  'kyc.selfie_type' | 'kyc.handoff_unset' | 'kyc.handoff_unknown' | 'kyc.handoff_used' | 'kyc.handoff_expired' | 'kyc.selfie_unconfigured';

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
type HandoffRow = { user_id: string; expires_at: Date; used_at: Date | null; open: boolean };

const toView = (row: Row): KycSelfie => ({ id: row.id, status: row.status, via: row.via, createdAt: row.created_at.toISOString() });

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
    const [row] = await this.sql<Array<{ expires_at: Date }>>`
      INSERT INTO kyc_selfie_handoffs (token_sha256, user_id, expires_at)
      VALUES (${tokenHash(token)}, ${userId}, now() + make_interval(secs => ${ttl}))
      RETURNING expires_at`;
    return { token, expiresAt: row!.expires_at.toISOString() };
  }

  /** The link's state for the account that made it; any other account, or no such link, refuses as unknown. */
  async checkHandoff(userId: string, token: string): Promise<KycSelfieHandoffCheck> {
    const row = await this.handoff(this.sql, userId, token, false);
    return { state: row.used_at ? 'used' : row.open ? 'open' : 'expired', expiresAt: row.expires_at.toISOString() };
  }

  private async handoff(sql: Sql, userId: string, token: string, lock: boolean): Promise<HandoffRow> {
    const [row] = lock
      ? await sql<HandoffRow[]>`
          SELECT user_id, expires_at, used_at, expires_at > now() AS open FROM kyc_selfie_handoffs
          WHERE token_sha256 = ${tokenHash(token)} AND user_id = ${userId} FOR UPDATE`
      : await sql<HandoffRow[]>`
          SELECT user_id, expires_at, used_at, expires_at > now() AS open FROM kyc_selfie_handoffs
          WHERE token_sha256 = ${tokenHash(token)} AND user_id = ${userId}`;
    if (!row) throw new KycSelfieError('That hand-off link is not known', 'kyc.handoff_unknown');
    return row;
  }

  private assertUsable(row: HandoffRow): void {
    if (row.used_at) throw new KycSelfieError('That hand-off link was already used', 'kyc.handoff_used');
    if (!row.open) throw new KycSelfieError('That hand-off link has expired', 'kyc.handoff_expired');
  }

  /**
   * Checks the frame and the link before anything is stored, then stores the frame in the vault, then (with the link
   * locked and checked again, so two sends of one link store one selfie) the row that refers to it.
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
    try {
      return await transaction(this.sql, async (tx) => {
        if (handoff) this.assertUsable(await this.handoff(tx, userId, handoff, true));
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
  }

  /** Compliance: one person's selfies, newest first, for the manual comparison queue. */
  async listFor(userId: string, limit: number): Promise<KycSelfie[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, via, status, created_at FROM kyc_selfies WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(toView);
  }
}
