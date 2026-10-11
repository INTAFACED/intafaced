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
});
