import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SupportTicket } from '@intafaced/contracts';
import {
  agentsNow,
  MemoryChatBook,
  ownerOf,
  signIdentityClaim,
  SupportChat,
  transcriptText,
  verifyIdentityClaim,
  type ChatProfileSource,
  type ChatSettings,
  type ChatTicketDesk,
} from './chat.js';
import type { StaffMember } from './desk-staff.js';

// SP-chat-01 (J-support-public-05): the chat's rules, on the memory book. The Postgres book is in chat.pg.test.ts.

const SECRET = 'a'.repeat(64);
const key = () => randomBytes(32).toString('base64url');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';

function staff(availability: StaffMember['availability'], userId = AGENT): StaffMember {
  return { userId, role: 'agent', appointedBy: AGENT, appointedAt: '2026-11-01T00:00:00.000Z', availability, availabilitySetAt: null, lastHeartbeatAt: null };
}

function world(overrides: Partial<ChatSettings> = {}, profiles: Record<string, 'individual' | 'business'> = {}) {
  const tickets: SupportTicket[] = [];
  const desk = {
    members: [staff('online')],
    async listStaff() {
      return this.members;
    },
    async createTicket(input: Parameters<ChatTicketDesk['createTicket']>[0]) {
      const prior = tickets.find((t) => (t as SupportTicket & { key: string }).key === input.clientRequestId);
      if (prior) return prior;
      const t = { id: randomUUID(), userId: input.userId, subject: input.subject, body: input.body, key: input.clientRequestId } as unknown as SupportTicket;
      tickets.push(t);
      return t;
    },
  };
  const source: ChatProfileSource = { profileOf: async (id) => profiles[id] ?? null };
  let now = new Date('2026-11-07T08:00:00.000Z');
  const settings: ChatSettings = {
    rateLimit: 5,
    rateWindowSeconds: 60,
    identityTtlSeconds: 300,
    prechatFields: ['name', 'email'],
    addressKey: 'b'.repeat(64),
    retentionDays: 30,
    claimSecret: SECRET,
    ...overrides,
  };
  const book = new MemoryChatBook();
  const chat = new SupportChat(book, desk, source, settings, async () => null, () => now);
  return { chat, book, desk, tickets, tick: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('who can answer', () => {
  it('online beats busy beats offline', () => {
    expect(agentsNow([staff('busy'), staff('online')])).toBe('online');
    expect(agentsNow([staff('busy'), staff('offline')])).toBe('busy');
    expect(agentsNow([staff('offline')])).toBe('offline');
    expect(agentsNow([])).toBe('offline');
  });
});

describe('identity claims', () => {
  const now = new Date('2026-11-07T08:00:00.000Z');
  it('a claim svc-support signed names its account until it expires', () => {
    const claim = signIdentityClaim(SECRET, ALICE, new Date(now.getTime() + 60_000));
    expect(verifyIdentityClaim(SECRET, claim, now)).toBe(ALICE);
    expect(verifyIdentityClaim(SECRET, claim, new Date(now.getTime() + 61_000))).toBeNull();
  });
  it('a claim signed with another key, edited, or made up fails', () => {
    const claim = signIdentityClaim(SECRET, ALICE, new Date(now.getTime() + 60_000));
    expect(verifyIdentityClaim('c'.repeat(64), claim, now)).toBeNull();
    const [payload, sig] = claim.split('.');
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), u: BOB })).toString('base64url');
    expect(verifyIdentityClaim(SECRET, `${edited}.${sig}`, now)).toBeNull();
    expect(verifyIdentityClaim(SECRET, BOB, now)).toBeNull();
  });
  it('the signed principal keeps its own identity; a false claim fails, and with no principal the session is a guest', () => {
    const verify = (c: string) => verifyIdentityClaim(SECRET, c, now);
    const bobs = signIdentityClaim(SECRET, BOB, new Date(now.getTime() + 60_000));
    expect(ownerOf(ALICE, undefined, verify)).toEqual({ userId: ALICE, claim: 'none', claimRefusal: null });
    expect(ownerOf(ALICE, bobs, verify)).toEqual({ userId: ALICE, claim: 'refused', claimRefusal: 'support.chat_identity_invalid' });
    expect(ownerOf(null, 'forged', verify)).toEqual({ userId: null, claim: 'refused', claimRefusal: 'support.chat_identity_invalid' });
    expect(ownerOf(null, bobs, verify)).toEqual({ userId: BOB, claim: 'verified', claimRefusal: null });
  });
});

