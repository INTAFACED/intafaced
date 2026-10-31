import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { guestVerificationKey, type GuestVerificationReceipt, type GuestVerificationSendInput } from '@intafaced/contracts';
import { GuestRequests, type GuestRequestSettings } from './guest-requests.js';
import { GuestVerificationRefusal, type GuestVerificationDoor } from './guest-verification-client.js';
import { MemorySupportStore } from './store.js';
import type { SupportService } from './support-service.js';
import { withTestCommentCap } from './comment-cap.fixture.js';

/** Guest requests against Postgres (SP-tickets-01, J-support-public-03): store, mail, verify once, read and reply by link. */

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

/** svc-notify's door as a recorder: answers each send as told and keeps the links it was handed. */
class Door implements GuestVerificationDoor {
  configured = true;
  readonly sent: GuestVerificationSendInput[] = [];
  answer: 'accepted' | 'unconfigured' | 'lost' | 'refuse-origin' = 'accepted';
  async send(input: GuestVerificationSendInput): Promise<GuestVerificationReceipt | null> {
    this.sent.push(input);
    if (this.answer === 'lost') return null;
    if (this.answer === 'refuse-origin') throw new GuestVerificationRefusal('guest.link_origin_mismatch');
    const accepted = this.answer === 'accepted';
    return {
      notificationId: '33333333-3333-4333-8333-333333333333',
      businessKey: input.businessKey,
      status: accepted ? 'accepted' : 'refused',
      attemptedAt: accepted ? new Date().toISOString() : null,
      acceptedAt: accepted ? new Date().toISOString() : null,
      code: accepted ? null : 'guest.notification_unconfigured',
      reference: null,
    };
  }
  async get() {
    return null;
  }
  readonly erased: string[] = [];
  async erase(id: string) {
    this.erased.push(id);
    return { guestRequestId: id, erasedCount: 1, erasedAt: new Date().toISOString() };
  }
  /** The token in the last link it was handed. */
  token(): string {
    return new URL(this.sent.at(-1)!.link).hash.replace('#token=', '');
  }
}

const SETTINGS: GuestRequestSettings = {
  linkTtlMinutes: 30,
  rateLimit: 3,
  rateWindowSeconds: 3600,
  retentionDays: 30,
  addressKey: 'ab'.repeat(32),
  publicOrigin: 'https://app.example.test',
};

