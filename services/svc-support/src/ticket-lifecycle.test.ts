import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryPropertiesBook } from './desk-properties.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';
import { TEST_COMMENT_CAP } from './comment-cap.fixture.js';

const authConfig = {
  secret: 'a-support-ticket-lifecycle-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-life' };
}

function desk() {
  const lifecycle = new MemoryLifecycleBook();
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    new MemoryGroupBook(),
    [],
    new MemoryPropertiesBook(),
    lifecycle,
    undefined,
    undefined,
    null,
    undefined,
    TEST_COMMENT_CAP,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const staff = async () => router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const mine = async (userId = CUSTOMER) => router.createCaller(await ctx(userId, ['support:read', 'support:write']));
  const ticket = (userId = CUSTOMER, extra: object = {}) =>
    support.createTicket({ userId, category: 'account', subject: 'Help', body: 'Help me please', ...extra });
  return { support, staff, mine, ticket };
}

describe('ticket lifecycle facts (SP-tickets-04)', () => {
  it('reads empty until something happens', async () => {
    const { staff, ticket } = desk();
    const t = await ticket();
    expect(await (await staff()).ticketLifecycle({ ticketId: t.id })).toEqual({
      ticketId: t.id,
      waitingOn: null,
      waitingSince: null,
      firstPublicReplyAt: null,
      followsTicketId: null,
    });
  });

  it('an operator reply puts the ticket on the customer and stamps the first reply once', async () => {
    const { support, staff, ticket } = desk();
    const t = await ticket();
    await support.comment({ userId: AGENT, ticketId: t.id, body: 'First answer', asOperator: true });
    const first = await (await staff()).ticketLifecycle({ ticketId: t.id });
    expect(first.waitingOn).toBe('customer');
    expect(first.waitingSince).not.toBeNull();
    expect(first.firstPublicReplyAt).not.toBeNull();
    await support.comment({ userId: AGENT, ticketId: t.id, body: 'Second answer', asOperator: true });
    const second = await (await staff()).ticketLifecycle({ ticketId: t.id });
    expect(second.firstPublicReplyAt).toBe(first.firstPublicReplyAt);
    expect(second.waitingSince).toBe(first.waitingSince);
  });

  it('a customer reply on an in-progress request puts it back to open on the team, with one trail row', async () => {
    const { support, staff, ticket } = desk();
    const t = await ticket();
    await support.claimForOperator({ operatorId: AGENT, ticketId: t.id });
    expect((await support.getTicket({ userId: CUSTOMER, ticketId: t.id })).status).toBe('pending');
    await support.comment({ userId: AGENT, ticketId: t.id, body: 'Please send the screenshot', asOperator: true });
    await support.comment({ userId: CUSTOMER, ticketId: t.id, body: 'Here it is' });
    const after = await support.getTicket({ userId: CUSTOMER, ticketId: t.id });
    expect(after.status).toBe('open');
    expect(after.assigneeId).toBe(AGENT);
    expect((await (await staff()).ticketLifecycle({ ticketId: t.id })).waitingOn).toBe('team');
    const trail = await support.listTicketEvents({ userId: CUSTOMER, ticketId: t.id, limit: 100 });
    const back = trail.filter((e) => e.kind === 'status_changed' && e.fromStatus === 'pending' && e.toStatus === 'open');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ actorId: CUSTOMER, actorRole: 'user', note: 'user_reply_resume' });
  });

  it('on hold needs a reason, leaves the queue, and a customer reply brings it back', async () => {
    const { support, ticket } = desk();
    const t = await ticket();
    await expect(support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'on_hold' })).rejects.toMatchObject({
      code: 'support.hold_reason_required',
    });
    await expect(support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'on_hold', note: '  ' })).rejects.toMatchObject({
      code: 'support.hold_reason_required',
    });
    const held = await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'on_hold', note: 'Waiting on the bank' });
    expect(held.status).toBe('on_hold');
    expect((await support.listOperatorQueue({ limit: 100 })).status).toBe('empty');
    expect((await support.queueMetrics()).onHold).toBe(1);
    const trail = await support.listTicketEvents({ userId: CUSTOMER, ticketId: t.id, limit: 100 });
    expect(trail.find((e) => e.toStatus === 'on_hold')).toMatchObject({ fromStatus: 'open', note: 'Waiting on the bank' });
    await support.comment({ userId: CUSTOMER, ticketId: t.id, body: 'Any news?' });
    expect((await support.getTicket({ userId: CUSTOMER, ticketId: t.id })).status).toBe('open');
    expect((await support.listOperatorQueue({ limit: 100 })).status).toBe('ok');
  });

  it('an agent can release a hold, resolve or close from it; a held request cannot jump to itself', async () => {
    const { support, ticket } = desk();
    const t = await ticket();
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'on_hold', note: 'Paused' });
    await expect(support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'on_hold', note: 'Again' })).rejects.toMatchObject({
      code: 'support.transition_same_status',
    });
    expect((await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'pending' })).status).toBe('pending');
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'on_hold', note: 'Paused again' });
    expect((await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' })).status).toBe('resolved');
  });

  it('resolving clears who it waits on', async () => {
    const { support, staff, ticket } = desk();
    const t = await ticket();
    await support.comment({ userId: AGENT, ticketId: t.id, body: 'Done?', asOperator: true });
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    const life = await (await staff()).ticketLifecycle({ ticketId: t.id });
    expect(life.waitingOn).toBeNull();
    expect(life.waitingSince).toBeNull();
    expect(life.firstPublicReplyAt).not.toBeNull();
  });

  it('a follow-up links to the caller’s own closed request and nothing else', async () => {
    const { support, staff, ticket } = desk();
    const closed = await ticket();
    const open = await ticket();
    const theirs = await ticket(OTHER);
    await support.setStatus({ operatorId: AGENT, ticketId: closed.id, status: 'closed' });
    await support.setStatus({ operatorId: AGENT, ticketId: theirs.id, status: 'closed' });
    const refusal = { code: 'support.follow_up_invalid' };
    await expect(ticket(CUSTOMER, { followsTicketId: open.id })).rejects.toMatchObject(refusal);
    await expect(ticket(CUSTOMER, { followsTicketId: theirs.id })).rejects.toMatchObject(refusal);
    await expect(ticket(CUSTOMER, { followsTicketId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject(refusal);
    const followUp = await ticket(CUSTOMER, { followsTicketId: closed.id });
    expect((await (await staff()).ticketLifecycle({ ticketId: followUp.id })).followsTicketId).toBe(closed.id);
    expect((await (await staff()).ticketLifecycle({ ticketId: closed.id })).followsTicketId).toBeNull();
  });

  it('the same create key returns the same follow-up and links once', async () => {
    const { support, staff, ticket } = desk();
    const closed = await ticket();
    await support.setStatus({ operatorId: AGENT, ticketId: closed.id, status: 'closed' });
    const a = await ticket(CUSTOMER, { followsTicketId: closed.id, clientRequestId: 'follow-1' });
    const b = await ticket(CUSTOMER, { followsTicketId: closed.id, clientRequestId: 'follow-1' });
    expect(b.id).toBe(a.id);
    expect((await (await staff()).ticketLifecycle({ ticketId: a.id })).followsTicketId).toBe(closed.id);
  });

  it('the customer cannot read the lifecycle, and the ticket they read carries no desk waiting-on facts', async () => {
    const { support, mine, ticket } = desk();
    const t = await ticket();
    await support.comment({ userId: AGENT, ticketId: t.id, body: 'Reply', asOperator: true });
    const own = await (await mine()).get({ ticketId: t.id });
    // The owner reads whose turn it is (SP-tickets-01) and nothing else: no side, no since, no reply stamp.
    const { customerStatus, ...rest } = own;
    expect(customerStatus).toBe('awaiting_reply');
    expect(JSON.stringify(rest)).not.toMatch(/waiting|firstPublicReply/i);
    await expect((await mine()).ticketLifecycle({ ticketId: t.id })).rejects.toBeTruthy();
  });

  it('an unknown ticket reads as not found', async () => {
    const { staff } = desk();
    await expect((await staff()).ticketLifecycle({ ticketId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
