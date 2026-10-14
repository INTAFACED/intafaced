import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { CrmOpportunity } from '@intafaced/contracts';
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
const now = new Date('2026-10-09T14:00:00Z');
const captureInput = (sourceKey?: string) => ({
  requestId: randomUUID(),
  continuationToken: randomBytes(32).toString('base64url'),
  ...(sourceKey ? { sourceKey } : {}),
  contact: { name: 'Prospect', email: 'prospect@example.test', interests: ['investor' as const], marketingOptIn: false },
});
const campaignInput = (name = 'Outreach') => ({
  requestId: randomUUID(),
  id: randomUUID(),
  expectedRevision: 0,
  name,
  channel: 'deck',
  status: 'active' as const,
  documentRef: 'approved-deck',
  providerLinkId: null,
  reason: 'Record the explicit outreach campaign',
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('founder CRM workflows on real PostgreSQL', () => {
  let db: TestDatabase;
  let crm: OutreachCrm;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'ops' });
    await migrateOutreach(db.sql);
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE ops.crm_contacts,ops.crm_organisations,ops.crm_rate_windows,ops.crm_campaigns,ops.crm_workflow_audit CASCADE`;
    crm = new OutreachCrm(db.sql, config, () => now);
  });
  afterAll(async () => {
    await db.drop();
  });
  it('resolves explicit source mappings at capture, preserving historical attribution after mapping edits and restart', async () => {
    expect(crm.owners()).toEqual({
      ownerUserIds: founders,
      initialOwnerUserId: founders[0],
      owners: [
        { userId: founders[0], displayName: 'Nitro' },
        { userId: founders[1], displayName: 'Phantom' },
      ],
    });
    const first = await crm.upsertCampaign(campaignInput(), founders[0]);
    const second = await crm.upsertCampaign(campaignInput('Next campaign'), founders[1]);
    const sourceKey = 'approved_source_1234';
    const mapping = await crm.upsertSourceMapping(
      {
        requestId: randomUUID(),
        id: randomUUID(),
        expectedRevision: 0,
        sourceKey,
        campaignId: first.id,
        status: 'active',
        reason: 'Map the approved source hint',
      },
      founders[0],
    );
    const saved = await crm.capture(captureInput(sourceKey), 'source-test');
    const opportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    expect((await crm.getContactProvenance({ contactId: opportunity.contactId }))?.firstKnownSource).toMatchObject({
      campaign: { id: first.id },
      sourceMappingId: mapping.id,
      recipientLinkage: 'unknown',
    });
    await crm.upsertSourceMapping(
      {
        requestId: randomUUID(),
        id: mapping.id,
        expectedRevision: 1,
        sourceKey,
        campaignId: second.id,
        status: 'active',
        reason: 'Use the new campaign only for future captures',
      },
      founders[0],
    );
    const restartedSql = postgres(db.url, { max: 1 });
    try {
      const restarted = new OutreachCrm(restartedSql, config, () => now);
      const exported = await restarted.exportSubmissions({ requestId: randomUUID(), limit: 1 }, founders[0]);
      expect(exported.items[0]?.submission.submissionId).toBe(saved.submissionId);
      expect(exported.items[0]?.attribution.campaign?.id).toBe(first.id);
      expect((await restarted.listSourceMappings({ limit: 10 })).items[0]?.campaignId).toBe(second.id);
    } finally {
      await restartedSql.end();
    }
  });
  it('counts persisted pipeline/source facts and overdue work without inventing document analytics', async () => {
    const campaign = await crm.upsertCampaign(campaignInput(), founders[0]);
    const sourceKey = 'metrics_source_1234';
    await crm.upsertSourceMapping(
      {
        requestId: randomUUID(),
        id: randomUUID(),
        expectedRevision: 0,
        sourceKey,
        campaignId: campaign.id,
        status: 'active',
        reason: 'Campaign reporting mapping',
      },
      founders[0],
    );
    const firstInput = captureInput(sourceKey);
    await crm.capture({ ...firstInput, contact: { ...firstInput.contact, interests: ['investor', 'merchant'] } }, 'metrics-a');
    const secondInput = captureInput('unknown_source_1234');
    await crm.capture({ ...secondInput, contact: { ...secondInput.contact, interests: ['academy'] } }, 'metrics-b');
    const investor = (await crm.listOpportunities({ limit: 10, audience: 'investor' })).items[0]!;
    await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: investor.id,
        expectedRevision: investor.revision,
        stage: 'qualified',
        reason: 'Founder reviewed the enquiry',
        closedDisposition: null,
        closingEvidenceRef: null,
        nextAction: { description: 'Request more information', dueAt: '2026-10-10T12:00:00Z' },
      },
      founders[0],
    );
    const metrics = await crm.metrics({});
    expect(metrics.totals).toMatchObject({
      opportunities: 3,
      submissions: 2,
      canonicalContacts: 2,
      incompleteSubmissions: 2,
      overdueTasks: 0,
      manualCallInvitations: 0,
      manualCallBookings: 0,
    });
    expect(metrics.byAudience).toEqual(
      expect.arrayContaining([
        { audience: 'investor', count: 1 },
        { audience: 'merchant', count: 1 },
        { audience: 'academy', count: 1 },
      ]),
    );
    expect(metrics.byStage).toContainEqual({ audience: 'investor', stage: 'qualified', count: 1 });
    expect(metrics.bySource).toContainEqual({ sourceKey, campaignId: campaign.id, count: 2 });
    expect(metrics.bySource).toContainEqual({ sourceKey: 'unknown_source_1234', campaignId: null, count: 1 });
    expect((await crm.metrics({ audience: 'investor' })).totals.opportunities).toBe(1);
    expect((await crm.metrics({ campaignId: campaign.id })).totals.submissions).toBe(1);
    const later = new OutreachCrm(db.sql, config, () => new Date('2026-10-13T12:00:00Z'));
    expect((await later.metrics({})).totals.overdueTasks).toBe(3);
  });

  it('serializes opposing duplicate merges while retaining every original submission and amount', async () => {
    const aInput = { ...captureInput(), contact: { ...captureInput().contact, organisationName: 'Original A organisation' } },
      bInput = {
        ...captureInput(),
        contact: { ...captureInput().contact, name: 'Second claimant', organisationName: 'Original B organisation' },
      };
    const a = await crm.capture(aInput, 'merge-a'),
      b = await crm.capture(bInput, 'merge-b');
    await crm.answer(
      {
        requestId: randomUUID(),
        submissionId: a.submissionId,
        continuationToken: aInput.continuationToken,
        expectedRevision: 1,
        questionnaire: {
          audience: 'investor',
          version: 1,
          answers: {
            investorType: 'individual',
            participation: 'direct',
            decisionRole: 'decision_maker',
            indicativeContribution: { status: 'stated', amount: '999999999999999.000000000000000001', currency: 'USD' },
            timing: 'later',
          },
        },
      },
      'merge-a',
    );
    const opportunities = (await crm.listOpportunities({ limit: 10 })).items;
    const aContact = opportunities.find((o) => o.submissionId === a.submissionId)!.contactId,
      bContact = opportunities.find((o) => o.submissionId === b.submissionId)!.contactId;
    const duplicatePage = await crm.listDuplicates({ limit: 1 });
    expect(duplicatePage.items).toHaveLength(1);
    expect(duplicatePage.items[0]?.matchingUnmergedContactCount).toBe(2);
    expect(duplicatePage.nextCursor).not.toBeNull();
    const secondPage = await crm.listDuplicates({ limit: 1, cursor: duplicatePage.nextCursor! });
    expect(secondPage.items[0]?.contact.id).not.toBe(duplicatePage.items[0]?.contact.id);
    const results = await Promise.allSettled([
      crm.mergeContacts(
        {
          requestId: randomUUID(),
          sourceContactId: aContact,
          targetContactId: bContact,
          sourceExpectedRevision: 1,
          targetExpectedRevision: 1,
          confirmed: true,
          reason: 'Founder reviewed both originals and confirmed one person',
        },
        founders[0],
      ),
      crm.mergeContacts(
        {
          requestId: randomUUID(),
          sourceContactId: bContact,
          targetContactId: aContact,
          sourceExpectedRevision: 1,
          targetExpectedRevision: 1,
          confirmed: true,
          reason: 'Competing founder review',
        },
        founders[1],
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Expected merge receipt');
    expect((await crm.listDuplicates({ limit: 10 })).items).toHaveLength(0);
    const mergedPage = await crm.listOpportunities({ limit: 10 });
    expect(mergedPage.contacts).toHaveLength(1);
    expect(mergedPage.submissions).toEqual(
      expect.arrayContaining([
        { submissionId: a.submissionId, completedAt: now.toISOString(), organisationName: 'Original A organisation' },
        { submissionId: b.submissionId, completedAt: null, organisationName: 'Original B organisation' },
      ]),
    );
    const exported = await crm.exportSubmissions({ requestId: randomUUID(), limit: 10 }, founders[0]);
    expect(exported.items).toHaveLength(2);
    expect(new Set(exported.items.map((r) => r.originalContact.id)).size).toBe(2);
    expect(exported.items.every((r) => r.canonicalContact.id === winner.value.targetContactId)).toBe(true);
    expect(
      exported.items.every((r) => r.originalContact.emailEvidence.status === 'unverified' && r.canonicalContact.platformIdentity === null),
    ).toBe(true);
    const originalA = exported.items.find((r) => r.submission.submissionId === a.submissionId)!;
    expect(originalA.submission.contactId).toBe(aContact);
    expect(originalA.submission.questionnaires[0]).toMatchObject({
      answers: { indicativeContribution: { status: 'stated', amount: '999999999999999.000000000000000001', currency: 'USD' } },
    });
    expect(
      (await crm.resume({ submissionId: a.submissionId, continuationToken: aInput.continuationToken }, 'merge-a')).questionnaires,
    ).toEqual(originalA.submission.questionnaires);
    const metrics = await crm.metrics({});
    expect(metrics.totals).toMatchObject({ canonicalContacts: 1, submissions: 2, opportunities: 2 });
    const history = await crm.listWorkflowAudit({ subjectType: 'contact', subjectId: winner.value.sourceContactId, limit: 10 });
    expect(history.items[0]).toMatchObject({ kind: 'contacts_merged', actorUserId: expect.stringMatching(new RegExp(founders.join('|'))) });
  });
  it('finds a merged-away contact by its old name or email and names it, but only when the visible contact does not match', async () => {
    const keep = { ...captureInput(), contact: { ...captureInput().contact, name: 'Ada Lovelace', email: 'ada@example.test' } },
      gone = { ...captureInput(), contact: { ...captureInput().contact, name: 'Augusta Byron', email: 'augusta@old.example.test' } },
      other = { ...captureInput(), contact: { ...captureInput().contact, name: 'Grace Hopper', email: 'grace@example.test' } };
    await crm.capture(keep, 'alias-keep');
    await crm.capture(gone, 'alias-gone');
    await crm.capture(other, 'alias-other');
    const contactOf = async (email: string) => (await db.sql`SELECT id,revision FROM ops.crm_contacts WHERE record->>'email'=${email}`)[0]!;
    const source = await contactOf('augusta@old.example.test'),
      target = await contactOf('ada@example.test');
    await crm.mergeContacts(
      {
        requestId: randomUUID(),
        sourceContactId: String(source.id),
        targetContactId: String(target.id),
        sourceExpectedRevision: source.revision,
        targetExpectedRevision: target.revision,
        confirmed: true,
        reason: 'Founder confirmed one person',
      },
      founders[0],
    );
    const visibleName = async (query: string) => {
      const page = await crm.listOpportunities({ limit: 10, query });
      return { page, names: page.items.map((o) => page.contacts.find((c) => c.id === o.contactId)?.name) };
    };
    // Merging moves both enquiries under the surviving contact; the old name finds them and each row says so.
    const old = await visibleName('augusta');
    expect(old.names).toEqual(['Ada Lovelace', 'Ada Lovelace']);
    expect(old.page.aliasMatches).toEqual(
      expect.arrayContaining(old.page.items.map((item) => ({ opportunityId: item.id, name: 'Augusta Byron' }))),
    );
    expect(old.page.aliasMatches).toHaveLength(2);
    // The old email works too, case-insensitively.
    const byEmail = await visibleName('AUGUSTA@OLD');
    expect(byEmail.names).toHaveLength(2);
    expect(byEmail.page.aliasMatches?.map((match) => match.name)).toEqual(['Augusta Byron', 'Augusta Byron']);
    // A match on the visible contact is a direct match: no "also".
    const direct = await visibleName('lovelace');
    expect(direct.names).toEqual(['Ada Lovelace', 'Ada Lovelace']);
    expect(direct.page.aliasMatches).toBeUndefined();
    // When the old and the surviving contact both match, the match is direct. No-match searches carry nothing.
    expect((await visibleName('example.test')).page.aliasMatches).toBeUndefined();
    const none = await visibleName('zzz-nobody');
    expect(none.names).toEqual([]);
    expect(none.page.aliasMatches).toBeUndefined();
    // Wildcards stay literal, and an alias match respects the other filters.
    expect((await visibleName('%')).names).toEqual([]);
    expect((await crm.listOpportunities({ limit: 10, query: 'augusta', audience: 'merchant' })).items).toEqual([]);
    expect((await crm.listOpportunities({ limit: 10 })).aliasMatches).toBeUndefined();
  });
  it('requires reviewed investor answers before calls and audits raced task completion with manual evidence', async () => {
    const input = captureInput();
    const receipt = await crm.capture(input, 'calls');
    let opportunity: CrmOpportunity = (await crm.listOpportunities({ limit: 10 })).items[0]!;
    const planned = {
      requestId: randomUUID(),
      opportunityId: opportunity.id,
      expectedRevision: opportunity.revision,
      ownerUserId: founders[0],
      description: 'Prepare investor invitation',
      dueAt: '2026-10-10T12:00:00Z',
      kind: 'call_invitation' as const,
      reason: 'Plan the next reviewed conversation',
    };
    await expect(crm.createTask(planned, founders[0])).rejects.toMatchObject({ code: 'ops.crm.investor_review_required' });
    opportunity = await crm.changeStage(
      {
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: opportunity.revision,
        stage: 'qualified',
        reason: 'Founder reviewed fit',
        closedDisposition: null,
        closingEvidenceRef: null,
        nextAction: { description: 'Get investor information', dueAt: '2026-10-10T12:00:00Z' },
      },
      founders[0],
    );
    await expect(
      crm.createTask({ ...planned, requestId: randomUUID(), expectedRevision: opportunity.revision }, founders[0]),
    ).rejects.toMatchObject({ code: 'ops.crm.investor_review_required' });
    await crm.answer(
      {
        requestId: randomUUID(),
        submissionId: receipt.submissionId,
        continuationToken: input.continuationToken,
        expectedRevision: 1,
        questionnaire: {
          audience: 'investor',
          version: 1,
          answers: {
            investorType: 'fund',
            participation: 'direct',
            decisionRole: 'adviser',
            indicativeContribution: { status: 'stated', amount: '0.000000000000000001', currency: 'USD' },
            timing: 'later',
          },
        },
      },
      'calls',
    );
    opportunity = (await crm.getOpportunity({ opportunityId: opportunity.id }))!.opportunity;
    const create = { ...planned, requestId: randomUUID(), expectedRevision: opportunity.revision };
    const task = await crm.createTask(create, founders[0]);
    expect(await crm.createTask(create, founders[0])).toEqual(task);
    const interaction = await crm.recordInteraction(
      {
        requestId: randomUUID(),
        opportunityId: opportunity.id,
        expectedRevision: task.opportunity.revision,
        kind: 'call_invited',
        occurredAt: now.toISOString(),
        evidenceRef: 'manual-invitation-1234',
        nextAction: { description: 'Await a reply to the recorded invitation', dueAt: '2026-10-13T12:00:00Z' },
        reason: 'Record the manually confirmed invitation',
      },
      founders[0],
    );
    expect(interaction.interaction.status).toBe('manually_recorded');
    expect(interaction.opportunity).toMatchObject({
      audience: 'investor',
      indicativeContribution: { status: 'stated', amount: '0.000000000000000001', currency: 'USD' },
    });
    const raced = await Promise.allSettled([
      crm.transitionTask(
        {
          requestId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: interaction.opportunity.revision,
          taskId: task.task.task.id,
          expectedTaskRevision: task.task.revision,
          status: 'completed',
          reason: 'The recorded invitation completes this plan',
        },
        founders[0],
      ),
      crm.transitionTask(
        {
          requestId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: interaction.opportunity.revision,
          taskId: task.task.task.id,
          expectedTaskRevision: task.task.revision,
          status: 'cancelled',
          reason: 'Competing cancellation',
        },
        founders[1],
      ),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const history = await crm.listWorkflowAudit({ subjectType: 'task', subjectId: task.task.task.id, limit: 10 });
    expect(history.items.filter((r) => r.kind === 'task_transitioned')).toHaveLength(1);
    const work = await crm.listTasks({ limit: 10, opportunityId: opportunity.id });
    expect(work.items.find((t) => t.task.id === task.task.task.id)?.task.status).not.toBe('pending');
    expect(work.items.every((t) => t.createdAt !== null)).toBe(true);
    expect((await crm.metrics({})).totals).toMatchObject({ manualCallInvitations: 1, manualCallBookings: 0 });
  });
  it('extends completed selections after merge, retaining originals, first completion and restart-safe retries', async () => {
    const input = captureInput();
    const receipt = await crm.capture(input, 'extend');
    const completed = await crm.answer(
      {
        requestId: randomUUID(),
        submissionId: receipt.submissionId,
        continuationToken: input.continuationToken,
        expectedRevision: 1,
        questionnaire: {
          audience: 'investor',
          version: 1,
          answers: {
            investorType: 'individual',
            participation: 'direct',
            decisionRole: 'decision_maker',
            indicativeContribution: { status: 'undecided' },
            timing: 'later',
          },
        },
      },
      'extend',
    );
    const other = await crm.capture(captureInput(), 'extend-other');
    const opportunities = (await crm.listOpportunities({ limit: 10 })).items;
    const original = opportunities.find((o) => o.submissionId === receipt.submissionId)!;
    const target = opportunities.find((o) => o.submissionId === other.submissionId)!;
    await crm.mergeContacts(
      {
        requestId: randomUUID(),
        sourceContactId: original.contactId,
        targetContactId: target.contactId,
        sourceExpectedRevision: 1,
        targetExpectedRevision: 1,
        confirmed: true,
        reason: 'Founder confirmed this duplicate',
      },
      founders[0],
    );
    const extension = {
      requestId: randomUUID(),
      submissionId: receipt.submissionId,
      continuationToken: input.continuationToken,
      expectedRevision: completed.revision,
      interests: ['academy' as const],
    };
    await expect(
      crm.addInterests({ ...extension, continuationToken: randomBytes(32).toString('base64url') }, 'extend'),
    ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
    const changed = await crm.addInterests(extension, 'extend');
    expect(changed.contact.interests).toEqual(['investor', 'academy']);
    expect(changed.completedAt).toBeNull();
    expect(changed.questionnaires).toEqual(completed.questionnaires);
    const reopenedSql = postgres(db.url, { max: 1 });
    try {
      const reopened = new OutreachCrm(reopenedSql, config, () => now);
      expect(await reopened.addInterests(extension, 'extend')).toEqual(changed);
      const rows = (await reopened.listOpportunities({ limit: 10 })).items.filter((o) => o.submissionId === receipt.submissionId);
      expect(rows).toHaveLength(2);
      expect(rows.every((o) => o.contactId === target.contactId)).toBe(true);
      const exported = (await reopened.exportSubmissions({ requestId: randomUUID(), limit: 10 }, founders[0])).items.find(
        (r) => r.submission.submissionId === receipt.submissionId,
      )!;
      expect(exported.initialContact.interests).toEqual(['investor']);
      expect(exported.originalContact.id).toBe(original.contactId);
      expect(exported.firstCompletedAt).toBe(completed.completedAt);
      expect(exported.submission.completedAt).toBeNull();
      const finished = await reopened.answer(
        {
          requestId: randomUUID(),
          submissionId: receipt.submissionId,
          continuationToken: input.continuationToken,
          expectedRevision: changed.revision,
          questionnaire: {
            audience: 'academy',
            version: 1,
            answers: { learningGoal: 'Learn markets', experience: 'beginner', subjects: ['risk'], format: 'self_paced', timing: 'later' },
          },
        },
        'extend',
      );
      expect(finished.completedAt).toBe(now.toISOString());
      expect(finished.questionnaires[0]).toEqual(completed.questionnaires[0]);
      const finalExport = (await reopened.exportSubmissions({ requestId: randomUUID(), limit: 10 }, founders[0])).items.find(
        (r) => r.submission.submissionId === receipt.submissionId,
      )!;
      expect(finalExport.firstCompletedAt).toBe(completed.completedAt);

      await expect(reopened.addInterests({ ...extension, interests: ['partner'] }, 'extend')).rejects.toMatchObject({
        code: 'ops.crm.idempotency_conflict',
      });
      await expect(reopened.addInterests({ ...extension, requestId: randomUUID() }, 'extend')).rejects.toMatchObject({
        code: 'ops.crm.revision_conflict',
      });
    } finally {
      await reopenedSql.end();
    }
  });
  it('bounds exports, authenticates actor-bound replays and rejects mismatched cursor filters', async () => {
    await crm.capture(captureInput(), 'export-a');
    await crm.capture(captureInput(), 'export-b');
    const request = { requestId: randomUUID(), limit: 1 };
    const first = await crm.exportSubmissions(request, founders[0]);
    expect(first.items).toHaveLength(1);
    expect(await crm.exportSubmissions(request, founders[0])).toEqual(first);
    await expect(crm.exportSubmissions(request, founders[1])).rejects.toMatchObject({ code: 'ops.crm.idempotency_conflict' });
    await expect(crm.exportSubmissions(request, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.operator_forbidden' });
    const second = await crm.exportSubmissions({ requestId: randomUUID(), limit: 1, cursor: first.nextCursor! }, founders[0]);
    expect(second.items[0]!.submission.submissionId).not.toBe(first.items[0]!.submission.submissionId);
    expect(second.nextCursor).toBeNull();
    await expect(
      crm.exportSubmissions({ requestId: randomUUID(), limit: 1, cursor: first.nextCursor!, audience: 'merchant' }, founders[0]),
    ).rejects.toMatchObject({ code: 'ops.crm.cursor_invalid' });
    await expect(crm.exportSubmissions({ requestId: randomUUID(), limit: 201 }, founders[0])).rejects.toMatchObject({ name: 'ZodError' });
    expect(JSON.stringify(first)).not.toContain('continuationToken');
    expect(JSON.stringify(first)).not.toContain('capability_hash');
  });
  it('serializes interest extensions against each other and canonical merges', async () => {
    const input = captureInput(),
      a = await crm.capture(input, 'extend-race');
    const b = await crm.capture(captureInput(), 'extend-target');
    const opportunities = (await crm.listOpportunities({ limit: 10 })).items;
    const original = opportunities.find((o) => o.submissionId === a.submissionId)!;
    const target = opportunities.find((o) => o.submissionId === b.submissionId)!;
    const results = await Promise.allSettled([
      crm.addInterests(
        {
          requestId: randomUUID(),
          submissionId: a.submissionId,
          continuationToken: input.continuationToken,
          expectedRevision: 1,
          interests: ['academy'],
        },
        'extend-race',
      ),
      crm.addInterests(
        {
          requestId: randomUUID(),
          submissionId: a.submissionId,
          continuationToken: input.continuationToken,
          expectedRevision: 1,
          interests: ['partner'],
        },
        'extend-race',
      ),
      crm.mergeContacts(
        {
          requestId: randomUUID(),
          sourceContactId: original.contactId,
          targetContactId: target.contactId,
          sourceExpectedRevision: 1,
          targetExpectedRevision: 1,
          confirmed: true,
          reason: 'Reviewed duplicate with concurrent public continuation',
        },
        founders[0],
      ),
    ]);
    expect(results.slice(0, 2).filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results[2]!.status).toBe('fulfilled');
    const current = await crm.resume({ submissionId: a.submissionId, continuationToken: input.continuationToken }, 'extend-race');
    expect(current.contact.interests).toHaveLength(2);
    const final = (await crm.listOpportunities({ limit: 10 })).items.filter((o) => o.submissionId === a.submissionId);
    expect(final).toHaveLength(2);
    expect(final.every((o) => o.contactId === target.contactId)).toBe(true);
    expect((await crm.listTasks({ limit: 10, status: 'pending' })).items).toHaveLength(3);
  });
  it('upgrades existing primary tasks without inventing their creation timestamps', async () => {
    await crm.capture(captureInput(), 'legacy-upgrade');
    const previous = (await crm.listTasks({ limit: 10 })).items[0]!;
    const down = await readFile(new URL('../../drizzle/0001_crm_workflows.down.sql', import.meta.url), 'utf8');
    const retentionDown = await readFile(new URL('../../drizzle/0004_crm_retention.down.sql', import.meta.url), 'utf8');
    await db.sql.begin(async (tx) => {
      await tx.unsafe(retentionDown);
      await tx`DELETE FROM ops.crm_migrations WHERE name='0004_crm_retention'`;
      await tx.unsafe(down);
      await tx`DELETE FROM ops.crm_migrations WHERE name='0001_crm_workflows'`;
    });
    await migrateOutreach(db.sql);
    const upgraded = (await crm.listTasks({ limit: 10 })).items[0]!;
    expect(upgraded.task).toEqual(previous.task);
    expect(upgraded.createdAt).toBeNull();
    expect(upgraded.revision).toBe(1);
    expect(upgraded.kind).toBe('next_action');
    await migrateOutreach(db.sql);
    expect((await crm.listTasks({ limit: 10 })).items).toHaveLength(1);
  });
});
