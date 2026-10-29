import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { SqlGroupBook, deskCanSee } from './desk-groups.js';
import { SqlPropertiesBook } from './desk-properties.js';
import { SqlStaffBook } from './desk-staff.js';
import { SqlLifecycleBook } from './ticket-lifecycle.js';
import { PostgresSupportStore } from './store.js';

/**
 * Staff, unclaim and assign against Postgres.
 *
 * The shared test server's database is named `test`, and the suite guard only
 * accepts a name ending in `_test`. This file creates `adminops_harness_test`
 * on that server when the role can, then isolates the run with createTestDatabase.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

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

if (!url) {
  describe.skip('support desk staff (Postgres unavailable)', () => {
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

  describe('SqlStaffBook and ticket assignment', () => {
    it('appoints a lead, replays the same command, and refuses a different fingerprint', async () => {
      const staff = new SqlStaffBook(db.sql);
      const at = '2026-10-17T00:00:00.000Z';
      const member = await staff.appoint({ userId: LEAD, role: 'lead', by: LEAD, at });
      expect(member.role).toBe('lead');
      expect(await staff.begin('appoint:k1', 'lead')).toBe('new');
      await staff.save('appoint:k1', member);
      expect(await staff.begin('appoint:k1', 'lead')).toBe('replay');
      expect(await staff.read('appoint:k1')).toMatchObject({ userId: LEAD, role: 'lead' });
      await expect(staff.begin('appoint:k1', 'agent')).rejects.toThrow(/idempotency_conflict/);
    });

    it('stores availability, logs one row per change, and writes nothing for an unchanged value', async () => {
      const staff = new SqlStaffBook(db.sql);
      const at = '2026-10-20T08:00:00.000Z';
      await staff.appoint({ userId: AGENT, role: 'agent', by: LEAD, at });
      expect(await staff.get(AGENT)).toMatchObject({ availability: 'offline', availabilitySetAt: null, lastHeartbeatAt: null });
      const set = { userId: AGENT, value: 'busy' as const, by: LEAD, reason: 'covering', at, heartbeat: true };
      expect(await staff.setAvailability(set)).toMatchObject({ availability: 'busy', availabilitySetAt: at, lastHeartbeatAt: at });
      await staff.setAvailability({ ...set, at: '2026-10-20T08:05:00.000Z' });
      const log = await db.sql`SELECT user_id, availability, set_by, reason FROM support.staff_availability_log`;
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ user_id: AGENT, availability: 'busy', set_by: LEAD, reason: 'covering' });
      expect((await staff.heartbeat(AGENT, '2026-10-20T08:10:00.000Z'))?.lastHeartbeatAt).toBe('2026-10-20T08:10:00.000Z');
      expect(await staff.setAvailability({ ...set, userId: USER })).toBeNull();
      expect(await staff.heartbeat(USER, at)).toBeNull();
    });

    it('stores groups, members and ticket placement, logs each change once, and refuses duplicates and unknown groups', async () => {
      const store = new PostgresSupportStore(db.sql);
      const groups = new SqlGroupBook(db.sql);
      const at = '2026-10-20T09:00:00.000Z';
      const ticket = await store.createTicket({ userId: USER, category: 'account', subject: 'Grouped', body: 'Please look' });
      const g = (await groups.save({ name: 'Trading', by: LEAD, at }))!;
      expect(g).toMatchObject({ name: 'Trading', memberIds: [] });
      await expect(groups.save({ name: 'Trading', by: LEAD, at })).rejects.toThrow(/group_name_taken/);
      expect(await groups.save({ id: g.id, name: 'Trading desk', by: LEAD, at })).toMatchObject({ name: 'Trading desk' });
      expect(await groups.addMember({ groupId: g.id, userId: AGENT, by: LEAD, at })).toBe('added');
      expect(await groups.addMember({ groupId: g.id, userId: AGENT, by: LEAD, at })).toBe('duplicate');
      expect(await groups.addMember({ groupId: USER, userId: AGENT, by: LEAD, at })).toBe('unknown_group');
      expect(await groups.groupsOfUser(AGENT)).toEqual([g.id]);
      expect(await groups.setTicketGroup({ ticketId: ticket.id, groupId: g.id, by: LEAD, at })).toBe('ok');
      expect(await groups.setTicketGroup({ ticketId: ticket.id, groupId: g.id, by: LEAD, at })).toBe('ok');
      expect(await groups.setTicketGroup({ ticketId: ticket.id, groupId: USER, by: LEAD, at })).toBe('unknown_group');
      expect(await groups.groupOfTicket(ticket.id)).toBe(g.id);
      expect((await groups.get(g.id))?.memberIds).toEqual([AGENT]);
      expect(await groups.removeMember({ groupId: g.id, userId: AGENT, by: LEAD, at })).toBe('removed');
      expect(await groups.removeMember({ groupId: g.id, userId: AGENT, by: LEAD, at })).toBe('absent');
      expect(await groups.setTicketGroup({ ticketId: ticket.id, groupId: null, by: LEAD, at })).toBe('ok');
      const log = await db.sql`SELECT action FROM support.group_log WHERE group_id = ${g.id} ORDER BY id`;
      expect(log.map((r) => r.action)).toEqual([
        'created',
        'renamed',
        'member_added',
        'ticket_grouped',
        'member_removed',
        'ticket_ungrouped',
      ]);
      expect(deskCanSee({ userId: AGENT, role: 'agent', groupIds: [g.id] }, { assigneeId: null }, g.id, [])).toBe(true);
    });

    it('stores priority, type and labels beside the ticket, logs a change once, and the database refuses a bad value', async () => {
      const store = new PostgresSupportStore(db.sql);
      const book = new SqlPropertiesBook(db.sql);
      const ticket = await store.createTicket({ userId: USER, category: 'account', subject: 'Props', body: 'Please look' });
      const at = '2026-10-20T09:30:00.000Z';
      expect(await book.get(ticket.id)).toEqual({ ticketId: ticket.id, priority: null, ticketType: null, labels: [], updatedAt: null });
      const set = await book.set({ ticketId: ticket.id, priority: 'high', labels: ['vip', 'a-b'], by: LEAD, reason: 'deadline', at });
      expect(set).toMatchObject({ priority: 'high', ticketType: null, labels: ['a-b', 'vip'], updatedAt: at });
      await book.set({ ticketId: ticket.id, priority: 'high', labels: ['vip', 'a-b'], by: LEAD, reason: 'again', at });
      expect(await db.sql`SELECT set_by, reason FROM support.ticket_property_log WHERE ticket_id = ${ticket.id}`).toHaveLength(1);
      expect(await book.changes(ticket.id, 100)).toEqual([
        {
          logId: expect.stringMatching(/^[0-9]+$/),
          ticketId: ticket.id,
          setBy: LEAD,
          reason: 'deadline',
          setAt: at,
          field: 'priority',
          from: null,
          to: 'high',
        },
        {
          logId: expect.stringMatching(/^[0-9]+$/),
          ticketId: ticket.id,
          setBy: LEAD,
          reason: 'deadline',
          setAt: at,
          field: 'labels',
          from: [],
          to: ['a-b', 'vip'],
        },
      ]);
      expect(await book.ticketsWithLabel('vip')).toEqual(new Set([ticket.id]));
      expect(await book.ticketsWithLabel('absent')).toEqual(new Set());
      const cleared = await book.set({ ticketId: ticket.id, priority: null, by: LEAD, reason: null, at: '2026-10-20T09:31:00.000Z' });
      expect(cleared).toMatchObject({ priority: null, labels: ['a-b', 'vip'] });
      // The newest save is kept when the limit cuts, and entries still come oldest first.
      expect((await book.changes(ticket.id, 1)).map((c) => [c.field, c.from, c.to])).toEqual([['priority', 'high', null]]);
      expect((await book.changes(ticket.id, 100)).map((c) => c.field)).toEqual(['priority', 'labels', 'priority']);
      await expect(db.sql`UPDATE support.ticket_properties SET priority = 'critical' WHERE ticket_id = ${ticket.id}`).rejects.toThrow();
    });

    it('rejects an availability outside online, busy and offline in the database', async () => {
      const staff = new SqlStaffBook(db.sql);
      await staff.appoint({ userId: AGENT, role: 'agent', by: LEAD, at: '2026-10-20T08:00:00.000Z' });
      await expect(db.sql`UPDATE support.staff SET availability = 'away' WHERE user_id = ${AGENT}`).rejects.toThrow();
    });

    it('holds a ticket in the database, resumes it on a customer reply with one trail row, and keeps closed terminal', async () => {
      const store = new PostgresSupportStore(db.sql);
      const ticket = await store.createTicket({ userId: USER, category: 'account', subject: 'Hold', body: 'Please look' });
      const held = await store.setStatus({ ticketId: ticket.id, status: 'on_hold', operatorId: AGENT, note: 'Waiting on the bank' });
      expect(held).toMatchObject({ status: 'ok', ticket: { status: 'on_hold' } });
      const reply = await store.addComment({ ticketId: ticket.id, authorId: USER, authorRole: 'user', body: 'Any news?' });
      expect(reply).toMatchObject({ status: 'ok', ticket: { status: 'open' } });
      const events =
        await db.sql`SELECT from_status, to_status, note FROM support.ticket_events WHERE ticket_id = ${ticket.id} AND kind = 'status_changed' ORDER BY sequence`;
      expect(events.map((e) => `${e.from_status}->${e.to_status}:${e.note}`)).toEqual([
        'open->on_hold:Waiting on the bank',
        'on_hold->open:user_reply_resume',
      ]);
      await db.sql`UPDATE support.tickets SET status = 'on_hold' WHERE id = ${ticket.id}`;
      await db.sql`UPDATE support.tickets SET status = 'closed' WHERE id = ${ticket.id}`;
      await expect(db.sql`UPDATE support.tickets SET status = 'on_hold' WHERE id = ${ticket.id}`).rejects.toThrow(/terminal/);
      await expect(db.sql`UPDATE support.tickets SET status = 'paused' WHERE id = ${ticket.id}`).rejects.toThrow();
    });

    it('stores waiting-on, the first public reply and the follow-up link beside the ticket', async () => {
      const store = new PostgresSupportStore(db.sql);
      const book = new SqlLifecycleBook(db.sql);
      const closed = await store.createTicket({ userId: USER, category: 'account', subject: 'Old', body: 'Please look' });
      const next = await store.createTicket({ userId: USER, category: 'account', subject: 'New', body: 'Again' });
      const t1 = '2026-10-20T10:00:00.000Z';
      const t2 = '2026-10-20T10:05:00.000Z';
      expect(await book.get(next.id)).toEqual({
        ticketId: next.id,
        waitingOn: null,
        waitingSince: null,
        firstPublicReplyAt: null,
        followsTicketId: null,
      });
      await book.setWaiting(next.id, 'customer', t1);
      await book.markFirstPublicReply(next.id, t1);
      await book.setWaiting(next.id, 'customer', t2);
      await book.markFirstPublicReply(next.id, t2);
      await book.linkFollowUp(next.id, closed.id, t1);
      await book.linkFollowUp(next.id, closed.id, t2);
      expect(await book.get(next.id)).toEqual({
        ticketId: next.id,
        waitingOn: 'customer',
        waitingSince: t1,
        firstPublicReplyAt: t1,
        followsTicketId: closed.id,
      });
      await book.setWaiting(next.id, 'team', t2);
      expect(await book.get(next.id)).toMatchObject({ waitingOn: 'team', waitingSince: t2, firstPublicReplyAt: t1 });
      await book.setWaiting(next.id, null, t2);
      expect(await book.get(next.id)).toMatchObject({ waitingOn: null, waitingSince: null });
      await expect(db.sql`UPDATE support.ticket_lifecycle SET waiting_on = 'both' WHERE ticket_id = ${next.id}`).rejects.toThrow();
      await expect(
        db.sql`UPDATE support.ticket_lifecycle SET follows_ticket_id = ticket_id WHERE ticket_id = ${next.id}`,
      ).rejects.toThrow();
    });

    it('unclaims only the assignee and lets a lead assign the ticket to another staff id', async () => {
      const store = new PostgresSupportStore(db.sql);
      const ticket = await store.createTicket({ userId: USER, category: 'account', subject: 'Stuck', body: 'Please look' });
      const claimed = await store.claimTicket({ ticketId: ticket.id, operatorId: AGENT });
      expect(claimed.status).toBe('ok');
      const stolen = await store.releaseTicket({ ticketId: ticket.id, operatorId: LEAD });
      expect(stolen).toMatchObject({ status: 'refuse', reason: 'not_assignee' });
      const released = await store.releaseTicket({ ticketId: ticket.id, operatorId: AGENT });
      expect(released.status).toBe('ok');
      if (released.status === 'ok') expect(released.ticket.assigneeId).toBeNull();
      const assigned = await store.assignTicket({ ticketId: ticket.id, operatorId: LEAD, assigneeId: LEAD });
      expect(assigned.status).toBe('ok');
      if (assigned.status === 'ok') expect(assigned.ticket.assigneeId).toBe(LEAD);
    });
  });
}
