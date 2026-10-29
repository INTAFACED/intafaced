import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryViewBook, type ViewCaps } from './desk-views.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/** SP-desk-01 — saved views, filters, sort and search. The queue screen already calls listQueue. */

const authConfig = {
  secret: 'a-support-desk-views-test-secret-long-enough-xx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';
const OPEN = { field: 'status', op: 'eq', value: 'open' };

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-views' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-views' };
}

function service(caps: ViewCaps) {
  return new SupportService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    null,
    new MemoryViewBook(caps),
  );
}

async function desk(caps: ViewCaps = { personal: 2, shared: 2 }) {
  const support = service(caps);
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string | null, scopes = ['support:ops', 'support:read']) => router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-views' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-views' });
  const ticket = (userId: string, subject: string, body = 'Please help with this request') =>
    support.createTicket({ userId, category: 'account', subject, body });
  return { support, as, lead, ticket };
}

const save = {
  name: 'Open requests',
  expectedRevision: 0,
  shared: true,
  filter: OPEN,
  reason: 'The queue the morning shift uses',
};

describe('saved views (SP-desk-01)', () => {
  it('refuses a save while either cap is blank and stores nothing', async () => {
    const blank = await desk({ personal: null, shared: null });
    await expect(blank.lead.viewsSave(save)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.view_cap_unset support.view_shared_cap',
    });
    const agent = await blank.as(AGENT);
    await expect(agent.viewsSave({ ...save, shared: false, name: 'Mine' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.view_cap_unset support.view_personal_cap',
    });
    expect((await blank.lead.viewsList()).views).toEqual([]);
    expect((await blank.lead.viewsList()).personalCap).toEqual({ cap: null, missing: 'support.view_personal_cap' });
    expect((await blank.lead.viewsList()).sharedCap).toEqual({ cap: null, missing: 'support.view_shared_cap' });
  });

  it('a lead shares a view, another agent can read it and cannot change it', async () => {
    const d = await desk();
    const alpha = await d.ticket(CUSTOMER, 'Alpha widget', 'The alpha body');
    await d.ticket(CUSTOMER, 'Beta widget', 'Something else');
    await d.support.comment({ userId: LEAD, ticketId: alpha.id, body: 'We are looking', asOperator: true });
    const view = await d.lead.viewsSave(save);
    const agent = await d.as(AGENT);
    const list = await agent.viewsList();
    expect(list.views.map((row) => row.id)).toEqual([view.id]);
    const counts = await agent.viewsCounts();
    const listed = await agent.listAll({ limit: 50, filter: view.filter });
    expect(counts.counts).toEqual([{ viewId: view.id, count: listed.length }]);
    expect(listed.every((row) => row.status === 'open')).toBe(true);
    await expect(
      agent.viewsSave({
        ...save,
        viewId: view.id,
        expectedRevision: view.revision,
        filter: { field: 'status', op: 'eq', value: 'pending' },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'support.view_not_owner',
    });
    await expect(agent.viewsDelete({ viewId: view.id, reason: 'Not mine to remove' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'support.view_not_owner',
    });
    expect((await agent.viewsList()).views[0]?.revision).toBe(view.revision);
    await d.lead.viewsDelete({ viewId: view.id, reason: 'Shift ended' });
    expect((await agent.viewsList()).views).toEqual([]);
  });

  it('a bad field or sort refuses and leaves the list as it was', async () => {
    const d = await desk();
    const ticket = await d.ticket(CUSTOMER, 'Alpha widget');
    const before = await d.lead.listAll({ limit: 20 });
    await expect(d.lead.listAll({ limit: 20, filter: { field: 'promise', op: 'eq', value: 'soon' } })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.filter_invalid',
    });
    await expect(d.lead.listAll({ limit: 20, sort: { key: 'sla', dir: 'asc' } })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.sort_invalid',
    });
    expect(await d.lead.listAll({ limit: 20 })).toEqual(before);
    expect(before.map((row) => row.id)).toContain(ticket.id);
  });

  it('search returns only tickets this agent may see', async () => {
    const d = await desk();
    const one = await d.lead.groupsSave({ name: 'Trading', idempotencyKey: 'group-trading-views' });
    const two = await d.lead.groupsSave({ name: 'Payments', idempotencyKey: 'group-payments-views' });
    await d.lead.groupsAddMember({ groupId: one.id, userId: AGENT });
    const visible = await d.ticket(CUSTOMER, 'Alpha widget', 'Visible body');
    const hidden = await d.ticket(OTHER, 'Alpha secret', 'Hidden body');
    await d.lead.ticketSetGroup({ ticketId: visible.id, groupId: one.id });
    await d.lead.ticketSetGroup({ ticketId: hidden.id, groupId: two.id });
    const agent = await d.as(AGENT);
    const found = await agent.listAll({ limit: 20, q: 'alpha' });
    expect(found.map((row) => row.id)).toEqual([visible.id]);
  });

  it('replays one save, refuses a different payload, and refuses a third personal view past the cap', async () => {
    const d = await desk({ personal: 2, shared: 2 });
    const agent = await d.as(AGENT);
    const first = await agent.viewsSave({ ...save, shared: false, name: 'Mine' });
    const replay = await agent.viewsSave({ ...save, shared: false, name: 'Mine' });
    expect(replay).toEqual(first);
    await expect(
      agent.viewsSave({ ...save, shared: false, name: 'Mine', filter: { field: 'status', op: 'eq', value: 'pending' } }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.idempotency_conflict',
    });
    await agent.viewsSave({ ...save, shared: false, name: 'Second', expectedRevision: 0 });
    await expect(agent.viewsSave({ ...save, shared: false, name: 'Third', expectedRevision: 0 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.view_cap_reached',
    });
    await expect(
      agent.viewsSave({ ...save, shared: false, name: 'Mine', expectedRevision: 4, filter: first.filter }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.view_revision_stale',
    });
  });

  it('an agent cannot share a view, and a queue filter still hides claimed tickets', async () => {
    const d = await desk();
    const agent = await d.as(AGENT);
    await expect(agent.viewsSave(save)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'support.not_lead' });
    const open = await d.ticket(CUSTOMER, 'Still open');
    const claimed = await d.ticket(CUSTOMER, 'Already claimed');
    await d.lead.claim({ ticketId: claimed.id });
    const either = { any: [OPEN, { field: 'status', op: 'eq', value: 'pending' }] };
    const queue = await d.lead.listQueue({ limit: 20, filter: either });
    expect(queue.status === 'ok' && queue.entries.map((row) => row.ticketId)).toEqual([open.id]);
    const all = await d.lead.listAll({ limit: 20, filter: either });
    expect(all.map((row) => row.id).sort()).toEqual([open.id, claimed.id].sort());
  });

  it('matches priority, label, waiting side and a time bound', async () => {
    const d = await desk();
    const marked = await d.ticket(CUSTOMER, 'Labelled');
    await d.lead.setProperties({
      ticketId: marked.id,
      priority: 'high',
      labels: ['vip'],
      clientRequestId: 'props-vip-1',
      reason: 'Owner set it',
    });
    await d.support.comment({ userId: LEAD, ticketId: marked.id, body: 'Noted', asOperator: true });
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const matched = await d.lead.listAll({
      limit: 20,
      filter: {
        all: [
          { field: 'priority', op: 'eq', value: 'high' },
          { field: 'labels', op: 'eq', value: 'vip' },
          { field: 'waiting_on', op: 'eq', value: 'customer' },
          { field: 'created', op: 'before', value: later },
        ],
      },
    });
    expect(matched.map((row) => row.id)).toEqual([marked.id]);
    await expect(d.lead.listAll({ limit: 20, filter: { field: 'labels', op: 'eq', value: 'two words' } })).rejects.toMatchObject({
      message: 'support.filter_invalid',
    });
  });

  it('matches a category and refuses one the desk does not offer (J-support-public-10 #2)', async () => {
    const d = await desk();
    const trading = await d.support.createTicket({ userId: CUSTOMER, category: 'trading', subject: 'Order stuck', body: 'Please help' });
    await d.ticket(CUSTOMER, 'Account question');
    const queue = await d.lead.listQueue({ limit: 20, filter: { field: 'category', op: 'eq', value: 'trading' } });
    expect(queue.status === 'ok' && queue.entries.map((row) => row.ticketId)).toEqual([trading.id]);
    await expect(d.lead.listQueue({ limit: 20, filter: { field: 'category', op: 'eq', value: 'refunds' } })).rejects.toMatchObject({
      message: 'support.filter_invalid',
    });
    await expect(d.lead.listQueue({ limit: 20, filter: { field: 'category', op: 'eq', value: null } })).rejects.toMatchObject({
      message: 'support.filter_invalid',
    });
  });
});