describe('opening a chat', () => {
  it('with nobody on the desk it refuses, and offers the request form instead', async () => {
    const { chat, desk } = world();
    desk.members = [staff('offline')];
    expect((await chat.availability()).agents).toBe('offline');
    await expect(chat.open(ALICE, { clientKey: key(), message: 'hello' })).rejects.toMatchObject({ code: 'support.chat_agent_unavailable' });
  });

  it('a guest fills in the pre-chat form: one enquiry with source chat, the address sealed and never answered', async () => {
    const { chat, book } = world();
    const k = key();
    const input = { clientKey: k, prechat: { name: 'TEST Guest', email: 'guest@local-test.invalid' }, message: 'hello' };
    const opened = await chat.open(null, input);
    expect(opened.session).toMatchObject({ identity: 'guest', status: 'waiting', waitingForAgent: true });
    const again = await chat.open(null, input);
    expect(again.session.id).toBe(opened.session.id);
    expect(again.accessToken).toBe(opened.accessToken);
    const enquiries = await chat.enquiries(opened.session.id, 10);
    expect(enquiries).toEqual([expect.objectContaining({ source: 'chat', name: 'TEST Guest', hasEmail: true })]);
    expect(JSON.stringify(enquiries)).not.toContain('guest@local-test.invalid');
    expect([...book.enquiryRows.values()][0]!.addressSealed).not.toContain('guest@');
  });

  it('a guest must answer every field the owner asks for, and nothing else; an account sends none', async () => {
    const { chat } = world({ prechatFields: ['name'] });
    await expect(chat.open(null, { clientKey: key(), message: 'hi' })).rejects.toMatchObject({ code: 'support.chat_prechat_invalid' });
    await expect(chat.open(null, { clientKey: key(), prechat: { name: 'A', email: 'a@b.invalid' }, message: 'hi' })).rejects.toMatchObject({
      code: 'support.chat_prechat_invalid',
    });
    await expect(chat.open(ALICE, { clientKey: key(), prechat: { name: 'A' }, message: 'hi' })).rejects.toMatchObject({
      code: 'support.chat_prechat_invalid',
    });
    await expect(chat.open(null, { clientKey: key(), prechat: { name: 'A' }, message: 'hi' })).resolves.toBeTruthy();
  });

  it('a guest address needs the guest address key and retention', async () => {
    const input = () => ({ clientKey: key(), prechat: { name: 'A', email: 'a@b.invalid' }, message: 'hi' });
    await expect(world({ addressKey: null }).chat.open(null, input())).rejects.toMatchObject({ code: 'support.guest_address_key_unset' });
    await expect(world({ retentionDays: null }).chat.open(null, input())).rejects.toMatchObject({ code: 'support.guest_retention_unset' });
  });

  it('the same key with different content is refused', async () => {
    const { chat } = world();
    const k = key();
    await chat.open(ALICE, { clientKey: k, message: 'hello' });
    await expect(chat.open(ALICE, { clientKey: k, message: 'other' })).rejects.toMatchObject({ code: 'support.chat_message_conflict' });
  });

  it('a blank message rate refuses the chat by name', async () => {
    const { chat } = world({ rateLimit: null });
    await expect(chat.open(ALICE, { clientKey: key(), message: 'hi' })).rejects.toMatchObject({ code: 'support.chat_rate_limit_unset' });
  });

  it('reads the profile type from identity; unread when identity cannot answer, and none for a guest', async () => {
    const { chat } = world({}, { [ALICE]: 'business' });
    const business = await chat.open(ALICE, { clientKey: key(), message: 'hi' });
    expect((await chat.deskPoll({ sessionId: business.session.id, after: 0 })).session).toMatchObject({ profileType: 'business', profileRead: 'read' });
    const unread = await chat.open(BOB, { clientKey: key(), message: 'hi' });
    expect((await chat.deskPoll({ sessionId: unread.session.id, after: 0 })).session).toMatchObject({ profileType: null, profileRead: 'unread' });
  });

  it('a card number in a chat message is refused before anything is stored', async () => {
    const { chat } = world();
    await expect(chat.open(ALICE, { clientKey: key(), message: 'my card 4111 1111 1111 1111' })).rejects.toMatchObject({
      code: 'support.comment_secret_refused',
    });
  });
});

