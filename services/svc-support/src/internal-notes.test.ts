import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryAttachmentStore, type MalwareScanner } from './attachments.js';
import { MemoryAttachmentSettingsBook } from './attachment-settings.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';

/**
 * Internal notes (SP-tickets-05): a staff-only note never reaches the customer through any procedure they can call, and
 * it moves nothing they read — no reopen, no "waiting on", no first-reply stamp, no new `updatedAt`.
 */

const authConfig = {
  secret: 'a-support-internal-notes-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const NOTE = 'TEST internal: customer sounded unsure, check the card block first';
const BODY = Buffer.from('hello').toString('base64');
const CUSTOMER_SCOPES = ['support:read', 'support:write'];
const AGENT_SCOPES = ['support:ops', 'support:read', 'support:write'];

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-internal-notes' };
}

const clean: MalwareScanner = { scan: async () => 'clean' };

async function desk() {
  const store = new MemorySupportStore();
  const lifecycle = new MemoryLifecycleBook();
  const settings = new MemoryAttachmentSettingsBook();
  await settings.set({
    changes: { maxBytes: 100, allowedTypes: ['text/plain'], maxCount: 5 },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'test',
    at: '2026-10-29T14:00:00.000Z',
  });
  const support = new SupportService(
    store,
    undefined,
    { store: new MemoryAttachmentStore(), scanner: clean, maxBytes: null, allowedTypes: null, maxCount: null },
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    undefined,
    [],
    undefined,
    lifecycle,
    undefined,
    settings,
    null,
    undefined,
    5,
  );
  const router = createSupportRouter(support, undefined, undefined, support, undefined, settings);
  const as = async (userId: string, scopes: string[]) => router.createCaller(await ctx(userId, scopes));
  const customer = await as(CUSTOMER, CUSTOMER_SCOPES);
  const agent = await as(AGENT, AGENT_SCOPES);
  const ticket = await customer.create({ category: 'account', subject: 'TEST cannot pay', body: 'TEST my card was declined' });
  return { store, lifecycle, support, router, as, customer, agent, ticketId: ticket.id };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { message?: string; code?: string }) => err.message?.split(' ')[0] ?? err.code,
  );

/**
 * Every procedure a customer token reaches, split by whether it reads a request. Kept by hand so a new customer
 * procedure fails the inventory test below until someone decides which list it belongs to and reads it here.
 */
const READS_A_REQUEST = [
  'awaitingMine',
  'listMine',
  'createdByRequest',
  'ratedMine',
  'get',
  'comment',
  'listComments',
  'events',
  'close',
  'rate',
  'rating',
  'attach',
  'attachment',
  'ticketAttachments',
  'attachmentDownload',
  'myTicketProperties',
] as const;
/**
 * A guest's link reads and replies on one request (SP-tickets-01). Its answer is the owner's own `getTicket` and
 * `listComments`, and `guest-requests.pg.test.ts` proves a staff note is not in it.
 */
const READS_BY_GUEST_LINK = ['guestThread', 'guestReply'] as const;
/** These read no request and no comment: help centre, knowledge base, forms, desk settings and a guest's submission. */
const READS_NO_REQUEST = [
  'guestCreate',
  'guestVerify',
  'contactChannels',
  'attachmentLimits',
  'helpCentre',
  'helpCentreLanguage',
  'requestForms',
  'ticketFieldValues',
  'kbFeedbackPublic',
  'kbSearchClick',
  'kbAnswer',
  'kbLibrary',
  'kbSection',
  'deskPolicy',
  'kbPolicy',
  'categories',
  'create',
  'listKb',
  'searchKb',
  'getKb',
  'kbFeedback',
  'kbRelated',
] as const;

