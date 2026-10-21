import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, SupportBulkInput } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/**
 * SP-tickets-07 — one change for several requests: each request is changed on its own and answers its own outcome, a
 * replayed batch changes nothing twice, and a blank or exceeded cap touches nothing.
 */

const authConfig = {
  secret: 'a-support-bulk-update-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-bulk' };
}

async function desk(cap: number | null = 5) {
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    cap,
  );
  const router = createSupportRouter(support);
  const lead = router.createCaller(await ctx(LEAD, ['support:ops']));
  const agent = router.createCaller(await ctx(AGENT, ['support:ops']));
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
  const make = async (n: number) =>
    (await support.createTicket({ userId: USER, category: 'account', subject: `Request ${n}`, body: `Body of request ${n}` })).id;
  return { support, router, lead, agent, make };
}

describe('bulk status', () => {
  it('changes each request, writes one trail row each, and reports a closed request as refused while the rest still change', async () => {
    const { support, lead, make } = await desk();
    const [a, b, c] = [await make(1), await make(2), await make(3)] as [string, string, string];
    await support.setStatus({ operatorId: LEAD, ticketId: c, status: 'closed' });
    const res = await lead.bulkUpdate({
      batchKey: 'batch-status-1',
      ticketIds: [a, b, c],
      change: { kind: 'status', status: 'resolved' },
      reason: 'duplicate noise',
    });
    expect(res.results.map((r) => [r.ticketId, r.outcome, r.code])).toEqual([
      [a, 'changed', null],
      [b, 'changed', null],
      [c, 'refused', 'support.transition_illegal'],
    ]);
    for (const id of [a, b]) {
      const events = await support.listTicketEvents({ userId: LEAD, ticketId: id, asOperator: true, limit: 50 });
      const moved = events.filter((e) => e.kind === 'status_changed');
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({ toStatus: 'resolved', actorId: LEAD, note: 'duplicate noise' });
    }
  });
  it('a replay of the same batch returns the first answers and changes nothing twice', async () => {
    const { support, lead, make } = await desk();
    const [a, b] = [await make(1), await make(2)] as [string, string];
    const input: SupportBulkInput = { batchKey: 'batch-status-2', ticketIds: [a, b], change: { kind: 'status', status: 'resolved' } };
    await lead.bulkUpdate(input);
    const again = await lead.bulkUpdate(input);
    expect(again.results.map((r) => r.outcome)).toEqual(['changed', 'changed']);
    const events = await support.listTicketEvents({ userId: LEAD, ticketId: a, asOperator: true, limit: 50 });
    expect(events.filter((e) => e.kind === 'status_changed')).toHaveLength(1);
  });
  it('a replay after a request was reopened does not resolve it a second time', async () => {
    const { support, lead, make } = await desk();
    const a = await make(1);
    const input: SupportBulkInput = { batchKey: 'batch-status-reopen', ticketIds: [a], change: { kind: 'status', status: 'resolved' } };
    await lead.bulkUpdate(input);
    await support.setStatus({ operatorId: LEAD, ticketId: a, status: 'open' });
    const again = await lead.bulkUpdate(input);
    expect(again.results.map((r) => r.outcome)).toEqual(['changed']);
    const events = await support.listTicketEvents({ userId: LEAD, ticketId: a, asOperator: true, limit: 50 });
    expect(events.filter((e) => e.kind === 'status_changed').map((e) => e.toStatus)).toEqual(['resolved', 'open']);
  });
  it('a replay answers an unchanged request unchanged and a refused one with its real reason, even after the ticket moved', async () => {
    const { support, lead, make } = await desk();
    const [a, b, c] = [await make(1), await make(2), await make(3)] as [string, string, string];
    await support.setStatus({ operatorId: LEAD, ticketId: b, status: 'resolved' });
    await support.setStatus({ operatorId: LEAD, ticketId: c, status: 'closed' });
    const input: SupportBulkInput = {
      batchKey: 'batch-status-mixed',
      ticketIds: [a, b, c],
      change: { kind: 'status', status: 'resolved' },
    };
    const first = await lead.bulkUpdate(input);
    expect(first.results.map((r) => [r.outcome, r.code])).toEqual([
      ['changed', null],
      ['unchanged', null],
      ['refused', 'support.transition_illegal'],
    ]);
    expect((await lead.bulkUpdate(input)).results).toEqual(first.results);
    // The unchanged request is reopened, then the batch is replayed: it must not be resolved a second time.
    await support.setStatus({ operatorId: LEAD, ticketId: b, status: 'open' });
    expect((await lead.bulkUpdate(input)).results[1]).toMatchObject({ ticketId: b, outcome: 'unchanged' });
    const events = await support.listTicketEvents({ userId: LEAD, ticketId: b, asOperator: true, limit: 50 });
    expect(events.filter((e) => e.kind === 'status_changed').map((e) => e.toStatus)).toEqual(['resolved', 'open']);
  });
  it('reports an unknown request as refused, not found, and keeps going', async () => {
    const { lead, make } = await desk();
    const a = await make(1);
    const ghost = '99999999-9999-4999-8999-999999999999';
    const res = await lead.bulkUpdate({
      batchKey: 'batch-status-3',
      ticketIds: [ghost, a],
      change: { kind: 'status', status: 'resolved' },
    });
    expect(res.results).toEqual([
      { ticketId: ghost, outcome: 'refused', code: 'support.not_found' },
      { ticketId: a, outcome: 'changed', code: null },
    ]);
  });
});

