import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer, type NoticeRow } from './board.js';
import { MaintenanceLifecycle, MemoryMaintenanceStore, maintenanceState, moveVerdict } from './maintenance.js';

/** Scheduled maintenance (SP-status-03): reminder offsets on the draft, the derived state, the moves and the reminders. */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

const T0 = Date.parse('2026-10-23T12:00:00.000Z');
const minutes = (n: number) => new Date(T0 + n * 60_000);

function desk() {
  const clock = { at: T0 };
  const now = () => new Date(clock.at);
  const store = new MemoryMaintenanceStore();
  const board = new NoticeBoard(
    new MemoryNoticeStore(),
    new Approvals(),
    new MemoryCommandLog(),
    now,
    async () => ['api'],
    async () => undefined,
    (ids) => store.closedAmong(ids),
  );
  const reminded: { id: string; offset: number }[] = [];
  const lifecycle = new MaintenanceLifecycle({
    store,
    notice: (id) => board.maintenanceNotice(id),
    upcoming: (at, limit) => board.upcomingMaintenance(at, limit),
    remind: async (notice, offset) => {
      reminded.push({ id: notice.id, offset });
      return { undelivered: 0 };
    },
    now,
  });
  let n = 0;
  const publish = async (input: { startsAt: Date; endsAt: Date; reminderOffsets?: number[]; components?: string[] }) => {
    n += 1;
    const draft = await board.draft(AUTHOR, {
      kind: 'maintenance',
      title: 'TEST database upgrade',
      body: 'TEST we upgrade the database',
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      components: input.components ?? ['api'],
      reminderOffsets: input.reminderOffsets ?? null,
      clientRequestId: `m-${n}`,
    });
    return board.publish(AUTHOR, { id: draft.id, clientRequestId: `p-${n}`, approvalId: `a-${n}`, operationId: `o-${n}` });
  };
  return { board, lifecycle, store, clock, reminded, publish };
}

