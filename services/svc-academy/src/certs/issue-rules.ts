/**
 * AC-certificates-02 — how a published certificate is issued.
 *
 * One rule per certificate: `manual` (the learner claims it once every required item is recorded; a certificate with no
 * rule row does the same), `automatic` (issued when the last required item is recorded) or `delayed` (issued once the
 * owner's delay has passed after that; a delayed rule without a delay refuses `academy.cert_delay_unset`). Each change is
 * a new revision with a history row naming the operator and the reason. A delayed certificate waits as one pending row
 * per learner and certificate, written when the learner first stands complete, so a later read or an Undo never moves
 * its due time. Issuing is AcademyService's job: this module stores rules and pending rows and decides nothing about
 * completeness. No money moves here.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { AcademyCertIssueMode, AcademyCertIssueRule, AcademySetCertIssueRuleInput } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';

type Db = Sql | TransactionSql;

type RuleRow = { cert_id: string; mode: AcademyCertIssueMode; delay_minutes: number | null; revision: number; updated_at: Date };

const ruleOf = (row: RuleRow): AcademyCertIssueRule => ({
  certId: row.cert_id,
  mode: row.mode,
  delayMinutes: row.delay_minutes,
  revision: row.revision,
  updatedAt: row.updated_at,
});

/** Pure: the time a delayed certificate is issued, counted from when the learner first stood complete. */
export function issueDueAt(completeAt: Date, delayMinutes: number): Date {
  return new Date(completeAt.getTime() + delayMinutes * 60_000);
}

/** Pure: the stored shape of a rule request. Throws the typed refusal for a delayed rule with no delay. */
export function decideIssueRule(input: Pick<AcademySetCertIssueRuleInput, 'mode' | 'delayMinutes'>): {
  mode: AcademyCertIssueMode;
  delayMinutes: number | null;
} {
  if (input.mode === 'delayed') {
    if (input.delayMinutes === null) throw new AcademyError('academy.cert_delay_unset', 'academy.cert_delay_unset');
    return { mode: 'delayed', delayMinutes: input.delayMinutes };
  }
  if (input.delayMinutes !== null) throw new AcademyError('only a delayed rule has a delay', 'academy.cert_invalid');
  return { mode: input.mode, delayMinutes: null };
}

export class CertIssueRules {
  constructor(private readonly sql: Sql) {}

  /** The stored rule, or null when staff have set none (the learner claims the certificate). */
  async rule(certId: string, db: Db = this.sql): Promise<AcademyCertIssueRule | null> {
    const rows = await db<RuleRow[]>`
      SELECT cert_id, mode, delay_minutes, revision, updated_at FROM academy.cert_issue_rules WHERE cert_id = ${certId}
    `;
    return rows[0] ? ruleOf(rows[0]) : null;
  }

  /**
   * Sets one certificate's rule as a new revision, with its history row, in one transaction. A request that matches the
   * stored rule answers it unchanged, so a replay after a lost reply writes nothing. Pending rows keep their due times:
   * a rule change applies to learners who complete after it.
   */
  async setRule(
    input: AcademySetCertIssueRuleInput & { operatorId: string; now: Date; sweepRunning: boolean },
  ): Promise<AcademyCertIssueRule> {
    const decided = decideIssueRule(input);
    if (decided.mode === 'delayed' && !input.sweepRunning) {
      // A delayed certificate is issued by the sweep; with no sweep interval set, a learner who never comes back would wait forever.
      throw new AcademyError('academy.cert_sweep_unset', 'academy.cert_sweep_unset');
    }
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`cert-issue-rule:${input.certId}`}, 0))`;
      const current = await this.rule(input.certId, tx);
      if (current && current.mode === decided.mode && current.delayMinutes === decided.delayMinutes) return current;
      const revision = (current?.revision ?? 0) + 1;
      const rows = await tx<RuleRow[]>`
        INSERT INTO academy.cert_issue_rules (cert_id, mode, delay_minutes, revision, updated_by, updated_at)
        VALUES (${input.certId}, ${decided.mode}, ${decided.delayMinutes}, ${revision}, ${input.operatorId}, ${input.now})
        ON CONFLICT (cert_id) DO UPDATE SET
          mode = EXCLUDED.mode, delay_minutes = EXCLUDED.delay_minutes, revision = EXCLUDED.revision,
          updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
        RETURNING cert_id, mode, delay_minutes, revision, updated_at
      `;
      await tx`
        INSERT INTO academy.cert_issue_rule_events (cert_id, revision, mode, delay_minutes, actor, reason, at)
        VALUES (${input.certId}, ${revision}, ${decided.mode}, ${decided.delayMinutes}, ${input.operatorId}, ${input.reason.trim()}, ${input.now})
      `;
      return ruleOf(rows[0]!);
    });
  }

  /** The time the learner's delayed certificate is issued, or null when nothing waits. */
  async pending(userId: string, certId: string): Promise<Date | null> {
    const rows = await this.sql<Array<{ due_at: Date }>>`
      SELECT due_at FROM academy.cert_issue_pending WHERE user_id = ${userId} AND cert_id = ${certId}
    `;
    return rows[0]?.due_at ?? null;
  }

  /** Records the wait once; an existing row keeps its due time. Answers the stored due time. */
  async ensurePending(userId: string, certId: string, dueAt: Date, now: Date): Promise<Date> {
    await this.sql`
      INSERT INTO academy.cert_issue_pending (user_id, cert_id, due_at, created_at)
      VALUES (${userId}, ${certId}, ${dueAt}, ${now})
      ON CONFLICT (user_id, cert_id) DO NOTHING
    `;
    return (await this.pending(userId, certId)) ?? dueAt;
  }

  async dropPending(userId: string, certId: string): Promise<void> {
    await this.sql`DELETE FROM academy.cert_issue_pending WHERE user_id = ${userId} AND cert_id = ${certId}`;
  }

  /** Pending certificates due by `now`, oldest first, one batch of the sweep. */
  async due(now: Date, batch: number): Promise<Array<{ userId: string; certId: string }>> {
    const rows = await this.sql<Array<{ user_id: string; cert_id: string }>>`
      SELECT user_id, cert_id FROM academy.cert_issue_pending WHERE due_at <= ${now} ORDER BY due_at, user_id, cert_id LIMIT ${batch}
    `;
    return rows.map((row) => ({ userId: row.user_id, certId: row.cert_id }));
  }
}
