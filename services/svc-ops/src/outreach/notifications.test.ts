import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { GuestNotificationReceipt, GuestNotificationSendInput } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';
import { OutreachNotificationWorker } from './notification-worker.js';
import { OutreachNotificationError, type OutreachNotificationPort } from './notification-client.js';

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
const capture = (email = 'original@example.test') => ({
  requestId: randomUUID(),
  continuationToken: randomBytes(32).toString('base64url'),
  contact: { name: 'Original prospect', email, interests: ['investor' as const], marketingOptIn: false },
});
const accepted = (input: GuestNotificationSendInput): GuestNotificationReceipt => ({
  notificationId: randomUUID(),
  businessKey: input.businessKey,
  status: 'accepted',
  attemptedAt: new Date().toISOString(),
  acceptedAt: new Date().toISOString(),
  code: null,
  reference: 'fixture-gateway-acceptance',
});
const fixture = () => {
  const receipts = new Map<string, GuestNotificationReceipt>();
  const send = vi.fn<OutreachNotificationPort['send']>(async (input: GuestNotificationSendInput) => {
    const value = receipts.get(input.businessKey) ?? accepted(input);
    receipts.set(input.businessKey, value);
    return value;
  });
  const port: OutreachNotificationPort = {
    configured: true,
    send,
    get: vi.fn(async (key) => receipts.get(key) ?? null),
    eraseSubmission: vi.fn(async () => null),
  };
  return { port, send, receipts };
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('CRM durable guest queue on real PostgreSQL', () => {
  let db: TestDatabase, crm: OutreachCrm;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'ops' });
    await migrateOutreach(db.sql);
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows,ops.crm_workflow_audit CASCADE`;
    crm = new OutreachCrm(db.sql, config);
  });
  afterAll(async () => {
    await db.drop();
  });
  it('queues one contact-only acknowledgement before answers; concurrent workers claim it once', async () => {
    const original = capture(),
      saved = await crm.capture(original, 'ack');
    const { port, send } = fixture();
    const a = new OutreachNotificationWorker(db.sql, port),
      b = new OutreachNotificationWorker(db.sql, port);
    expect(await Promise.all([a.runOnce(), b.runOnce()])).toEqual(expect.arrayContaining([true, false]));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({
      businessKey: `acknowledgement:${saved.submissionId}`,
      contactId: expect.any(String),
      submissionId: saved.submissionId,
      recipientEmail: original.contact.email,
      message: { kind: 'enquiry_acknowledgement' },
    });
    expect((await db.sql`SELECT record FROM ops.crm_submissions`)[0]?.record.completedAt).toBeNull();
    expect((await db.sql`SELECT status,notification_receipt FROM ops.crm_outbox`)[0]).toMatchObject({
      status: 'accepted',
      notification_receipt: { status: 'accepted', reference: 'fixture-gateway-acceptance' },
    });
    expect(await a.runOnce()).toBe(false);
  });
  it('recovers a lost notify receipt after restart using get and the original key, without another send', async () => {
    await crm.capture(capture(), 'lost-ack');
    const { port, send, receipts } = fixture();
    send.mockImplementationOnce(async (input) => {
      receipts.set(input.businessKey, accepted(input));
      return null;
    });
    await new OutreachNotificationWorker(db.sql, port).runOnce();
    expect((await db.sql`SELECT status,error_code FROM ops.crm_outbox`)[0]).toMatchObject({
      status: 'pending',
      error_code: 'ops.crm.notification_acceptance_unknown',
    });
    await db.sql`UPDATE ops.crm_outbox SET retry_at=clock_timestamp()`;
    const restarted = postgres(db.url, { max: 1 });
    try {
      await new OutreachNotificationWorker(restarted, port).runOnce();
    } finally {
      await restarted.end();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.sql`SELECT status,attempts FROM ops.crm_outbox`)[0]).toMatchObject({ status: 'accepted', attempts: 2 });
  });
  it('resumes a pre-attempt configuration refusal with the same immutable wire', async () => {
    await crm.capture(capture(), 'config');
    const { port, send, receipts } = fixture();
    send.mockImplementationOnce(async (input) => {
      const value: GuestNotificationReceipt = {
        notificationId: randomUUID(),
        businessKey: input.businessKey,
        status: 'refused',
        attemptedAt: null,
        acceptedAt: null,
        code: 'guest.notification_unconfigured',
        reference: null,
      };
      receipts.set(input.businessKey, value);
      return value;
    });
    const worker = new OutreachNotificationWorker(db.sql, port);
    await worker.runOnce();
    expect((await db.sql`SELECT status FROM ops.crm_outbox`)[0]?.status).toBe('unconfigured');
    await db.sql`UPDATE ops.crm_outbox SET retry_at=clock_timestamp()`;
    send.mockImplementationOnce(async (input) => {
      const value = accepted(input);
      receipts.set(input.businessKey, value);
      return value;
    });
    await worker.runOnce();
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect((await db.sql`SELECT status FROM ops.crm_outbox`)[0]?.status).toBe('accepted');
    await expect(
      db.sql`UPDATE ops.crm_outbox SET dispatch_payload=jsonb_set(dispatch_payload,'{recipientEmail}','"changed@example.test"')`,
    ).rejects.toMatchObject({ message: 'ops.crm.dispatch_origin_immutable' });
  });
  it('never resends a provider-uncertain outcome or labels it as delivered', async () => {
    await crm.capture(capture(), 'uncertain');
    const { port, send } = fixture();
    send.mockImplementationOnce(async (input) => ({
      notificationId: randomUUID(),
      businessKey: input.businessKey,
      status: 'unresolved',
      attemptedAt: new Date().toISOString(),
      acceptedAt: null,
      code: 'guest.acceptance_unknown',
      reference: null,
    }));
    const worker = new OutreachNotificationWorker(db.sql, port);
    await worker.runOnce();
    expect(await worker.runOnce()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.sql`SELECT status,acceptance_ref FROM ops.crm_outbox`)[0]).toMatchObject({
      status: 'unresolved',
      acceptance_ref: null,
    });
  });
  it('does not reuse an old configuration refusal when the renewed send has an uncertain storage outcome', async () => {
    await crm.capture(capture(), 'reconfiguration-unknown');
    const { port, send } = fixture();
    port.get = async (businessKey) => ({
      notificationId: randomUUID(),
      businessKey,
      status: 'refused',
      attemptedAt: null,
      acceptedAt: null,
      code: 'guest.notification_unconfigured',
      reference: null,
    });
    await db.sql`UPDATE ops.crm_outbox SET attempts=1`;
    send.mockRejectedValueOnce(new OutreachNotificationError('guest.storage_unavailable'));
    await new OutreachNotificationWorker(db.sql, port).runOnce();
    expect((await db.sql`SELECT status,error_code,notification_receipt FROM ops.crm_outbox`)[0]).toMatchObject({
      status: 'pending',
      error_code: 'guest.storage_unavailable',
      notification_receipt: null,
    });
  });
  it('binds staff queues to the actor and original recipient even after merging contacts', async () => {
    const a = await crm.capture(capture(), 'original'),
      b = await crm.capture(capture('canonical@example.test'), 'canonical');
    const page = await crm.listOpportunities({ limit: 10 });
    const source = page.items.find((o) => o.submissionId === a.submissionId)!,
      target = page.items.find((o) => o.submissionId === b.submissionId)!;
    await crm.mergeContacts(
      {
        requestId: randomUUID(),
        sourceContactId: source.contactId,
        targetContactId: target.contactId,
        sourceExpectedRevision: 1,
        targetExpectedRevision: 1,
        confirmed: true,
        reason: 'Founder-confirmed duplicate',
      },
      founders[0],
    );
    const current = (await crm.getOpportunity({ opportunityId: source.id }))!.opportunity;
    const input = {
      requestId: randomUUID(),
      opportunityId: source.id,
      expectedRevision: current.revision,
      kind: 'information_request' as const,
      staffText: 'Please tell us about your introduction.',
      reason: 'Founder follow-up',
    };
    const queued = await crm.queueMessage(input, founders[0]);
    expect(queued.opportunity.revision).toBe(current.revision + 1);
    expect(queued.activity.actor).toEqual({ kind: 'operator', userId: founders[0] });
    expect(queued.message).toMatchObject({ status: 'unconfigured', notification: null, submissionId: a.submissionId });
    expect(await crm.queueMessage(input, founders[0])).toEqual(queued);
    await expect(crm.queueMessage({ ...input, staffText: 'Changed' }, founders[0])).rejects.toMatchObject({
      code: 'ops.crm.idempotency_conflict',
    });
    await expect(crm.queueMessage(input, founders[1])).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.queueMessage({ ...input, requestId: randomUUID() }, randomUUID())).rejects.toMatchObject({
      code: 'ops.crm.operator_forbidden',
    });
    const wire = (await db.sql`SELECT dispatch_payload FROM ops.crm_outbox WHERE id=${queued.message.id}`)[0]?.dispatch_payload;
    expect(wire).toMatchObject({
      contactId: source.contactId,
      recipientEmail: 'original@example.test',
      submissionId: a.submissionId,
      message: { activityId: queued.activity.id, kind: 'information_request', staffText: input.staffText },
    });
    expect((await crm.listMessages({ opportunityId: source.id, limit: 10 })).items).toEqual([queued.message]);
  });
  it('refuses call invitations until actual investor answers and founder review exist', async () => {
    const original = capture(),
      saved = await crm.capture(original, 'review');
    let opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    const queue = () =>
      crm.queueMessage(
        {
          requestId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: opportunity.revision,
          kind: 'call_invitation',
          staffText: 'We have reviewed your enquiry and would like to discuss it.',
          reason: 'Reviewed invitation',
        },
        founders[0],
      );
    await expect(queue()).rejects.toMatchObject({ code: 'ops.crm.investor_review_required' });
    await crm.answer(
      {
        requestId: randomUUID(),
        submissionId: saved.submissionId,
        continuationToken: original.continuationToken,
        expectedRevision: 1,
        questionnaire: {
          audience: 'investor',
          version: 1,
          answers: {
            investorType: 'individual',
            participation: 'introduction',
            decisionRole: 'introducer',
            indicativeContribution: { status: 'undecided' },
            timing: 'undecided',
          },
        },
      },
      'review',
    );
    opportunity = (await crm.getOpportunity({ opportunityId: opportunity.id }))!.opportunity;
    await expect(queue()).rejects.toMatchObject({ code: 'ops.crm.investor_review_required' });
    opportunity = await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: opportunity.revision,
        stage: 'qualified',
        reason: 'Founder reviewed the original answers',
        closedDisposition: null,
        closingEvidenceRef: null,
        nextAction: { description: 'Discuss introduction', dueAt: new Date(Date.now() + 86400000).toISOString() },
      },
      founders[0],
    );
    expect((await queue()).message.kind).toBe('call_invitation');
  });
});
