/**
 * Change or remove the signed-in user's phone.
 *
 * The number is E.164 and is stored only after the code is confirmed. It is
 * not a sign-in factor, a recovery channel, or a step-up factor: no auth path
 * reads `user_phones`.
 *
 * `PhoneCodeSender` is the port. No provider is installed, so `begin` refuses
 * `auth.change_unwired` and writes nothing until an owner wires one.
 */
import {
  assertLiveSession,
  consumeStepUp,
  deliver,
  insertProof,
  invalidCode,
  markNotice,
  normaliseContactPhone,
  postgresCode,
  requirePublishedBudget,
  takeMatchingProof,
  transaction,
  writeAudit,
  type ContactDeps,
  type PhoneSenderPort,
} from './contact-common.js';
import { ContactError } from './contact-common.js';

const CHANGE_SCOPE = 'identity.step_up.phone_change';
const REMOVE_SCOPE = 'identity.step_up.phone_remove';

export type PhoneCodeSender = PhoneSenderPort;

export class PhoneChange {
  constructor(private readonly deps: ContactDeps) {}

  async begin(input: { userId: string; sessionId: string; newPhone: string; stepUpApprovalId: string }): Promise<{ accepted: true }> {
    const phone = normaliseContactPhone(input.newPhone);
    if (!phone) throw new ContactError('identity.phone_invalid');
    const budget = requirePublishedBudget(this.deps);
    const sender = this.deps.phone;
    if (!sender) {
      this.deps.log.warn({ reason: 'phone' }, 'auth.change_unwired');
      throw new ContactError('auth.change_unwired', 'Changing this contact is not available yet. No phone code sender is installed.');
    }
    await consumeStepUp(this.deps, {
      userId: input.userId,
      sessionId: input.sessionId,
      scope: CHANGE_SCOPE,
      field: 'newPhone',
      value: phone,
      stepUpApprovalId: input.stepUpApprovalId,
    });
    const proof = await insertProof(this.deps, {
      userId: input.userId,
      sessionId: input.sessionId,
      channel: 'phone',
      target: phone,
      ttlSeconds: budget.ttlSeconds,
    });
    try {
      await sender.send({ phone, code: proof.code, expiresAt: proof.expiresAt, purpose: 'phone-change' });
    } catch {
      this.deps.log.warn({ userId: input.userId, reason: 'delivery' }, 'identity.contact_change_delivery_failed');
    }
    return { accepted: true };
  }

  async confirm(input: { userId: string; sessionId: string; code: string }): Promise<{ ok: true }> {
    const budget = requirePublishedBudget(this.deps);
    const proof = await takeMatchingProof(this.deps, {
      userId: input.userId,
      channel: 'phone',
      code: input.code,
      maxAttempts: budget.maxAttempts,
    });
    let oldPhone: string | null = null;
    let auditId = '';
    try {
      const swapped = await transaction(
        this.deps.sql,
        async (tx) => {
          await tx`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
          const open = await tx<Array<{ id: string }>>`
            SELECT id FROM contact_change_proofs
            WHERE id = ${proof.id} AND consumed_at IS NULL AND attempts < ${budget.maxAttempts}
            FOR UPDATE
          `;
          if (!open[0]) throw invalidCode();
          await assertLiveSession(tx, input.userId, input.sessionId);
          const current = await tx<Array<{ phone: string }>>`
            SELECT phone FROM user_phones WHERE user_id = ${input.userId}
          `;
          const now = this.deps.now();
          await tx`
            INSERT INTO user_phones (user_id, phone, verified_at)
            VALUES (${input.userId}, ${proof.target}, ${now})
            ON CONFLICT (user_id) DO UPDATE SET phone = ${proof.target}, verified_at = ${now}
          `;
          await tx`UPDATE contact_change_proofs SET consumed_at = ${now} WHERE id = ${proof.id}`;
          const id = await writeAudit(tx, {
            userId: input.userId,
            sessionId: input.sessionId,
            channel: 'phone',
            event: 'confirm',
            oldTarget: current[0]?.phone ?? null,
            newTarget: proof.target,
            oldNotice: current[0] ? 'unsent' : 'unsent',
          });
          return { oldPhone: current[0]?.phone ?? null, auditId: id };
        },
        { isolation: 'read committed', maxAttempts: 1 },
      );
      oldPhone = swapped.oldPhone;
      auditId = swapped.auditId;
    } catch (err) {
      if (postgresCode(err) === '23505') {
        await this.deps.sql`
          UPDATE contact_change_proofs SET attempts = attempts + 1
          WHERE id = ${proof.id} AND consumed_at IS NULL AND attempts < ${budget.maxAttempts}
        `;
        throw invalidCode();
      }
      throw err;
    }
    if (oldPhone && oldPhone !== proof.target) {
      const notice = await this.notice(input.userId, oldPhone);
      await markNotice(this.deps.sql, auditId, notice);
    }
    return { ok: true };
  }

  async remove(input: { userId: string; sessionId: string; stepUpApprovalId: string }): Promise<{ ok: true }> {
    const current = await this.deps.sql<Array<{ phone: string }>>`
      SELECT phone FROM user_phones WHERE user_id = ${input.userId}
    `;
    const phone = current[0]?.phone;
    if (!phone) throw new ContactError('identity.phone_missing');
    await consumeStepUp(this.deps, {
      userId: input.userId,
      sessionId: input.sessionId,
      scope: REMOVE_SCOPE,
      field: 'phone',
      value: phone,
      stepUpApprovalId: input.stepUpApprovalId,
    });
    const removed = await transaction(
      this.deps.sql,
      async (tx) => {
        const locked = await tx<Array<{ phone: string }>>`
          SELECT phone FROM user_phones WHERE user_id = ${input.userId} FOR UPDATE
        `;
        if (!locked[0] || locked[0].phone !== phone) throw new ContactError('identity.phone_missing');
        await assertLiveSession(tx, input.userId, input.sessionId);
        await tx`DELETE FROM user_phones WHERE user_id = ${input.userId} AND phone = ${phone}`;
        const id = await writeAudit(tx, {
          userId: input.userId,
          sessionId: input.sessionId,
          channel: 'phone',
          event: 'remove',
          oldTarget: phone,
          newTarget: null,
          oldNotice: 'unsent',
        });
        return id;
      },
      { isolation: 'read committed', maxAttempts: 1 },
    );
    const notice = await this.notice(input.userId, phone);
    await markNotice(this.deps.sql, removed, notice);
    return { ok: true };
  }

  private async notice(userId: string, phone: string): Promise<'sent' | 'failed' | 'unsent'> {
    const sender = this.deps.phone;
    if (!sender) return 'unsent';
    return deliver(this.deps, {
      userId,
      run: () => sender.send({ phone, code: '', expiresAt: this.deps.now(), purpose: 'phone-notice' }),
    });
  }
}
