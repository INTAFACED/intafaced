import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import type { SupportTicket } from '@intafaced/contracts';
import { SqlChatBook, SupportChat, type ChatSettings } from './chat.js';
import type { StaffMember } from './desk-staff.js';

/** The chat book against Postgres (SP-chat-01): keys hold under a race, the rate window is counted in the database, and close links one request. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.endsWith('_test')) return raw;
  const admin = postgres(raw, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe('CREATE DATABASE adminops_harness_test');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(raw);
  url.pathname = '/adminops_harness_test';
  return url.toString();
}

const url = await harnessUrl();
const ALICE = '11111111-1111-4111-8111-111111111111';
const AGENT = '33333333-3333-4333-8333-333333333333';
const key = () => randomBytes(32).toString('base64url');

if (!url) {
  describe.skip('support chat book (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  const settings: ChatSettings = {
    rateLimit: 3,
    rateWindowSeconds: 3600,
    identityTtlSeconds: 300,
    prechatFields: ['name', 'email'],
    addressKey: 'b'.repeat(64),
    retentionDays: 30,
    guestRateLimit: 3,
    guestRateWindowSeconds: 3600,
    claimSecret: 'a'.repeat(64),
  };
  const staff: StaffMember[] = [
    {
      userId: AGENT,
      role: 'agent',
      appointedBy: AGENT,
      appointedAt: '2026-11-01T00:00:00.000Z',
      availability: 'online',
      availabilitySetAt: null,
      lastHeartbeatAt: null,
    },
  ];
  // The request a chat becomes, written as the support store writes one, keyed like `createTicketOnce`.
  const made = new Map<string, Promise<SupportTicket>>();
  const desk = {
    listStaff: async () => staff,
    createTicket(input: { userId: string; category: 'other'; subject: string; body: string; clientRequestId: string }) {
      const prior = made.get(input.clientRequestId);
      if (prior) return prior;
      const ticket = db.sql<{ id: string }[]>`INSERT INTO support.tickets (user_id, category, subject, body)
        VALUES (${input.userId}, ${input.category}, ${input.subject}, ${input.body}) RETURNING id`.then(
        (rows) => ({ id: rows[0]!.id, userId: input.userId }) as SupportTicket,
      );
      made.set(input.clientRequestId, ticket);
      return ticket;
    },
  };
  const chatOf = () => new SupportChat(new SqlChatBook(db.sql), desk, { profileOf: async () => 'business' }, settings, async () => null);

  describe('SqlChatBook', () => {
    it('the same key opened twice at once is one chat with one first message', async () => {
      const chat = chatOf();
      const k = key();
      const [a, b] = await Promise.all([
        chat.open(ALICE, { clientKey: k, message: 'hello' }),
        chat.open(ALICE, { clientKey: k, message: 'hello' }),
      ]);
      expect(a.session.id).toBe(b.session.id);
      expect(a.accessToken).toBe(b.accessToken);
      expect(await db.sql`SELECT 1 FROM support.chat_sessions`).toHaveLength(1);
      expect(await db.sql`SELECT 1 FROM support.chat_messages`).toHaveLength(1);
      const stored = await db.sql<{ client_key: string; access_hash: string }[]>`SELECT client_key, access_hash FROM support.chat_sessions`;
      expect(stored[0]!.client_key).not.toBe(k);
      expect(stored[0]!.access_hash).not.toBe(a.accessToken);
    });

    it('the same message key sent twice at once stores one message', async () => {
      const chat = chatOf();
      const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
      const send = () => chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000001', body: 'twice' });
      const [a, b] = await Promise.all([send(), send()]);
      expect(a.id).toBe(b.id);
      expect(await db.sql`SELECT 1 FROM support.chat_messages WHERE body = 'twice'`).toHaveLength(1);
    });

    it('counts the opening message in the rate window and refuses past it, storing nothing', async () => {
      const chat = chatOf();
      const { session } = await chat.open(ALICE, { clientKey: key(), message: 'one' });
      await chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000002', body: 'two' });
      await chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000003', body: 'three' });
      await expect(
        chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000004', body: 'four' }),
      ).rejects.toMatchObject({
        code: 'support.chat_rate_limited',
      });
      expect(await db.sql`SELECT 1 FROM support.chat_messages WHERE session_id = ${session.id}`).toHaveLength(3);
    });

    it('a guest enquiry keeps the address sealed, and the erase sweep removes it after the retention', async () => {
      const chat = chatOf();
      const opened = await chat.open(null, {
        clientKey: key(),
        prechat: { name: 'TEST', email: 'guest@local-test.invalid' },
        message: 'hi',
      });
      const rows = await db.sql<
        { address_sealed: string | null; source: string }[]
      >`SELECT address_sealed, source FROM support.chat_enquiries`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('chat');
      expect(rows[0]!.address_sealed).not.toContain('guest@');
      await db.sql`UPDATE support.chat_enquiries SET erase_after = now() - interval '1 minute'`;
      expect(await chat.eraseDue()).toBe(1);
      expect((await chat.enquiries(opened.session.id, 10))[0]!.hasEmail).toBe(false);
    });

    it('closing twice at once makes one request, linked with its source row, and the chat takes no more messages', async () => {
      made.clear();
      const chat = chatOf();
      const { session } = await chat.open(ALICE, { clientKey: key(), message: 'hello' });
      await chat.accept(AGENT, session.id);
      await chat.reply(AGENT, { sessionId: session.id, clientMessageId: 'r-000001', body: 'hi there' });
      const [a, b] = await Promise.all([chat.close({ userId: ALICE }, session.id), chat.close({ userId: ALICE }, session.id)]);
      expect(a.ticketId).toBeTruthy();
      expect(b.ticketId).toBe(a.ticketId);
      expect(await db.sql`SELECT 1 FROM support.tickets`).toHaveLength(1);
      const source = await chat.requestSource(a.ticketId!);
      expect(source).toMatchObject({ source: 'chat', sessionId: session.id, profileType: 'business', profileRead: 'read' });
      expect(source!.transcript.map((m) => m.body)).toEqual(['hello', 'hi there']);
      await expect(
        chat.send({ userId: ALICE }, { sessionId: session.id, clientMessageId: 'm-000009', body: 'late' }),
      ).rejects.toMatchObject({
        code: 'support.chat_closed',
      });
      await expect(db.sql`UPDATE support.chat_sessions SET ticket_id = NULL, status = 'active' WHERE id = ${session.id}`).rejects.toThrow();
    });
  });
}
