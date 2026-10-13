import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { outreachCaptureReceiptSchema, type OutreachCaptureInput, type OutreachQuestionnaireInput } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';
import { nextReviewAt, outreachConfigSchema } from './config.js';

const founders: [string, string] = [randomUUID(), randomUUID()];
const config = {
  founders,
  initialOwnerUserId: founders[0],
  continuationTtlSeconds: 3600,
  timeZone: 'Asia/Makassar',
  businessWeekdays: [1, 2, 3, 4, 5],
  reviewHour: 9,
  reviewMinute: 15,
};
const token = () => randomBytes(32).toString('base64url');
const contact = {
  name: 'Prospect',
  email: 'prospect@example.test',
  interests: ['investor' as const],
  marketingOptIn: false,
  organisationName: 'Prospect organisation',
};
const captureInput = (): OutreachCaptureInput => ({ requestId: randomUUID(), continuationToken: token(), contact });
const questionnaire = {
  audience: 'investor' as const,
  version: 1 as const,
  answers: {
    investorType: 'individual' as const,
    participation: 'direct' as const,
    decisionRole: 'decision_maker' as const,
    indicativeContribution: { status: 'undecided' as const },
    timing: 'undecided' as const,
  },
};
const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)('durable outreach PostgreSQL boundary', () => {
  let db: TestDatabase;
  let crm: OutreachCrm;
  let now: Date;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'ops' });
    await migrateOutreach(db.sql);
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows CASCADE`;
    now = new Date('2026-10-09T14:00:00Z');
    crm = new OutreachCrm(db.sql, config, () => now);
  });
  afterAll(async () => {
    await db.drop();
  });
  it('persists capture, owner/task/outbox together and resumes through a fresh connection', async () => {
    const input = captureInput();
    const receipt = await crm.capture(input, 'ip1');
    expect(outreachCaptureReceiptSchema.parse(receipt)).toEqual(receipt);
    const sql = postgres(db.url, { max: 1 });
    try {
      const restarted = new OutreachCrm(sql, config, () => now);
      expect(
        (await restarted.resume({ submissionId: receipt.submissionId, continuationToken: input.continuationToken }, 'ip1')).contact,
      ).toEqual(contact);
    } finally {
      await sql.end();
    }
    const opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    expect(opportunity.ownerUserId).toBe(founders[0]);
    expect(opportunity.nextAction?.dueAt).toBe('2026-10-12T01:15:00.000Z');
    const detail = await crm.getOpportunity({ opportunityId: opportunity.id });
    expect(detail?.tasks[0]?.status).toBe('pending');
    const outbox = await db.sql`SELECT status,error_code FROM ops.crm_outbox`;
    expect(outbox[0]).toMatchObject({ status: 'unconfigured', error_code: 'ops.crm.notification_unconfigured' });
    expect(detail?.contact.emailEvidence).toEqual({ status: 'unverified' });
    expect(detail?.contact.platformIdentity).toBeNull();
  });
  it('same-email public captures create separate contacts and preserve original data', async () => {
    const a = captureInput(),
      b = { ...captureInput(), contact: { ...contact, name: 'Another claimant' } };
    await crm.capture(a, 'ip');
    await crm.capture(b, 'ip');
    const rows = await db.sql`SELECT record FROM ops.crm_contacts`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.record.name).sort()).toEqual(['Another claimant', 'Prospect']);
    expect(rows.every((r) => r.record.platformIdentity === null && r.record.emailEvidence.status === 'unverified')).toBe(true);
  });
  it('deduplicates concurrent capture and authenticates before replay', async () => {
    const input = captureInput();
    const receipts = await Promise.all([crm.capture(input, 'ip'), crm.capture(input, 'ip')]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await crm.capture({ ...input, requestId: input.requestId.toUpperCase() }, 'ip')).toEqual(receipts[0]);
    expect(await db.sql`SELECT id FROM ops.crm_submissions`).toHaveLength(1);
    await expect(crm.capture({ ...input, continuationToken: token() }, 'ip')).rejects.toMatchObject({
      code: 'ops.crm.continuation_invalid',
    });
    await expect(crm.capture({ ...input, contact: { ...contact, name: 'Changed' } }, 'ip')).rejects.toMatchObject({
      code: 'ops.crm.idempotency_conflict',
    });
    const database = await db.sql`SELECT record,capability_hash FROM ops.crm_submissions`;
    const requests = await db.sql`SELECT result,fingerprint FROM ops.crm_requests`;
    expect(JSON.stringify([database, requests])).not.toContain(input.continuationToken);
  });
  it('rejects wrong and expired continuation without returning saved answers', async () => {
    const input = captureInput(),
      receipt = await crm.capture(input, 'ip');
    await expect(crm.resume({ submissionId: receipt.submissionId, continuationToken: token() }, 'ip')).rejects.toMatchObject({
      code: 'ops.crm.continuation_invalid',
    });
    now = new Date(now.getTime() + 3600000);
    await expect(
      crm.resume({ submissionId: receipt.submissionId, continuationToken: input.continuationToken }, 'ip'),
    ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
    await expect(crm.capture(input, 'ip')).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
  });
  it('serializes concurrent answers, preserves originals and binds retries to full payload', async () => {
    const input = captureInput(),
      receipt = await crm.capture(input, 'ip');
    const answer: OutreachQuestionnaireInput = {
      requestId: randomUUID(),
      submissionId: receipt.submissionId,
      continuationToken: input.continuationToken,
      expectedRevision: 1,
      questionnaire,
    };
    const results = await Promise.all([crm.answer(answer, 'ip'), crm.answer(answer, 'ip')]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.revision).toBe(2);
    expect(results[0]?.completedAt).not.toBeNull();
    await expect(
      crm.answer({ ...answer, questionnaire: { ...questionnaire, answers: { ...questionnaire.answers, message: 'changed' } } }, 'ip'),
    ).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.answer({ ...answer, requestId: randomUUID(), expectedRevision: 2 }, 'ip')).rejects.toMatchObject({
      code: 'ops.crm.answers_already_preserved',
    });
    const opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    expect((await crm.getOpportunity({ opportunityId: opportunity.id }))?.submission.questionnaires).toEqual([questionnaire]);
  });
  it('only selected audiences can answer and concurrent independent requests detect revisions', async () => {
    const input = captureInput(),
      receipt = await crm.capture(input, 'ip');
    const a = {
      requestId: randomUUID(),
      submissionId: receipt.submissionId,
      continuationToken: input.continuationToken,
      expectedRevision: 1,
      questionnaire,
    };
    const results = await Promise.allSettled([crm.answer(a, 'ip'), crm.answer({ ...a, requestId: randomUUID() }, 'ip')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'ops.crm.revision_conflict' } });
    await expect(
      crm.answer(
        {
          ...a,
          requestId: randomUUID(),
          expectedRevision: 2,
          questionnaire: {
            audience: 'partner',
            version: 1,
            answers: { expertise: 'testing', contribution: 'help', relationship: 'collaboration', timing: 'undecided' },
          },
        },
        'ip',
      ),
    ).rejects.toMatchObject({ code: 'ops.crm.audience_not_selected' });
  });
  it('staff changes use actor-bound idempotency, optimistic revisions and audience stages', async () => {
    await crm.capture(captureInput(), 'ip');
    const opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    const assignment = { requestId: randomUUID(), opportunityId: opportunity.id, expectedRevision: 1, ownerUserId: founders[1]! };
    const results = await Promise.all([crm.assign(assignment, founders[0]!), crm.assign(assignment, founders[0]!)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.revision).toBe(2);
    await expect(crm.assign(assignment, founders[1]!)).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.assign({ ...assignment, requestId: randomUUID() }, founders[0]!)).rejects.toMatchObject({
      code: 'ops.crm.revision_conflict',
    });
    await expect(
      crm.changeStage(
        {
          requestId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: 2,
          stage: 'invited',
          reason: 'Test',
          nextAction: { description: 'Call', dueAt: '2026-10-15T00:00:00Z' },
          closedDisposition: null,
          closingEvidenceRef: null,
        },
        founders[0]!,
      ),
    ).rejects.toMatchObject({ code: 'ops.crm.stage_invalid_for_audience' });
    const closed = await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: 2,
        stage: 'closed',
        reason: 'Duplicate submission reviewed',
        nextAction: null,
        closedDisposition: 'duplicate',
        closingEvidenceRef: 'review-note',
      },
      founders[1]!,
    );
    expect(closed.stage).toBe('closed');
    const detail = await crm.getOpportunity({ opportunityId: opportunity.id });
    expect(detail?.tasks.every((t) => t.status !== 'pending')).toBe(true);
    expect(detail?.activities.at(-1)?.actor).toEqual({ kind: 'operator', userId: founders[1] });
  });
  it('edits only the next action: no stage change, no reason, replaced task, own history entry, revision-checked and founder-only', async () => {
    await crm.capture(captureInput(), 'ip');
    const opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    const edit = {
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: opportunity.revision,
      description: 'Send the deck',
      dueAt: '2026-10-14T09:00:00+08:00',
    };
    const saved = await crm.updateNextAction(edit, founders[1]!);
    expect(saved).toMatchObject({
      stage: opportunity.stage,
      ownerUserId: opportunity.ownerUserId,
      revision: opportunity.revision + 1,
      nextAction: { description: 'Send the deck', dueAt: '2026-10-14T01:00:00.000Z' },
    });
    // The same request replays the stored result and writes nothing new.
    expect(await crm.updateNextAction(edit, founders[1]!)).toEqual(saved);
    await expect(crm.updateNextAction(edit, founders[0]!)).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.updateNextAction({ ...edit, description: 'Changed' }, founders[1]!)).rejects.toMatchObject({
      code: 'ops.crm.idempotency_conflict',
    });
    const detail = (await crm.getOpportunity({ opportunityId: opportunity.id }))!;
    const pending = detail.tasks.filter((task) => task.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      description: 'Send the deck',
      dueAt: '2026-10-14T01:00:00.000Z',
      ownerUserId: opportunity.ownerUserId,
    });
    expect(detail.tasks.filter((task) => task.status === 'cancelled')).toHaveLength(1);
    const entries = detail.activities.filter((activity) => activity.kind === 'next_action_changed');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'operator', userId: founders[1] },
      note: 'Send the deck',
      referenceId: '2026-10-14T01:00:00.000Z',
    });
    expect(detail.activities.some((activity) => activity.kind === 'stage_changed')).toBe(false);
    const audits = await db.sql`SELECT kind FROM ops.crm_workflow_audit WHERE request_id=${edit.requestId} ORDER BY kind`;
    expect(audits.map((row) => row.kind)).toEqual(['task_created', 'task_transitioned']);
    // A stale revision, an unknown founder and a closed enquiry are all refused.
    await expect(crm.updateNextAction({ ...edit, requestId: randomUUID(), description: 'Stale' }, founders[0]!)).rejects.toMatchObject({
      code: 'ops.crm.revision_conflict',
    });
    await expect(
      crm.updateNextAction({ ...edit, requestId: randomUUID(), expectedRevision: saved.revision }, randomUUID()),
    ).rejects.toMatchObject({ code: 'ops.crm.operator_forbidden' });
    await expect(
      crm.updateNextAction({ ...edit, requestId: randomUUID(), opportunityId: randomUUID(), expectedRevision: 1 }, founders[0]!),
    ).rejects.toMatchObject({ code: 'ops.crm.opportunity_not_found' });
    const closed = await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: saved.revision,
        stage: 'closed',
        reason: 'Declined',
        nextAction: null,
        closedDisposition: 'declined',
        closingEvidenceRef: 'review-note',
      },
      founders[0]!,
    );
    await expect(
      crm.updateNextAction({ ...edit, requestId: randomUUID(), expectedRevision: closed.revision }, founders[0]!),
    ).rejects.toMatchObject({ code: 'ops.crm.opportunity_closed' });
  });
  it('concurrent notes produce monotonic immutable history without duplicate retry effects', async () => {
    await crm.capture(captureInput(), 'ip');
    const opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    const note = { requestId: randomUUID(), opportunityId: opportunity.id, note: 'Reviewed enquiry' };
    await Promise.all([
      crm.addNote(note, founders[0]!),
      crm.addNote(note, founders[0]!),
      crm.addNote({ ...note, requestId: randomUUID(), note: 'Second note' }, founders[1]!),
    ]);
    const detail = await crm.getOpportunity({ opportunityId: opportunity.id });
    expect(detail?.activities.map((a) => a.sequence)).toEqual([1, 2, 3]);
    expect(detail?.activities.filter((a) => a.kind === 'note')).toHaveLength(2);
  });
  it('lists stable keyset pages with literal search and audience/owner filters', async () => {
    for (let n = 0; n < 5; n++) await crm.capture({ ...captureInput(), contact: { ...contact, name: `Prospect ${n}` } }, 'ip');
    const one = await crm.listOpportunities({ limit: 2, audience: 'investor', ownerUserId: founders[0] });
    const two = await crm.listOpportunities({ limit: 2, cursor: one.nextCursor! });
    const three = await crm.listOpportunities({ limit: 2, cursor: two.nextCursor! });
    expect(new Set([...one.items, ...two.items, ...three.items].map((r) => r.id)).size).toBe(5);
    expect(three.nextCursor).toBeNull();
    expect(one.contacts.map((c) => c.id).sort()).toEqual(one.items.map((o) => o.contactId).sort());
    expect(three.contacts).toHaveLength(1);
    for (const page of [one, two, three]) {
      expect(page.submissions.map((s) => s.submissionId).sort()).toEqual([...new Set(page.items.map((o) => o.submissionId))].sort());
      expect(page.submissions.every((s) => s.completedAt === null && s.organisationName === 'Prospect organisation')).toBe(true);
    }
    expect((await crm.listOpportunities({ limit: 10, query: 'no match' })).submissions).toEqual([]);
    expect((await crm.listOpportunities({ limit: 10, query: 'no match' })).contacts).toEqual([]);
    expect((await crm.listOpportunities({ limit: 10, query: '%' })).items).toHaveLength(0);
    expect((await crm.listOpportunities({ limit: 10, query: 'Prospect 3' })).items).toHaveLength(1);
    await expect(crm.listOpportunities({ limit: 10, cursor: 'invalid' })).rejects.toMatchObject({ code: 'ops.crm.cursor_invalid' });
  });
  it('completes every selected audience without dropping earlier answers', async () => {
    const input = {
      ...captureInput(),
      contact: { ...contact, interests: ['investor', 'trader', 'merchant', 'academy', 'partner'] as const },
    };
    const receipt = await crm.capture({ ...input, contact: { ...input.contact, interests: [...input.contact.interests] } }, 'ip');
    const answers = [
      questionnaire,
      {
        audience: 'trader',
        version: 1,
        answers: { markets: ['spot'], experience: 'advanced', role: 'professional', platformInterest: 'Workbench', timing: 'undecided' },
      },
      {
        audience: 'merchant',
        version: 1,
        answers: {
          businessName: 'Business',
          industry: 'Services',
          operatingCountries: ['ID'],
          processingVolume: { status: 'unknown' },
          services: ['payment_acceptance'],
          timing: 'undecided',
        },
      },
      {
        audience: 'academy',
        version: 1,
        answers: { learningGoal: 'Learn trading', experience: 'beginner', subjects: ['Risk'], format: 'self_paced', timing: 'undecided' },
      },
      {
        audience: 'partner',
        version: 1,
        answers: { expertise: 'Technology', contribution: 'Build integrations', relationship: 'partnership', timing: 'undecided' },
      },
    ];
    for (let n = 0; n < answers.length; n++) {
      const result = await crm.answer(
        {
          requestId: randomUUID(),
          submissionId: receipt.submissionId,
          continuationToken: input.continuationToken,
          expectedRevision: n + 1,
          questionnaire: answers[n] as OutreachQuestionnaireInput['questionnaire'],
        },
        'ip',
      );
      expect(result.questionnaires).toHaveLength(n + 1);
      expect(result.completedAt !== null).toBe(n === 4);
    }
    const opportunities = (await crm.listOpportunities({ limit: 10 })).items;
    expect(opportunities).toHaveLength(5);
    const completedPage = await crm.listOpportunities({ limit: 10 });
    expect(completedPage.contacts).toHaveLength(1);
    expect(completedPage.submissions).toHaveLength(1);
    expect(completedPage.submissions[0]).toMatchObject({ submissionId: receipt.submissionId, completedAt: now.toISOString() });
    for (const opportunity of opportunities)
      expect((await crm.getOpportunity({ opportunityId: opportunity.id }))?.submission.questionnaires).toHaveLength(5);
  });
  it('failed guesses consume durable abuse budget', async () => {
    for (let n = 0; n < 30; n++)
      await expect(crm.resume({ submissionId: randomUUID(), continuationToken: token() }, 'attacker')).rejects.toMatchObject({
        code: 'ops.crm.continuation_invalid',
      });
    await expect(crm.resume({ submissionId: randomUUID(), continuationToken: token() }, 'attacker')).rejects.toMatchObject({
      code: 'ops.crm.rate_limited',
    });
  });
  it('database refuses activity history updates and deletes', async () => {
    await crm.capture(captureInput(), 'ip');
    const rows = await db.sql`SELECT id FROM ops.crm_activities`;
    await expect(db.sql`UPDATE ops.crm_activities SET record=record WHERE id=${rows[0]!.id}`).rejects.toMatchObject({
      message: 'ops.crm.activity_immutable',
    });
    await expect(db.sql`DELETE FROM ops.crm_activities WHERE id=${rows[0]!.id}`).rejects.toMatchObject({
      message: 'ops.crm.activity_immutable',
    });
  });
  it('up/down/up migration restores empty valid tables and runner deduplicates safely', async () => {
    await migrateOutreach(db.sql, 'down');
    await Promise.all([migrateOutreach(db.sql), migrateOutreach(db.sql)]);
    expect(await db.sql`SELECT id FROM ops.crm_contacts`).toHaveLength(0);
  });
});
describe('explicit configuration and schedule', () => {
  it('storage and founder/schedule configuration refuse instead of reporting capture', async () => {
    await expect(new OutreachCrm(null, config).capture(captureInput(), 'ip')).rejects.toMatchObject({
      code: 'ops.crm.storage_unconfigured',
    });
  });
  it('normalizes founder UUID casing before duplicates and owner membership', () => {
    const parsed = outreachConfigSchema.parse({
      ...config,
      founders: [founders[0].toUpperCase(), founders[1]],
      initialOwnerUserId: founders[0].toUpperCase(),
    });
    expect(parsed.founders).toEqual(founders);
    expect(parsed.initialOwnerUserId).toBe(founders[0]);
    expect(outreachConfigSchema.safeParse({ ...config, founders: [founders[0], founders[0].toUpperCase()] }).success).toBe(false);
  });
  it('DST gaps move to earliest valid clock on that business date and folds choose first occurrence', () => {
    const sunday = { ...config, timeZone: 'America/New_York', businessWeekdays: [7], reviewHour: 2, reviewMinute: 30 };
    expect(nextReviewAt(new Date('2026-03-07T17:00:00Z'), sunday)).toBe('2026-03-08T07:00:00.000Z');
    expect(nextReviewAt(new Date('2026-10-31T16:00:00Z'), { ...sunday, reviewHour: 1 })).toBe('2026-11-01T05:30:00.000Z');
    expect(() => nextReviewAt(new Date('2011-12-29T12:00:00Z'), { ...config, timeZone: 'Pacific/Apia', businessWeekdays: [5] })).toThrow(
      'ops.crm.schedule_unavailable',
    );
  });
  it('next business day uses configured local clock', () => {
    expect(nextReviewAt(new Date('2026-10-09T14:00:00Z'), config)).toBe('2026-10-12T01:15:00.000Z');
    expect(nextReviewAt(new Date('2026-10-12T18:00:00Z'), config)).toBe('2026-10-14T01:15:00.000Z');
  });
});
