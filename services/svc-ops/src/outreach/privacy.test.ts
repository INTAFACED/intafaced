import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createTestDatabase, transaction, type TestDatabase } from '@intafaced/db';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { Context, GuestNotificationReceipt } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';
import { OutreachError } from './config.js';
import { createOutreachRouter } from './router.js';
import { OutreachNotificationWorker } from './notification-worker.js';
import { OutreachNotificationError, type OutreachNotificationPort } from './notification-client.js';
import { privacyReadLock, withPrivacySnapshot } from './privacy.js';

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
const capture = () => ({
  requestId: randomUUID(),
  continuationToken: randomBytes(32).toString('base64url'),
  contact: {
    name: 'Private prospect',
    email: 'private@example.test',
    organisationName: 'Private organisation',
    interests: ['investor' as const],
    marketingOptIn: false,
  },
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
const beginInput = (preview: Awaited<ReturnType<OutreachCrm['privacy']['preview']>>) => ({
  requestId: randomUUID(),
  canonicalContactId: preview.canonicalContactId,
  expectedCanonicalRevision: preview.canonicalRevision,
  snapshot: preview.snapshot,
  confirmedEntireCluster: true as const,
  reason: 'confirmed_privacy_request' as const,
});
const fixture = () => {
  const receipts = new Map<string, NonNullable<Awaited<ReturnType<OutreachNotificationPort['eraseSubmission']>>>>();
  const eraseSubmission = vi.fn<OutreachNotificationPort['eraseSubmission']>(async (input) => {
    const receipt = receipts.get(input.requestId) ?? { ...input, erasedCount: 1, erasedAt: new Date().toISOString() };
    receipts.set(input.requestId, receipt);
    return receipt;
  });
  const port: OutreachNotificationPort = { configured: true, get: async () => null, send: vi.fn(async () => null), eraseSubmission };
  return { port, eraseSubmission, receipts };
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('founder-controlled cluster privacy on isolated PostgreSQL', () => {
  let db: TestDatabase, crm: OutreachCrm, notify: ReturnType<typeof fixture>;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'ops' });
    await migrateOutreach(db.sql);
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows,ops.crm_workflow_audit,ops.crm_erasure_intents,ops.crm_erased_requests CASCADE`;
    notify = fixture();
    crm = new OutreachCrm(db.sql, config, undefined, notify.port);
  });
  afterAll(async () => {
    await db.drop();
  });
  const saved = async () => {
    const input = capture(),
      receipt = await crm.capture(input, randomUUID());
    const opportunity = (await crm.listOpportunities({ limit: 100 })).items.find((o) => o.submissionId === receipt.submissionId)!;
    return { input, receipt, opportunity };
  };
  it('recovers an unreceived start receipt from the canonical contact after reconnection, for either founder', async () => {
    const original = await saved(),
      unrelated = await saved();
    await expect(crm.privacy.status({ canonicalContactId: original.opportunity.contactId }, founders[0])).rejects.toMatchObject({
      code: 'ops.crm.erasure_not_found',
    });
    const preview = await crm.privacy.preview({ canonicalContactId: original.opportunity.contactId }, founders[0]);
    // The committed start receipt was lost before the founder received its generated intent identifier.
    await crm.privacy.begin(beginInput(preview), founders[0]);
    const reconnected = postgres(db.url, { max: 2 });
    try {
      const reopened = new OutreachCrm(reconnected, config, undefined, notify.port);
      const recovered = await reopened.privacy.status({ canonicalContactId: original.opportunity.contactId }, founders[1]);
      expect(recovered).toMatchObject({
        canonicalContactId: original.opportunity.contactId,
        status: 'pending_notify',
        requestedBy: founders[0],
      });
      expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_erasure_intents`)[0]?.count).toBe(1);
      await expect(reopened.privacy.status({ canonicalContactId: unrelated.opportunity.contactId }, founders[1])).rejects.toMatchObject({
        code: 'ops.crm.erasure_not_found',
      });
      const completed = await reopened.privacy.advance(
        { requestId: randomUUID(), intentId: recovered.intentId, expectedRevision: recovered.revision },
        founders[1],
      );
      expect(completed.status).toBe('complete');
      expect(await reopened.privacy.status({ canonicalContactId: original.opportunity.contactId }, founders[0])).toEqual(completed);
      expect(await crm.getOpportunity({ opportunityId: unrelated.opportunity.id })).not.toBeNull();
      await expect(reopened.privacy.status({ canonicalContactId: original.opportunity.contactId }, randomUUID())).rejects.toMatchObject({
        code: 'ops.crm.operator_forbidden',
      });
    } finally {
      await reconnected.end();
    }
  });
  it('releases a failed consistent read before an exclusive privacy operation', async () => {
    await expect(
      withPrivacySnapshot(db.sql, async (tx) => {
        await tx`SELECT id FROM ops.crm_contacts`;
        throw new Error('fixture.read_failed');
      }),
    ).rejects.toThrow('fixture.read_failed');
    const [lock] = await db.sql`SELECT pg_try_advisory_xact_lock(hashtext('ops.crm.privacy')) AS acquired`;
    expect(lock?.acquired).toBe(true);
    const original = await saved();
    expect(await crm.privacy.preview({ canonicalContactId: original.opportunity.contactId }, founders[0])).toMatchObject({
      canonicalContactId: original.opportunity.contactId,
    });
  });
  it('reads a new consistent snapshot after waiting for completed erasure', async () => {
    const original = await saved();
    const preview = await crm.privacy.preview({ canonicalContactId: original.opportunity.contactId }, founders[0]);
    const intent = await crm.privacy.begin(beginInput(preview), founders[0]);
    let enter: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    notify.eraseSubmission.mockImplementationOnce(async (input) => {
      enter();
      await held;
      return { ...input, erasedCount: 1, erasedAt: new Date().toISOString() };
    });
    const erasing = crm.privacy.advance(
      { requestId: randomUUID(), intentId: intent.intentId, expectedRevision: intent.revision },
      founders[0],
    );
    await entered;
    const reading = crm.getOpportunity({ opportunityId: original.opportunity.id });
    try {
      await vi.waitFor(async () => {
        const blocked = await db.sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE 'SELECT pg_advisory%lock_shared%'`;
        expect(blocked.length).toBeGreaterThan(0);
      });
    } finally {
      release();
    }
    expect((await erasing).status).toBe('complete');
    expect(await db.sql`SELECT id FROM ops.crm_submissions WHERE id=${original.receipt.submissionId}`).toHaveLength(0);
    expect(await reading).toBeNull();
    expect((await crm.listOpportunities({ limit: 100 })).items).toHaveLength(0);
  });
  const finish = async (intent: Awaited<ReturnType<OutreachCrm['privacy']['begin']>>) => {
    let current = intent;
    for (let count = 0; current.status !== 'complete' && count < 10; count++)
      current = await crm.privacy.advance(
        { requestId: randomUUID(), intentId: current.intentId, expectedRevision: current.revision },
        founders[0],
      );
    return current;
  };
  it('erases every alias and original, cached exports, notes/messages/tasks/merge facts while preserving another cluster and immutable history', async () => {
    const a = await saved(),
      b = await saved(),
      unrelated = await saved();
    await crm.answer(
      {
        requestId: randomUUID(),
        submissionId: a.receipt.submissionId,
        continuationToken: a.input.continuationToken,
        expectedRevision: 1,
        questionnaire,
      },
      randomUUID(),
    );
    await crm.mergeContacts(
      {
        requestId: randomUUID(),
        sourceContactId: a.opportunity.contactId,
        targetContactId: b.opportunity.contactId,
        sourceExpectedRevision: 1,
        targetExpectedRevision: 1,
        confirmed: true,
        reason: 'Private merge evidence',
      },
      founders[0],
    );
    const current = (await crm.getOpportunity({ opportunityId: a.opportunity.id }))!.opportunity;
    const note = { requestId: randomUUID(), opportunityId: current.id, note: 'Private discussion' };
    await crm.addNote(note, founders[0]);
    await crm.queueMessage(
      {
        requestId: randomUUID(),
        opportunityId: current.id,
        expectedRevision: current.revision,
        kind: 'follow_up',
        staffText: 'Private message',
        reason: 'Private follow-up',
      },
      founders[0],
    );
    const exported = { requestId: randomUUID(), limit: 100 };
    expect((await crm.exportSubmissions(exported, founders[0])).items).toHaveLength(3);
    const unrelatedExport = { requestId: randomUUID(), limit: 1, capturedBefore: '2020-01-01T00:00:00Z' };
    const emptyPage = await crm.exportSubmissions(unrelatedExport, founders[0]);
    const preview = await crm.privacy.preview({ canonicalContactId: b.opportunity.contactId }, founders[0]);
    expect(preview.contacts.map((c) => c.contactId)).toEqual(expect.arrayContaining([a.opportunity.contactId, b.opportunity.contactId]));
    expect(preview.counts).toMatchObject({ contacts: 2, submissions: 2, opportunities: 2, messages: 3 });
    const begun = await crm.privacy.begin(beginInput(preview), founders[0]);
    await expect(crm.capture(a.input, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
    await expect(crm.addNote(note, founders[0])).rejects.toMatchObject({ code: 'ops.crm.erasure_pending' });
    const complete = await finish(begun);
    expect(complete).toMatchObject({ status: 'complete', pendingSubmissionCount: 0, code: null });
    expect(notify.eraseSubmission.mock.calls.map(([v]) => v.submissionId).sort()).toEqual(
      [a.receipt.submissionId, b.receipt.submissionId].sort(),
    );
    for (const table of ['crm_contacts', 'crm_submissions', 'crm_opportunities', 'crm_organisations', 'crm_outbox'])
      expect((await db.sql.unsafe(`SELECT count(*)::int AS count FROM ops.${table}`))[0]?.count).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_contact_aliases`)[0]?.count).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_contact_merges`)[0]?.count).toBe(0);
    await expect(crm.exportSubmissions(exported, founders[0])).rejects.toMatchObject({ code: 'ops.crm.request_erased' });
    expect(await crm.exportSubmissions(unrelatedExport, founders[0])).toEqual(emptyPage);
    await expect(crm.capture(a.input, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
    expect(
      (
        await crm.resume(
          { submissionId: unrelated.receipt.submissionId, continuationToken: unrelated.input.continuationToken },
          randomUUID(),
        )
      ).contact.email,
    ).toBe(unrelated.input.contact.email);
    await expect(db.sql`DELETE FROM ops.crm_activities`).rejects.toMatchObject({ message: 'ops.crm.activity_immutable' });
    await expect(db.sql`UPDATE ops.crm_activities SET record=record`).rejects.toMatchObject({ message: 'ops.crm.activity_immutable' });
    const evidence = JSON.stringify(await db.sql`SELECT * FROM ops.crm_erasure_intents`);
    for (const privateValue of ['private@example.test', 'Private discussion', 'Private prospect', a.input.continuationToken])
      expect(evidence).not.toContain(privateValue);
  });
  it('snapshot changes, actor changes and absent retention policy refuse before creating an intent', async () => {
    const a = await saved();
    const preview = await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0]);
    const input = beginInput(preview);
    await crm.addNote({ requestId: randomUUID(), opportunityId: a.opportunity.id, note: 'Changed after preview' }, founders[0]);
    await expect(crm.privacy.begin(input, founders[0])).rejects.toMatchObject({ code: 'ops.crm.revision_conflict' });
    await expect(crm.privacy.begin({ ...input, reason: 'approved_retention_policy' }, founders[0])).rejects.toMatchObject({
      code: 'ops.crm.retention_unconfigured',
    });
    const fresh = beginInput(await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0]));
    const pending = await crm.privacy.begin(fresh, founders[0]);
    expect(await crm.privacy.begin(fresh, founders[0])).toEqual(pending);
    await expect(crm.privacy.begin(fresh, founders[1])).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.privacy.begin({ ...fresh, snapshot: 'b'.repeat(64) }, founders[0])).rejects.toMatchObject({
      code: 'ops.crm.idempotency_conflict',
    });
  });
  it('retains a restartable intent when remote erasure succeeded but its response was lost, using the same remote UUID', async () => {
    const a = await saved();
    const pending = await crm.privacy.begin(
      beginInput(await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0])),
      founders[0],
    );
    const request = { requestId: randomUUID(), intentId: pending.intentId, expectedRevision: 1 };
    notify.eraseSubmission.mockImplementationOnce(async (input) => {
      notify.receipts.set(input.requestId, { ...input, erasedCount: 1, erasedAt: new Date().toISOString() });
      return null;
    });
    const unknown = await crm.privacy.advance(request, founders[0]);
    expect(unknown).toMatchObject({ status: 'pending_notify', code: 'ops.crm.notification_erasure_unknown' });
    await expect(crm.privacy.advance(request, founders[1])).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.privacy.advance({ ...request, requestId: randomUUID() }, founders[0])).rejects.toMatchObject({
      code: 'ops.crm.revision_conflict',
    });
    expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_contacts`)[0]?.count).toBe(1);
    const restarted = postgres(db.url, { max: 1 });
    try {
      const recovered = new OutreachCrm(restarted, config, undefined, notify.port);
      await expect(
        recovered.resume({ submissionId: a.receipt.submissionId, continuationToken: a.input.continuationToken }, randomUUID()),
      ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
      expect((await recovered.privacy.advance(request, founders[0])).status).toBe('complete');
      expect(notify.eraseSubmission.mock.calls[0]?.[0]).toEqual(notify.eraseSubmission.mock.calls[1]?.[0]);
      expect((await recovered.privacy.status({ intentId: pending.intentId }, founders[1])).status).toBe('complete');
    } finally {
      await restarted.end();
    }
  });
  it('unavailable, wrong-bound receipts and notify in-flight outcomes retain originals and stop new dispatch', async () => {
    const a = await saved();
    const pending = await crm.privacy.begin(
      beginInput(await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0])),
      founders[0],
    );
    const request = { requestId: randomUUID(), intentId: pending.intentId, expectedRevision: 1 };
    Object.defineProperty(notify.port, 'configured', { value: false });
    expect((await crm.privacy.advance(request, founders[0])).code).toBe('ops.crm.notification_unconfigured');
    Object.defineProperty(notify.port, 'configured', { value: true });
    expect(await new OutreachNotificationWorker(db.sql, notify.port).runOnce()).toBe(false);
    expect(notify.port.send).not.toHaveBeenCalled();
    await expect(db.sql`SELECT ops.crm_apply_erasure(${pending.intentId}::uuid)`).rejects.toMatchObject({
      message: 'ops.crm.erasure_evidence_missing',
    });
    await expect(db.sql`DELETE FROM ops.crm_outbox`).rejects.toMatchObject({ message: 'ops.crm.erasure_required' });
    await expect(db.sql`DELETE FROM ops.crm_submissions`).rejects.toMatchObject({ message: 'ops.crm.erasure_required' });
    notify.eraseSubmission.mockResolvedValueOnce({
      requestId: randomUUID(),
      submissionId: a.receipt.submissionId,
      erasedCount: 1,
      erasedAt: new Date().toISOString(),
    });
    expect((await crm.privacy.advance(request, founders[0])).code).toBe('ops.crm.notification_erasure_unknown');
    notify.eraseSubmission.mockRejectedValueOnce(new OutreachNotificationError('guest.delivery_in_progress'));
    expect((await crm.privacy.advance(request, founders[0])).code).toBe('ops.crm.notification_in_flight');
    expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_submissions`)[0]?.count).toBe(1);
    expect((await crm.privacy.advance(request, founders[0])).status).toBe('complete');
  });
  it('a claimed worker blocks erase completion until its actual bounded ingress finishes', async () => {
    const a = await saved();
    let release: (value: GuestNotificationReceipt | null) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((r) => {
      entered = r;
    });
    notify.port.send = vi.fn<OutreachNotificationPort['send']>(() => {
      entered();
      return new Promise((r) => {
        release = r;
      });
    });
    const running = new OutreachNotificationWorker(db.sql, notify.port).runOnce();
    await started;
    const pending = await crm.privacy.begin(
      beginInput(await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0])),
      founders[0],
    );
    const request = { requestId: randomUUID(), intentId: pending.intentId, expectedRevision: 1 };
    expect((await crm.privacy.advance(request, founders[0])).code).toBe('ops.crm.notification_in_flight');
    expect(notify.eraseSubmission).not.toHaveBeenCalled();
    release(null);
    await running;
    expect((await crm.privacy.advance(request, founders[0])).status).toBe('complete');
  });
  it('a crashed expired lease can reconcile notify erasure, and a delayed worker cannot resurrect local rows', async () => {
    const a = await saved();
    let release: (value: GuestNotificationReceipt | null) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((r) => {
      entered = r;
    });
    notify.port.send = vi.fn<OutreachNotificationPort['send']>(() => {
      entered();
      return new Promise((r) => {
        release = r;
      });
    });
    const running = new OutreachNotificationWorker(db.sql, notify.port).runOnce();
    await started;
    await db.sql`UPDATE ops.crm_outbox SET lease_until=clock_timestamp()-interval '1 second'`;
    const pending = await crm.privacy.begin(
      beginInput(await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0])),
      founders[0],
    );
    expect((await finish(pending)).status).toBe('complete');
    release(null);
    await running;
    expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_outbox`)[0]?.count).toBe(0);
    await expect(crm.capture(a.input, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
  });
  it('migration reversal removes privacy hooks and a fresh upgrade reinstates them without weakening append-only records', async () => {
    await migrateOutreach(db.sql, 'down');
    await migrateOutreach(db.sql);
    const a = await saved();
    await expect(db.sql`DELETE FROM ops.crm_outbox`).rejects.toMatchObject({ message: 'ops.crm.erasure_required' });
    const preview = await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0]);
    expect((await finish(await crm.privacy.begin(beginInput(preview), founders[0]))).status).toBe('complete');
  });
  it('serializes answer/merge/capture retries against erasure preparation and never freezes a new same-email enquiry', async () => {
    const a = await saved(),
      b = await saved();
    const preview = await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0]);
    const outcomes = await Promise.allSettled([
      crm.privacy.begin(beginInput(preview), founders[0]),
      crm.answer(
        {
          requestId: randomUUID(),
          submissionId: a.receipt.submissionId,
          continuationToken: a.input.continuationToken,
          expectedRevision: 1,
          questionnaire,
        },
        randomUUID(),
      ),
      crm.mergeContacts(
        {
          requestId: randomUUID(),
          sourceContactId: a.opportunity.contactId,
          targetContactId: b.opportunity.contactId,
          sourceExpectedRevision: 1,
          targetExpectedRevision: 1,
          confirmed: true,
          reason: 'Race',
        },
        founders[0],
      ),
      crm.capture(a.input, randomUUID()),
    ]);
    if (outcomes[0]?.status === 'fulfilled') {
      expect(outcomes[1]?.status).toBe('rejected');
      expect(outcomes[2]?.status).toBe('rejected');
      await finish(outcomes[0].value);
    } else expect(outcomes[0]?.reason).toMatchObject({ code: 'ops.crm.revision_conflict' });
    expect((await crm.capture(capture(), randomUUID())).submissionId).not.toBe(a.receipt.submissionId);
    await expect(
      crm.resume({ submissionId: a.receipt.submissionId, continuationToken: 'A'.repeat(43) }, randomUUID()),
    ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
  });
  it('a preparation waiting behind an actual answer observes the committed revision and requires a fresh preview', async () => {
    const a = await saved();
    const preview = await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0]);
    let unlock: () => void = () => {},
      entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = transaction(
      db.sql,
      async (tx) => {
        await privacyReadLock(tx);
        await tx`SELECT id FROM ops.crm_submissions WHERE id=${a.receipt.submissionId} FOR UPDATE`;
        entered();
        await new Promise<void>((resolve) => {
          unlock = resolve;
        });
      },
      { isolation: 'read committed' },
    );
    await ready;
    const answering = crm.answer(
      {
        requestId: randomUUID(),
        submissionId: a.receipt.submissionId,
        continuationToken: a.input.continuationToken,
        expectedRevision: 1,
        questionnaire,
      },
      randomUUID(),
    );
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const rows =
        await db.sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM ops.crm_submissions%'`;
      blocked = rows.length > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!blocked) {
      unlock();
      await held;
      await answering;
      throw new Error('Expected actual answer row-lock barrier');
    }
    const preparing = crm.privacy.begin(beginInput(preview), founders[0]);
    const refusal = expect(preparing).rejects.toMatchObject({ code: 'ops.crm.revision_conflict' });
    unlock();
    await held;
    await answering;
    await refusal;
    expect((await db.sql`SELECT count(*)::int AS count FROM ops.crm_erasure_intents`)[0]?.count).toBe(0);
    expect(
      (await crm.resume({ submissionId: a.receipt.submissionId, continuationToken: a.input.continuationToken }, randomUUID())).revision,
    ).toBe(2);
  });
  it('live founder/MFA router checks cover preview, confirmation, retries, status and retention', async () => {
    const a = await saved(),
      preview = await crm.privacy.preview({ canonicalContactId: a.opportunity.contactId }, founders[0]);
    let active = true;
    const authority = vi.fn(async () => {
      if (!active) throw new OutreachError('ops.crm.operator_forbidden');
      return founders[0];
    });
    const context: Context = {
      principal: {
        userId: founders[0],
        sub: founders[0],
        sid: randomUUID(),
        scopes: ['ops:read', 'ops:write'],
        tier: 'full',
        mfa: true,
        expiresAt: new Date(Date.now() + 60000),
      },
      service: null,
      region: 'ID',
      requestId: randomUUID(),
    };
    const api = createOutreachRouter(crm, authority),
      caller = api.createCaller(context),
      input = beginInput(preview);
    const begun = await caller.privacyBegin(input);
    active = false;
    for (const call of [
      () => caller.privacyPreview({ canonicalContactId: a.opportunity.contactId }),
      () => caller.privacyBegin(input),
      () => caller.privacyAdvance({ requestId: randomUUID(), intentId: begun.intentId, expectedRevision: 1 }),
      () => caller.privacyStatus({ intentId: begun.intentId }),
      () => caller.privacyStatus({ canonicalContactId: a.opportunity.contactId }),
      () => caller.privacyRetentionStatus(),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.createCaller({ ...context, principal: null }).privacyStatus({ intentId: begun.intentId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(authority).toHaveBeenCalledTimes(7);
  });
});
