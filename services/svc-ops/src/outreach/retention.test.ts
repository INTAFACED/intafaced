import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';
import { exportErasureArchive, applyErasureArchive } from './restore-privacy.js';
import { createOutreachRouter } from './router.js';
import { OutreachError } from './config.js';
import type { Context } from '@intafaced/contracts';
import type { OutreachNotificationPort } from './notification-client.js';

const founders = [randomUUID(), randomUUID()];
const configuration = {
  founders,
  initialOwnerUserId: founders[0],
  continuationTtlSeconds: 2592000,
  timeZone: 'Asia/Makassar',
  businessWeekdays: [1, 2, 3, 4, 5],
  reviewHour: 9,
  reviewMinute: 15,
  retention: { publishedPolicy: 'six_calendar_months_v1', automationEnabled: true },
};
const notify: OutreachNotificationPort = {
  configured: true,
  get: async () => null,
  send: async () => null,
  eraseSubmission: async (input) => ({ ...input, erasedCount: 1, erasedAt: new Date().toISOString() }),
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('approved outreach retention on isolated PostgreSQL', () => {
  let db: TestDatabase;
  let now: Date;
  let crm: OutreachCrm;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'ops' });
    await migrateOutreach(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows,ops.crm_workflow_audit,ops.crm_erasure_intents,ops.crm_erased_requests,ops.crm_retention_reviews,ops.crm_retention_scheduler CASCADE`;
    now = new Date('2024-08-31T09:15:00.000Z');
    crm = new OutreachCrm(db.sql, configuration, () => now, notify);
  });
  const capture = async () => {
    const input = {
      requestId: randomUUID(),
      continuationToken: randomBytes(32).toString('base64url'),
      contact: { name: 'Retention fixture', email: 'retention@example.test', interests: ['investor' as const], marketingOptIn: false },
    };
    const receipt = await crm.capture(input, randomUUID());
    const opportunity = (await crm.listOpportunities({ limit: 100 })).items.find((row) => row.submissionId === receipt.submissionId)!;
    return { input, receipt, opportunity };
  };

  it('admits the approved retention reason at the exact six-calendar-month deadline', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00.000Z');
    const preview = await crm.privacy.preview({ canonicalContactId: saved.opportunity.contactId }, founders[0]!);
    await expect(
      crm.privacy.begin(
        {
          requestId: randomUUID(),
          canonicalContactId: preview.canonicalContactId,
          expectedCanonicalRevision: preview.canonicalRevision,
          snapshot: preview.snapshot,
          confirmedEntireCluster: true,
          reason: 'approved_retention_policy',
        },
        founders[0]!,
      ),
    ).resolves.toMatchObject({ status: 'pending_notify', actorKind: 'founder', requestedBy: founders[0] });
  });
  const beginDue = async (contactId: string) => {
    const preview = await crm.privacy.preview({ canonicalContactId: contactId }, founders[0]!);
    return crm.privacy.begin(
      {
        requestId: randomUUID(),
        canonicalContactId: contactId,
        expectedCanonicalRevision: preview.canonicalRevision,
        snapshot: preview.snapshot,
        confirmedEntireCluster: true,
        reason: 'approved_retention_policy',
      },
      founders[0]!,
    );
  };
  const reviewInput = (contactId: string) => ({
    requestId: randomUUID(),
    canonicalContactId: contactId,
    expectedCanonicalRevision: 1,
    expectedReviewRevision: 0,
    state: 'active' as const,
    evidenceRef: 'fixture-discussion-review',
    reason: 'Founder verified an ongoing discussion',
  });
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

  it('refuses one millisecond before calendar expiry and leaves open stages subject to expiry', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:14:59.999Z');
    await expect(beginDue(saved.opportunity.contactId)).rejects.toMatchObject({ code: 'ops.crm.retention_not_due' });
    now = new Date('2025-02-28T09:15:00.000Z');
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify' });
  });
  it('new answers advance contact time once; retries, reaffirmed answers, exports, notes and tasks do not', async () => {
    const saved = await capture();
    now = new Date('2024-09-15T09:15:00Z');
    const answer = {
      requestId: randomUUID(),
      submissionId: saved.receipt.submissionId,
      continuationToken: saved.input.continuationToken,
      expectedRevision: 1,
      questionnaire,
    };
    const answered = await crm.answer(answer, randomUUID());
    now = new Date('2024-09-20T09:15:00Z');
    expect(await crm.answer(answer, randomUUID())).toEqual(answered);
    await expect(crm.answer({ ...answer, requestId: randomUUID(), expectedRevision: 2 }, randomUUID())).rejects.toMatchObject({
      code: 'ops.crm.answers_already_preserved',
    });
    await crm.resume({ submissionId: saved.receipt.submissionId, continuationToken: saved.input.continuationToken }, randomUUID());
    await crm.addNote(
      { requestId: randomUUID(), opportunityId: saved.opportunity.id, note: 'Internal review does not renew contact' },
      founders[0]!,
    );
    await crm.exportSubmissions({ requestId: randomUUID(), limit: 100 }, founders[0]!);
    await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: saved.opportunity.id,
        expectedRevision: 2,
        stage: 'qualified',
        reason: 'Internal stage review does not renew contact',
        closedDisposition: null,
        closingEvidenceRef: null,
        nextAction: { description: 'Internal task does not renew contact', dueAt: '2025-12-01T09:15:00Z' },
      },
      founders[0]!,
    );
    await crm.queueMessage(
      {
        requestId: randomUUID(),
        opportunityId: saved.opportunity.id,
        expectedRevision: 3,
        kind: 'follow_up',
        staffText: 'Queued staff message is not human interaction evidence',
        reason: 'Fixture',
      },
      founders[0]!,
    );
    now = new Date('2025-03-15T09:14:59.999Z');
    await expect(beginDue(saved.opportunity.contactId)).rejects.toMatchObject({ code: 'ops.crm.retention_not_due' });
    now = new Date('2025-03-15T09:15:00Z');
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify' });
  });
  it('only genuinely added interests advance time, not an unchanged or replayed addition', async () => {
    const saved = await capture();
    now = new Date('2024-09-10T09:15:00Z');
    const addition = {
      requestId: randomUUID(),
      submissionId: saved.receipt.submissionId,
      continuationToken: saved.input.continuationToken,
      expectedRevision: 1,
      interests: ['academy' as const],
    };
    const added = await crm.addInterests(addition, randomUUID());
    now = new Date('2024-09-20T09:15:00Z');
    expect(await crm.addInterests(addition, randomUUID())).toEqual(added);
    await crm.addInterests({ ...addition, requestId: randomUUID(), expectedRevision: 2 }, randomUUID());
    now = new Date('2025-03-10T09:14:59.999Z');
    await expect(beginDue(saved.opportunity.contactId)).rejects.toMatchObject({ code: 'ops.crm.retention_not_due' });
    now = new Date('2025-03-10T09:15:00Z');
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify', pendingSubmissionCount: 1 });
  });
  it('uses actual backdated evidence time, rejects future events, and excludes scheduled task time', async () => {
    const saved = await capture();
    now = new Date('2024-10-01T09:15:00Z');
    const interaction = {
      requestId: randomUUID(),
      opportunityId: saved.opportunity.id,
      expectedRevision: 1,
      kind: 'follow_up' as const,
      occurredAt: '2024-09-15T09:15:00Z',
      evidenceRef: 'fixture-human-reply',
      nextAction: { description: 'Future internal work', dueAt: '2025-12-01T09:15:00Z' },
      reason: 'Record actual human reply',
    };
    const recorded = await crm.recordInteraction(interaction, founders[0]!);
    await expect(
      crm.recordInteraction(
        {
          ...interaction,
          requestId: randomUUID(),
          expectedRevision: recorded.opportunity.revision,
          evidenceRef: 'future-invalid',
          occurredAt: '2024-10-02T09:15:00Z',
        },
        founders[0]!,
      ),
    ).rejects.toMatchObject({ code: 'ops.crm.interaction_in_future' });
    now = new Date('2025-03-15T09:15:00Z');
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify' });
  });
  it('active reviews expire at 30 days and exact founder retries do not renew them', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    const input = reviewInput(saved.opportunity.contactId);
    const review = await crm.privacy.retentionReview(input, founders[0]!);
    expect(review).toMatchObject({ reviewedBy: founders[0], expiresAt: '2025-03-30T09:15:00.000Z' });
    await expect(beginDue(saved.opportunity.contactId)).rejects.toMatchObject({ code: 'ops.crm.retention_not_due' });
    now = new Date('2025-03-29T09:15:00Z');
    expect(await crm.privacy.retentionReview(input, founders[0]!)).toEqual(review);
    await expect(crm.privacy.retentionReview(input, founders[1]!)).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.privacy.retentionReview({ ...input, requestId: randomUUID() }, founders[0]!)).rejects.toMatchObject({
      code: 'ops.crm.revision_conflict',
    });
    now = new Date('2025-03-30T09:15:00Z');
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify' });
  });
  it('inactive review ends exemption immediately without resetting the meaningful clock', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    const input = reviewInput(saved.opportunity.contactId);
    await crm.privacy.retentionReview(input, founders[0]!);
    const inactive = await crm.privacy.retentionReview(
      { ...input, requestId: randomUUID(), expectedReviewRevision: 1, state: 'inactive' },
      founders[1]!,
    );
    expect(inactive).toMatchObject({ state: 'inactive', expiresAt: null, reviewedBy: founders[1] });
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify' });
  });
  it('linked originals use the latest genuine event and a merge invalidates the prior cluster review', async () => {
    const a = await capture();
    now = new Date('2024-09-15T09:15:00Z');
    const b = await capture();
    now = new Date('2025-03-10T09:15:00Z');
    await crm.privacy.retentionReview(reviewInput(b.opportunity.contactId), founders[0]!);
    await crm.mergeContacts(
      {
        requestId: randomUUID(),
        sourceContactId: a.opportunity.contactId,
        targetContactId: b.opportunity.contactId,
        sourceExpectedRevision: 1,
        targetExpectedRevision: 1,
        confirmed: true,
        reason: 'Confirmed fixture originals',
      },
      founders[0]!,
    );
    await expect(beginDue(b.opportunity.contactId)).rejects.toMatchObject({ code: 'ops.crm.retention_not_due' });
    now = new Date('2025-03-15T09:15:00Z');
    const begun = await beginDue(b.opportunity.contactId);
    expect(begun).toMatchObject({ pendingSubmissionCount: 2, status: 'pending_notify' });
  });
  it('a fresh review changes the snapshot so stale privacy confirmation cannot defeat it', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    const old = await crm.privacy.preview({ canonicalContactId: saved.opportunity.contactId }, founders[0]!);
    await crm.privacy.retentionReview(reviewInput(saved.opportunity.contactId), founders[0]!);
    await expect(
      crm.privacy.begin(
        {
          requestId: randomUUID(),
          canonicalContactId: old.canonicalContactId,
          expectedCanonicalRevision: old.canonicalRevision,
          snapshot: old.snapshot,
          confirmedEntireCluster: true,
          reason: 'approved_retention_policy',
        },
        founders[0]!,
      ),
    ).rejects.toMatchObject({ code: 'ops.crm.revision_conflict' });
  });
  it('system selection commits before remote erasure, retries exact unknown receipt after restart, and erases reviews', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    await crm.privacy.retentionReview({ ...reviewInput(saved.opportunity.contactId), state: 'inactive' }, founders[0]!);
    const receipts = new Map<string, unknown>();
    let loseReply = true;
    const erase = vi.fn<OutreachNotificationPort['eraseSubmission']>(async (input) => {
      const receipt = receipts.get(input.requestId) ?? { ...input, erasedCount: 1, erasedAt: now.toISOString() };
      receipts.set(input.requestId, receipt);
      if (loseReply) throw new Error('synthetic lost acknowledgement');
      return receipt as NonNullable<Awaited<ReturnType<OutreachNotificationPort['eraseSubmission']>>>;
    });
    const port = { ...notify, eraseSubmission: erase };
    crm = new OutreachCrm(db.sql, configuration, () => now, port);
    expect(await crm.privacy.runRetentionOnce()).toBe(true);
    expect(erase).not.toHaveBeenCalled();
    const selected = await crm.privacy.status({ canonicalContactId: saved.opportunity.contactId }, founders[0]!);
    expect(selected).toMatchObject({ actorKind: 'system', requestedBy: null, status: 'pending_notify' });
    await expect(
      crm.queueMessage(
        {
          requestId: randomUUID(),
          opportunityId: saved.opportunity.id,
          expectedRevision: 1,
          kind: 'follow_up',
          staffText: 'Must not send',
          reason: 'Fixture pending deletion',
        },
        founders[0]!,
      ),
    ).rejects.toMatchObject({ code: 'ops.crm.erasure_pending' });
    await crm.privacy.runRetentionOnce();
    expect((await crm.privacy.status({ intentId: selected.intentId }, founders[0]!)).code).toBe('ops.crm.notification_erasure_unknown');
    loseReply = false;
    crm = new OutreachCrm(db.sql, configuration, () => now, port);
    for (let step = 0; step < 5; step++) await crm.privacy.runRetentionOnce();
    expect(await crm.privacy.status({ intentId: selected.intentId }, founders[1]!)).toMatchObject({
      status: 'complete',
      actorKind: 'system',
      requestedBy: null,
    });
    expect(new Set(erase.mock.calls.map(([input]) => input.requestId)).size).toBe(1);
    const archive = await exportErasureArchive(db.sql);
    expect(archive.version).toBe(2);
    expect(archive.intents[0]).toMatchObject({ actorUserId: null, actorKind: 'system' });
    expect(JSON.stringify(archive)).not.toContain('retention@example.test');
    await applyErasureArchive(db.sql, archive);
    await applyErasureArchive(db.sql, archive);
    expect(await crm.getOpportunity({ opportunityId: saved.opportunity.id })).toBeNull();
    await expect(
      crm.privacy.retentionReviewStatus({ canonicalContactId: saved.opportunity.contactId }, founders[0]!),
    ).rejects.toMatchObject({ code: 'ops.crm.contact_erased' });
  });
  it('absent policy stays disabled and status reports actual invocation separately from configuration', async () => {
    const disabled = new OutreachCrm(db.sql, { ...configuration, retention: undefined }, () => now, notify);
    expect(await disabled.privacy.retentionStatus(founders[0]!)).toEqual({ status: 'disabled', reason: 'published_policy_unconfigured' });
    expect(await disabled.privacy.runRetentionOnce()).toBe(false);
    expect(await crm.privacy.retentionStatus(founders[0]!)).toMatchObject({
      status: 'configured',
      inactivityCalendarMonths: 6,
      clockTimeZone: 'UTC',
      activeReviewMaxDays: 30,
      automationEnabled: true,
      lastSweepAt: null,
    });
    await crm.privacy.runRetentionOnce();
    expect(await crm.privacy.retentionStatus(founders[0]!)).toMatchObject({ lastSweepAt: now.toISOString() });
    const manual = new OutreachCrm(
      db.sql,
      { ...configuration, retention: { ...configuration.retention, automationEnabled: false } },
      () => now,
      notify,
    );
    expect(await manual.privacy.runRetentionOnce()).toBe(false);
    expect(await manual.privacy.retentionStatus(founders[0]!)).toMatchObject({ status: 'configured', automationEnabled: false });
  });
  it('protected review endpoints recheck live founder authority on retries and refuse caller expiry/actor fields', async () => {
    const saved = await capture();
    let active = true;
    const authority = async () => {
      if (!active) throw new OutreachError('ops.crm.operator_forbidden');
      return founders[0]!;
    };
    const context: Context = {
      principal: {
        userId: founders[0]!,
        sub: founders[0]!,
        sid: randomUUID(),
        mfa: true,
        tier: 'full',
        scopes: ['ops:read', 'ops:write'],
        expiresAt: new Date(Date.now() + 60000),
      },
      service: null,
      region: 'ID',
      requestId: randomUUID(),
    };
    const api = createOutreachRouter(crm, authority);
    const caller = api.createCaller(context);
    const input = reviewInput(saved.opportunity.contactId);
    const review = await caller.privacyRetentionReview(input);
    expect(await caller.privacyRetentionReviewStatus({ canonicalContactId: saved.opportunity.contactId })).toEqual(review);
    await expect(caller.privacyRetentionReview({ ...input, expiresAt: '2099-01-01T00:00:00Z' } as typeof input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    active = false;
    for (const invoke of [
      () => caller.privacyRetentionReview(input),
      () => caller.privacyRetentionReviewStatus({ canonicalContactId: saved.opportunity.contactId }),
      () => caller.privacyRetentionStatus(),
    ])
      await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('serializes a meaningful human reply against system selection without accepting a late write', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    const outcomes = await Promise.allSettled([
      crm.privacy.runRetentionOnce(),
      crm.recordInteraction(
        {
          requestId: randomUUID(),
          opportunityId: saved.opportunity.id,
          expectedRevision: 1,
          kind: 'follow_up',
          occurredAt: now.toISOString(),
          evidenceRef: 'fixture-racing-human-reply',
          nextAction: { description: 'Read the actual reply', dueAt: '2025-03-01T09:15:00Z' },
          reason: 'Actual human response',
        },
        founders[0]!,
      ),
    ]);
    expect(outcomes[0]?.status).toBe('fulfilled');
    if (outcomes[1]?.status === 'fulfilled') {
      await expect(crm.privacy.status({ canonicalContactId: saved.opportunity.contactId }, founders[0]!)).rejects.toMatchObject({
        code: 'ops.crm.erasure_not_found',
      });
      expect(await crm.getOpportunity({ opportunityId: saved.opportunity.id })).not.toBeNull();
    } else {
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'ops.crm.erasure_pending' } });
      expect(await crm.privacy.status({ canonicalContactId: saved.opportunity.contactId }, founders[0]!)).toMatchObject({
        status: 'pending_notify',
        actorKind: 'system',
      });
    }
  });
  it('uncertain erasure does not indefinitely prevent selection of another aged contact', async () => {
    const a = await capture(),
      b = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    crm = new OutreachCrm(db.sql, configuration, () => now, { ...notify, eraseSubmission: async () => null });
    for (let step = 0; step < 5; step++) await crm.privacy.runRetentionOnce();
    for (const saved of [a, b])
      expect(await crm.privacy.status({ canonicalContactId: saved.opportunity.contactId }, founders[0]!)).toMatchObject({
        status: 'pending_notify',
        actorKind: 'system',
        requestedBy: null,
      });
    await expect(migrateOutreach(db.sql, 'down')).rejects.toMatchObject({ message: 'ops.crm.retention_downgrade_unsafe' });
    expect(await crm.privacy.status({ canonicalContactId: a.opportunity.contactId }, founders[0]!)).toMatchObject({
      status: 'pending_notify',
    });
  });
  it('closing the whole discussion ends active exemption and cannot create a new active review', async () => {
    const saved = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    const input = reviewInput(saved.opportunity.contactId);
    await crm.privacy.retentionReview(input, founders[0]!);
    await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: saved.opportunity.id,
        expectedRevision: 1,
        stage: 'closed',
        reason: 'Actual closed discussion',
        closedDisposition: 'withdrawn',
        closingEvidenceRef: 'fixture-withdrawal',
        nextAction: null,
      },
      founders[0]!,
    );
    await expect(
      crm.privacy.retentionReview({ ...input, requestId: randomUUID(), expectedReviewRevision: 1 }, founders[1]!),
    ).rejects.toMatchObject({ code: 'ops.crm.retention_active_closed' });
    await expect(beginDue(saved.opportunity.contactId)).resolves.toMatchObject({ status: 'pending_notify' });
  });
  it('a future clock refuses deletion and persists the actual failed scheduler invocation', async () => {
    await capture();
    now = new Date('2024-08-30T09:15:00Z');
    await expect(crm.privacy.runRetentionOnce()).rejects.toMatchObject({ code: 'ops.crm.retention_clock_invalid' });
    expect(await crm.privacy.retentionStatus(founders[0]!)).toMatchObject({ lastSweepAt: '2024-08-30T09:15:00.000Z' });
    expect((await crm.listOpportunities({ limit: 100 })).items).toHaveLength(1);
  });
  it('a refused future-clock cluster advances the cursor so another aged cluster can still erase', async () => {
    now = new Date('2025-03-01T09:15:00Z');
    const future = await capture();
    now = new Date('2024-08-31T09:15:00Z');
    const aged = await capture();
    now = new Date('2025-02-28T09:15:00Z');
    let refused = false;
    for (let step = 0; step < 6; step++) {
      try {
        await crm.privacy.runRetentionOnce();
      } catch (error) {
        expect(error).toMatchObject({ code: 'ops.crm.retention_clock_invalid' });
        refused = true;
      }
    }
    expect(refused).toBe(true);
    expect(await crm.privacy.status({ canonicalContactId: aged.opportunity.contactId }, founders[0]!)).toMatchObject({
      status: 'complete',
      actorKind: 'system',
    });
    expect(await crm.getOpportunity({ opportunityId: future.opportunity.id })).not.toBeNull();
  });
  it('yields a noneligible scan with a committed cursor and continues to a later overdue contact after restart', async () => {
    const saved = [];
    for (let index = 0; index < 7; index++) saved.push(await capture());
    saved.sort((a, b) => a.opportunity.contactId.localeCompare(b.opportunity.contactId));
    now = new Date('2025-02-28T09:15:00Z');
    for (const recent of saved.slice(0, 6))
      await crm.recordInteraction(
        {
          requestId: randomUUID(),
          opportunityId: recent.opportunity.id,
          expectedRevision: 1,
          kind: 'follow_up',
          occurredAt: now.toISOString(),
          evidenceRef: 'fixture-recent-contact-' + recent.receipt.submissionId,
          nextAction: { description: 'Actual reply review', dueAt: '2025-03-01T09:15:00Z' },
          reason: 'Recent actual human contact',
        },
        founders[0]!,
      );
    const overdue = saved[6]!;
    expect(await crm.privacy.runRetentionOnce()).toBe(true);
    await expect(crm.privacy.status({ canonicalContactId: overdue.opportunity.contactId }, founders[0]!)).rejects.toMatchObject({
      code: 'ops.crm.erasure_not_found',
    });
    const [cursor] = await db.sql`SELECT scan_cursor FROM ops.crm_retention_scheduler WHERE singleton`;
    const position = saved.findIndex((row) => row.opportunity.contactId === cursor?.scan_cursor);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
    crm = new OutreachCrm(db.sql, configuration, () => now, notify);
    for (let step = 0; step < 7; step++) await crm.privacy.runRetentionOnce();
    expect(await crm.privacy.status({ canonicalContactId: overdue.opportunity.contactId }, founders[0]!)).toMatchObject({
      status: 'complete',
      actorKind: 'system',
    });
    for (const recent of saved.slice(0, 6)) expect(await crm.getOpportunity({ opportunityId: recent.opportunity.id })).not.toBeNull();
  });
});
