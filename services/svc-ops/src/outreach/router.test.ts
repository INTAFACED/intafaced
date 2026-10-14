import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { OutreachCrm } from './crm.js';
import { OutreachError } from './config.js';
import { createOutreachRouter } from './router.js';

const userId = randomUUID();
const context: Context = {
  principal: {
    userId,
    sub: userId,
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
describe('private CRM router authority boundary', () => {
  it('anonymous and ordinary scoped callers cannot read CRM records', async () => {
    const crm = new OutreachCrm(null, null);
    const authority = vi.fn(async () => {
      throw new OutreachError('ops.crm.operator_forbidden');
    });
    const api = createOutreachRouter(crm, authority);
    await expect(api.createCaller({ ...context, principal: null }).listOpportunities({ limit: 10 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(authority).not.toHaveBeenCalled();
    await expect(api.createCaller(context).getOpportunity({ opportunityId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authority).toHaveBeenCalledOnce();
  });
  it('rechecks live authority before every request and mutation replay', async () => {
    const crm = new OutreachCrm(null, null);
    const assign = vi.spyOn(crm, 'assign').mockImplementation(async () => {
      throw new OutreachError('ops.crm.storage_unconfigured');
    });
    let enabled = true;
    const authority = vi.fn(async () => {
      if (!enabled) throw new OutreachError('ops.crm.operator_forbidden');
      return userId;
    });
    const caller = createOutreachRouter(crm, authority).createCaller(context);
    const input = { requestId: randomUUID(), opportunityId: randomUUID(), expectedRevision: 1, ownerUserId: userId };
    await expect(caller.assign(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(assign).toHaveBeenCalledWith(input, userId);
    enabled = false;
    await expect(caller.assign(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authority).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledOnce();
  });
  it('read scopes cannot acquire write authority through founder entitlement', async () => {
    const authority = vi.fn(async () => userId);
    const caller = createOutreachRouter(new OutreachCrm(null, null), authority).createCaller({
      ...context,
      principal: { ...context.principal!, scopes: ['ops:read'] },
    });
    await expect(caller.addNote({ requestId: randomUUID(), opportunityId: randomUUID(), note: 'Test' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(authority).not.toHaveBeenCalled();
  });
  it('keeps the next-action edit and the sent message text founder-only', async () => {
    const crm = new OutreachCrm(null, null);
    const edit = vi.spyOn(crm, 'updateNextAction').mockImplementation(async () => {
      throw new OutreachError('ops.crm.storage_unconfigured');
    });
    const list = vi.spyOn(crm, 'listMessages').mockImplementation(async () => {
      throw new OutreachError('ops.crm.storage_unconfigured');
    });
    const input = {
      requestId: randomUUID(),
      opportunityId: randomUUID(),
      expectedRevision: 1,
      description: 'Send the deck',
      dueAt: '2026-10-14T09:00:00.000Z',
    };
    const reads = { opportunityId: input.opportunityId, limit: 10 };
    // No sign-in, and a read-only token, never reach the service.
    const anonymous = createOutreachRouter(
      crm,
      vi.fn(async () => userId),
    ).createCaller({ ...context, principal: null });
    await expect(anonymous.updateNextAction(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonymous.listMessages(reads)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const readOnly = createOutreachRouter(
      crm,
      vi.fn(async () => userId),
    ).createCaller({
      ...context,
      principal: { ...context.principal!, scopes: ['ops:read'] },
    });
    await expect(readOnly.updateNextAction(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A signed-in user who is not a founder is refused before either call.
    const notFounder = createOutreachRouter(crm, async () => {
      throw new OutreachError('ops.crm.operator_forbidden');
    }).createCaller(context);
    await expect(notFounder.updateNextAction(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(notFounder.listMessages(reads)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(edit).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    // A founder reaches the service, and the edit carries the authenticated user, never one the caller names.
    const founder = createOutreachRouter(crm, async () => userId).createCaller(context);
    await expect(founder.updateNextAction(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(edit).toHaveBeenCalledWith(input, userId);
    await expect(founder.updateNextAction({ ...input, actorUserId: randomUUID() } as never)).rejects.toThrow();
    await expect(founder.listMessages(reads)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(edit).toHaveBeenCalledOnce();
  });
  it('rechecks founder authority for exports, workflow reads and unavailable provider surfaces', async () => {
    const crm = new OutreachCrm(null, null);
    const exportRead = vi.spyOn(crm, 'exportSubmissions').mockRejectedValue(new OutreachError('ops.crm.storage_unconfigured'));
    let enabled = true;
    const authority = vi.fn(async () => {
      if (!enabled) throw new OutreachError('ops.crm.operator_forbidden');
      return userId;
    });
    const caller = createOutreachRouter(crm, authority).createCaller(context);
    const request = { requestId: randomUUID(), limit: 1 };
    await expect(caller.exportSubmissions(request)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(exportRead).toHaveBeenCalledWith(request, userId);
    expect(await caller.documentProviderStatus()).toEqual({ status: 'disabled', reason: 'api_access_unavailable' });
    expect(await caller.documentViews({ providerLinkId: 'document-link', limit: 10 })).toEqual({
      status: 'unavailable',
      reason: 'api_access_unavailable',
    });
    enabled = false;
    for (const call of [
      () => caller.exportSubmissions(request),
      () => caller.metrics({}),
      () => caller.listDuplicates({ limit: 10 }),
      () => caller.listTasks({ limit: 10 }),
      () => caller.listCampaigns({ limit: 10 }),
      () => caller.listSourceMappings({ limit: 10 }),
      () => caller.documentProviderStatus(),
      () => caller.documentViews({ providerLinkId: 'document-link', limit: 10 }),
      () => caller.getContactProvenance({ contactId: randomUUID() }),
      () => caller.listWorkflowAudit({ subjectType: 'contact', subjectId: randomUUID(), limit: 10 }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(exportRead).toHaveBeenCalledOnce();
    expect(authority).toHaveBeenCalledTimes(13);
  });
  it('keeps setCommitment founder-only, binds it to the signed-in user and refuses bad money before the service', async () => {
    const crm = new OutreachCrm(null, null);
    const set = vi.spyOn(crm, 'setCommitment').mockRejectedValue(new OutreachError('ops.crm.storage_unconfigured'));
    const input = {
      requestId: randomUUID(),
      opportunityId: randomUUID(),
      expectedRevision: 2,
      commitment: { tier: 'soft_circled' as const, amount: '250000', currency: 'EUR', evidenceRef: 'call notes' },
      reason: 'After the call',
    };
    const anonymous = createOutreachRouter(crm, async () => userId).createCaller({ ...context, principal: null });
    await expect(anonymous.setCommitment(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const readOnly = createOutreachRouter(crm, async () => userId).createCaller({
      ...context,
      principal: { ...context.principal!, scopes: ['ops:read'] },
    });
    await expect(readOnly.setCommitment(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const notFounder = createOutreachRouter(crm, async () => {
      throw new OutreachError('ops.crm.operator_forbidden');
    }).createCaller(context);
    await expect(notFounder.setCommitment(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(set).not.toHaveBeenCalled();
    const founder = createOutreachRouter(crm, async () => userId).createCaller(context);
    await expect(founder.setCommitment(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(set).toHaveBeenCalledWith(input, userId);
    // Bad money, an unknown currency and a smuggled identity never reach the service.
    for (const bad of [
      { ...input, commitment: { ...input.commitment, amount: '-5' } },
      { ...input, commitment: { ...input.commitment, amount: '1e6' } },
      { ...input, commitment: { ...input.commitment, amount: 250000 } },
      { ...input, commitment: { ...input.commitment, currency: 'ZZZ' } },
      { ...input, commitment: { ...input.commitment, recordedBy: userId } },
      { ...input, actorUserId: randomUUID() },
      { ...input, reason: '' },
    ])
      await expect(founder.setCommitment(bad as never)).rejects.toThrow();
    expect(set).toHaveBeenCalledOnce();
  });
  it('passes the waiting queue through and refuses a list page that lacks reply state', async () => {
    const crm = new OutreachCrm(null, null);
    const list = vi.spyOn(crm, 'listOpportunities').mockResolvedValue({
      items: [],
      contacts: [],
      submissions: [],
      nextCursor: null,
    });
    const founder = createOutreachRouter(crm, async () => userId).createCaller(context);
    expect(await founder.listOpportunities({ limit: 25, queue: 'waiting' })).toEqual({
      items: [],
      contacts: [],
      submissions: [],
      nextCursor: null,
    });
    expect(list).toHaveBeenCalledWith({ limit: 25, queue: 'waiting' });
    await expect(founder.listOpportunities({ limit: 25, queue: 'overdue' } as never)).rejects.toThrow();
    const now = '2026-10-14T01:00:00.000Z';
    const contactId = randomUUID();
    const submissionId = randomUUID();
    const row = {
      id: randomUUID(),
      contactId,
      organisationId: null,
      submissionId,
      ownerUserId: userId,
      revision: 1,
      nextAction: { description: 'Review enquiry', dueAt: now },
      closedDisposition: null,
      closingEvidenceRef: null,
      createdAt: now,
      updatedAt: now,
      audience: 'trader' as const,
      stage: 'new' as const,
    };
    const contact = {
      id: contactId,
      name: 'Ada',
      email: 'ada@example.test',
      emailEvidence: { status: 'unverified' as const },
      organisationIds: [],
      interests: ['trader' as const],
      platformIdentity: null,
      createdAt: now,
      updatedAt: now,
    };
    const page = (item: object) => ({
      items: [item],
      contacts: [contact],
      submissions: [{ submissionId, completedAt: null, organisationName: null }],
      nextCursor: null,
    });
    list.mockResolvedValue(page({ ...row, firstReplyAt: null, lastTouchAt: null, waitingSince: now }) as never);
    expect((await founder.listOpportunities({ limit: 25, queue: 'waiting' })).items[0]).toMatchObject({
      waitingSince: now,
      firstReplyAt: null,
    });
    // A service that forgets the reply state is a fault, never "nobody has replied".
    list.mockResolvedValue(page(row) as never);
    await expect(founder.listOpportunities({ limit: 25, queue: 'waiting' })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