if (!url) {
  describe.skip('guest requests (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  let door: Door;
  let desk: SupportService;
  let store: MemorySupportStore;
  let clock: Date;
  const guests = (settings: Partial<GuestRequestSettings> = {}) =>
    new GuestRequests(db.sql, desk, door, { ...SETTINGS, ...settings }, () => clock);
  let n = 0;
  const ask = (over: Record<string, unknown> = {}) => ({
    email: 'Guest@Example.test',
    category: 'account',
    subject: 'TEST cannot sign in',
    body: 'TEST guest request body',
    clientRequestId: `guest-${++n}`,
    ...over,
  });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (err: { code?: string }) => err.code,
    );

  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
    door = new Door();
    store = new MemorySupportStore();
    desk = withTestCommentCap(store);
    clock = new Date('2026-10-31T10:00:00.000Z');
  });

  it('stores the request, mails a link to the customer app and opens no ticket; the address and token are not stored in clear', async () => {
    const made = await guests().create(ask());
    expect(made).toMatchObject({ state: 'check_email', linkExpiresAt: '2026-10-31T10:30:00.000Z' });
    expect(door.sent).toHaveLength(1);
    expect(door.sent[0]).toMatchObject({
      businessKey: guestVerificationKey(made.guestRequestId, 1),
      recipientEmail: 'Guest@Example.test',
      expiresAt: '2026-10-31T10:30:00.000Z',
    });
    expect(door.sent[0]!.link.startsWith('https://app.example.test/support/guest/verify#token=')).toBe(true);
    const rows = await db.sql`SELECT * FROM support.guest_requests`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', ticket_id: null, send_ordinal: 1 });
    const stored = JSON.stringify(rows);
    expect(stored.toLowerCase()).not.toContain('guest@example.test');
    expect(stored).not.toContain(door.token().split('.')[1]);
    expect(await desk.listAllTickets({ limit: 10 })).toHaveLength(0);
  });

  it('a replay of the same submission mails nothing new; a different request under its key is a conflict', async () => {
    const input = ask();
    const first = await guests().create(input);
    expect(await guests().create(input)).toEqual(first);
    expect(door.sent).toHaveLength(1);
    expect(await code(guests().create({ ...input, subject: 'TEST other' }))).toBe('support.idempotency_conflict');
  });

  it('with no sender the request stays pending with vendor.email, and the same submission is mailed once a sender exists', async () => {
    const input = ask();
    door.configured = false;
    expect(await code(guests().create(input))).toBe('vendor.email');
    expect(door.sent).toHaveLength(0);
    expect(await db.sql`SELECT status, delivery_code FROM support.guest_requests`).toEqual([
      { status: 'pending_delivery', delivery_code: 'vendor.email' },
    ]);
    door.configured = true;
    door.answer = 'unconfigured';
    expect(await code(guests().create(input))).toBe('vendor.email');
    expect(await code(guests({ publicOrigin: null }).create(input))).toBe('vendor.email');
    door.answer = 'accepted';
    expect(await guests().create(input)).toMatchObject({ state: 'check_email' });
    expect(door.sent.map((s) => s.businessKey.split(':').at(-1))).toEqual(['2', '4']);
    expect(await db.sql`SELECT status FROM support.guest_requests`).toEqual([{ status: 'sent' }]);
  });

  it('a lost answer from the sender is never sent again', async () => {
    const input = ask();
    door.answer = 'lost';
    expect(await code(guests().create(input))).toBe('support.guest_delivery_unknown');
    door.answer = 'accepted';
    expect(await code(guests().create(input))).toBe('support.guest_delivery_unknown');
    expect(door.sent).toHaveLength(1);
  });

  it('a typed refusal from the door keeps the request pending under that code', async () => {
    door.answer = 'refuse-origin';
    expect(await code(guests().create(ask()))).toBe('guest.link_origin_mismatch');
    expect(await db.sql`SELECT status, delivery_code FROM support.guest_requests`).toEqual([
      { status: 'pending_delivery', delivery_code: 'guest.link_origin_mismatch' },
    ]);
  });

  it('the emailed link opens one ticket, and the same link again opens the same ticket', async () => {
    await guests().create(ask({ subject: 'TEST guest opens a ticket' }));
    const token = door.token();
    const first = await guests().verify({ token });
    const again = await guests().verify({ token });
    expect(again.ticketId).toBe(first.ticketId);
    const ticket = await desk.getTicket({ userId: 'operator', ticketId: first.ticketId, asOperator: true });
    expect(ticket).toMatchObject({ subject: 'TEST guest opens a ticket', category: 'account' });
    expect(ticket.userId.startsWith('guest:')).toBe(true);
    expect(await db.sql`SELECT status, ticket_id FROM support.guest_requests`).toEqual([{ status: 'verified', ticket_id: first.ticketId }]);
  });

  it('reads and replies through the access token on that one request only, never a staff note; a verification or altered token reads as none', async () => {
    await guests().create(ask());
    const opened = await guests().verify({ token: door.token() });
    const thread = await guests().thread({ access: opened.access, limit: 50 });
    expect(thread.ticket.id).toBe(opened.ticketId);
    const reply = await guests().reply({ access: opened.access, body: 'TEST guest reply', clientRequestId: 'r-1' });
    expect(reply.body).toBe('TEST guest reply');
    // A staff note on the request is never in what the guest link reads.
    await store.addComment({
      ticketId: opened.ticketId,
      authorId: 'agent-1',
      authorRole: 'operator',
      visibility: 'internal',
      body: 'TEST staff only',
      clientRequestId: 'note-1',
    });
    const bodies = (await guests().thread({ access: opened.access, limit: 50 })).comments.map((c) => c.body);
    expect(bodies).toContain('TEST guest reply');
    expect(bodies).not.toContain('TEST staff only');
    // The verification token is not an access token, and an altered one reads as no request.
    expect(await code(guests().thread({ access: door.token(), limit: 50 }))).toBe('support.guest_link_invalid');
    const [id] = opened.access.split('.');
    expect(await code(guests().thread({ access: `${id}.${'A'.repeat(43)}`, limit: 50 }))).toBe('support.guest_link_invalid');
  });

  it('an expired link refuses by name and opens nothing', async () => {
    await guests().create(ask());
    clock = new Date('2026-10-31T10:31:00.000Z');
    expect(await code(guests().verify({ token: door.token() }))).toBe('support.guest_link_expired');
    expect(await db.sql`SELECT ticket_id FROM support.guest_requests`).toEqual([{ ticket_id: null }]);
  });

  it('over the per-address limit: a typed refusal and no row; another address is not affected', async () => {
    for (let i = 0; i < 3; i += 1) await guests().create(ask({ email: 'busy@example.test' }));
    expect(await code(guests().create(ask({ email: 'BUSY@example.test' })))).toBe('support.guest_rate_limited');
    expect(await db.sql`SELECT 1 FROM support.guest_requests`).toHaveLength(3);
    expect(await guests().create(ask({ email: 'calm@example.test' }))).toMatchObject({ state: 'check_email' });
  });

  it('each blank owner value refuses by name and stores nothing', async () => {
    expect(await code(guests({ linkTtlMinutes: null }).create(ask()))).toBe('support.guest_link_ttl_unset');
    expect(await code(guests({ rateLimit: null }).create(ask()))).toBe('support.guest_rate_limit_unset');
    expect(await code(guests({ rateWindowSeconds: null }).create(ask()))).toBe('support.guest_rate_limit_unset');
    expect(await code(guests({ retentionDays: null }).create(ask()))).toBe('support.guest_retention_unset');
    expect(await code(guests({ addressKey: null }).create(ask()))).toBe('support.guest_address_key_unset');
    expect(await code(guests().create(ask({ category: 'lottery' })))).toBe('support.category_unknown');
    expect(await db.sql`SELECT 1 FROM support.guest_requests`).toHaveLength(0);
    expect(door.sent).toHaveLength(0);
  });

  it('a fraud report with no compliance group is refused before anything is stored', async () => {
    expect(await code(guests().create(ask({ category: 'fraud_report' })))).toBe('support.fraud_route_unset');
    expect(await db.sql`SELECT 1 FROM support.guest_requests`).toHaveLength(0);
  });

  it('erases addresses past retention here once svc-notify has erased them, and the links stop', async () => {
    await guests().create(ask());
    const opened = await guests().verify({ token: door.token() });
    clock = new Date('2026-12-01T10:00:00.000Z');
    expect(await guests().eraseDue()).toBe(1);
    expect(door.erased).toHaveLength(1);
    expect(await db.sql`SELECT address_sealed, access_hash FROM support.guest_requests`).toEqual([
      { address_sealed: null, access_hash: null },
    ]);
    clock = new Date('2026-10-31T11:00:00.000Z');
    expect(await code(guests().thread({ access: opened.access, limit: 50 }))).toBe('support.guest_link_invalid');
  });
}
