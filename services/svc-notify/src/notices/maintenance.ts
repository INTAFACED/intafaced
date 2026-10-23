/**
 * Scheduled maintenance (SP-status-03): where a published window stands, the operator's moves, and its reminders.
 *
 * The state is derived, never held by a timer: before the start it is scheduled, from the start in progress, and after
 * that only an operator moves it on, to verifying and then completed. A window not yet verifying can be cancelled. A
 * completed or cancelled window is final (`status.maintenance_reopen_refused`); any other move that does not follow is
 * `status.maintenance_illegal_move`. Each move is stored once, with who made it and why.
 *
 * Reminders are rows keyed (window, offset), one per offset the window was published with (none without offsets). A
 * sweep sends a due reminder to the subscribers the window concerns while the window is still scheduled, and marks it
 * sent; a window that started, completed or was cancelled first skips it. Delivery rows are keyed per subscriber, so a
 * reminder sent again after a crash reaches no one twice.
 */
import type { NoticeRow } from './board.js';

export const MAINTENANCE_STATES = ['scheduled', 'in_progress', 'verifying', 'completed', 'cancelled'] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];

/** The states an operator moves a window to; scheduled and in progress follow from the clock. */
export const MAINTENANCE_MOVES = ['verifying', 'completed', 'cancelled'] as const;
export type MaintenanceMoveState = (typeof MAINTENANCE_MOVES)[number];

/** What the desk asks for: a move, or putting a finished window back in progress (always refused). */
export type MaintenanceTarget = MaintenanceMoveState | 'in_progress';

export const REMINDER_LEASE_MS = 120_000;
/** How often the reminder sweep runs: a due reminder goes out within this of its time. An operating interval, not a promise. */
export const MAINTENANCE_SWEEP_INTERVAL_MS = 15_000;
const REMINDERS_PER_SWEEP = 50;
const SWEEP_WINDOWS_MAX = 500;

export type MaintenanceCode =
  | 'status.maintenance_illegal_move'
  | 'status.maintenance_reopen_refused'
  | 'status.maintenance_unknown'
  | 'status.maintenance_reason_unset';

export class MaintenanceError extends Error {
  constructor(readonly code: MaintenanceCode) {
    super(code);
    this.name = 'MaintenanceError';
  }
}

export type MaintenanceMove = {
  readonly noticeId: string;
  readonly state: MaintenanceMoveState;
  readonly movedBy: string;
  readonly reason: string;
  readonly movedAt: Date;
};

export type ReminderRow = {
  readonly noticeId: string;
  readonly offsetMinutes: number;
  readonly dueAt: Date;
  readonly sentAt: Date | null;
  /** The state the window was in when its reminder came due and was not sent. */
  readonly skipped: 'in_progress' | 'verifying' | 'completed' | 'cancelled' | null;
};

export interface MaintenanceStore {
  moves(noticeId: string): Promise<readonly MaintenanceMove[]>;
  /** Moves of many windows at once, for the desk. */
  movesOf(noticeIds: readonly string[]): Promise<readonly MaintenanceMove[]>;
  /** Ids of windows moved to completed or cancelled. */
  closed(): Promise<ReadonlySet<string>>;
  /**
   * Stores `move` when `allowed` says the window's moves so far permit it, in one step under the window's lock, so two
   * moves at once cannot both pass. Answers the moves as stored after it, or the refusal `allowed` gave.
   */
  applyMove(
    move: MaintenanceMove,
    allowed: (moves: readonly MaintenanceMove[]) => MaintenanceCode | 'replay' | null,
  ): Promise<readonly MaintenanceMove[] | MaintenanceCode>;
  /** Makes the window's reminder rows; rows that exist are left as they are. */
  schedule(noticeId: string, reminders: readonly { offsetMinutes: number; dueAt: Date }[]): Promise<void>;
  remindersOf(noticeIds: readonly string[]): Promise<readonly ReminderRow[]>;
  /** Takes up to `limit` due, unsettled reminders for a lease; another sweep holding one is skipped. */
  claimDue(at: Date, until: Date, limit: number): Promise<readonly ReminderRow[]>;
  settle(
    noticeId: string,
    offsetMinutes: number,
    outcome: { sentAt: Date } | { skipped: NonNullable<ReminderRow['skipped']> },
  ): Promise<void>;
}

