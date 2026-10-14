import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  crmActivitySchema,
  crmListInputSchema,
  crmMetricsSchema,
  type CrmOpportunityRow,
  type OutreachAudience,
} from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';

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
const T0 = Date.parse('2026-10-12T00:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0 + hours * HOUR);
const iso = (hours: number) => at(hours).toISOString();

type Stated = { amount: string; currency: string } | 'undecided';
const investorAnswers = (indicative: Stated, participation: 'direct' | 'introduction' | 'both' = 'direct') => ({
  audience: 'investor' as const,
  version: 1 as const,
  answers: {
    investorType: 'individual' as const,
    participation,
    decisionRole: 'decision_maker' as const,
    indicativeContribution: indicative === 'undecided' ? { status: 'undecided' as const } : { status: 'stated' as const, ...indicative },
    timing: 'undecided' as const,
  },
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'founder inbox: reply state, waiting queue, commitment and raise on real PostgreSQL',
  () => {
    let db: TestDatabase;
    let crm: OutreachCrm;
    let now: Date;
    let n = 0;
    beforeAll(async () => {
      db = await createTestDatabase({ service: 'ops' });
      await migrateOutreach(db.sql);
    });
    beforeEach(async () => {
      await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows,ops.crm_campaigns,ops.crm_workflow_audit CASCADE`;
      now = at(0);
      crm = new OutreachCrm(db.sql, config, () => now);
    });
    afterAll(async () => {
      await db.drop();
    });

    async function enquire(
      audience: OutreachAudience = 'investor',
      stated?: Stated,
      participation: 'direct' | 'introduction' | 'both' = 'direct',
      email?: string,
    ): Promise<CrmOpportunityRow> {
      n += 1;
      const continuationToken = randomBytes(32).toString('base64url');
      const receipt = await crm.capture(
        {
          requestId: randomUUID(),
          continuationToken,
          contact: { name: `Prospect ${n}`, email: email ?? `prospect${n}@example.test`, interests: [audience], marketingOptIn: false },
        },
        `ip-${n}`,
      );
      if (audience === 'investor' && stated !== undefined)
        await crm.answer(
          {
            requestId: randomUUID(),
            submissionId: receipt.submissionId,
            continuationToken,
            expectedRevision: 1,
            questionnaire: investorAnswers(stated, participation),
          },
          `ip-${n}`,
        );
      const page = await crm.listOpportunities({ limit: 200 });
      return page.items.find((item) => item.submissionId === receipt.submissionId)!;
    }
    const reload = async (id: string) => (await crm.getOpportunity({ opportunityId: id }))!.opportunity;
    const reply = async (id: string, occurredAt: string, dueHours: number, extra: { evidenceRef?: string; requestId?: string } = {}) => {
      const current = await reload(id);
      return crm.recordInteraction(
        {
          requestId: extra.requestId ?? randomUUID(),
          opportunityId: id,
          expectedRevision: current.revision,
          kind: 'reply_sent',
          occurredAt,
          ...(extra.evidenceRef === undefined ? {} : { evidenceRef: extra.evidenceRef }),
          nextAction: { description: 'Check in', dueAt: iso(dueHours) },
          reason: 'Replied from Gmail',
        },
        founders[0],
      );
    };
    const close = async (id: string) => {
      const current = await reload(id);
      return crm.changeStage(
        {
          requestId: randomUUID(),
          opportunityId: id,
          expectedRevision: current.revision,
          stage: 'closed',
          reason: 'Not a fit',
          closedDisposition: 'declined',
          closingEvidenceRef: 'polite no sent',
          nextAction: null,
        },
        founders[0],
      );
    };
    const setCommitment = async (
      id: string,
      commitment: { tier: 'soft_circled' | 'committed'; amount: string; currency: string; evidenceRef?: string } | null,
      actor = founders[0],
    ) => {
      const current = await reload(id);
      // Committed means documented agreements, so the reference is required; tests not about that supply one.
      const documented =
        commitment?.tier === 'committed' && commitment.evidenceRef === undefined
          ? { ...commitment, evidenceRef: 'signed agreement' }
          : commitment;
      return crm.setCommitment(
        {
          requestId: randomUUID(),
          opportunityId: id,
          expectedRevision: current.revision,
          commitment: documented,
          reason: 'After the call',
        },
        actor,
      );
    };
    const metrics = (filters: Record<string, string> = {}) => crm.metrics(filters as never);
    const raise = async (filters: Record<string, string> = {}) => crmMetricsSchema.shape.raise.parse((await metrics(filters)).raise);

    describe('reply state', () => {
      it('starts unreplied and waiting since it was created; notes and owner changes are not touches', async () => {
        const row = await enquire();
        expect(row).toMatchObject({ firstReplyAt: null, lastTouchAt: null, waitingSince: row.createdAt });
        now = at(1);
        await crm.addNote({ requestId: randomUUID(), opportunityId: row.id, note: 'Looks serious' }, founders[0]);
        await crm.assign(
          { requestId: randomUUID(), opportunityId: row.id, expectedRevision: (await reload(row.id)).revision, ownerUserId: founders[1] },
          founders[0],
        );
        await crm.updateNextAction(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: (await reload(row.id)).revision,
            description: 'Prepare a reply',
            dueAt: iso(30),
          },
          founders[0],
        );
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: null, lastTouchAt: null });
      });

      it('a stage change is a touch but not a reply', async () => {
        const row = await enquire();
        now = at(2);
        await crm.changeStage(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: row.revision,
            stage: 'qualified',
            reason: 'Reviewed: fits',
            closedDisposition: null,
            closingEvidenceRef: null,
            nextAction: { description: 'Schedule a call', dueAt: iso(40) },
          },
          founders[0],
        );
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: null, lastTouchAt: iso(2), waitingSince: row.createdAt });
      });

      it('a queued message is the first reply and a touch; later touches move only lastTouchAt', async () => {
        const row = await enquire();
        now = at(3);
        const queued = await crm.queueMessage(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: row.revision,
            kind: 'information_request',
            staffText: 'Could you share your timing?',
            reason: 'Founder follow-up',
          },
          founders[0],
        );
        expect(queued.opportunity.revision).toBe(row.revision + 1);
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(3), lastTouchAt: iso(3), waitingSince: row.nextAction!.dueAt });
        now = at(6);
        await crm.recordInteraction(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: (await reload(row.id)).revision,
            kind: 'follow_up',
            occurredAt: iso(6),
            evidenceRef: 'phone-note-1',
            nextAction: { description: 'Wait for the deck review', dueAt: iso(50) },
            reason: 'Called',
          },
          founders[0],
        );
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(3), lastTouchAt: iso(6), waitingSince: iso(50) });
      });

      it('a follow-up interaction is a touch only: it is not a reply', async () => {
        const row = await enquire();
        now = at(1);
        await crm.recordInteraction(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: row.revision,
            kind: 'follow_up',
            occurredAt: iso(1),
            evidenceRef: 'note-a',
            nextAction: { description: 'Try again', dueAt: iso(20) },
            reason: 'Internal chase',
          },
          founders[0],
        );
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: null, lastTouchAt: iso(1), waitingSince: row.createdAt });
      });

      it('list rows and the detail agree, and a queued message on another enquiry changes nothing here', async () => {
        const [a, b] = [await enquire(), await enquire()];
        now = at(2);
        await reply(a.id, iso(2), 24);
        const page = await crm.listOpportunities({ limit: 10 });
        const detail = await crm.getOpportunity({ opportunityId: a.id });
        expect(page.items.find((item) => item.id === a.id)).toEqual(detail!.opportunity);
        expect(page.items.find((item) => item.id === b.id)).toMatchObject({ firstReplyAt: null, lastTouchAt: null });
        expect(detail!.opportunity).toMatchObject({ firstReplyAt: iso(2), lastTouchAt: iso(2), waitingSince: iso(24) });
      });

      it('a closed enquiry is no longer waiting', async () => {
        const row = await enquire();
        now = at(1);
        const closed = await close(row.id);
        expect(closed.stage).toBe('closed');
        expect(await reload(row.id)).toMatchObject({ waitingSince: null, firstReplyAt: null, lastTouchAt: iso(1) });
      });
    });

    describe('reply_sent', () => {
      it('records a reply sent outside the console without evidence, audited, and sets the reply state', async () => {
        const row = await enquire();
        now = at(4);
        const requestId = randomUUID();
        const input = {
          requestId,
          opportunityId: row.id,
          expectedRevision: row.revision,
          kind: 'reply_sent' as const,
          occurredAt: iso(3.5),
          nextAction: { description: 'Check in', dueAt: iso(28) },
          reason: 'Replied from Gmail',
        };
        const receipt = await crm.recordInteraction(input, founders[0]);
        expect(receipt.interaction).toMatchObject({
          kind: 'reply_sent',
          evidenceRef: null,
          occurredAt: iso(3.5),
          recordedAt: iso(4),
          actorUserId: founders[0],
          status: 'manually_recorded',
          scheduledAt: null,
        });
        expect(receipt.activity).toMatchObject({ kind: 'reply_sent', referenceId: null, note: 'Replied from Gmail' });
        expect(receipt.opportunity).toMatchObject({ revision: row.revision + 1, nextAction: { description: 'Check in', dueAt: iso(28) } });
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(3.5), lastTouchAt: iso(3.5), waitingSince: iso(28) });
        const audit = await crm.listWorkflowAudit({ subjectType: 'opportunity', subjectId: row.id, limit: 10 });
        expect(audit.items).toHaveLength(1);
        expect(audit.items[0]).toMatchObject({
          kind: 'interaction_recorded',
          requestId,
          actorUserId: founders[0],
          reason: 'Replied from Gmail',
        });
        // The same request replays; it does not record a second reply.
        expect(await crm.recordInteraction(input, founders[0])).toEqual(receipt);
        expect(await db.sql`SELECT id FROM ops.crm_interactions WHERE opportunity_id=${row.id}`).toHaveLength(1);
      });

      it('keeps an optional evidence reference and refuses the same one twice, while evidence-less replies can repeat', async () => {
        const row = await enquire();
        now = at(2);
        const first = await reply(row.id, iso(1), 24, { evidenceRef: 'gmail-thread-18f2' });
        expect(first.interaction.evidenceRef).toBe('gmail-thread-18f2');
        expect(first.activity.referenceId).toBe('gmail-thread-18f2');
        await expect(reply(row.id, iso(1.5), 24, { evidenceRef: 'gmail-thread-18f2' })).rejects.toMatchObject({
          code: 'ops.crm.interaction_already_recorded',
        });
        await reply(row.id, iso(1.5), 24);
        await reply(row.id, iso(1.75), 24);
        expect(await db.sql`SELECT id FROM ops.crm_interactions WHERE opportunity_id=${row.id}`).toHaveLength(3);
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(1), lastTouchAt: iso(1.75) });
      });

      it('refuses a stale revision, a future time, a closed enquiry and anyone who is not a founder', async () => {
        const row = await enquire();
        now = at(2);
        const input = {
          requestId: randomUUID(),
          opportunityId: row.id,
          expectedRevision: row.revision,
          kind: 'reply_sent' as const,
          occurredAt: iso(1),
          nextAction: { description: 'Check in', dueAt: iso(30) },
          reason: 'Replied',
        };
        await expect(crm.recordInteraction({ ...input, expectedRevision: row.revision + 5 }, founders[0])).rejects.toMatchObject({
          code: 'ops.crm.revision_conflict',
        });
        await expect(crm.recordInteraction({ ...input, occurredAt: iso(2.5) }, founders[0])).rejects.toMatchObject({
          code: 'ops.crm.interaction_in_future',
        });
        await expect(crm.recordInteraction(input, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.operator_forbidden' });
        await expect(crm.recordInteraction({ ...input, reason: '' }, founders[0])).rejects.toMatchObject({ name: 'ZodError' });
        await expect(crm.recordInteraction({ ...input, nextAction: undefined } as never, founders[0])).rejects.toMatchObject({
          name: 'ZodError',
        });
        expect(await db.sql`SELECT id FROM ops.crm_interactions`).toHaveLength(0);
        await close(row.id);
        await expect(
          crm.recordInteraction({ ...input, requestId: randomUUID(), expectedRevision: (await reload(row.id)).revision }, founders[0]),
        ).rejects.toMatchObject({ code: 'ops.crm.opportunity_closed' });
      });

      it('still requires evidence for every other kind', async () => {
        const row = await enquire();
        now = at(2);
        await expect(
          crm.recordInteraction(
            {
              requestId: randomUUID(),
              opportunityId: row.id,
              expectedRevision: row.revision,
              kind: 'follow_up',
              occurredAt: iso(1),
              nextAction: { description: 'x', dueAt: iso(30) },
              reason: 'No evidence',
            } as never,
            founders[0],
          ),
        ).rejects.toMatchObject({ name: 'ZodError' });
      });
    });

    describe('waiting queue', () => {
      async function scenario() {
        const rows: Record<string, CrmOpportunityRow> = {};
        now = at(0);
        rows.A = await enquire(); // unreplied since 0h
        now = at(1);
        rows.B = await enquire(); // unreplied since 1h
        now = at(2);
        rows.C = await enquire();
        now = at(2.5);
        await reply(rows.C.id, iso(2.5), 30); // replied, next action due 30h: not waiting yet
        now = at(3);
        rows.D = await enquire();
        now = at(3.25);
        await reply(rows.D.id, iso(3.25), 4); // replied, next action due 4h: waiting from 4h
        now = at(3.5);
        rows.E = await enquire();
        await close(rows.E.id); // closed: never in the queue
        now = at(4);
        rows.F = await enquire();
        now = at(4.25);
        await reply(rows.F.id, iso(4.25), 5); // due exactly at the evaluation time
        rows.G = await enquire('trader'); // other audience, unreplied since 4.25h
        now = at(5);
        return rows;
      }
      const queueIds = async (extra: Record<string, unknown> = {}, limit = 50) =>
        (await crm.listOpportunities({ limit, queue: 'waiting', ...extra } as never)).items.map((item) => item.id);

      it('returns only open enquiries that are unreplied or due now, oldest waiting first, each with waitingSince', async () => {
        const r = await scenario();
        const page = await crm.listOpportunities({ limit: 50, queue: 'waiting' });
        expect(page.items.map((item) => [item.id, item.waitingSince])).toEqual([
          [r.A!.id, r.A!.createdAt],
          [r.B!.id, r.B!.createdAt],
          [r.D!.id, iso(4)],
          [r.G!.id, iso(4.25)],
          [r.F!.id, iso(5)],
        ]);
        expect(page.items.map((item) => item.id)).not.toContain(r.C!.id);
        expect(page.items.map((item) => item.id)).not.toContain(r.E!.id);
        // The page still names exactly the contacts and submissions it shows.
        expect(page.contacts).toHaveLength(5);
        expect(page.submissions).toHaveLength(5);
      });

      it('breaks ties on waitingSince by id, and pages without skipping or repeating', async () => {
        const r = await scenario();
        const everything = await queueIds();
        expect(everything).toHaveLength(5);
        for (const limit of [1, 2, 3]) {
          const seen: string[] = [];
          let cursor: string | undefined;
          for (let guard = 0; guard < 10; guard += 1) {
            const page = await crm.listOpportunities({ limit, queue: 'waiting', ...(cursor ? { cursor } : {}) });
            seen.push(...page.items.map((item) => item.id));
            if (page.nextCursor === null) break;
            expect(page.items).toHaveLength(limit);
            cursor = page.nextCursor;
          }
          expect(seen, `limit ${limit}`).toEqual(everything);
        }
        expect(r.A!.id).toBe(everything[0]);
      });

      it('breaks a waitingSince tie by id', async () => {
        now = at(0);
        const [x, y, z] = [await enquire(), await enquire(), await enquire()];
        const ids = [x.id, y.id, z.id].sort();
        expect(await queueIds()).toEqual(ids);
        const first = await crm.listOpportunities({ limit: 2, queue: 'waiting' });
        const second = await crm.listOpportunities({ limit: 2, queue: 'waiting', cursor: first.nextCursor! });
        expect([...first.items, ...second.items].map((item) => item.id)).toEqual(ids);
        expect(second.nextCursor).toBeNull();
      });

      it('moves an enquiry out when it is replied to, and back when its next action falls due', async () => {
        const r = await scenario();
        expect(await queueIds()).toContain(r.A!.id);
        await reply(r.A!.id, iso(5), 29);
        expect(await queueIds()).not.toContain(r.A!.id);
        expect(await queueIds()).toContain(r.F!.id);
        now = at(30);
        const back = await crm.listOpportunities({ limit: 50, queue: 'waiting' });
        expect(back.items.find((item) => item.id === r.C!.id)?.waitingSince).toBe(iso(30));
        expect(back.items.find((item) => item.id === r.A!.id)?.waitingSince).toBe(iso(29));
        const times = back.items.map((item) => Date.parse(item.waitingSince!));
        expect(times).toEqual([...times].sort((x, y) => x - y));
        expect(back.items.findIndex((item) => item.id === r.A!.id)).toBeLessThan(back.items.findIndex((item) => item.id === r.C!.id));
      });

      it('combines with the other filters', async () => {
        const r = await scenario();
        expect(await queueIds({ audience: 'trader' })).toEqual([r.G!.id]);
        expect(await queueIds({ audience: 'investor' })).not.toContain(r.G!.id);
        expect(await queueIds({ stage: 'new' })).toHaveLength(5);
        expect(await queueIds({ stage: 'qualified' })).toEqual([]);
        await crm.assign(
          { requestId: randomUUID(), opportunityId: r.B!.id, expectedRevision: (await reload(r.B!.id)).revision, ownerUserId: founders[1] },
          founders[0],
        );
        expect(await queueIds({ ownerUserId: founders[1] })).toEqual([r.B!.id]);
        expect(await queueIds({ query: 'Prospect' })).toHaveLength(5);
        expect(await queueIds({ query: 'nobody-by-this-name' })).toEqual([]);
      });

      it('keeps the default listing newest first, and refuses a cursor from the other mode', async () => {
        const r = await scenario();
        const listed = (await crm.listOpportunities({ limit: 50 })).items.map((item) => item.id);
        expect(listed[0]).toBe(r.G!.id); // newest first, as before
        expect(listed).toHaveLength(7);
        const queuePage = await crm.listOpportunities({ limit: 1, queue: 'waiting' });
        const defaultPage = await crm.listOpportunities({ limit: 1 });
        await expect(crm.listOpportunities({ limit: 1, cursor: queuePage.nextCursor! })).rejects.toMatchObject({
          code: 'ops.crm.cursor_invalid',
        });
        await expect(crm.listOpportunities({ limit: 1, queue: 'waiting', cursor: defaultPage.nextCursor! })).rejects.toMatchObject({
          code: 'ops.crm.cursor_invalid',
        });
        await expect(crm.listOpportunities({ limit: 1, queue: 'waiting', cursor: 'not-a-cursor' })).rejects.toMatchObject({
          code: 'ops.crm.cursor_invalid',
        });
        // The default page now carries reply state on each row, too.
        expect(defaultPage.items[0]).toMatchObject({ firstReplyAt: null, lastTouchAt: null, waitingSince: r.G!.createdAt });
      });

      it('refuses an unknown queue name', () => {
        expect(crmListInputSchema.safeParse({ limit: 5, queue: 'overdue' }).success).toBe(false);
      });
    });

    describe('commitment', () => {
      it('sets, replays, changes and clears a commitment: revision-checked, audited, with the exact amount', async () => {
        const row = await enquire('investor', { amount: '250000', currency: 'EUR' });
        const exact = '12345678901234567890.123456789012345678';
        now = at(1);
        const requestId = randomUUID();
        const input = {
          requestId,
          opportunityId: row.id,
          expectedRevision: (await reload(row.id)).revision,
          commitment: { tier: 'soft_circled' as const, amount: exact, currency: 'EUR', evidenceRef: 'call notes 2026-10-12' },
          reason: 'After the call',
        };
        const saved = await crm.setCommitment(input, founders[0]);
        expect(saved).toMatchObject({
          revision: input.expectedRevision + 1,
          audience: 'investor',
          stage: 'new',
          commitment: {
            tier: 'soft_circled',
            amount: exact,
            currency: 'EUR',
            evidenceRef: 'call notes 2026-10-12',
            recordedAt: iso(1),
            recordedBy: founders[0],
          },
        });
        expect(await crm.setCommitment(input, founders[0])).toEqual(saved);
        expect(await db.sql`SELECT record->'commitment'->>'amount' AS amount FROM ops.crm_opportunities WHERE id=${row.id}`).toEqual([
          { amount: exact },
        ]);
        // The questionnaire amount is untouched: indicated and confirmed money are different facts.
        expect(saved.audience === 'investor' && saved.indicativeContribution).toEqual({
          status: 'stated',
          amount: '250000',
          currency: 'EUR',
        });
        now = at(2);
        const upgraded = await setCommitment(row.id, { tier: 'committed', amount: '100000', currency: 'EUR' });
        expect(upgraded.audience === 'investor' && upgraded.commitment).toMatchObject({
          tier: 'committed',
          amount: '100000',
          recordedAt: iso(2),
        });
        expect(upgraded.audience === 'investor' && upgraded.commitment && upgraded.commitment.evidenceRef).toBe('signed agreement');
        const cleared = await setCommitment(row.id, null);
        expect(cleared.audience === 'investor' && cleared.commitment).toBeNull();
        const detail = await crm.getOpportunity({ opportunityId: row.id });
        const changes = detail!.activities.filter((a) => a.kind === 'commitment_changed');
        expect(changes.map((a) => [a.fromCommitment ?? null, a.toCommitment ?? null])).toEqual([
          [null, { tier: 'soft_circled', amount: exact, currency: 'EUR' }],
          [
            { tier: 'soft_circled', amount: exact, currency: 'EUR' },
            { tier: 'committed', amount: '100000', currency: 'EUR' },
          ],
          [{ tier: 'committed', amount: '100000', currency: 'EUR' }, null],
        ]);
        expect(changes.every((a) => crmActivitySchema.safeParse(a).success && a.note === 'After the call')).toBe(true);
        const audits = (await crm.listWorkflowAudit({ subjectType: 'opportunity', subjectId: row.id, limit: 10 })).items.filter(
          (a) => a.kind === 'commitment_changed',
        );
        expect(audits).toHaveLength(3);
        const first = audits.find((a) => a.requestId === requestId)!;
        expect(first).toMatchObject({ actorUserId: founders[0], reason: 'After the call' });
        expect(first.facts).toMatchObject({ previous: null, current: { tier: 'soft_circled', amount: exact, currency: 'EUR' } });
      });

      it('refuses any audience but investor', async () => {
        const trader = await enquire('trader');
        await expect(
          crm.setCommitment(
            {
              requestId: randomUUID(),
              opportunityId: trader.id,
              expectedRevision: trader.revision,
              commitment: { tier: 'committed', amount: '100', currency: 'EUR', evidenceRef: 'signed' },
              reason: 'Should not be possible',
            },
            founders[0],
          ),
        ).rejects.toMatchObject({ code: 'ops.crm.commitment_investor_only' });
        // Clearing a commitment that cannot exist is refused as well.
        await expect(
          crm.setCommitment(
            { requestId: randomUUID(), opportunityId: trader.id, expectedRevision: trader.revision, commitment: null, reason: 'Clear' },
            founders[0],
          ),
        ).rejects.toMatchObject({ code: 'ops.crm.commitment_investor_only' });
        expect(await reload(trader.id)).toMatchObject({ revision: trader.revision });
        expect(await db.sql`SELECT id FROM ops.crm_workflow_audit WHERE kind='commitment_changed'`).toHaveLength(0);
      });

      it('refuses a stale revision, a reused request id with other content, a non-founder and a closed enquiry', async () => {
        const row = await enquire();
        const input = {
          requestId: randomUUID(),
          opportunityId: row.id,
          expectedRevision: row.revision,
          commitment: { tier: 'soft_circled' as const, amount: '1000', currency: 'USD' },
          reason: 'After the call',
        };
        await expect(crm.setCommitment({ ...input, expectedRevision: row.revision + 1 }, founders[0])).rejects.toMatchObject({
          code: 'ops.crm.revision_conflict',
        });
        await expect(crm.setCommitment(input, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.operator_forbidden' });
        await crm.setCommitment(input, founders[0]);
        // The first save moved the revision on, so the same revision is now stale for a new request.
        await expect(crm.setCommitment({ ...input, requestId: randomUUID() }, founders[0])).rejects.toMatchObject({
          code: 'ops.crm.revision_conflict',
        });
        await expect(
          crm.setCommitment(
            { ...input, commitment: { tier: 'committed', amount: '1000', currency: 'USD', evidenceRef: 'signed' } },
            founders[0],
          ),
        ).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
        await expect(
          crm.setCommitment({ ...input, requestId: randomUUID(), expectedRevision: row.revision + 1 }, founders[1]),
        ).resolves.toBeTruthy();
        await close(row.id);
        await expect(setCommitment(row.id, { tier: 'committed', amount: '5', currency: 'USD' })).rejects.toMatchObject({
          code: 'ops.crm.opportunity_closed',
        });
        // Clearing is still allowed on a closed enquiry.
        await expect(setCommitment(row.id, null)).resolves.toBeTruthy();
      });

      it('refuses negative, non-decimal and zero amounts, unknown currencies, unknown tiers and missing reasons', async () => {
        const row = await enquire();
        const base = {
          requestId: randomUUID(),
          opportunityId: row.id,
          expectedRevision: row.revision,
          commitment: { tier: 'committed' as const, amount: '100', currency: 'EUR', evidenceRef: 'signed' },
          reason: 'After the call',
        };
        const refused = async (patch: Record<string, unknown>) =>
          crm.setCommitment({ ...base, requestId: randomUUID(), ...patch } as never, founders[0]);
        for (const amount of ['-1', '-0.01', '1e3', '1,000', ' 100', '100 ', '0', '0.0', '.5', '5.', 'ten', '', '1.1234567890123456789'])
          await expect(refused({ commitment: { ...base.commitment, amount } }), amount).rejects.toMatchObject({ name: 'ZodError' });
        await expect(refused({ commitment: { ...base.commitment, amount: 100 } })).rejects.toMatchObject({ name: 'ZodError' });
        for (const currency of ['ZZZ', 'XXX', 'BTC', 'eur', 'EURO', 'E'])
          await expect(refused({ commitment: { ...base.commitment, currency } }), currency).rejects.toMatchObject({ name: 'ZodError' });
        await expect(refused({ commitment: { ...base.commitment, tier: 'received' } })).rejects.toMatchObject({ name: 'ZodError' });
        await expect(refused({ commitment: { ...base.commitment, evidenceRef: 'x'.repeat(201) } })).rejects.toMatchObject({
          name: 'ZodError',
        });
        await expect(refused({ commitment: { ...base.commitment, recordedBy: founders[1] } })).rejects.toMatchObject({ name: 'ZodError' });
        await expect(refused({ reason: '   ' })).rejects.toMatchObject({ name: 'ZodError' });
        await expect(refused({ reason: undefined })).rejects.toMatchObject({ name: 'ZodError' });
        expect(await reload(row.id)).toMatchObject({ revision: row.revision, commitment: null });
      });

      it('survives a later stage change of the same enquiry', async () => {
        const row = await enquire('investor', 'undecided');
        await setCommitment(row.id, { tier: 'soft_circled', amount: '5', currency: 'SGD' });
        const current = await reload(row.id);
        now = at(1);
        await crm.changeStage(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: current.revision,
            stage: 'qualified',
            reason: 'Reviewed: fits',
            closedDisposition: null,
            closingEvidenceRef: null,
            nextAction: { description: 'Call', dueAt: iso(30) },
          },
          founders[0],
        );
        const after = await reload(row.id);
        expect(after.audience === 'investor' && after.commitment).toMatchObject({ tier: 'soft_circled', amount: '5', currency: 'SGD' });
      });
    });

    describe('raise totals', () => {
      it('is empty with no investors', async () => {
        await enquire('trader');
        expect(await raise()).toEqual({
          indicated: [],
          softCircled: [],
          committed: [],
          counts: { indicated: 0, softCircled: 0, committed: 0, undecided: 0 },
        });
      });

      it('sums each level and currency separately and exactly, and never counts anyone at two levels', async () => {
        const i1 = await enquire('investor', { amount: '250000', currency: 'EUR' });
        await enquire('investor', { amount: '100000.50', currency: 'EUR' });
        await enquire('investor', { amount: '50000', currency: 'USD' });
        await enquire('investor', 'undecided');
        const i5 = await enquire('investor', { amount: '1000', currency: 'EUR' }); // stated 1000 but soft-circled 300 EUR
        await enquire('trader');
        await setCommitment(i5.id, { tier: 'soft_circled', amount: '300', currency: 'EUR' });
        const i6 = await enquire('investor', 'undecided');
        await setCommitment(i6.id, { tier: 'committed', amount: '0.1', currency: 'EUR' });
        const i7 = await enquire('investor', 'undecided');
        await setCommitment(i7.id, { tier: 'committed', amount: '0.2', currency: 'EUR' });
        const i8 = await enquire('investor', 'undecided');
        await setCommitment(i8.id, { tier: 'committed', amount: '9007199254740993', currency: 'USD' });
        const i9 = await enquire('investor', 'undecided');
        await setCommitment(i9.id, { tier: 'committed', amount: '1', currency: 'USD' });
        expect(i1.audience).toBe('investor');
        expect(await raise()).toEqual({
          // 250000 + 100000.50 EUR and 50000 USD; the 1000 EUR of i5 is not here because i5 has a commitment.
          indicated: [
            { currency: 'EUR', amount: '350000.5' },
            { currency: 'USD', amount: '50000' },
          ],
          softCircled: [{ currency: 'EUR', amount: '300' }],
          // 0.1 + 0.2 is exactly 0.3, and 2^53 + 1 + 1 is exactly 9007199254740994: no float anywhere.
          committed: [
            { currency: 'EUR', amount: '0.3' },
            { currency: 'USD', amount: '9007199254740994' },
          ],
          counts: { indicated: 3, softCircled: 1, committed: 4, undecided: 1 },
        });
      });

      it('leaves out closed enquiries unless they proceeded, and a cleared commitment goes back to indicated', async () => {
        const declined = await enquire('investor', { amount: '700', currency: 'EUR' });
        await close(declined.id); // closed, declined: not indicated
        const withdrawn = await enquire('investor', { amount: '800', currency: 'EUR' });
        await setCommitment(withdrawn.id, { tier: 'committed', amount: '800', currency: 'EUR' });
        await close(withdrawn.id); // closed, declined, with a commitment: not counted
        const proceeded = await enquire('investor', { amount: '900', currency: 'EUR' });
        await setCommitment(proceeded.id, { tier: 'committed', amount: '900', currency: 'EUR' });
        const current = await reload(proceeded.id);
        await crm.changeStage(
          {
            requestId: randomUUID(),
            opportunityId: proceeded.id,
            expectedRevision: current.revision,
            stage: 'closed',
            reason: 'Documents signed',
            closedDisposition: 'proceeded',
            closingEvidenceRef: 'signed agreement',
            nextAction: null,
          },
          founders[0],
        );
        const back = await enquire('investor', { amount: '40', currency: 'EUR' });
        await setCommitment(back.id, { tier: 'soft_circled', amount: '30', currency: 'EUR' });
        expect((await raise()).indicated).toEqual([]);
        expect(await raise()).toMatchObject({
          softCircled: [{ currency: 'EUR', amount: '30' }],
          committed: [{ currency: 'EUR', amount: '900' }],
          counts: { indicated: 0, softCircled: 1, committed: 1, undecided: 0 },
        });
        await setCommitment(back.id, null);
        expect(await raise()).toMatchObject({
          indicated: [{ currency: 'EUR', amount: '40' }],
          softCircled: [],
          counts: { indicated: 1, softCircled: 0, committed: 1 },
        });
      });

      it('follows the same filters as the other totals', async () => {
        const mine = await enquire('investor', { amount: '10', currency: 'EUR' });
        await enquire('investor', { amount: '20', currency: 'EUR' });
        await crm.assign(
          { requestId: randomUUID(), opportunityId: mine.id, expectedRevision: (await reload(mine.id)).revision, ownerUserId: founders[1] },
          founders[0],
        );
        expect((await raise({ ownerUserId: founders[1] })).indicated).toEqual([{ currency: 'EUR', amount: '10' }]);
        expect((await raise({ audience: 'trader' })).indicated).toEqual([]);
        expect((await raise()).indicated).toEqual([{ currency: 'EUR', amount: '30' }]);
      });
    });

    describe('stage history', () => {
      it('records from and to on a stage change and the old and new due on a next-action edit; older entries stay as they are', async () => {
        const row = await enquire();
        now = at(1);
        await crm.changeStage(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: row.revision,
            stage: 'qualified',
            reason: 'Reviewed: fits',
            closedDisposition: null,
            closingEvidenceRef: null,
            nextAction: { description: 'Call', dueAt: iso(30) },
          },
          founders[0],
        );
        now = at(2);
        await crm.updateNextAction(
          {
            requestId: randomUUID(),
            opportunityId: row.id,
            expectedRevision: (await reload(row.id)).revision,
            description: 'Call on Thursday',
            dueAt: '2026-10-15T09:00:00+08:00',
          },
          founders[0],
        );
        const { activities } = (await crm.getOpportunity({ opportunityId: row.id }))!;
        const stage = activities.find((a) => a.kind === 'stage_changed')!;
        expect(stage).toMatchObject({ fromStage: 'new', toStage: 'qualified', note: 'Reviewed: fits' });
        const edit = activities.find((a) => a.kind === 'next_action_changed')!;
        expect(edit).toMatchObject({ fromDueAt: iso(30), toDueAt: '2026-10-15T01:00:00.000Z', referenceId: '2026-10-15T01:00:00.000Z' });
        const assigned = activities.find((a) => a.kind === 'assigned')!;
        expect('fromStage' in assigned || 'fromDueAt' in assigned).toBe(false);
        // An entry written before these fields existed still parses and reads the same.
        const stored = await db.sql`SELECT record FROM ops.crm_activities WHERE opportunity_id=${row.id} AND record->>'kind'='assigned'`;
        expect(crmActivitySchema.parse(stored[0]!.record)).toEqual(assigned);
      });
    });

    describe('migration 0006', () => {
      it('down keeps recorded replies and refuses new ones; up restores the rule', async () => {
        const row = await enquire();
        now = at(1);
        await reply(row.id, iso(1), 24);
        const sql = async (name: string) => readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8');
        await db.sql.unsafe(await sql('0006_crm_reply_commitment.down.sql'));
        expect(await db.sql`SELECT kind FROM ops.crm_interactions`).toEqual([{ kind: 'reply_sent' }]);
        await expect(
          db.sql`INSERT INTO ops.crm_interactions(id,opportunity_id,actor_user_id,kind,occurred_at,record)
          VALUES (${randomUUID()},${row.id},${founders[0]},'reply_sent',${iso(2)},${db.sql.json({})})`,
        ).rejects.toMatchObject({ code: '23514' });
        // Up again, as the runner would apply it after a down.
        await db.sql.unsafe(await sql('0006_crm_reply_commitment.sql'));
        expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(1) });
      });

      it('is registered with the runner, down then up leaves the tables usable', async () => {
        await migrateOutreach(db.sql, 'down');
        await migrateOutreach(db.sql);
        const migrations = await db.sql`SELECT name FROM ops.crm_migrations ORDER BY name`;
        expect(migrations.map((m) => m.name)).toContain('0006_crm_reply_commitment');
        await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows CASCADE`;
        crm = new OutreachCrm(db.sql, config, () => now);
        const row = await enquire();
        now = at(1);
        await reply(row.id, iso(1), 24);
        expect((await reload(row.id)).firstReplyAt).toBe(iso(1));
      });

      describe('review fixes', () => {
        it('does not count a message whose delivery failed as a reply or a touch', async () => {
          const row = await enquire();
          now = at(1);
          const queued = await crm.queueMessage(
            {
              requestId: randomUUID(),
              opportunityId: row.id,
              expectedRevision: row.revision,
              kind: 'information_request',
              staffText: 'Could you share your timing?',
              reason: 'Founder follow-up',
            },
            founders[0],
          );
          expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(1), lastTouchAt: iso(1) });
          await db.sql`UPDATE ops.crm_outbox SET status='failed' WHERE id=${queued.message.id}`;
          expect(await reload(row.id)).toMatchObject({ firstReplyAt: null, lastTouchAt: null, waitingSince: row.createdAt });
          now = at(2);
          expect((await crm.listOpportunities({ limit: 10, queue: 'waiting' })).items.map((item) => item.id)).toEqual([row.id]);
          // Unresolved is not failed: delivery is unknown, so it still counts.
          await db.sql`UPDATE ops.crm_outbox SET status='unresolved' WHERE id=${queued.message.id}`;
          expect(await reload(row.id)).toMatchObject({ firstReplyAt: iso(1) });
        });

        it('requires a reference to the documents for committed, and not for soft-circled', async () => {
          const row = await enquire();
          const base = { requestId: randomUUID(), opportunityId: row.id, expectedRevision: row.revision, reason: 'Documents signed' };
          await expect(
            crm.setCommitment({ ...base, commitment: { tier: 'committed', amount: '5', currency: 'EUR' } }, founders[0]),
          ).rejects.toMatchObject({ name: 'ZodError' });
          expect(await reload(row.id)).toMatchObject({ revision: row.revision });
          await expect(
            crm.setCommitment(
              { ...base, requestId: randomUUID(), commitment: { tier: 'soft_circled', amount: '5', currency: 'EUR' } },
              founders[0],
            ),
          ).resolves.toBeTruthy();
        });

        it('accepts an ISO currency that replaced an older one, and still the older', async () => {
          const row = await enquire();
          await setCommitment(row.id, { tier: 'soft_circled', amount: '5', currency: 'XCG' });
          await expect(setCommitment(row.id, { tier: 'soft_circled', amount: '5', currency: 'ANG' })).resolves.toBeTruthy();
        });

        it('refuses a commitment for an introduction-only investor (CONT:40), allows direct, both and unanswered, and still allows clearing', async () => {
          const introducer = await enquire('investor', 'undecided', 'introduction');
          const ask = { tier: 'soft_circled' as const, amount: '5', currency: 'EUR' };
          await expect(setCommitment(introducer.id, ask)).rejects.toMatchObject({ code: 'ops.crm.commitment_introduction_only' });
          expect(await reload(introducer.id)).toMatchObject({ revision: introducer.revision, commitment: null });
          expect(await db.sql`SELECT id FROM ops.crm_workflow_audit WHERE kind='commitment_changed'`).toHaveLength(0);
          await expect(setCommitment(introducer.id, null)).resolves.toBeTruthy();
          await expect(setCommitment((await enquire('investor', 'undecided', 'direct')).id, ask)).resolves.toBeTruthy();
          await expect(setCommitment((await enquire('investor', 'undecided', 'both')).id, ask)).resolves.toBeTruthy();
          await expect(setCommitment((await enquire('investor')).id, ask)).resolves.toBeTruthy();
        });

        it('lets metrics label any three-letter currency a visitor stated, ISO or not', async () => {
          await enquire('investor', { amount: '5', currency: 'XCG' });
          await enquire('investor', { amount: '7', currency: 'BTC' });
          await enquire('investor', { amount: '1', currency: 'ZZZ' });
          await enquire('investor', { amount: '2', currency: 'HRK' });
          const raise = (await metrics()).raise;
          expect(raise.indicated).toEqual([
            { currency: 'BTC', amount: '7' },
            { currency: 'HRK', amount: '2' },
            { currency: 'XCG', amount: '5' },
            { currency: 'ZZZ', amount: '1' },
          ]);
        });

        it('survives more than 60 currencies and sums longer than one amount', async () => {
          const code = (i: number) => String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26), 65);
          for (let i = 0; i < 62; i += 1) await enquire('investor', { amount: '1', currency: code(i) });
          const big = '999999999999999.999999999999999999';
          for (const _ of [1, 2, 3]) await enquire('investor', { amount: big, currency: 'EUR' });
          const raise = (await metrics()).raise;
          expect(raise.indicated).toHaveLength(63);
          // 3 x (10^15 - 10^-18), exact.
          expect(raise.indicated.find((t) => t.currency === 'EUR')!.amount).toBe('2999999999999999.999999999999999997');
          expect(raise.counts.indicated).toBe(65);
          await expect(enquire('investor', { amount: '1000000000000000', currency: 'EUR' })).rejects.toMatchObject({ name: 'ZodError' });
        }, 60_000);

        it('counts each person once, at their highest level and by their most recent enquiry, so a duplicate does not double the amount', async () => {
          now = at(0);
          const older = await enquire('investor', { amount: '100', currency: 'EUR' }, 'direct', 'same@example.test');
          now = at(1);
          const newer = await enquire('investor', { amount: '200', currency: 'EUR' }, 'direct', 'same@example.test');
          await enquire('investor', { amount: '10', currency: 'EUR' });
          expect((await raise()).counts).toMatchObject({ indicated: 3 });
          await crm.mergeContacts(
            {
              requestId: randomUUID(),
              sourceContactId: newer.contactId,
              targetContactId: older.contactId,
              sourceExpectedRevision: 1,
              targetExpectedRevision: 1,
              confirmed: true,
              reason: 'Same person',
            },
            founders[0],
          );
          // One person with two enquiries: their most recent stated amount, once.
          expect(await raise()).toMatchObject({ indicated: [{ currency: 'EUR', amount: '210' }], counts: { indicated: 2 } });
          // The older enquiry gets a commitment: the person is now counted once, as soft-circled, and not as indicated too.
          await setCommitment(older.id, { tier: 'soft_circled', amount: '50', currency: 'EUR' });
          expect(await raise()).toMatchObject({
            indicated: [{ currency: 'EUR', amount: '10' }],
            softCircled: [{ currency: 'EUR', amount: '50' }],
            counts: { indicated: 1, softCircled: 1, committed: 0, undecided: 0 },
          });
          // The unknown-amount duplicate of a person who has stated an amount does not count as undecided.
          now = at(2);
          const third = await enquire('investor', 'undecided', 'direct', 'same@example.test');
          await crm.mergeContacts(
            {
              requestId: randomUUID(),
              sourceContactId: third.contactId,
              targetContactId: older.contactId,
              sourceExpectedRevision: 1,
              targetExpectedRevision: (await crm.getContactProvenance({ contactId: older.contactId }))!.canonicalRevision,
              confirmed: true,
              reason: 'Same person',
            },
            founders[0],
          );
          expect((await raise()).counts).toMatchObject({ undecided: 0 });
        });

        it('walks the waiting queue one row at a time over times finer than a millisecond, without looping or repeating', async () => {
          now = at(0);
          const rows = [await enquire(), await enquire(), await enquire(), await enquire()];
          now = at(5);
          const fine = ['2026-10-12T01:00:00.1231Z', '2026-10-12T01:00:00.1235Z', '2026-10-12T01:00:00.1239Z'];
          for (const [i, dueAt] of fine.entries()) {
            const row = rows[i]!;
            await crm.recordInteraction(
              {
                requestId: randomUUID(),
                opportunityId: row.id,
                expectedRevision: (await reload(row.id)).revision,
                kind: 'reply_sent',
                occurredAt: iso(1),
                nextAction: { description: 'Check in', dueAt },
                reason: 'Replied',
              },
              founders[0],
            );
          }
          // Stored to the millisecond, whatever finer time came in.
          const stored = await db.sql`SELECT record->'nextAction'->>'dueAt' AS due FROM ops.crm_opportunities WHERE id=${rows[0]!.id}`;
          expect(stored[0]!.due).toBe('2026-10-12T01:00:00.123Z');
          const walk = async () => {
            const seen: string[] = [];
            let cursor: string | undefined;
            for (let guard = 0; guard < 12; guard += 1) {
              const page = await crm.listOpportunities({ limit: 1, queue: 'waiting', ...(cursor ? { cursor } : {}) });
              seen.push(...page.items.map((item) => item.id));
              if (page.nextCursor === null) return seen;
              cursor = page.nextCursor;
            }
            throw new Error('the walk did not terminate');
          };
          const all = (await crm.listOpportunities({ limit: 50, queue: 'waiting' })).items.map((item) => item.id);
          expect(all).toHaveLength(4);
          expect(await walk()).toEqual(all);
          // A record saved before the rule, with finer time already stored, pages exactly as well.
          await db.sql`UPDATE ops.crm_opportunities SET record=jsonb_set(record,'{nextAction,dueAt}','"2026-10-12T01:00:00.1237Z"') WHERE id=${rows[1]!.id}`;
          const legacy = (await crm.listOpportunities({ limit: 50, queue: 'waiting' })).items.map((item) => item.id);
          expect(legacy).toHaveLength(4);
          expect(await walk()).toEqual(legacy);
        });
      });
    });
  },
);