describe('maintenance reminder offsets on the draft', () => {
  it('belong to maintenance with a start, are stored distinct largest first, and are part of what the approval binds', async () => {
    const { board } = desk();
    const base = {
      kind: 'maintenance',
      title: 'TEST',
      body: 'TEST',
      startsAt: minutes(60).toISOString(),
      endsAt: minutes(120).toISOString(),
    };
    const draft = await board.draft(AUTHOR, { ...base, reminderOffsets: [10, 30, 10], clientRequestId: 'd-1' });
    const plain = await board.draft(AUTHOR, { ...base, clientRequestId: 'd-2' });
    const rows = await board.operatorNotices({ kind: 'maintenance', limit: 10 });
    expect(rows.find((r) => r.id === draft.id)?.reminderOffsets).toEqual([30, 10]);
    expect(rows.find((r) => r.id === plain.id)?.reminderOffsets).toEqual([]);
    // The approval binds the offsets: the hash is the notice's fields with `reminders`, and without them when none.
    const hash = (fields: object) => `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
    const fields = (id: string) => ({ id, kind: 'maintenance', title: 'TEST', body: 'TEST', version: 1 });
    expect((await board.publishProposal(draft.id)).payloadHash).toBe(hash({ ...fields(draft.id), reminders: [30, 10] }));
    expect((await board.publishProposal(plain.id)).payloadHash).toBe(hash(fields(plain.id)));
    for (const bad of [
      { ...base, kind: 'announcement', reminderOffsets: [10] },
      { ...base, startsAt: null, reminderOffsets: [10] },
      { ...base, reminderOffsets: [0] },
      { ...base, reminderOffsets: [43_201] },
      { ...base, reminderOffsets: [1.5] },
      { ...base, reminderOffsets: Array.from({ length: 11 }, (_, i) => i + 1) },
    ])
      await expect(board.draft(AUTHOR, { ...bad, clientRequestId: `bad-${JSON.stringify(bad)}` })).rejects.toMatchObject({
        code: 'notify.notice_reminders_invalid',
      });
  });
});

describe('maintenance state and moves', () => {
  it('is scheduled before the start, in progress from it, then only an operator moves it to verifying and completed', async () => {
    const { lifecycle, clock, publish } = desk();
    const window = await publish({ startsAt: minutes(10), endsAt: minutes(70) });
    const state = async () => (await lifecycle.windows([(await lifecycle['deps'].notice(window.id))!]))[0]!.state;
    expect(await state()).toBe('scheduled');
    await expect(lifecycle.move(AUTHOR, { id: window.id, to: 'verifying', reason: 'TEST' })).rejects.toMatchObject({
      code: 'status.maintenance_illegal_move',
    });
    clock.at = minutes(10).getTime();
    expect(await state()).toBe('in_progress');
    await expect(lifecycle.move(AUTHOR, { id: window.id, to: 'completed', reason: 'TEST' })).rejects.toMatchObject({
      code: 'status.maintenance_illegal_move',
    });
    expect((await lifecycle.move(AUTHOR, { id: window.id, to: 'verifying', reason: 'TEST checks running' })).state).toBe('verifying');
    // Past the planned end it stays where the operator left it: nothing moves on a timer.
    clock.at = minutes(90).getTime();
    expect(await state()).toBe('verifying');
    await expect(lifecycle.move(AUTHOR, { id: window.id, to: 'cancelled', reason: 'TEST' })).rejects.toMatchObject({
      code: 'status.maintenance_illegal_move',
    });
    const done = await lifecycle.move(APPROVER, { id: window.id, to: 'completed', reason: 'TEST checks passed' });
    expect(done.state).toBe('completed');
    expect(done.moves.map((m) => [m.state, m.movedBy, m.reason])).toEqual([
      ['verifying', AUTHOR, 'TEST checks running'],
      ['completed', APPROVER, 'TEST checks passed'],
    ]);
    // The same move again is a replay; any other is a reopen, refused.
    expect((await lifecycle.move(APPROVER, { id: window.id, to: 'completed', reason: 'TEST again' })).moves).toHaveLength(2);
    for (const to of ['in_progress', 'verifying', 'cancelled'] as const)
      await expect(lifecycle.move(AUTHOR, { id: window.id, to, reason: 'TEST reopen' })).rejects.toMatchObject({
        code: 'status.maintenance_reopen_refused',
      });
  });

  it('a window is cancelled before it is verified; drafts and other notices take no move; a move names its reason', async () => {
    const { board, lifecycle, publish } = desk();
    const window = await publish({ startsAt: minutes(10), endsAt: minutes(70) });
    await expect(lifecycle.move(AUTHOR, { id: window.id, to: 'cancelled', reason: '  ' })).rejects.toMatchObject({
      code: 'status.maintenance_reason_unset',
    });
    expect((await lifecycle.move(AUTHOR, { id: window.id, to: 'cancelled', reason: 'TEST not needed' })).state).toBe('cancelled');
    await expect(lifecycle.move(AUTHOR, { id: window.id, to: 'in_progress', reason: 'TEST' })).rejects.toMatchObject({
      code: 'status.maintenance_reopen_refused',
    });
    const draft = await board.draft(AUTHOR, { kind: 'maintenance', title: 'TEST', body: 'TEST', clientRequestId: 'draft' });
    await expect(lifecycle.move(AUTHOR, { id: draft.id, to: 'cancelled', reason: 'TEST' })).rejects.toMatchObject({
      code: 'status.maintenance_unknown',
    });
  });

  it('the derived state and the move rules, exhaustively', () => {
    expect(maintenanceState({ startsAt: minutes(1) }, [], minutes(0))).toBe('scheduled');
    expect(maintenanceState({ startsAt: null }, [], minutes(0))).toBe('in_progress');
    expect(maintenanceState({ startsAt: minutes(1) }, [{ state: 'cancelled' }], minutes(0))).toBe('cancelled');
    expect(moveVerdict('scheduled', 'cancelled')).toBeNull();
    expect(moveVerdict('in_progress', 'cancelled')).toBeNull();
    expect(moveVerdict('scheduled', 'in_progress')).toBe('status.maintenance_illegal_move');
    expect(moveVerdict('in_progress', 'in_progress')).toBe('replay');
    expect(moveVerdict('cancelled', 'completed')).toBe('status.maintenance_reopen_refused');
  });

  it('a completed window leaves the open maintenance and the status feed before its planned end', async () => {
    const { board, lifecycle, clock, publish } = desk();
    const window = await publish({ startsAt: minutes(0), endsAt: minutes(120) });
    clock.at = minutes(1).getTime();
    expect((await board.noticeStatus()).maintenance.map((m) => m.id)).toEqual([window.id]);
    expect((await board.statusFeedFor(['api'], { days: 1 })).maintenance.map((m) => m.id)).toEqual([window.id]);
    await lifecycle.move(AUTHOR, { id: window.id, to: 'verifying', reason: 'TEST' });
    expect((await board.noticeStatus()).maintenance.map((m) => m.id)).toEqual([window.id]);
    await lifecycle.move(AUTHOR, { id: window.id, to: 'completed', reason: 'TEST' });
    expect((await board.noticeStatus()).maintenance).toEqual([]);
    expect((await board.statusFeedFor(['api'], { days: 1 })).maintenance).toEqual([]);
  });
});

describe('maintenance reminders', () => {
  it('one reminder per offset, sent once when due while the window is scheduled; none without offsets', async () => {
    const { lifecycle, clock, reminded, publish } = desk();
    const window = await publish({ startsAt: minutes(60), endsAt: minutes(120), reminderOffsets: [30, 10] });
    const quiet = await publish({ startsAt: minutes(60), endsAt: minutes(120) });
    expect(await lifecycle.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 0 });
    clock.at = minutes(30).getTime();
    expect(await lifecycle.sweep()).toEqual({ sent: 1, skipped: 0, retrying: 0 });
    expect(await lifecycle.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 0 });
    clock.at = minutes(55).getTime();
    await lifecycle.sweep();
    await lifecycle.sweep();
    expect(reminded).toEqual([
      { id: window.id, offset: 30 },
      { id: window.id, offset: 10 },
    ]);
    const [shown, none] = await lifecycle.windows([
      (await lifecycle['deps'].notice(window.id)) as NoticeRow,
      (await lifecycle['deps'].notice(quiet.id)) as NoticeRow,
    ]);
    expect(shown!.reminders.map((r) => [r.offsetMinutes, r.sentAt !== null, r.skipped])).toEqual([
      [30, true, null],
      [10, true, null],
    ]);
    expect(none!.reminders).toEqual([]);
  });

  it('a window cancelled, or already started, skips its due reminders instead of sending them', async () => {
    const { lifecycle, clock, reminded, publish } = desk();
    const cancelled = await publish({ startsAt: minutes(60), endsAt: minutes(120), reminderOffsets: [30] });
    const late = await publish({ startsAt: minutes(20), endsAt: minutes(120), reminderOffsets: [10] });
    expect(await lifecycle.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 0 });
    await lifecycle.move(AUTHOR, { id: cancelled.id, to: 'cancelled', reason: 'TEST' });
    // No sweep ran between the late window's reminder coming due and its start.
    clock.at = minutes(35).getTime();
    expect(await lifecycle.sweep()).toEqual({ sent: 0, skipped: 2, retrying: 0 });
    expect(reminded).toEqual([]);
    const windows = await lifecycle.windows([
      (await lifecycle['deps'].notice(cancelled.id)) as NoticeRow,
      (await lifecycle['deps'].notice(late.id)) as NoticeRow,
    ]);
    expect(windows.map((w) => w.reminders[0]!.skipped)).toEqual(['cancelled', 'in_progress']);
  });

  it('a reminder that failed part way is taken again once its lease runs out', async () => {
    const { lifecycle, clock, publish } = desk();
    await publish({ startsAt: minutes(60), endsAt: minutes(120), reminderOffsets: [30] });
    clock.at = minutes(30).getTime();
    const failing = new MaintenanceLifecycle({
      ...lifecycle['deps'],
      remind: async () => {
        throw new Error('TEST transport down');
      },
    });
    await expect(failing.sweep()).rejects.toThrow('TEST transport down');
    expect(await lifecycle.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 0 });
    clock.at = minutes(33).getTime();
    expect(await lifecycle.sweep()).toEqual({ sent: 1, skipped: 0, retrying: 0 });
  });

  it('a reminder some subscribers did not get stays unsent and is tried again after its lease', async () => {
    const { lifecycle, clock, publish } = desk();
    const window = await publish({ startsAt: minutes(60), endsAt: minutes(120), reminderOffsets: [30] });
    clock.at = minutes(30).getTime();
    const tries: number[] = [];
    const flaky = new MaintenanceLifecycle({
      ...lifecycle['deps'],
      remind: async () => {
        tries.push(clock.at);
        return { undelivered: tries.length === 1 ? 1 : 0 };
      },
    });
    expect(await flaky.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 1 });
    const unsent = await lifecycle.windows([(await lifecycle['deps'].notice(window.id)) as NoticeRow]);
    expect(unsent[0]!.reminders.map((r) => [r.sentAt, r.skipped])).toEqual([[null, null]]);
    expect(await flaky.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 0 });
    clock.at = minutes(33).getTime();
    expect(await flaky.sweep()).toEqual({ sent: 1, skipped: 0, retrying: 0 });
    expect(tries).toHaveLength(2);
  });

  it('offsets already past when the window is published are marked late, never sent in a burst', async () => {
    const { lifecycle, reminded, publish } = desk();
    // Published at T0 for a start 20 minutes later: the 60 and 30 minute reminders were due before it existed.
    const window = await publish({ startsAt: minutes(20), endsAt: minutes(80), reminderOffsets: [60, 30, 10] });
    expect(await lifecycle.sweep()).toEqual({ sent: 0, skipped: 0, retrying: 0 });
    expect(reminded).toEqual([]);
    const [shown] = await lifecycle.windows([(await lifecycle['deps'].notice(window.id)) as NoticeRow]);
    expect(shown!.reminders.map((r) => [r.offsetMinutes, r.skipped])).toEqual([
      [60, 'published_late'],
      [30, 'published_late'],
      [10, null],
    ]);
  });

  it('the sweep reads only windows still to start, and makes a reminder row once', async () => {
    const { board, lifecycle, store, clock, publish } = desk();
    const soon = await publish({ startsAt: minutes(40), endsAt: minutes(80), reminderOffsets: [10] });
    await publish({ startsAt: minutes(40), endsAt: minutes(80) });
    expect((await board.upcomingMaintenance(minutes(0), 10)).map((n) => n.id)).toEqual([soon.id]);
    expect(await board.upcomingMaintenance(minutes(40), 10)).toEqual([]);
    const made: number[] = [];
    const schedule = store.schedule.bind(store);
    store.schedule = async (id, rows) => {
      made.push(rows.length);
      return schedule(id, rows);
    };
    await lifecycle.sweep();
    clock.at = minutes(1).getTime();
    await lifecycle.sweep();
    expect(made).toEqual([1]);
  });
});