/** Where a published window stands at `at`. */
export function maintenanceState(
  row: Pick<NoticeRow, 'startsAt'>,
  moves: readonly Pick<MaintenanceMove, 'state'>[],
  at: Date,
): MaintenanceState {
  const done = new Set(moves.map((m) => m.state));
  if (done.has('cancelled')) return 'cancelled';
  if (done.has('completed')) return 'completed';
  if (done.has('verifying')) return 'verifying';
  return row.startsAt && row.startsAt.getTime() > at.getTime() ? 'scheduled' : 'in_progress';
}

/** Whether `to` follows from `from`. A finished window takes no move; the same move again is a replay. */
export function moveVerdict(from: MaintenanceState, to: MaintenanceTarget): MaintenanceCode | 'replay' | null {
  if (to === from) return 'replay';
  if (from === 'completed' || from === 'cancelled') return 'status.maintenance_reopen_refused';
  if (to === 'verifying') return from === 'in_progress' ? null : 'status.maintenance_illegal_move';
  if (to === 'completed') return from === 'verifying' ? null : 'status.maintenance_illegal_move';
  if (to === 'cancelled') return from === 'scheduled' || from === 'in_progress' ? null : 'status.maintenance_illegal_move';
  return 'status.maintenance_illegal_move';
}

export type MaintenanceWindow = {
  readonly notice: NoticeRow;
  readonly state: MaintenanceState | null;
  readonly moves: readonly MaintenanceMove[];
  readonly reminders: readonly ReminderRow[];
};

/** What the lifecycle needs from the notice board and the subscriber fan-out. */
export type MaintenanceDeps = {
  readonly store: MaintenanceStore;
  readonly notice: (id: string) => Promise<NoticeRow | null>;
  readonly published: (limit: number) => Promise<readonly NoticeRow[]>;
  readonly remind: (notice: NoticeRow, offsetMinutes: number) => Promise<void>;
  readonly now?: () => Date;
};

export class MaintenanceLifecycle {
  private readonly now: () => Date;
  constructor(private readonly deps: MaintenanceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The founders' desk: each window with its state (null for a draft), its moves and its reminders. */
  async windows(notices: readonly NoticeRow[]): Promise<readonly MaintenanceWindow[]> {
    const ids = notices.map((n) => n.id);
    const [moves, reminders] = await Promise.all([this.deps.store.movesOf(ids), this.deps.store.remindersOf(ids)]);
    const at = this.now();
    return notices.map((notice) => {
      const own = moves.filter((m) => m.noticeId === notice.id);
      return {
        notice,
        state: notice.status === 'published' ? maintenanceState(notice, own, at) : null,
        moves: own,
        reminders: reminders.filter((r) => r.noticeId === notice.id).sort((a, b) => b.offsetMinutes - a.offsetMinutes),
      };
    });
  }

  /** One operator move, with a reason. The same move again answers the window as it stands. */
  async move(by: string, input: { id: string; to: MaintenanceTarget; reason: string }): Promise<MaintenanceWindow> {
    const reason = input.reason.trim();
    if (reason === '' || reason.length > 500) throw new MaintenanceError('status.maintenance_reason_unset');
    const notice = await this.deps.notice(input.id);
    if (!notice || notice.status !== 'published') throw new MaintenanceError('status.maintenance_unknown');
    const at = this.now();
    if (input.to !== 'in_progress') {
      const stored = await this.deps.store.applyMove({ noticeId: notice.id, state: input.to, movedBy: by, reason, movedAt: at }, (moves) =>
        moveVerdict(maintenanceState(notice, moves, at), input.to),
      );
      if (typeof stored === 'string') throw new MaintenanceError(stored);
    } else {
      const verdict = moveVerdict(maintenanceState(notice, await this.deps.store.moves(notice.id), at), 'in_progress');
      if (verdict !== 'replay') throw new MaintenanceError(verdict ?? 'status.maintenance_illegal_move');
    }
    return (await this.windows([notice]))[0]!;
  }

  /**
   * One sweep: makes the reminder rows of every published window with offsets, then sends the due ones whose window is
   * still scheduled. Returns how many it sent and skipped.
   */
  async sweep(): Promise<{ sent: number; skipped: number }> {
    const started = this.now().getTime();
    for (const notice of await this.deps.published(SWEEP_WINDOWS_MAX)) {
      const offsets = notice.reminderOffsets ?? [];
      // A window that has started is reminded of no more: its rows, made or not, would only be skipped.
      if (offsets.length === 0 || !notice.startsAt || notice.startsAt.getTime() <= started) continue;
      const start = notice.startsAt.getTime();
      await this.deps.store.schedule(
        notice.id,
        offsets.map((offsetMinutes) => ({ offsetMinutes, dueAt: new Date(start - offsetMinutes * 60_000) })),
      );
    }
    const at = this.now();
    let sent = 0;
    let skipped = 0;
    for (const reminder of await this.deps.store.claimDue(at, new Date(at.getTime() + REMINDER_LEASE_MS), REMINDERS_PER_SWEEP)) {
      const notice = await this.deps.notice(reminder.noticeId);
      if (!notice) continue;
      const state = maintenanceState(notice, await this.deps.store.moves(notice.id), this.now());
      if (state !== 'scheduled') {
        await this.deps.store.settle(notice.id, reminder.offsetMinutes, { skipped: state });
        skipped += 1;
        continue;
      }
      await this.deps.remind(notice, reminder.offsetMinutes);
      await this.deps.store.settle(notice.id, reminder.offsetMinutes, { sentAt: this.now() });
      sent += 1;
    }
    return { sent, skipped };
  }

  async closed(): Promise<ReadonlySet<string>> {
    return this.deps.store.closed();
  }
}

export class MemoryMaintenanceStore implements MaintenanceStore {
  private readonly allMoves: MaintenanceMove[] = [];
  private readonly reminders = new Map<string, ReminderRow & { claimedUntil: Date | null }>();
  private key = (noticeId: string, offset: number) => `${noticeId}:${offset}`;

