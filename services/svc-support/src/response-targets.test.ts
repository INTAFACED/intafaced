import { describe, expect, it } from 'vitest';
import { MemoryStaffBook } from './desk-staff.js';
import { SupportService } from './support-service.js';
import { MemoryResponseTargetBook, SLA_POLICY_STALE, SLA_TARGETS_UNSET } from './response-targets.js';
import { MemorySupportStore } from './store.js';

const USER = '11111111-1111-4111-8111-111111111111';
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-18T10:00:00.000Z');

async function desk() {
  const staff = new MemoryStaffBook();
  await staff.appoint({ userId: LEAD, role: 'lead', by: LEAD, at: NOW.toISOString() });
  await staff.appoint({ userId: AGENT, role: 'agent', by: LEAD, at: NOW.toISOString() });
  const svc = new SupportService(new MemorySupportStore(), undefined, undefined, staff, undefined, null, () => NOW);
  const book = new MemoryResponseTargetBook();
  svc.useResponseTargets(book);
  return { svc, book };
}

const ask = (svc: SupportService, subject: string) => svc.createTicket({ userId: USER, category: 'account', subject, body: 'B' });
const save = (svc: SupportService, input: { firstReplyMinutes?: number | null; active?: boolean; expectedRevision: number }) =>
  svc.saveResponseTargets({ actorId: LEAD, reason: 'TEST target', ...input });

describe('response targets (SP-sla-01)', () => {
  it('blank: no target, off, and no due time on the queue', async () => {
    const { svc } = await desk();
    expect(await svc.responseTargets()).toEqual({ firstReplyMinutes: null, active: false, revision: 0, updatedAt: null });
    await ask(svc, 'one');
    const q = await svc.listOperatorQueue({ limit: 10 });
    expect(q.status === 'ok' && q.entries.map((e) => e.responseDue)).toEqual([null]);
  });

  it('turning on with no target refuses support.sla_targets_unset and changes nothing', async () => {
    const { svc, book } = await desk();
    await expect(save(svc, { active: true, expectedRevision: 0 })).rejects.toMatchObject({ code: SLA_TARGETS_UNSET });
    await save(svc, { firstReplyMinutes: 30, active: true, expectedRevision: 0 });
    await expect(save(svc, { firstReplyMinutes: null, expectedRevision: 1 })).rejects.toMatchObject({ code: SLA_TARGETS_UNSET });
    expect((await svc.responseTargets()).firstReplyMinutes).toBe(30);
    expect(book.log).toHaveLength(1);
  });

  it('only a lead changes it, from the revision read; a replay of the same change returns the stored policy', async () => {
    const { svc } = await desk();
    await expect(
      svc.saveResponseTargets({ actorId: AGENT, firstReplyMinutes: 30, expectedRevision: 0, reason: 'r' }),
    ).rejects.toMatchObject({
      code: 'support.not_lead',
    });
    const first = await save(svc, { firstReplyMinutes: 30, expectedRevision: 0 });
    expect(await save(svc, { firstReplyMinutes: 30, expectedRevision: 0 })).toEqual(first);
    await expect(save(svc, { firstReplyMinutes: 45, expectedRevision: 0 })).rejects.toMatchObject({ code: SLA_POLICY_STALE });
  });

  it('a request made while the target is on shows the due time from it; one from before shows none; off hides them all', async () => {
    const { svc } = await desk();
    const before = await ask(svc, 'before');
    await save(svc, { firstReplyMinutes: 30, active: true, expectedRevision: 0 });
    const after = await ask(svc, 'after');
    const due = async () => {
      const q = await svc.listOperatorQueue({ limit: 10 });
      return new Map(q.status === 'ok' ? q.entries.map((e) => [e.ticketId, e.responseDue]) : []);
    };
    const on = await due();
    expect(on.get(before.id)).toBeNull();
    expect(on.get(after.id)).toEqual({ dueAt: new Date(Date.parse(after.createdAt) + 30 * 60_000).toISOString(), targetMinutes: 30 });
    // A later change of target does not move a clock already started.
    await save(svc, { firstReplyMinutes: 60, expectedRevision: 1 });
    expect((await due()).get(after.id)?.targetMinutes).toBe(30);
    await save(svc, { active: false, expectedRevision: 2 });
    expect([...(await due()).values()]).toEqual([null, null]);
  });
});
