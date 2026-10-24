import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  crmErasureAdvanceInputSchema,
  crmErasureBeginInputSchema,
  crmErasurePreviewInputSchema,
  crmErasurePreviewSchema,
  crmErasureStatusInputSchema,
  crmErasureStatusSchema,
  crmRetentionStatusSchema,
  crmRetentionReviewInputSchema,
  crmRetentionReviewStatusInputSchema,
  crmRetentionReviewSchema,
  guestNotificationEraseReceiptSchema,
} from '@intafaced/contracts';
import { z } from 'zod';
import { OutreachError, outreachConfigSchema } from './config.js';
import { OutreachNotificationError, type OutreachNotificationPort } from './notification-client.js';
import { createArchiveClient, prepareArchive, confirmArchive, type ArchivePublisher } from './archive-publication.js';
import { outreachInactivityDeadline } from './retention-calendar.js';

type ClusterSelection = {
  preview: z.infer<typeof crmErasurePreviewSchema>;
  contactIds: string[];
  submissionIds: string[];
  opportunityIds: string[];
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function privacyReadLock(tx: Sql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock_shared(hashtext('ops.crm.privacy'))`;
}
/** Acquire the gate BEFORE PostgreSQL establishes a repeatable-read snapshot. */
export async function withPrivacySnapshot<T>(sql: Sql, read: (tx: Sql) => Promise<T>): Promise<T> {
  const connection = await sql.reserve();
  let locked = false;
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock_shared(hashtext('ops.crm.privacy'))`;
    locked = true;
    await connection`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    transactionOpen = true;
    const result = await read(connection);
    await connection`COMMIT`;
    transactionOpen = false;
    return result;
  } finally {
    try {
      if (transactionOpen) await connection`ROLLBACK`;
    } finally {
      try {
        if (locked) await connection`SELECT pg_advisory_unlock_shared(hashtext('ops.crm.privacy'))`;
      } finally {
        connection.release();
      }
    }
  }
}
export async function assertContactWritable(tx: Sql, contactId: string): Promise<void> {
  const rows = await tx`SELECT status FROM ops.crm_erasure_intents WHERE ${contactId}::uuid=ANY(contact_ids) LIMIT 1`;
  if (rows[0]) throw new OutreachError(rows[0].status === 'complete' ? 'ops.crm.contact_erased' : 'ops.crm.erasure_pending');
}
export async function assertSubmissionWritable(tx: Sql, submissionId: string): Promise<void> {
  const rows = await tx`SELECT id FROM ops.crm_erasure_intents WHERE ${submissionId}::uuid=ANY(submission_ids) LIMIT 1`;
  if (rows.length) throw new OutreachError('ops.crm.continuation_invalid');
}
export async function assertRequestNotErased(tx: Sql, requestId: string, prospect = false): Promise<void> {
  const rows = await tx`SELECT request_id FROM ops.crm_erased_requests WHERE request_id=${requestId}`;
  if (rows.length) throw new OutreachError(prospect ? 'ops.crm.continuation_invalid' : 'ops.crm.request_erased');
}

/** Separate privacy authority and minimal restartable evidence; never email-based identity. */
export class OutreachPrivacy {
  constructor(
    private readonly sql: Sql | null,
    private readonly configuration: unknown,
    private readonly notify: OutreachNotificationPort,
    private readonly now: () => Date = () => new Date(),
    private readonly archivePublisher?: ArchivePublisher,
  ) {
    if (!archivePublisher && ['prod', 'staging'].includes(process.env.APP_ENV ?? ''))
      this.archivePublisher = createArchiveClient({
        environment: process.env.APP_ENV!,
        url: process.env.OPS_ERASURE_ARCHIVE_URL,
        secret: process.env.OPS_ERASURE_ARCHIVE_SECRET,
        fleetSecrets: [process.env.INTERNAL_SERVICE_SECRET, process.env.EDGE_PRINCIPAL_SECRET, process.env.OPS_NOTIFY_SERVICE_SECRET],
      });
  }
  private async controlled<T>(actor: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    if (!this.sql) throw new OutreachError('ops.crm.storage_unconfigured');
    const config = outreachConfigSchema.safeParse(this.configuration);
    if (!config.success) throw new OutreachError('ops.crm.configuration_unverified');
    if (actor === null) {
      if (!config.data.retention?.automationEnabled) throw new OutreachError('ops.crm.retention_unconfigured');
    } else {
      actor = z.string().guid().parse(actor).toLowerCase();
      if (!config.data.founders.includes(actor)) throw new OutreachError('ops.crm.operator_forbidden');
    }
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          // Rare, bounded privacy calls serialize with writes and worker claims before any row lock.
          await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.privacy'))`;
          return fn(tx);
        },
        { isolation: 'read committed', maxAttempts: 1 },
      );
    } catch (error) {
      if (error instanceof OutreachError || (error instanceof Error && error.name === 'ZodError')) throw error;
      throw new OutreachError('ops.crm.storage_unavailable');
    }
  }
  private async cluster(tx: Sql, canonicalContactId: string) {
    const aliases = await tx`SELECT contact_id FROM ops.crm_contact_aliases WHERE contact_id=${canonicalContactId}`;
    if (aliases.length) throw new OutreachError('ops.crm.canonical_target_required');
    const contacts = await tx`SELECT id,revision,md5(record::text) AS digest FROM ops.crm_contacts
      WHERE id=${canonicalContactId} OR id IN (SELECT contact_id FROM ops.crm_contact_aliases WHERE canonical_contact_id=${canonicalContactId}) ORDER BY id`;
    if (!contacts.length) throw new OutreachError('ops.crm.contact_not_found');
    if (contacts.length > 200) throw new OutreachError('ops.crm.erasure_too_large');
    const contactIds = contacts.map((r) => String(r.id));
    const submissions =
      await tx`SELECT id,revision,md5(record::text || original_contact::text || attribution::text) AS digest FROM ops.crm_submissions
      WHERE contact_id=ANY(${tx.array(contactIds)}::uuid[]) ORDER BY id`;
    if (submissions.length > 200) throw new OutreachError('ops.crm.erasure_too_large');
    const submissionIds = submissions.map((r) => String(r.id));
    const opportunities =
      await tx`SELECT id,revision,md5(record::text) AS digest FROM ops.crm_opportunities WHERE submission_id=ANY(${tx.array(submissionIds)}::uuid[]) ORDER BY id`;
    const opportunityIds = opportunities.map((r) => String(r.id));
    const tasks =
      await tx`SELECT id,revision,md5(record::text) AS digest FROM ops.crm_tasks WHERE opportunity_id=ANY(${tx.array(opportunityIds)}::uuid[]) ORDER BY id`;
    const history =
      await tx`SELECT id,md5(record::text) AS digest FROM ops.crm_activities WHERE opportunity_id=ANY(${tx.array(opportunityIds)}::uuid[]) ORDER BY id`;
    const messages =
      await tx`SELECT id,status,attempts,lease_token,md5(COALESCE(dispatch_payload::text,'')) AS digest FROM ops.crm_outbox WHERE submission_id=ANY(${tx.array(submissionIds)}::uuid[]) ORDER BY id`;
    const reviews = await tx`SELECT DISTINCT ON (canonical_contact_id) id,canonical_revision,revision,md5(record::text) AS digest
      FROM ops.crm_retention_reviews WHERE canonical_contact_id=ANY(${tx.array(contactIds)}::uuid[])
      ORDER BY canonical_contact_id,revision DESC`;
    const snapshot = digest([contacts, submissions, opportunities, tasks, history, messages, reviews]);
    const preview = crmErasurePreviewSchema.parse({
      canonicalContactId,
      canonicalRevision: contacts.find((r) => r.id === canonicalContactId)!.revision,
      contacts: contacts.map((r) => ({ contactId: r.id, revision: r.revision })),
      submissionIds,
      counts: {
        contacts: contacts.length,
        submissions: submissions.length,
        opportunities: opportunities.length,
        tasks: tasks.length,
        messages: messages.length,
      },
      snapshot,
    });
    return { preview, contactIds, submissionIds, opportunityIds };
  }
  async preview(raw: z.input<typeof crmErasurePreviewInputSchema>, actor: string) {
    const input = crmErasurePreviewInputSchema.parse(raw);
    return this.controlled(actor, async (tx) => {
      await assertContactWritable(tx, input.canonicalContactId);
      return (await this.cluster(tx, input.canonicalContactId)).preview;
    });
  }
  private async request(tx: Sql, input: { requestId: string }, actor: string, operation: string) {
    const rows = await tx`SELECT * FROM ops.crm_privacy_requests WHERE request_id=${input.requestId}`;
    const row = rows[0];
    if (!row) {
      if (
        (await tx`SELECT 1 FROM ops.crm_requests WHERE request_id=${input.requestId}`).length ||
        (await tx`SELECT 1 FROM ops.crm_erased_requests WHERE request_id=${input.requestId}`).length ||
        (await tx`SELECT 1 FROM ops.crm_erasure_intents WHERE request_id=${input.requestId}`).length
      )
        throw new OutreachError('ops.crm.idempotency_conflict');
      return null;
    }
    if (row.actor_user_id !== actor.toLowerCase() || row.operation !== operation || row.fingerprint !== digest(input))
      throw new OutreachError('ops.crm.idempotency_conflict');
    return String(row.intent_id);
  }
  private async remember(tx: Sql, input: { requestId: string }, actor: string, operation: string, intentId: string) {
    await tx`INSERT INTO ops.crm_privacy_requests(request_id,actor_user_id,operation,fingerprint,intent_id)
      VALUES (${input.requestId},${actor.toLowerCase()},${operation},${digest(input)},${intentId})`;
  }
  private async readStatus(tx: Sql, intentId: string) {
    const rows =
      await tx`SELECT e.*,(SELECT count(*)::int FROM ops.crm_erasure_notifications n WHERE n.intent_id=e.id AND n.receipt IS NULL) AS pending
      FROM ops.crm_erasure_intents e WHERE e.id=${intentId}`;
    const e = rows[0];
    if (!e) throw new OutreachError('ops.crm.erasure_not_found');
    return crmErasureStatusSchema.parse({
      intentId: e.id,
      canonicalContactId: e.canonical_contact_id,
      revision: e.revision,
      status: e.status,
      requestedBy: e.actor_user_id,
      actorKind: e.actor_kind,
      requestedAt: new Date(e.requested_at).toISOString(),
      completedAt: e.completed_at ? new Date(e.completed_at).toISOString() : null,
      pendingSubmissionCount: e.pending,
      code: e.error_code,
    });
  }
  async status(raw: z.input<typeof crmErasureStatusInputSchema>, actor: string) {
    const input = crmErasureStatusInputSchema.parse(raw);
    return this.controlled(actor, async (tx) => {
      if ('intentId' in input) return this.readStatus(tx, input.intentId);
      const [intent] = await tx`SELECT id FROM ops.crm_erasure_intents WHERE canonical_contact_id=${input.canonicalContactId}`;
      if (!intent) throw new OutreachError('ops.crm.erasure_not_found');
      return this.readStatus(tx, String(intent.id));
    });
  }
  private policy() {
    const config = outreachConfigSchema.safeParse(this.configuration);
    if (!config.success || !config.data.retention) throw new OutreachError('ops.crm.retention_unconfigured');
    return config.data.retention;
  }
  async retentionStatus(actor: string) {
    const config = outreachConfigSchema.safeParse(this.configuration);
    if (!config.success || !config.data.retention)
      return crmRetentionStatusSchema.parse({ status: 'disabled', reason: 'published_policy_unconfigured' });
    return this.controlled(actor, async (tx) => {
      const [scheduler] = await tx`SELECT last_sweep_at FROM ops.crm_retention_scheduler WHERE singleton`;
      return crmRetentionStatusSchema.parse({
        status: 'configured',
        inactivityCalendarMonths: 6,
        clockTimeZone: 'UTC',
        activeReviewMaxDays: 30,
        automationEnabled: config.data.retention!.automationEnabled,
        lastSweepAt: scheduler?.last_sweep_at ? new Date(scheduler.last_sweep_at).toISOString() : null,
      });
    });
  }
  private async latestReview(tx: Sql, canonicalContactId: string) {
    const [row] = await tx`SELECT canonical_revision,record FROM ops.crm_retention_reviews
      WHERE canonical_contact_id=${canonicalContactId} ORDER BY revision DESC LIMIT 1`;
    return row ? { canonicalRevision: row.canonical_revision, review: crmRetentionReviewSchema.parse(row.record) } : null;
  }
  async retentionReviewStatus(raw: z.input<typeof crmRetentionReviewStatusInputSchema>, actor: string) {
    const input = crmRetentionReviewStatusInputSchema.parse(raw);
    return this.controlled(actor, async (tx) => {
      await assertContactWritable(tx, input.canonicalContactId);
      await this.cluster(tx, input.canonicalContactId);
      return (await this.latestReview(tx, input.canonicalContactId))?.review ?? null;
    });
  }
  async retentionReview(raw: z.input<typeof crmRetentionReviewInputSchema>, actor: string) {
    const input = crmRetentionReviewInputSchema.parse(raw);
    actor = z.string().guid().parse(actor).toLowerCase();
    return this.controlled(actor, async (tx) => {
      this.policy();
      await assertRequestNotErased(tx, input.requestId);
      const [replay] = await tx`SELECT actor_key,operation,fingerprint,result FROM ops.crm_requests WHERE request_id=${input.requestId}`;
      if (replay) {
        if (replay.actor_key !== `operator:${actor}` || replay.operation !== 'retentionReview' || replay.fingerprint !== digest(input))
          throw new OutreachError('ops.crm.idempotency_conflict');
        return crmRetentionReviewSchema.parse(replay.result);
      }
      if (
        (
          await tx`SELECT 1 FROM ops.crm_privacy_requests WHERE request_id=${input.requestId}
        UNION ALL SELECT 1 FROM ops.crm_erasure_intents WHERE request_id=${input.requestId}`
        ).length
      )
        throw new OutreachError('ops.crm.idempotency_conflict');
      await assertContactWritable(tx, input.canonicalContactId);
      const selection = await this.cluster(tx, input.canonicalContactId);
      const latest = await this.latestReview(tx, input.canonicalContactId);
      if (
        selection.preview.canonicalRevision !== input.expectedCanonicalRevision ||
        (latest?.review.revision ?? 0) !== input.expectedReviewRevision
      )
        throw new OutreachError('ops.crm.revision_conflict');
      if (input.state === 'active') {
        const open = await tx`SELECT 1 FROM ops.crm_opportunities WHERE id=ANY(${tx.array(selection.opportunityIds)}::uuid[])
          AND stage<>'closed' LIMIT 1`;
        if (!open.length) throw new OutreachError('ops.crm.retention_active_closed');
      }
      const at = this.now();
      const result = crmRetentionReviewSchema.parse({
        reviewId: randomUUID(),
        canonicalContactId: input.canonicalContactId,
        revision: input.expectedReviewRevision + 1,
        state: input.state,
        reviewedBy: actor,
        reviewedAt: at.toISOString(),
        expiresAt: input.state === 'active' ? new Date(at.getTime() + 30 * 86400000).toISOString() : null,
        evidenceRef: input.evidenceRef,
        reason: input.reason,
      });
      await tx`INSERT INTO ops.crm_retention_reviews(id,canonical_contact_id,canonical_revision,revision,record)
        VALUES (${result.reviewId},${input.canonicalContactId},${input.expectedCanonicalRevision},${result.revision},${tx.json(result)})`;
      await tx`INSERT INTO ops.crm_requests(request_id,actor_key,operation,fingerprint,result)
        VALUES (${input.requestId},${`operator:${actor}`},'retentionReview',${digest(input)},${tx.json(result)})`;
      return result;
    });
  }
  private async retentionAge(tx: Sql, selection: ClusterSelection) {
    const [clock] = await tx`SELECT max(contact_at) AS meaningful_at FROM (
      SELECT (record->>'capturedAt')::timestamptz AS contact_at FROM ops.crm_submissions WHERE id=ANY(${tx.array(selection.submissionIds)}::uuid[])
      UNION ALL SELECT created_at FROM ops.crm_opportunities WHERE id=ANY(${tx.array(selection.opportunityIds)}::uuid[])
      UNION ALL SELECT (record->>'occurredAt')::timestamptz FROM ops.crm_activities
        WHERE opportunity_id=ANY(${tx.array(selection.opportunityIds)}::uuid[])
          AND record->>'kind'='questionnaire_submitted' AND record#>>'{actor,kind}'='prospect'
      UNION ALL SELECT occurred_at FROM ops.crm_interactions WHERE opportunity_id=ANY(${tx.array(selection.opportunityIds)}::uuid[])
        AND kind IN ('call_invited','call_booked','follow_up')
      ) contact_events`;
    const meaningfulAt = clock?.meaningful_at ? new Date(clock.meaningful_at) : new Date(NaN);
    const eligibleAt = outreachInactivityDeadline(meaningfulAt);
    if (meaningfulAt.getTime() > this.now().getTime()) throw new OutreachError('ops.crm.retention_clock_invalid');
    const latest = await this.latestReview(tx, selection.preview.canonicalContactId);
    const open = await tx`SELECT 1 FROM ops.crm_opportunities WHERE id=ANY(${tx.array(selection.opportunityIds)}::uuid[])
      AND stage<>'closed' LIMIT 1`;
    const active = Boolean(
      open.length &&
      latest?.canonicalRevision === selection.preview.canonicalRevision &&
      latest.review.state === 'active' &&
      latest.review.expiresAt !== null &&
      Date.parse(latest.review.expiresAt) > this.now().getTime(),
    );
    return { eligible: this.now().getTime() >= eligibleAt.getTime() && !active };
  }
  private async createIntent(tx: Sql, selection: ClusterSelection, actor: string | null, requestId: string, reason: string) {
    const intentId = randomUUID();
    const actorKind = actor === null ? 'system' : 'founder';
    await tx`INSERT INTO ops.crm_erasure_intents(id,canonical_contact_id,actor_user_id,actor_kind,request_id,reason,requested_at,contact_ids,submission_ids,opportunity_ids,snapshot)
      VALUES (${intentId},${selection.preview.canonicalContactId},${actor},${actorKind},${requestId},${reason},${this.now()},
      ${tx.array(selection.contactIds)}::uuid[],${tx.array(selection.submissionIds)}::uuid[],${tx.array(selection.opportunityIds)}::uuid[],${selection.preview.snapshot})`;
    for (const submissionId of selection.submissionIds)
      await tx`INSERT INTO ops.crm_erasure_notifications(intent_id,submission_id,request_id) VALUES (${intentId},${submissionId},${randomUUID()})`;
    return this.readStatus(tx, intentId);
  }
  async begin(raw: z.input<typeof crmErasureBeginInputSchema>, actor: string) {
    const input = crmErasureBeginInputSchema.parse(raw);
    return this.controlled(actor, async (tx) => {
      const replay = await this.request(tx, input, actor, 'begin');
      if (replay) return this.readStatus(tx, replay);
      if (input.reason === 'approved_retention_policy') this.policy();
      await assertContactWritable(tx, input.canonicalContactId);
      const selection = await this.cluster(tx, input.canonicalContactId);
      if (selection.preview.canonicalRevision !== input.expectedCanonicalRevision || selection.preview.snapshot !== input.snapshot)
        throw new OutreachError('ops.crm.revision_conflict');
      if (input.reason === 'approved_retention_policy') {
        if (!(await this.retentionAge(tx, selection)).eligible) throw new OutreachError('ops.crm.retention_not_due');
      }
      const status = await this.createIntent(tx, selection, actor.toLowerCase(), input.requestId, input.reason);
      await this.remember(tx, input, actor, 'begin', status.intentId);
      return status;
    });
  }
  async advance(raw: z.input<typeof crmErasureAdvanceInputSchema>, actor: string) {
    const input = crmErasureAdvanceInputSchema.parse(raw);
    await this.controlled(actor, async (tx) => {
      const replay = await this.request(tx, input, actor, 'advance');
      let status = await this.readStatus(tx, input.intentId);
      if (!replay && status.revision !== input.expectedRevision) throw new OutreachError('ops.crm.revision_conflict');
      if (!replay) await this.remember(tx, input, actor, 'advance', input.intentId);
      if (this.archivePublisher) await prepareArchive(tx, input.intentId);
    });
    return this.controlled(actor, (tx) => this.advanceIntent(tx, input.intentId));
  }
  private async advanceIntent(tx: Sql, intentId: string) {
    let status = await this.readStatus(tx, intentId);
    if (status.status === 'complete') return status;
    if (this.archivePublisher) await confirmArchive(tx, intentId, this.archivePublisher);
    let code: string | null = null;
    const lease = await tx`SELECT 1 FROM ops.crm_outbox o JOIN ops.crm_erasure_notifications n ON n.submission_id=o.submission_id
        WHERE n.intent_id=${intentId} AND o.lease_until>clock_timestamp() LIMIT 1`;
    if (lease.length) code = 'ops.crm.notification_in_flight';
    else if (!this.notify.configured) code = 'ops.crm.notification_unconfigured';
    else {
      const next =
        await tx`SELECT * FROM ops.crm_erasure_notifications WHERE intent_id=${intentId} AND receipt IS NULL ORDER BY submission_id LIMIT 1`;
      if (next[0]) {
        try {
          const receipt = guestNotificationEraseReceiptSchema.safeParse(
            await this.notify.eraseSubmission({ requestId: next[0].request_id, submissionId: next[0].submission_id }),
          );
          if (!receipt.success || receipt.data.requestId !== next[0].request_id || receipt.data.submissionId !== next[0].submission_id)
            code = 'ops.crm.notification_erasure_unknown';
          else
            await tx`UPDATE ops.crm_erasure_notifications SET receipt=${tx.json(receipt.data)} WHERE intent_id=${intentId} AND submission_id=${next[0].submission_id}`;
        } catch (error) {
          code =
            error instanceof OutreachNotificationError && error.code === 'guest.delivery_in_progress'
              ? 'ops.crm.notification_in_flight'
              : 'ops.crm.notification_erasure_unknown';
        }
      }
    }
    await tx`UPDATE ops.crm_erasure_intents SET error_code=${code},revision=revision+1 WHERE id=${intentId}`;
    status = await this.readStatus(tx, intentId);
    if (!code && status.pendingSubmissionCount === 0) {
      await tx`SELECT ops.crm_apply_erasure(${intentId}::uuid)`;
      await tx`UPDATE ops.crm_erasure_intents SET status='complete',completed_at=${this.now()},error_code=NULL WHERE id=${intentId}`;
      status = await this.readStatus(tx, intentId);
    }
    return status;
  }
  /** Owner-only bounded scheduler step. Commits the original intent BEFORE any remote erasure. */
  async runRetentionOnce(): Promise<boolean> {
    const config = outreachConfigSchema.safeParse(this.configuration);
    if (!config.success || !config.data.retention?.automationEnabled) return false;
    // Persist invocation separately: a later failed scan is not a completed sweep.
    await this.controlled(null, async (tx) => {
      await tx`INSERT INTO ops.crm_retention_scheduler(singleton,last_sweep_at)
        VALUES (true,${this.now()}) ON CONFLICT(singleton) DO UPDATE SET last_sweep_at=EXCLUDED.last_sweep_at`;
    });
    const outcome = await this.controlled(null, async (tx) => {
      const startedAt = performance.now();
      const at = this.now();
      const [scheduler] = await tx`SELECT scan_cursor,process_pending FROM ops.crm_retention_scheduler WHERE singleton`;
      await tx`UPDATE ops.crm_retention_scheduler SET process_pending=${!scheduler?.process_pending} WHERE singleton`;
      const [pending] = await tx`SELECT id FROM ops.crm_erasure_intents WHERE actor_kind='system' AND status='pending_notify'
        ORDER BY COALESCE(last_retention_attempt_at,requested_at),id LIMIT 1`;
      if (pending && scheduler?.process_pending) {
        await tx`UPDATE ops.crm_erasure_intents SET last_retention_attempt_at=${at} WHERE id=${pending.id}`;
        if (this.archivePublisher) await prepareArchive(tx, String(pending.id));
        return { pending: String(pending.id) };
      }
      const candidates = await tx`SELECT c.id FROM ops.crm_contacts c
        WHERE (${scheduler?.scan_cursor ?? null}::uuid IS NULL OR c.id>${scheduler?.scan_cursor ?? null}::uuid)
          AND NOT EXISTS(SELECT 1 FROM ops.crm_contact_aliases a WHERE a.contact_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM ops.crm_erasure_intents e WHERE e.canonical_contact_id=c.id)
        ORDER BY c.id LIMIT 100`;
      if (!candidates.length) {
        await tx`UPDATE ops.crm_retention_scheduler SET scan_cursor=NULL WHERE singleton`;
        if (pending) {
          await tx`UPDATE ops.crm_erasure_intents SET last_retention_attempt_at=${at} WHERE id=${pending.id}`;
          if (this.archivePublisher) await prepareArchive(tx, String(pending.id));
          return { pending: String(pending.id) };
        }
      }
      let processed = 0;
      for (const candidate of candidates) {
        // Yield only between complete candidates; never advance past one we did not inspect.
        if (processed >= 5 || (processed > 0 && performance.now() - startedAt >= 1000)) return true;
        processed += 1;
        await tx`UPDATE ops.crm_retention_scheduler SET scan_cursor=${candidate.id} WHERE singleton`;
        try {
          const selection = await this.cluster(tx, String(candidate.id));
          if (!(await this.retentionAge(tx, selection)).eligible) continue;
          await this.createIntent(tx, selection, null, randomUUID(), 'approved_retention_policy');
        } catch (error) {
          if (error instanceof OutreachError && ['ops.crm.retention_clock_invalid', 'ops.crm.erasure_too_large'].includes(error.code))
            return { refused: error.code };
          throw error;
        }
        return true;
      }
      return candidates.length > 0;
    });
    // Keep the advanced cursor durable while surfacing a cluster that needs owner recovery.
    if (typeof outcome !== 'boolean') {
      if (outcome.refused) throw new OutreachError(outcome.refused);
      await this.controlled(null, (tx) => this.advanceIntent(tx, outcome.pending!));
      return true;
    }
    return outcome;
  }
}