describe('internal notes', () => {
  it('the lists above are every procedure a customer token reaches', async () => {
    const { router, customer } = await desk();
    const reachable: string[] = [];
    for (const path of Object.keys((router as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures)) {
      const call = (customer as unknown as Record<string, (input: unknown) => Promise<unknown>>)[path]!;
      const refused = await call({}).then(
        () => null,
        (err: { code?: string }) => err.code,
      );
      if (refused !== 'FORBIDDEN') reachable.push(path);
    }
    expect(reachable.sort()).toEqual([...READS_A_REQUEST, ...READS_BY_GUEST_LINK, ...READS_NO_REQUEST].sort());
  });

  it('a note is in no answer a customer procedure gives, and moves nothing the customer reads', async () => {
    const { support, customer, agent, ticketId } = await desk();
    const reply = await agent.comment({ ticketId, body: 'TEST public: please try again', clientRequestId: 'reply-1' });
    const own = await customer.attach({ ticketId, clientRequestId: 'file-1', contentType: 'text/plain', bodyBase64: BODY });
    const before = await customer.get({ ticketId });
    const lifecycleBefore = await support.getTicketLifecycle({ operatorId: AGENT, ticketId });
    const eventsBefore = await customer.events({ ticketId, limit: 100 });

    const note = await agent.addInternalNote({ ticketId, body: NOTE, clientRequestId: 'note-1' });
    expect(note).toMatchObject({ visibility: 'internal', authorRole: 'operator', authorId: AGENT, body: NOTE });

    // The desk reads it, marked internal, after the public reply.
    expect((await agent.listComments({ ticketId, limit: 100 })).map((c) => [c.id, c.visibility])).toEqual([
      [reply.id, 'public'],
      [note.id, 'internal'],
    ]);

    // Nothing the customer reads changed.
    expect(await customer.get({ ticketId })).toEqual(before);
    expect(await support.getTicketLifecycle({ operatorId: AGENT, ticketId })).toEqual(lifecycleBefore);
    expect(await customer.events({ ticketId, limit: 100 })).toEqual(eventsBefore);
    expect(await customer.listComments({ ticketId, limit: 100 })).toEqual([reply]);

    // Every procedure that reads a request, answered after the note: none carries its words or its id.
    const answers: Record<(typeof READS_A_REQUEST)[number], unknown> = {
      awaitingMine: await customer.awaitingMine(),
      listMine: await customer.listMine({ limit: 100 }),
      createdByRequest: await customer.createdByRequest({ clientRequestId: 'note-1' }),
      ratedMine: await customer.ratedMine(),
      get: await customer.get({ ticketId }),
      listComments: await customer.listComments({ ticketId, limit: 100 }),
      events: await customer.events({ ticketId, limit: 100 }),
      rating: await customer.rating({ ticketId }),
      attachment: await customer.attachment({ attachmentId: own.id }),
      ticketAttachments: await customer.ticketAttachments({ ticketId, limit: 100 }),
      attachmentDownload: await customer.attachmentDownload({ attachmentId: own.id }),
      myTicketProperties: await customer.myTicketProperties({ ticketId }),
      attach: await customer.attach({ ticketId, clientRequestId: 'file-2', contentType: 'text/plain', bodyBase64: BODY }),
      comment: await customer.comment({ ticketId, body: 'TEST still declined', clientRequestId: 'customer-1' }),
      close: null,
      rate: null,
    };
    await support.setStatus({ operatorId: AGENT, ticketId, status: 'resolved' });
    await agent.addInternalNote({ ticketId, body: `${NOTE} (after resolve)`, clientRequestId: 'note-2' });
    answers.rate = await customer.rate({ ticketId, score: 5, clientRequestId: 'rate-1' });
    answers.close = await customer.close({ ticketId, clientRequestId: 'close-1' });
    for (const [procedure, answer] of Object.entries(answers)) {
      const said = JSON.stringify(answer);
      expect(said, procedure).not.toContain('TEST internal');
      expect(said, procedure).not.toContain(note.id);
      expect(said, procedure).not.toContain('"internal"');
    }
    // `createdByRequest` is keyed by the customer's own create key: the note's key answers nothing of theirs.
    expect(answers.createdByRequest).toBeNull();
  });

  it('a note on a resolved request leaves it resolved, with no reopen and no new updatedAt', async () => {
    const { support, customer, agent, ticketId } = await desk();
    await support.setStatus({ operatorId: AGENT, ticketId, status: 'resolved' });
    const before = await customer.get({ ticketId });
    const lifecycleBefore = await support.getTicketLifecycle({ operatorId: AGENT, ticketId });
    await agent.addInternalNote({ ticketId, body: NOTE, clientRequestId: 'note-resolved' });
    const after = await customer.get({ ticketId });
    expect(after.status).toBe('resolved');
    expect(after).toEqual(before);
    expect(await support.getTicketLifecycle({ operatorId: AGENT, ticketId })).toEqual(lifecycleBefore);
  });

  it('a blank note refuses support.note_empty and writes nothing', async () => {
    const { agent, ticketId } = await desk();
    const before = await agent.listComments({ ticketId, limit: 100 });
    expect(await code(agent.addInternalNote({ ticketId, body: '   \n ', clientRequestId: 'note-blank' }))).toBe('support.note_empty');
    expect(await agent.listComments({ ticketId, limit: 100 })).toEqual(before);
  });

  it('the same key is one note; other words under it refuse; a reply key never answers a note', async () => {
    const { agent, ticketId } = await desk();
    const first = await agent.addInternalNote({ ticketId, body: NOTE, clientRequestId: 'note-key' });
    expect(await agent.addInternalNote({ ticketId, body: NOTE, clientRequestId: 'note-key' })).toEqual(first);
    expect(await code(agent.addInternalNote({ ticketId, body: `${NOTE}!`, clientRequestId: 'note-key' }))).toBe(
      'support.idempotency_conflict',
    );
    const reply = await agent.comment({ ticketId, body: 'TEST same words', clientRequestId: 'shared-key' });
    const note = await agent.addInternalNote({ ticketId, body: 'TEST same words', clientRequestId: 'shared-key' });
    expect(note.id).not.toBe(reply.id);
    expect((await agent.listComments({ ticketId, limit: 100 })).map((c) => [c.id, c.visibility])).toEqual([
      [first.id, 'internal'],
      [reply.id, 'public'],
      [note.id, 'internal'],
    ]);
  });

  it('a customer cannot write a note, and a staff member never reads the notes on their own request', async () => {
    const { as, agent, customer, ticketId } = await desk();
    await expect(customer.addInternalNote({ ticketId, body: NOTE, clientRequestId: 'note-cust' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await agent.listComments({ ticketId, limit: 100 })).toEqual([]);

    // A second agent files a request of their own; the first writes a note on it.
    const colleague = await as('55555555-5555-4555-8555-555555555555', AGENT_SCOPES);
    const theirs = await colleague.create({ category: 'account', subject: 'TEST my own question', body: 'TEST body' });
    const note = await agent.addInternalNote({ ticketId: theirs.id, body: NOTE, clientRequestId: 'note-colleague' });
    expect((await agent.listComments({ ticketId: theirs.id, limit: 100 })).map((c) => c.id)).toEqual([note.id]);
    expect(await colleague.listComments({ ticketId: theirs.id, limit: 100 })).toEqual([]);
  });

  it('a note may hold a placeholder as written: only a public reply refuses one', async () => {
    const { agent, ticketId } = await desk();
    const note = await agent.addInternalNote({ ticketId, body: 'TEST ask {{requester.name}} for the card', clientRequestId: 'note-ph' });
    expect(note.body).toBe('TEST ask {{requester.name}} for the card');
    expect(await code(agent.comment({ ticketId, body: 'Hi {{requester.name}}', clientRequestId: 'reply-ph' }))).toBe(
      'support.macro_placeholder_blank',
    );
  });

  it('the store refuses a note by anyone but an operator', async () => {
    const { store, ticketId } = await desk();
    await expect(
      store.addComment({ ticketId, authorId: CUSTOMER, authorRole: 'user', visibility: 'internal', body: NOTE }),
    ).rejects.toThrow('only an operator writes an internal note');
    expect(await store.listComments(ticketId, { withInternal: true })).toEqual([]);
  });
});