describe('messages', () => {
  it('a resend with the same key stores one message; the agent reads it from the cursor and the reply reaches the customer', async () => {
    const { chat } = world();
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
    const caller = { userId: ALICE };
    const sent = await chat.send(caller, { sessionId: session.id, clientMessageId: 'm-000001', body: 'where is my deposit?' });
    const again = await chat.send(caller, { sessionId: session.id, clientMessageId: 'm-000001', body: 'where is my deposit?' });
    expect(again.id).toBe(sent.id);
    const desk = await chat.deskPoll({ sessionId: session.id, after: 1 });
    expect(desk.messages.map((m) => m.body)).toEqual(['where is my deposit?']);
    await expect(chat.reply(AGENT, { sessionId: session.id, clientMessageId: 'r-000001', body: 'looking' })).rejects.toMatchObject({
      code: 'support.chat_not_accepted',
    });
    await chat.accept(AGENT, session.id);
    await chat.reply(AGENT, { sessionId: session.id, clientMessageId: 'r-000001', body: 'looking now' });
    const read = await chat.poll(caller, { sessionId: session.id, after: sent.seq });
    expect(read.messages).toEqual([expect.objectContaining({ author: 'agent', body: 'looking now' })]);
    expect(read.session.waitingForAgent).toBe(false);
  });

  it('the same key with another body is refused, not stored', async () => {
    const { chat } = world();
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
    await chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000001', body: 'one' });
    await expect(chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000001', body: 'two' })).rejects.toMatchObject({
      code: 'support.chat_message_conflict',
    });
  });

  it('the owner rate refuses past the limit in one window and opens again in the next', async () => {
    const { chat, tick } = world({ rateLimit: 2 });
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'one' });
    await chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000002', body: 'two' });
    await expect(chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000003', body: 'three' })).rejects.toMatchObject({
      code: 'support.chat_rate_limited',
    });
    tick(60_000);
    await expect(chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000003', body: 'three' })).resolves.toBeTruthy();
  });

  it('someone else, or a wrong token, reads the chat as not there', async () => {
    const { chat } = world();
    const opened = await chat.open(null, { clientKey: key(), prechat: { name: 'A', email: 'a@b.invalid' }, message: 'hello' });
    await expect(chat.poll({ userId: BOB }, { sessionId: opened.session.id, after: 0 })).rejects.toMatchObject({ code: 'support.chat_not_found' });
    await expect(chat.poll({ userId: null, accessToken: key() }, { sessionId: opened.session.id, after: 0 })).rejects.toMatchObject({
      code: 'support.chat_not_found',
    });
    await expect(chat.poll({ userId: null, accessToken: opened.accessToken }, { sessionId: opened.session.id, after: 0 })).resolves.toBeTruthy();
  });
});

