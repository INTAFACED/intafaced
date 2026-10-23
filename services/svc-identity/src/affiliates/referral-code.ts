/**
 * Short referral codes (CM-referral-01; J-campaigns-05 #1). One per person, beside the share link token (the UUID link
 * stays). Random from an alphabet without look-alike characters (no 0, O, 1 or I); the length is the owner setting
 * `IDENTITY_REFERRAL_CODE_LENGTH`, blank refuses with `referral.code_length_unset`. A collision draws a new random value;
 * a code is never reused or derived from the account. The code is an identifier, not a secret.
 */

import { randomInt } from 'node:crypto';
import type { Sql } from 'postgres';
import { ReferralError } from './referral-tree.js';

export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_MIN_LENGTH = 4;
export const REFERRAL_CODE_MAX_LENGTH = 16;
/** Fresh draws before a create gives up; at the published lengths a second draw is already rare. */
const DRAWS = 8;

export type ReferralCode = { readonly userId: string; readonly code: string; readonly createdAt: Date };

/** The owner setting, parsed. Blank stays undefined (refuses at use); a malformed value stops the service at start. */
export function parseReferralCodeLength(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const length = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(length >= REFERRAL_CODE_MIN_LENGTH && length <= REFERRAL_CODE_MAX_LENGTH)) {
    throw new Error(`IDENTITY_REFERRAL_CODE_LENGTH must be a whole number from ${REFERRAL_CODE_MIN_LENGTH} to ${REFERRAL_CODE_MAX_LENGTH}`);
  }
  return length;
}

export function drawReferralCode(length: number, pick: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < length; i++) code += REFERRAL_CODE_ALPHABET[pick(REFERRAL_CODE_ALPHABET.length)];
  return code;
}

type CodeRow = { user_id: string; code: string; created_at: Date };
const toCode = (row: CodeRow): ReferralCode => ({ userId: row.user_id, code: row.code, createdAt: row.created_at });

export class ReferralCodeService {
  constructor(
    private readonly sql: Sql,
    private readonly length: number | undefined,
    private readonly draw: (length: number) => string = drawReferralCode,
  ) {}

  async codeOf(userId: string): Promise<ReferralCode | null> {
    const rows = await this.sql<CodeRow[]>`SELECT user_id, code, created_at FROM referral_codes WHERE user_id = ${userId}`;
    return rows[0] ? toCode(rows[0]) : null;
  }

  /** The person's code, made on the first call. Repeats return the same code. */
  async createCode(userId: string): Promise<ReferralCode> {
    const existing = await this.codeOf(userId);
    if (existing) return existing;
    if (this.length === undefined) {
      throw new ReferralError(
        'The referral code length is not set by the owner [referral.code_length_unset]',
        'referral.code_length_unset',
      );
    }
    for (let draw = 0; draw < DRAWS; draw++) {
      const rows = await this.sql<CodeRow[]>`
        INSERT INTO referral_codes (user_id, code)
        VALUES (${userId}, ${this.draw(this.length)})
        ON CONFLICT DO NOTHING
        RETURNING user_id, code, created_at
      `;
      if (rows[0]) return toCode(rows[0]);
      // Either this person got a code meanwhile (return it) or the drawn code is taken (draw again).
      const raced = await this.codeOf(userId);
      if (raced) return raced;
    }
    throw new Error('referral code draws kept colliding');
  }
}
