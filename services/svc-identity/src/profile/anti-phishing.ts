/**
 * Anti-phishing code (I-signin-sessions-25). A word the account owner picks so a real security message can be told
 * from a fake one: identity's mails to the account's own address carry it (anti-phishing-mail.ts), a phishing mail cannot.
 *
 * - 4 to 20 letters and digits. Refused when it equals the handle, the email or the password (case-insensitive for
 *   the first two): a code anyone who knows the account could guess is no proof.
 * - Stored encrypted (AES-256-GCM), never hashed, because it is shown back to its owner. The key is derived from
 *   IDENTITY_TOTP_SECRET_KEY with HKDF under its own label, so no new secret is needed and the two uses never share a
 *   key. No key: setting refuses `identity.anti_phishing_key_unset`; clearing still works.
 * - Set or cleared only with a single-use step-up (`identity.step_up.anti_phishing_set`) bound to the exact code and
 *   request id, by the signed-in owner on a live session. An API key or a sub-account is refused.
 * - Read only by its owner on a live session, in its own answer with nothing else sensitive beside it.
 * - Every change writes an audit row naming the action and the session, never the code.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  ANTI_PHISHING_CODE_PATTERN,
  ANTI_PHISHING_STEP_UP_SCOPE,
  customerStepUpPayloadHash,
  type AntiPhishingCodeView,
  type AntiPhishingSetResult,
} from '@intafaced/contracts';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import { verifyPassword } from '../auth/passwords.js';
import { userCopy } from '../user-copy.js';

// A fresh uuid per save: it is hashed with the code, so a guessable one would let a reader of the stored hash test codes.
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_LABEL = 'intafaced/identity/anti-phishing/v1';
const NONCE_LEN = 12;
const TAG_LEN = 16;

export type AntiPhishingCode =
  | 'identity.anti_phishing_delegated'
  | 'identity.anti_phishing_invalid'
  | 'identity.anti_phishing_guessable'
  | 'identity.anti_phishing_key_unset'
  | 'identity.anti_phishing_unavailable'
  | 'identity.anti_phishing_unreadable'
  | 'identity.session_not_live'
  | 'identity.client_request_id_invalid'
  | 'auth.not_found'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target';

export class AntiPhishingError extends Error {
  constructor(readonly code: AntiPhishingCode) {
    super(userCopy(code));
    this.name = 'AntiPhishingError';
  }
}

/** The anti-phishing key, derived from the TOTP secret key. Null when that key is unset: nothing is improvised. */
export function antiPhishingKey(totpKey: Buffer | null): Buffer | null {
  if (!totpKey || totpKey.length !== 32) return null;
  return Buffer.from(hkdfSync('sha256', totpKey, Buffer.alloc(0), KEY_LABEL, 32));
}

export function sealCode(key: Buffer, code: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const sealed = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([sealed, cipher.getAuthTag()]), nonce };
}