describe('agents', () => {
  it('a busy agent cannot take a chat: it waits for an online agent', async () => {
    const { chat, desk } = world();
    desk.members = [staff('busy')];
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
    expect(session.waitingForAgent).toBe(true);
    await expect(chat.accept(AGENT, session.id)).rejects.toMatchObject({ code: 'support.chat_agent_not_online' });
    desk.members = [staff('online')];
    expect((await chat.accept(AGENT, session.id)).status).toBe('active');
  });

  it('a chat another agent took is refused', async () => {
    const { chat, desk } = world();
    const OTHER = '44444444-4444-4444-8444-444444444444';
    desk.members = [staff('online'), staff('online', OTHER)];
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
    await chat.accept(AGENT, session.id);
    await expect(chat.accept(OTHER, session.id)).rejects.toMatchObject({ code: 'support.chat_already_accepted' });
  });
});

describe('closing', () => {
  it('a closed chat is one request holding the transcript, and cannot be written to', async () => {
    const { chat, tickets } = world({}, { [ALICE]: 'business' });
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
    await chat.accept(AGENT, session.id);
    await chat.reply(AGENT, { sessionId: session.id, clientMessageId: 'r-000001', body: 'hi, how can I help?' });
    const closed = await chat.close({ userId: ALICE }, session.id);
    const again = await chat.close({ userId: ALICE }, session.id);
    expect(tickets).toHaveLength(1);
    expect(closed.ticketId).toBe(tickets[0]!.id);
    expect(again.ticketId).toBe(closed.ticketId);
    expect(tickets[0]!.userId).toBe(ALICE);
    expect(tickets[0]!.body).toContain('Customer: hello');
    expect(tickets[0]!.body).toContain('Support: hi, how can I help?');
    const source = await chat.requestSource(closed.ticketId!);
    expect(source).toMatchObject({ source: 'chat', sessionId: session.id, profileType: 'business', profileRead: 'read' });
    expect(source!.transcript.map((m) => m.body)).toEqual(['hello', 'hi, how can I help?']);
    await expect(chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000009', body: 'more' })).rejects.toMatchObject({
      code: 'support.chat_closed',
    });
    await expect(chat.continueByEmail({ userId: ALICE }, session.id)).rejects.toMatchObject({ code: 'support.chat_closed' });
  });

  it('a guest chat becomes a request owned by the session, never by an account', async () => {
    const { chat, tickets } = world();
    const opened = await chat.open(null, { clientKey: key(), prechat: { name: 'A', email: 'a@b.invalid' }, message: 'hello' });
    await chat.close({ userId: null, accessToken: opened.accessToken }, opened.session.id);
    expect(tickets[0]!.userId).toBe(opened.session.id);
  });

  it('a transcript past the request body limit says where the rest is', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ author: 'customer' as const, body: 'x'.repeat(400), createdAt: `t${i}` }));
    const text = transcriptText(many);
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toContain('the rest of the 50 messages is in the chat transcript');
  });
});

describe('continue by email', () => {
  it('there is no mailbox in this build: it names vendor.email and the chat stays open', async () => {
    const { chat } = world();
    const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
    expect(await chat.continueByEmail({ userId: ALICE }, session.id)).toMatchObject({ status: 'not_connected', code: 'vendor.email' });
    await expect(chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000002', body: 'still here' })).resolves.toBeTruthy();
  });
});

describe('identity token', () => {
  it('is refused while the owner has not set its lifetime', () => {
    expect(() => world({ identityTtlSeconds: null }).chat.identityToken(ALICE)).toThrow(expect.objectContaining({ code: 'support.chat_identity_ttl_unset' }));
  });
  it('opens a chat as that account from a page with no session of ours', async () => {
    const { chat } = world();
    const { token } = chat.identityToken(ALICE);
    const opened = await chat.open(null, { clientKey: key(), identity: token, message: 'hello' });
    expect(opened.session).toMatchObject({ identity: 'account', claim: 'verified' });
  });
});