describe('MemoryViewBook', () => {
  it('replays a live create, then saves the same name as a new view after delete', async () => {
    const book = new MemoryViewBook({ personal: 2, shared: 1 });
    const input = {
      name: 'Mine',
      ownerId: AGENT,
      expectedRevision: 0,
      shared: false,
      filter: OPEN,
      sort: null,
      layout: null,
      favourite: false,
      reason: 'My queue',
      at: '2026-10-23T01:00:00.000Z',
    };
    const first = await book.save(input);
    expect(await book.save(input)).toEqual(first);
    expect(await book.listVisible(AGENT)).toEqual([first]);
    await book.remove({ viewId: first.id, actorId: AGENT, reason: 'Clearing it', at: input.at });
    expect(await book.get(first.id)).toBeNull();
    const second = await book.save(input);
    expect(second.id).not.toBe(first.id);
    expect(await book.save(input)).toEqual(second);
    expect(await book.listVisible(AGENT)).toEqual([second]);
    await expect(book.save({ ...input, reason: 'A different reason' })).rejects.toMatchObject({ code: 'support.idempotency_conflict' });
    expect(await book.listVisible(AGENT)).toEqual([second]);
  });
});

describe('saved views: retries, stale tabs and dates (SP-desk-01 review)', () => {
  it('a retried delete answers with the deleted view; another reason is not found', async () => {
    const d = await desk();
    const view = await d.lead.viewsSave(save);
    const first = await d.lead.viewsDelete({ viewId: view.id, reason: 'Shift ended' });
    expect(await d.lead.viewsDelete({ viewId: view.id, reason: 'Shift ended' })).toEqual(first);
    await expect(d.lead.viewsDelete({ viewId: view.id, reason: 'Something else' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const agent = await d.as(AGENT);
    await expect(agent.viewsDelete({ viewId: view.id, reason: 'Shift ended' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the queue honours score ascending as well as descending', async () => {
    const d = await desk();
    for (const category of ['phishing', 'account', 'other'] as const)
      await d.support.createTicket({ userId: CUSTOMER, category, subject: `Widget ${category}`, body: 'Please help with this request' });
    const ids = (queue: unknown) => ((queue as { entries?: { score: number }[] }).entries ?? []).map((entry) => entry.score);
    const desc = ids(await d.lead.listQueue({ limit: 20, filter: OPEN, sort: { key: 'score', dir: 'desc' } }));
    const asc = ids(await d.lead.listQueue({ limit: 20, filter: OPEN, sort: { key: 'score', dir: 'asc' } }));
    expect(desc).toHaveLength(3);
    expect(new Set(desc).size).toBe(3);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    expect(asc).toEqual([...desc].reverse());
  });

  it('a date filter with eq matches the same instant however it is spelled', async () => {
    const d = await desk();
    const ticket = await d.ticket(CUSTOMER, 'Dated widget');
    const at = new Date(ticket.createdAt);
    const spelled = `${at.toISOString().slice(0, 19)}${at.getUTCMilliseconds() ? `.${String(at.getUTCMilliseconds()).padStart(3, '0')}` : ''}+00:00`;
    const listed = await d.lead.listAll({ limit: 50, filter: { field: 'created', op: 'eq', value: spelled } });
    expect(listed.map((row) => row.id)).toEqual([ticket.id]);
  });
});
