import { describe, expect, it } from 'vitest';
import type { AccountState } from '@intafaced/contracts';
import type { AccountStateSource } from './account-state.js';
import { listPlatformKb } from './kb-catalog.js';
import { MemorySupportStore, type SupportStore } from './store.js';
import { IDENTITY_GROUNDING_UNWIRED, IdentityGroundingUnwiredError } from './identity-grounding-honesty.js';
import { SupportError, SupportService } from './support-service.js';
import { withTestCommentCap } from './comment-cap.fixture.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const OP = '33333333-3333-4333-8333-333333333333';

class FixedAccountState implements AccountStateSource {
  calls: string[] = [];
  constructor(private readonly state: AccountState | null) {}
  async stateOf(userId: string): Promise<AccountState | null> {
    this.calls.push(userId);
    return this.state;
  }
}

const frozen: AccountState = { userId: USER, status: 'frozen', kycTier: 'basic' };

function desk(accounts: AccountStateSource = new FixedAccountState(frozen)) {
  const store = new MemorySupportStore();
  return { store, accounts, support: withTestCommentCap(store, accounts) };
}

async function openTicket(support: SupportService) {
  return support.createTicket({ userId: USER, category: 'account', subject: 'S', body: 'B' });
}

/** The refusal code, never the sentence. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof SupportError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal, got none');
}

describe('audit trail', () => {
  it('creating a ticket records `opened` as sequence 1', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, limit: 100 });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ sequence: 1, kind: 'opened', actorId: USER, actorRole: 'user', fromStatus: null, toStatus: null });
  });

  it('a status change records who moved it and from what', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved', note: 'cited kb-account-access' });

    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.map((e) => e.kind)).toEqual(['opened', 'status_changed']);
    expect(trail[1]).toMatchObject({
      sequence: 2,
      kind: 'status_changed',
      actorId: OP,
      actorRole: 'operator',
      fromStatus: 'open',
      toStatus: 'resolved',
      note: 'cited kb-account-access',
    });
  });

  it('a claim records the assignment AND the open→pending move it caused', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.claimForOperator({ operatorId: OP, ticketId: t.id });

    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.map((e) => e.kind)).toEqual(['opened', 'assigned', 'status_changed']);
    expect(trail[2]).toMatchObject({ fromStatus: 'open', toStatus: 'pending', actorId: OP });
  });

  it('an idempotent self re-claim records nothing — a trail that grows on refresh hides its own rows', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.claimForOperator({ operatorId: OP, ticketId: t.id });
    const before = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    await support.claimForOperator({ operatorId: OP, ticketId: t.id });
    await support.claimForOperator({ operatorId: OP, ticketId: t.id });
    const after = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(after).toHaveLength(before.length);
  });

  it('sequences are dense — no gaps, no repeats', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.claimForOperator({ operatorId: OP, ticketId: t.id });
    await support.readAccountState({ operatorId: OP, ticketId: t.id });
    await support.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved' });

    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.map((e) => e.sequence)).toEqual(trail.map((_, i) => i + 1));
  });

  it('a refused status change writes no trail row', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    expect(await codeOf(() => support.setStatus({ operatorId: OP, ticketId: t.id, status: 'open' }))).toBe(
      'support.transition_same_status',
    );
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail).toHaveLength(1);
  });

  it('closed is terminal, and the refusal is a code', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.setStatus({ operatorId: OP, ticketId: t.id, status: 'closed' });
    expect(await codeOf(() => support.setStatus({ operatorId: OP, ticketId: t.id, status: 'open' }))).toBe('support.transition_illegal');
  });

  it('resolved reopens onto the SAME ticket, keeping its history', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.setStatus({ operatorId: OP, ticketId: t.id, status: 'resolved' });
    const reopened = await support.setStatus({ operatorId: OP, ticketId: t.id, status: 'open' });
    expect(reopened.id).toBe(t.id);
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.filter((e) => e.kind === 'status_changed')).toHaveLength(2);
  });

  it("a stranger's trail is not found, not forbidden", async () => {
    const { support } = desk();
    const t = await openTicket(support);
    // Same answer as `get`, so the trail cannot be used to probe for ticket ids.
    expect(await codeOf(() => support.listTicketEvents({ userId: OTHER, ticketId: t.id, limit: 100 }))).toBe('support.not_found');
  });
});

describe('account-state grounding', () => {
  it('reads the ticket owner, and the operator cannot name a different user', async () => {
    const { support, accounts } = desk();
    const t = await openTicket(support);
    const grounding = await support.readAccountState({ operatorId: OP, ticketId: t.id });

    expect(grounding).toMatchObject({ status: 'read', state: frozen });
    // The user id came off the TICKET. There is no parameter for an operator to
    // pass a different one, which is what stops `support:ops` from being a
    // platform-wide account lookup.
    expect((accounts as FixedAccountState).calls).toEqual([USER]);
  });

  it('records the read — who looked at whose account, and when', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.readAccountState({ operatorId: OP, ticketId: t.id });
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.at(-1)).toMatchObject({ kind: 'grounding_read', actorId: OP, note: 'account_state:frozen' });
  });

  it('a dark plane says so and does not invent `active`', async () => {
    const { support } = desk(new FixedAccountState(null));
    const t = await openTicket(support);
    const grounding = await support.readAccountState({ operatorId: OP, ticketId: t.id });
    expect(grounding).toEqual({ status: 'unread', reason: 'plane_dark' });
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.at(-1)).toMatchObject({ kind: 'grounding_read', note: 'unread:plane_dark' });
  });

  it('unwired identity secret refuses by name and does not record plane_dark', async () => {
    const unwired: AccountStateSource = {
      async stateOf() {
        throw new IdentityGroundingUnwiredError();
      },
    };
    const { support } = desk(unwired);
    const t = await openTicket(support);
    expect(await codeOf(() => support.readAccountState({ operatorId: OP, ticketId: t.id }))).toBe(IDENTITY_GROUNDING_UNWIRED);
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.filter((e) => e.kind === 'grounding_read')).toHaveLength(0);
  });
});

describe('escalation carries its case file', () => {
  it('cites the account state, the KB articles relied on, and the conversation', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.comment({ userId: USER, ticketId: t.id, body: 'card ending 4321 declined' });
    const article = listPlatformKb()[0]!;

    const file = await support.escalate({
      operatorId: OP,
      ticketId: t.id,
      reason: 'account_state',
      summary: 'Frozen account blocking a withdrawal.',
      citedArticleIds: [article.id],
    });

    expect(file.grounding).toMatchObject({ status: 'read', state: frozen });
    expect(file.citations.map((c) => c.kind).sort()).toEqual(['account_state', 'kb_article', 'ticket_comment']);
    // Every citation is a ref plus a digest. None of them is content.
    for (const c of file.citations) expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
    // No cited content either: not the comment, and not its card digits outside the random ids and digests, whose hex can
    // hold "4321" by chance (a ticket id ending 6c843211 did once).
    expect(JSON.stringify(file)).not.toContain('card ending');
    expect(JSON.stringify(file).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/g, '')).not.toContain(
      '4321',
    );
  });

  it('an escalation that read nothing at all is refused by code', async () => {
    // Dark plane, no comments, no article ids → nothing was read.
    const { support } = desk(new FixedAccountState(null));
    const t = await openTicket(support);
    expect(await codeOf(() => support.escalate({ operatorId: OP, ticketId: t.id, reason: 'other', summary: 'Escalating.' }))).toBe(
      'support.case_file.ungrounded',
    );
  });

  it('a KB id that does not exist contributes no citation', async () => {
    const { support } = desk(new FixedAccountState(null));
    const t = await openTicket(support);
    await support.comment({ userId: USER, ticketId: t.id, body: 'hello' });

    const file = await support.escalate({
      operatorId: OP,
      ticketId: t.id,
      reason: 'technical',
      summary: 'Login loop.',
      citedArticleIds: ['kb-does-not-exist', 'kb-also-not-real'],
    });
    // Grounded by the comment alone. An escalation cannot be made to LOOK
    // grounded by citing articles that were never there.
    expect(file.citations.map((c) => c.kind)).toEqual(['ticket_comment']);
  });

  it('the case file survives as the context of the escalation', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    const written = await support.escalate({
      operatorId: OP,
      ticketId: t.id,
      reason: 'kyc_review',
      summary: 'Tier does not match the deposit route.',
    });
    const read = await support.getCaseFile({ operatorId: OP, ticketId: t.id });
    expect(read).toEqual(written);
  });

  it('a ticket never escalated has no case file, not an empty one', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    expect(await support.getCaseFile({ operatorId: OP, ticketId: t.id })).toBeNull();
  });

  it('escalating records `escalated` on the trail', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.escalate({ operatorId: OP, ticketId: t.id, reason: 'money_request', summary: 'User asks for a refund.' });
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.at(-1)).toMatchObject({ kind: 'escalated', actorId: OP, note: 'reason:money_request citations:1' });
  });

  it('a crash after the case file and before the trail leaves neither', async () => {
    // The residual: putCaseFile then appendEvent as two writes. A mid-flight
    // failure left a case file with no escalated row — desk incomplete.
    const base = new MemorySupportStore();
    const store: SupportStore = {
      createTicket: (i) => base.createTicket(i),
      createTicketOnce: (i) => base.createTicketOnce(i),
      listByUser: (u, options) => base.listByUser(u, options),
      openIdsByUser: (u) => base.openIdsByUser(u),
      listAll: () => base.listAll(),
      findById: (id) => base.findById(id),
      addComment: (i) => base.addComment(i),
      listComments: (id) => base.listComments(id),
      setStatus: (i) => base.setStatus(i),
      claimTicket: (i) => base.claimTicket(i),
      releaseTicket: (i) => base.releaseTicket(i),
      assignTicket: (i) => base.assignTicket(i),
      appendEvent: (i) => base.appendEvent(i),
      listEvents: (id) => base.listEvents(id),
      putCaseFile: (c) => base.putCaseFile(c),
      putCaseFileWithEscalated: async () => {
        throw new Error('simulated crash mid-escalation');
      },
      latestCaseFile: (id) => base.latestCaseFile(id),
      listPublishedKb: () => base.listPublishedKb(),
      getPublishedKb: (id) => base.getPublishedKb(id),
      listKbVersions: (id) => base.listKbVersions(id),
      putKbRevision: (i) => base.putKbRevision(i),
      closeByOwner: (i) => base.closeByOwner(i),
      rateByOwner: (i) => base.rateByOwner(i),
      readRating: (i) => base.readRating(i),
      listRatings: () => base.listRatings(),
      setKbAudience: (input) => base.setKbAudience(input),
      listKbAudienceChanges: (id) => base.listKbAudienceChanges(id),
      setAttachmentScanState: (input) => base.setAttachmentScanState(input),
      listScanningAttachments: (limit) => base.listScanningAttachments(limit),
      listAttachmentsFor: (ticketId, limit) => base.listAttachmentsFor(ticketId, limit),
      listRatedTicketIdsFor: (userId) => base.listRatedTicketIdsFor(userId),
      readReceipt: (procedure, actorId, clientRequestId) => base.readReceipt(procedure, actorId, clientRequestId),
      recordAttachment: (i) => base.recordAttachment(i),
      readAttachment: (i) => base.readAttachment(i),
      recordKbFeedback: (i) => base.recordKbFeedback(i),
      mergeTickets: (i) => base.mergeTickets(i),
      previewMerge: (i) => base.previewMerge(i),
      findMergeBySource: (id) => base.findMergeBySource(id),
      listKbFeedbackSummary: (limit) => base.listKbFeedbackSummary(limit),
      recordSearchMiss: (input) => base.recordSearchMiss(input),
      listSearchMisses: (limit) => base.listSearchMisses(limit),
      hasSearchClick: (clientRequestId) => base.hasSearchClick(clientRequestId),
      recordSearchClick: (input) => base.recordSearchClick(input),
    };
    const support = new SupportService(store, new FixedAccountState({ userId: USER, status: 'active', kycTier: 'basic' }));
    const t = await support.createTicket({
      userId: USER,
      category: 'account',
      subject: 'S',
      body: 'B',
    });
    await expect(support.escalate({ operatorId: OP, ticketId: t.id, reason: 'other', summary: 'Escalating now.' })).rejects.toThrow(
      /simulated crash/,
    );
    expect(await support.getCaseFile({ operatorId: OP, ticketId: t.id })).toBeNull();
    const trail = await support.listTicketEvents({ userId: USER, ticketId: t.id, asOperator: true, limit: 100 });
    expect(trail.filter((e) => e.kind === 'escalated')).toHaveLength(0);
  });

  it('a money_request escalation moves nothing and carries no amount', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    const file = await support.escalate({
      operatorId: OP,
      ticketId: t.id,
      reason: 'money_request',
      summary: 'User asks for a refund of 250.00 EUR.',
    });
    // The operator's prose may mention a number — it is prose. What matters is
    // that the RECORD has no field a downstream system could read as an
    // instruction, and that no ticket status implies value moved.
    expect(Object.keys(file)).not.toContain('amount');
    const ticket = await support.getTicket({ userId: USER, ticketId: t.id, asOperator: true });
    expect(ticket.status).toBe('open');
  });

  it('escalating a closed ticket is refused by code — terminal means finished', async () => {
    const { support } = desk();
    const t = await openTicket(support);
    await support.setStatus({ operatorId: OP, ticketId: t.id, status: 'closed' });
    expect(
      await codeOf(() =>
        support.escalate({
          operatorId: OP,
          ticketId: t.id,
          reason: 'other',
          summary: 'Late hand-off after close.',
        }),
      ),
    ).toBe('support.escalation.terminal');
    expect(await support.getCaseFile({ operatorId: OP, ticketId: t.id })).toBeNull();
  });
});