export function openCode(key: Buffer, ciphertext: Buffer, nonce: Buffer): string {
  if (ciphertext.length < TAG_LEN || nonce.length !== NONCE_LEN) throw new Error('anti-phishing ciphertext malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LEN));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LEN)), decipher.final()]).toString('utf8');
}

/** The stored code, or null when there is no key or this key cannot open it (it was sealed under another key). */
export function openStoredCode(key: Buffer | null, row: { ciphertext: Buffer; nonce: Buffer }): string | null {
  if (!key) return null;
  try {
    return openCode(key, row.ciphertext, row.nonce);
  } catch {
    return null;
  }
}

export type AntiPhishingDeps = {
  readonly sql: Sql;
  readonly approvals: { consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown> };
  readonly key: Buffer | null;
};

type Actor = { readonly userId: string; readonly sessionId: string; readonly apiKey: boolean; readonly subAccount: boolean };

export class AntiPhishingService {
  constructor(private readonly deps: AntiPhishingDeps) {}

  /** The owner's code, or null when none is set. A live session of the owner only. */
  async read(actor: Actor): Promise<AntiPhishingCodeView> {
    if (actor.apiKey || actor.subAccount) throw new AntiPhishingError('identity.anti_phishing_delegated');
    await this.requireLive(this.deps.sql, actor);
    const rows = await this.deps.sql<Array<{ ciphertext: Buffer; nonce: Buffer; updated_at: Date }>>`
      SELECT ciphertext, nonce, updated_at FROM anti_phishing_codes WHERE user_id = ${actor.userId}
    `;
    const row = rows[0];
    if (!row) return { code: null, updatedAt: null };
    if (!this.deps.key) throw new AntiPhishingError('identity.anti_phishing_key_unset');
    const code = this.open(row);
    // Sealed under another key (it changed since): unreadable here. Setting a new code, or clearing, replaces it.
    if (code === null) throw new AntiPhishingError('identity.anti_phishing_unreadable');
    return { code, updatedAt: row.updated_at.toISOString() };
  }

  /**
   * Set the code, or clear it with ''. The account row is locked and the code's shape checked first; the same code again
   * (or a clear with none stored) answers `changed: false` and spends nothing. Otherwise the step-up is spent through the
   * approvals service, which commits on its own: a write that then fails leaves it spent, never a change without one. A
   * code equal to the handle, email or password is refused after the step-up is spent.
   */
  async set(
    input: Actor & { readonly code: string; readonly stepUpApprovalId: string; readonly clientRequestId: string },
  ): Promise<AntiPhishingSetResult> {
    if (input.apiKey || input.subAccount) throw new AntiPhishingError('identity.anti_phishing_delegated');
    if (!CLIENT_ID.test(input.clientRequestId)) throw new AntiPhishingError('identity.client_request_id_invalid');
    const clearing = input.code === '';
    if (!clearing && !ANTI_PHISHING_CODE_PATTERN.test(input.code)) throw new AntiPhishingError('identity.anti_phishing_invalid');
    const key = this.deps.key;
    if (!clearing && !key) throw new AntiPhishingError('identity.anti_phishing_key_unset');

    return transaction(this.deps.sql, async (tx) => {
      const users = await tx<Array<{ handle: string; email: string; password_hash: string }>>`
        SELECT handle::text AS handle, email::text AS email, password_hash FROM users WHERE id = ${input.userId} FOR UPDATE
      `;
      const user = users[0];
      if (!user) throw new AntiPhishingError('auth.not_found');
      await this.requireLive(tx, input);

      const stored = await tx<Array<{ ciphertext: Buffer; nonce: Buffer; updated_at: Date }>>`
        SELECT ciphertext, nonce, updated_at FROM anti_phishing_codes WHERE user_id = ${input.userId}
      `;
      // Clearing never reads the old code; a code sealed under another key compares as unknown and is replaced.
      const current = !clearing && stored[0] ? this.open(stored[0]) : null;
      if (clearing ? !stored[0] : current === input.code) {
        return { code: clearing ? null : input.code, updatedAt: stored[0]?.updated_at.toISOString() ?? null, changed: false };
      }
      // Spent before the password comparison, so the refusal below cannot be used to test password guesses without a
      // fresh factor for each one.
      await this.consume(input);
      if (!clearing && (await guessable(input.code, user))) throw new AntiPhishingError('identity.anti_phishing_guessable');
      let updatedAt: string | null = null;
      if (clearing) {
        await tx`DELETE FROM anti_phishing_codes WHERE user_id = ${input.userId}`;
      } else {
        const sealed = sealCode(key!, input.code);
        const written = await tx<Array<{ updated_at: Date }>>`
          INSERT INTO anti_phishing_codes (user_id, ciphertext, nonce, updated_at)
          VALUES (${input.userId}, ${sealed.ciphertext}, ${sealed.nonce}, clock_timestamp())
          ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, updated_at = EXCLUDED.updated_at
          RETURNING updated_at
        `;
        updatedAt = written[0]!.updated_at.toISOString();
      }
      await tx`
        INSERT INTO anti_phishing_audit (user_id, session_id, action)
        VALUES (${input.userId}, ${input.sessionId}, ${clearing ? 'cleared' : 'set'})
      `;
      return { code: clearing ? null : input.code, updatedAt, changed: true };
    });
  }

  private open(row: { ciphertext: Buffer; nonce: Buffer }): string | null {
    return openStoredCode(this.deps.key, row);
  }

  /**
   * The session must still be live: its own row unrevoked and unexpired, the same rule the edge applies. A rotated,
   * signed-out or revoked session is refused, whatever its access token still says.
   */
  private async requireLive(q: Sql, actor: Actor): Promise<void> {
    const rows = await q<Array<{ live: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM sessions
        WHERE id::text = ${actor.sessionId} AND user_id = ${actor.userId} AND revoked = false AND expires_at > now()
      ) AS live
    `;
    if (!rows[0]?.live) throw new AntiPhishingError('identity.session_not_live');
  }

  private async consume(input: Actor & { readonly code: string; readonly stepUpApprovalId: string; readonly clientRequestId: string }) {
    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: input.stepUpApprovalId,
        operationId: input.stepUpApprovalId,
        payloadHash: customerStepUpPayloadHash(ANTI_PHISHING_STEP_UP_SCOPE, {
          actor: input.userId,
          code: input.code,
          clientRequestId: input.clientRequestId,
        }),
        targetService: 'svc-identity',
        targetId: ANTI_PHISHING_STEP_UP_SCOPE,
        expectedVersion: '1',
        principalUserId: input.userId,
        principalSessionId: input.sessionId,
      });
    } catch (err) {
      if (err instanceof ActionApprovalError) {
        const code =
          err.code === 'action_approval.expired'
            ? 'identity.step_up_expired'
            : err.code === 'action_approval.consumed'
              ? 'identity.step_up_used'
              : err.code === 'action_approval.not_requester'
                ? 'identity.step_up_not_yours'
                : err.code === 'action_approval.payload_mismatch' || err.code === 'action_approval.target_mismatch'
                  ? 'identity.step_up_target'
                  : 'identity.step_up_required';
        throw new AntiPhishingError(code);
      }
      throw err;
    }
  }
}

/**
 * True when the code is the handle, the email or the password. A code has no '@', so the email compares by the part
 * before it.
 */
async function guessable(code: string, user: { handle: string; email: string; password_hash: string }): Promise<boolean> {
  const lower = code.toLowerCase();
  if (lower === user.handle.toLowerCase() || lower === user.email.toLowerCase().split('@')[0]) return true;
  return verifyPassword(user.password_hash, code);
}
