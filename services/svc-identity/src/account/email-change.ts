/**
 * Change the signed-in user's email.
 *
 * `begin` consumes a same-person step-up bound to the normalised new address,
 * stores a SHA-256 proof, and mails the code to that address. A missing mail
 * port or a blank TTL stores nothing. The reply does not say whether the
 * address is already registered.
 *
 * `confirm` swaps `users.email` under a row lock. A unique violation answers
 * exactly like a wrong code. Other sessions are revoked. Open password-reset
 * proofs are consumed. The old address is told afterwards; a failed notice
 * does not undo the swap.
 *
 * `users.email` has a BEFORE UPDATE trigger that clears `email_verified_at`
 * whenever the address changes. The stamp is set again in a second statement
 * in the same transaction, which does not touch `email`, so the new address
 * stays verified. The password hash and the factors are not written.
 */
import { syncNavigatorSessionClosed } from '../agents/navigator-session-projection-sync.js';
import type { PasswordResetMail } from '../auth/password-reset.js';
import {
  assertLiveSession,
  consumeStepUp,
  deliver,
  insertProof,
  invalidCode,
  killPasswordResetProofs,
  MAIL_PORT_KEY,
  markNotice,
  normaliseContactEmail,
  postgresCode,
  requirePublishedBudget,
  revokeOtherSessions,
  takeMatchingProof,
  transaction,
  writeAudit,
  type ContactDeps,
} from './contact-common.js';
import { ContactError } from './contact-common.js';

const SCOPE = 'identity.step_up.email_change';
const FIELD = 'newEmail';

export class EmailChange {
  /** Runs after the new address is confirmed. A throw does not undo the change. */
  private onConfirmed: ((userId: string) => Promise<void>) | undefined;

  constructor(private readonly deps: ContactDeps) {}

  useOnConfirmed(hook: (userId: string) => Promise<void>): void {
    this.onConfirmed = hook;
  }

  async begin(input: { userId: string; sessionId: string; newEmail: string; stepUpApprovalId: string }): Promise<{ accepted: true }> {
    const email = normaliseContactEmail(input.newEmail);
    if (!email) throw new ContactError('identity.email_invalid');
    const budget = requirePublishedBudget(this.deps);
    const mail = this.deps.mail;
    if (!mail) {
      this.deps.log.warn({ reason: 'mail', key: MAIL_PORT_KEY }, 'auth.change_unwired');
      throw new ContactError('auth.change_unwired', `Changing this contact is not available yet. ${MAIL_PORT_KEY} is not set.`);
    }
    await consumeStepUp(this.deps, { ...input, scope: SCOPE, field: FIELD, value: email });
    const proof = await insertProof(this.deps, {
      userId: input.userId,
      sessionId: input.sessionId,
      channel: 'email',
      target: email,
      ttlSeconds: budget.ttlSeconds,
    });
    try {
      await mail.send({ email, code: proof.code, expiresAt: proof.expiresAt, purpose: 'email-change' });
    } catch {
      this.deps.log.warn({ userId: input.userId, reason: 'delivery' }, 'identity.contact_change_delivery_failed');
    }
    return { accepted: true };
  }

  async confirm(input: { userId: string; sessionId: string; code: string }): Promise<{ ok: true }> {
    const budget = requirePublishedBudget(this.deps);
    const proof = await takeMatchingProof(this.deps, {
      userId: input.userId,
      channel: 'email',
      code: input.code,
      maxAttempts: budget.maxAttempts,
    });
    let oldEmail = '';
    let revoked: string[] = [];
    let auditId = '';
    try {
      const swapped = await transaction(
        this.deps.sql,
        async (tx) => {
          const locked = await tx<Array<{ email: string; status: string }>>`
            SELECT email, status FROM users WHERE id = ${input.userId} FOR UPDATE
          `;
          const user = locked[0];
          if (!user || user.status !== 'active') throw invalidCode();
          const open = await tx<Array<{ id: string; attempts: number }>>`
            SELECT id, attempts FROM contact_change_proofs
            WHERE id = ${proof.id} AND consumed_at IS NULL AND attempts < ${budget.maxAttempts}
            FOR UPDATE
          `;
          if (!open[0]) throw invalidCode();
          await assertLiveSession(tx, input.userId, input.sessionId);
          const now = this.deps.now();
          await tx`UPDATE users SET email = ${proof.target}, updated_at = now() WHERE id = ${input.userId}`;
          await tx`UPDATE users SET email_verified_at = ${now} WHERE id = ${input.userId}`;
          await tx`UPDATE contact_change_proofs SET consumed_at = ${now} WHERE id = ${proof.id}`;
          await killPasswordResetProofs(tx, input.userId, now);
          const others = await revokeOtherSessions(tx, input.userId, input.sessionId);
          const id = await writeAudit(tx, {
            userId: input.userId,
            sessionId: input.sessionId,
            channel: 'email',
            event: 'confirm',
            oldTarget: user.email,
            newTarget: proof.target,
            oldNotice: 'unsent',
          });
          return { oldEmail: user.email, revoked: others, auditId: id };
        },
        { isolation: 'read committed', maxAttempts: 1 },
      );
      oldEmail = swapped.oldEmail;
      revoked = swapped.revoked;
      auditId = swapped.auditId;
    } catch (err) {
      if (postgresCode(err) === '23505') {
        await this.bump(proof.id, budget.maxAttempts);
        throw invalidCode();
      }
      throw err;
    }
    for (const id of revoked) await syncNavigatorSessionClosed(this.deps.sql, id);
    if (this.onConfirmed) {
      try {
        await this.onConfirmed(input.userId);
      } catch (err) {
        this.deps.log.warn(
          { userId: input.userId, reason: err instanceof Error ? err.name : 'error' },
          'merchant email invite claim failed',
        );
      }
    }
    const notice = await this.notice(input.userId, oldEmail);
    await markNotice(this.deps.sql, auditId, notice);
    return { ok: true };
  }

  private async bump(proofId: string, maxAttempts: number): Promise<void> {
    await this.deps.sql`
      UPDATE contact_change_proofs SET attempts = attempts + 1
      WHERE id = ${proofId} AND consumed_at IS NULL AND attempts < ${maxAttempts}
    `;
  }

  private async notice(userId: string, oldEmail: string): Promise<'sent' | 'failed' | 'unsent'> {
    const mail: PasswordResetMail | undefined = this.deps.mail;
    if (!mail) return 'unsent';
    const expiresAt = this.deps.now();
    return deliver(this.deps, {
      userId,
      run: () => mail.send({ email: oldEmail, userId, code: '', expiresAt, purpose: 'email-change-notice' }),
    });
  }
}

/** The notice must not carry a login code. Empty `code` is not a proof. */
export type EmailMail = PasswordResetMail;
