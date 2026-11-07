import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { SqlGroupBook } from './desk-groups.js';
import { DeskRouting, SqlRoutingBook } from './desk-routing.js';
import { SqlStaffBook } from './desk-staff.js';
import { PostgresSupportStore } from './store.js';
import { SupportError } from './support-service.js';

/** Routing against Postgres (SP-routing-01): in turn, the stored cursor, capacity, skills and racing passes. */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(here, '..', 'drizzle', name), 'utf8'));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const LEAD = '33333333-3333-4333-8333-333333333333';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const D = 'd0000000-0000-4000-8000-00000000000d';
const AT = '2026-11-06T10:00:00.000Z';

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.endsWith('_test')) return raw;
  const admin = postgres(raw, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe('CREATE DATABASE adminops_harness_test');
  } catch (err) {
    if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(raw);
  url.pathname = '/adminops_harness_test';
  return url.toString();
}

const url = await harnessUrl();

// Runs unconditionally: CI provides the database, and without one this fails rather than passing unseen.
if (!url) throw new Error('desk-routing.pg.test.ts needs TEST_DATABASE_URL pointing at a reachable Postgres');
{
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.truncateAll();
  });

  async function desk(agents: { id: string; capacity: number | null; skills?: string[] }[]) {
    const store = new PostgresSupportStore(db.sql);
    const staff = new SqlStaffBook(db.sql);
    const groups = new SqlGroupBook(db.sql);
    await staff.appoint({ userId: LEAD, role: 'lead', by: LEAD, at: AT });
    const group = (await groups.save({ name: 'Routed', by: LEAD, at: AT }))!;
    const routing = new DeskRouting(
      new SqlRoutingBook(db.sql),
      staff,
      groups,
      { assertDeskVisible: async () => undefined },
      null,
      null,
      () => new Date(AT),
    );
    for (const a of agents) {
      await staff.appoint({ userId: a.id, role: 'agent', by: LEAD, at: AT });
      await staff.setAvailability({ userId: a.id, value: 'online', by: LEAD, reason: null, at: AT, heartbeat: false });
      await groups.addMember({ groupId: group.id, userId: a.id, by: LEAD, at: AT });
      await routing.setStaffRouting(LEAD, { userId: a.id, capacity: a.capacity, skills: a.skills ?? [] });
    }
    const request = async (subject: string) => {
      const t = await store.createTicket({ userId: CUSTOMER, category: 'account', subject, body: 'TEST' });
      await groups.setTicketGroup({ ticketId: t.id, groupId: group.id, by: LEAD, at: AT });
      return t;
    };
    const assignedRows = async (ticketId: string) =>
      db.sql`SELECT actor_id, note FROM support.ticket_events WHERE ticket_id = ${ticketId} AND kind = 'assigned'`;
    return { store, staff, groups, group, routing, request, assignedRows };
  }

  describe('SqlRoutingBook', () => {
    it('routes nothing while a group has no routing set or has it off', async () => {
      const { routing, request, group } = await desk([{ id: A, capacity: 3 }]);
      const t = await request('unset');
      expect(await routing.route(t.id)).toMatchObject({ status: 'skipped', reason: 'routing_unset' });
      await routing.setMode(LEAD, { groupId: group.id, mode: 'off' });
      expect(await routing.route(t.id)).toMatchObject({ status: 'skipped', reason: 'routing_off' });
    });

    it('assigns five requests in turn to three agents, and the stored cursor carries on in a new process', async () => {
      const { routing, request, group, store } = await desk([
        { id: C, capacity: 5 },
        { id: A, capacity: 5 },
        { id: B, capacity: 5 },
        { id: D, capacity: null },
      ]);
      await routing.setMode(LEAD, { groupId: group.id, mode: 'round_robin' });
      const got: string[] = [];
      for (const n of [1, 2, 3]) got.push(((await routing.route((await request(`r${n}`)).id)) as { assigneeId: string }).assigneeId);
      // A restart: a new book and desk over the same database read the cursor where the last pass left it.
      const again = new DeskRouting(
        new SqlRoutingBook(db.sql),
        new SqlStaffBook(db.sql),
        new SqlGroupBook(db.sql),
        { assertDeskVisible: async () => undefined },
        null,
        null,
        () => new Date(AT),
      );
      for (const n of [4, 5]) got.push(((await again.route((await request(`r${n}`)).id)) as { assigneeId: string }).assigneeId);
      expect(got).toEqual([A, B, C, A, B]);
      expect((await again.overview(LEAD)).groups[0]).toMatchObject({ mode: 'round_robin', cursorUserId: B });
      // D has a blank capacity and was never chosen.
      expect((await store.listAll()).filter((t) => t.assigneeId === D)).toHaveLength(0);
    });

    it('skips an agent at capacity, and queues a request needing a skill nobody has with support.no_agent_available', async () => {
      const { routing, request, group } = await desk([
        { id: A, capacity: 1 },
        { id: B, capacity: 2, skills: ['fx'] },
      ]);
      await routing.setMode(LEAD, { groupId: group.id, mode: 'round_robin' });
      expect(await routing.route((await request('one')).id)).toMatchObject({ assigneeId: A });
      expect(await routing.route((await request('two')).id)).toMatchObject({ assigneeId: B });
      expect(await routing.route((await request('three')).id)).toMatchObject({ assigneeId: B });
      const full = await request('four');
      expect(await routing.route(full.id)).toMatchObject({ status: 'queued', code: 'support.no_agent_available' });
      const skilled = await request('five');
      const set = await routing.setRequiredSkill(LEAD, { ticketId: skilled.id, skill: 'nobody-has-this' });
      expect(set.outcome).toMatchObject({ status: 'queued', code: 'support.no_agent_available' });
      expect(await routing.ticketState(LEAD, skilled.id)).toMatchObject({
        requiredSkill: 'nobody-has-this',
        state: 'no_agent',
        code: 'support.no_agent_available',
      });
      expect((await routing.waiting(LEAD)).map((w) => w.ticketId).sort()).toEqual([full.id, skilled.id].sort());
    });

    it('makes one assignment and one audit row when two passes race on one request', async () => {
      const { routing, request, group, assignedRows } = await desk([
        { id: A, capacity: 5 },
        { id: B, capacity: 5 },
      ]);
      await routing.setMode(LEAD, { groupId: group.id, mode: 'round_robin' });
      const t = await request('race');
      const outcomes = await Promise.all([routing.route(t.id), routing.route(t.id), routing.route(t.id)]);
      expect(outcomes.filter((o) => o.status === 'assigned')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(2);
      expect(await assignedRows(t.id)).toHaveLength(1);
    });

    it('lets exactly one of a hand claim and a routing pass win; the loser changes nothing', async () => {
      const { routing, request, group, store, assignedRows } = await desk([{ id: A, capacity: 5 }]);
      await routing.setMode(LEAD, { groupId: group.id, mode: 'round_robin' });
      const t = await request('claim race');
      const [claim, pass] = await Promise.all([store.claimTicket({ ticketId: t.id, operatorId: B }), routing.route(t.id)]);
      const winners = [claim.status === 'ok', pass.status === 'assigned'].filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(await assignedRows(t.id)).toHaveLength(1);
    });

    it('refuses a non-lead, an unknown person, a bad capacity and a malformed skill', async () => {
      const { routing, group } = await desk([{ id: A, capacity: 1 }]);
      await expect(routing.setMode(A, { groupId: group.id, mode: 'round_robin' })).rejects.toMatchObject({ code: 'support.not_lead' });
      await expect(routing.setStaffRouting(LEAD, { userId: CUSTOMER, capacity: 1, skills: [] })).rejects.toMatchObject({
        code: 'support.not_staff',
      });
      await expect(routing.setStaffRouting(LEAD, { userId: A, capacity: -1, skills: [] })).rejects.toBeInstanceOf(SupportError);
      await expect(routing.setStaffRouting(LEAD, { userId: A, capacity: 1, skills: ['no spaces'] })).rejects.toMatchObject({
        code: 'support.skill_invalid',
      });
      await expect(routing.setMode(LEAD, { groupId: CUSTOMER, mode: 'round_robin' })).rejects.toMatchObject({
        code: 'support.group_unknown',
      });
      const log = await routing.log(LEAD, A);
      expect(log.map((e) => e.action)).toEqual(['capacity_set']);
    });
  });
}