  async moves(noticeId: string) {
    return this.allMoves.filter((m) => m.noticeId === noticeId);
  }
  async movesOf(noticeIds: readonly string[]) {
    return this.allMoves.filter((m) => noticeIds.includes(m.noticeId));
  }
  async closed() {
    return new Set(this.allMoves.filter((m) => m.state === 'completed' || m.state === 'cancelled').map((m) => m.noticeId));
  }
  async applyMove(move: MaintenanceMove, allowed: (moves: readonly MaintenanceMove[]) => MaintenanceCode | 'replay' | null) {
    const current = await this.moves(move.noticeId);
    const verdict = allowed(current);
    if (verdict === 'replay') return current;
    if (verdict) return verdict;
    this.allMoves.push(move);
    return this.moves(move.noticeId);
  }
  async schedule(noticeId: string, reminders: readonly { offsetMinutes: number; dueAt: Date }[]) {
    for (const r of reminders) {
      const key = this.key(noticeId, r.offsetMinutes);
      if (!this.reminders.has(key))
        this.reminders.set(key, {
          noticeId,
          offsetMinutes: r.offsetMinutes,
          dueAt: r.dueAt,
          sentAt: null,
          skipped: null,
          claimedUntil: null,
        });
    }
  }
  async remindersOf(noticeIds: readonly string[]) {
    return [...this.reminders.values()].filter((r) => noticeIds.includes(r.noticeId)).map(({ claimedUntil: _c, ...row }) => row);
  }
  async claimDue(at: Date, until: Date, limit: number) {
    const due = [...this.reminders.values()]
      .filter((r) => r.sentAt === null && r.skipped === null && r.dueAt <= at && (r.claimedUntil === null || r.claimedUntil <= at))
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit);
    for (const r of due) this.reminders.set(this.key(r.noticeId, r.offsetMinutes), { ...r, claimedUntil: until });
    return due.map(({ claimedUntil: _c, ...row }) => row);
  }
  async settle(noticeId: string, offsetMinutes: number, outcome: { sentAt: Date } | { skipped: NonNullable<ReminderRow['skipped']> }) {
    const key = this.key(noticeId, offsetMinutes);
    const row = this.reminders.get(key);
    if (!row || row.sentAt !== null || row.skipped !== null) return;
    this.reminders.set(key, {
      ...row,
      ...('sentAt' in outcome ? { sentAt: outcome.sentAt } : { skipped: outcome.skipped }),
      claimedUntil: null,
    });
  }
}