describe('bulk assign', () => {
  it('assigns each request through the single path, once, and a replay returns the first answers', async () => {
    const { support, lead, make } = await desk();
    const [a, b] = [await make(1), await make(2)] as [string, string];
    const input: SupportBulkInput = { batchKey: 'batch-assign-1', ticketIds: [a, b], change: { kind: 'assign', assigneeId: AGENT } };
    const res = await lead.bulkUpdate(input);
    expect(res.results.map((r) => r.outcome)).toEqual(['changed', 'changed']);
    expect(
      (await support.listTicketEvents({ userId: LEAD, ticketId: a, asOperator: true, limit: 50 })).filter((e) => e.kind === 'assigned'),
    ).toHaveLength(1);
    const again = await lead.bulkUpdate(input);
    expect(again.results.map((r) => r.outcome)).toEqual(['changed', 'changed']);
    expect(
      (await support.listTicketEvents({ userId: LEAD, ticketId: a, asOperator: true, limit: 50 })).filter((e) => e.kind === 'assigned'),
    ).toHaveLength(1);
  });
  it('refuses the whole batch for a non-lead, and an assignee who is not staff, without touching a request', async () => {
    const { support, agent, lead, make } = await desk();
    const a = await make(1);
    await expect(
      agent.bulkUpdate({ batchKey: 'batch-assign-2', ticketIds: [a], change: { kind: 'assign', assigneeId: AGENT } }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const res = await lead.bulkUpdate({
      batchKey: 'batch-assign-3',
      ticketIds: [a],
      change: { kind: 'assign', assigneeId: '88888888-8888-4888-8888-888888888888' },
    });
    expect(res.results).toEqual([{ ticketId: a, outcome: 'refused', code: 'support.not_staff' }]);
    expect(
      (await support.listTicketEvents({ userId: LEAD, ticketId: a, asOperator: true, limit: 50 })).filter((e) => e.kind === 'assigned'),
    ).toHaveLength(0);
  });
});

describe('bulk priority', () => {
  it('sets a priority on each, refuses a closed one, and refuses a value the single change would refuse', async () => {
    const { support, lead, make } = await desk();
    const [a, b] = [await make(1), await make(2)] as [string, string];
    await support.setStatus({ operatorId: LEAD, ticketId: b, status: 'closed' });
    const res = await lead.bulkUpdate({ batchKey: 'batch-prio-1', ticketIds: [a, b], change: { kind: 'priority', priority: 'high' } });
    expect(res.results).toEqual([
      { ticketId: a, outcome: 'changed', code: null },
      { ticketId: b, outcome: 'refused', code: 'support.ticket_closed' },
    ]);
    expect((await support.getTicketProperties({ operatorId: LEAD, ticketId: a })).priority).toBe('high');
    // A value the single change would refuse never reaches the service: the contract refuses the whole request.
    await expect(
      lead.bulkUpdate({ batchKey: 'batch-prio-2', ticketIds: [a], change: { kind: 'priority', priority: 'whenever' as never } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('the batch cap', () => {
  it('is blank until the owner sets it: the policy says so and a batch refuses, touching nothing', async () => {
    const { support, lead, make } = await desk(null);
    const a = await make(1);
    expect(await lead.bulkPolicy()).toEqual({ cap: null, missing: 'support.bulk_cap' });
    await expect(
      lead.bulkUpdate({ batchKey: 'batch-cap-1', ticketIds: [a], change: { kind: 'status', status: 'resolved' } }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect((await support.getTicket({ userId: USER, ticketId: a })).status).toBe('open');
  });
  it('refuses a batch over the cap and takes one at the cap', async () => {
    const { support, lead, make } = await desk(2);
    const ids = [await make(1), await make(2), await make(3)] as [string, string, string];
    expect(await lead.bulkPolicy()).toEqual({ cap: 2, missing: null });
    await expect(
      lead.bulkUpdate({ batchKey: 'batch-cap-2', ticketIds: ids, change: { kind: 'status', status: 'resolved' } }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    for (const id of ids) expect((await support.getTicket({ userId: USER, ticketId: id })).status).toBe('open');
    const ok = await lead.bulkUpdate({
      batchKey: 'batch-cap-3',
      ticketIds: [ids[0], ids[1]],
      change: { kind: 'status', status: 'resolved' },
    });
    expect(ok.results.map((r) => r.outcome)).toEqual(['changed', 'changed']);
  });
  it('is for the desk only: a caller without support:ops cannot read the policy or change anything', async () => {
    const { router, make } = await desk();
    const a = await make(1);
    const plain = router.createCaller(await ctx(USER, ['support:read', 'support:write']));
    await expect(plain.bulkPolicy()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      plain.bulkUpdate({ batchKey: 'batch-cap-4', ticketIds: [a], change: { kind: 'status', status: 'resolved' } }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
