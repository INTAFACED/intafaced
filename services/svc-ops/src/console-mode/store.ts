import type { Sql, TransactionSql } from 'postgres';
import type { ConsoleModeAction } from '@intafaced/contracts';

/** The mode as stored. An absent row is off, never changed. */
export interface ModeState {
  readonly readOnly: boolean;
  readonly reason: string | null;
  readonly revision: number;
  readonly changedAt: string | null;
  readonly requesterId: string | null;
  readonly approverId: string | null;
}

export interface ModeChange {
  readonly key: string;
  readonly action: ConsoleModeAction;
  readonly reason: string | null;
  readonly approvalId: string;
  readonly requesterId: string;
  readonly approverId: string;
  readonly policyVersion: string;
  readonly at: string;
}

/** What a logged change asked for: a replay must ask for the same thing. */
export interface LoggedChange {
  readonly action: ConsoleModeAction;
  readonly reason: string | null;
}

export interface ModeRecord {
  readonly state: ModeState;
  readonly outcome: 'changed' | 'noop';
}

/** The mode and its log inside one change: no other change runs until this one returns. */
export interface LockedConsoleMode {
  get(): Promise<ModeState>;
  /** The change already logged under this key, or null (checked before an approval is spent). */
  logged(key: string): Promise<LoggedChange | null>;
  /** Store the change: one to the state the mode is already in is logged as a `noop` and changes nothing. */
  record(change: ModeChange): Promise<ModeRecord>;
}

/**
 * The console mode and its log. A change runs whole under one lock (`change`): the replay check, the approval spend and the
 * write, so two runs of one approval never both reach identity, and the second finds the first one's change logged.
 */
export interface ConsoleModeStore {
  get(): Promise<ModeState>;
  change<T>(fn: (locked: LockedConsoleMode) => Promise<T>): Promise<T>;
}

export const OFF: ModeState = { readOnly: false, reason: null, revision: 0, changedAt: null, requesterId: null, approverId: null };

const next = (prior: ModeState, change: ModeChange): ModeState | null => {
  const on = change.action === 'ops.console_mode.on';
  if (prior.readOnly === on) return null;
  return {
    readOnly: on,
    reason: on ? change.reason : null,
    revision: prior.revision + 1,
    changedAt: change.at,
    requesterId: change.requesterId,
    approverId: change.approverId,
  };
};

export class MemoryConsoleModeStore implements ConsoleModeStore {
  private state: ModeState = OFF;
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: (ModeChange & { outcome: 'changed' | 'noop' })[] = [];

  async get(): Promise<ModeState> {
    return this.state;
  }

  change<T>(fn: (locked: LockedConsoleMode) => Promise<T>): Promise<T> {
    const locked: LockedConsoleMode = {
      get: async () => this.state,
      logged: async (key) => {
        const row = this.log.find((r) => r.key === key);
        return row ? { action: row.action, reason: row.reason } : null;
      },
      record: async (change) => {
        const moved = next(this.state, change);
        this.log.push({ ...change, outcome: moved ? 'changed' : 'noop' });
        if (moved) this.state = moved;
        return { state: this.state, outcome: moved ? 'changed' : 'noop' };
      },
    };
    const run = this.queue.then(() => fn(locked));
    this.queue = run.catch(() => undefined);
    return run;
  }
}

type Row = {
  read_only: boolean;
  reason: string | null;
  revision: number;
  requester_id: string;
  approver_id: string;
  changed_at: Date | string;
};

const fromRow = (row: Row | undefined): ModeState =>
  row
    ? {
        readOnly: row.read_only,
        reason: row.reason,
        revision: row.revision,
        changedAt: new Date(row.changed_at).toISOString(),
        requesterId: row.requester_id,
        approverId: row.approver_id,
      }
    : OFF;

const readState = async (sql: Sql | TransactionSql): Promise<ModeState> => {
  const rows = await sql<Row[]>`
    SELECT read_only, reason, revision, requester_id, approver_id, changed_at FROM ops.console_mode WHERE singleton
  `;
  return fromRow(rows[0]);
};

export class SqlConsoleModeStore implements ConsoleModeStore {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<ModeState> {
    return readState(this.sql);
  }

  /**
   * One transaction holds the advisory lock for the whole change, including the call to identity that spends the approval
   * (bounded by the approval client's timeout). Changes are founder actions, a handful a year, so the wait is never felt.
   */
  async change<T>(fn: (locked: LockedConsoleMode) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      // One change at a time: the lock covers the first change too, before the row exists.
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.console_mode'))`;
      return fn({
        get: () => readState(tx),
        logged: async (key) => {
          const rows = await tx<{ action: ConsoleModeAction; reason: string | null }[]>`
            SELECT action, reason FROM ops.console_mode_log WHERE key = ${key}
          `;
          return rows[0] ? { action: rows[0].action, reason: rows[0].reason } : null;
        },
        record: async (change) => {
          const prior = await readState(tx);
          const moved = next(prior, change);
          const after = moved ?? prior;
          if (moved) {
            await tx`
              INSERT INTO ops.console_mode (singleton, read_only, reason, revision, requester_id, approver_id, changed_at)
              VALUES (true, ${moved.readOnly}, ${moved.reason}, ${moved.revision}, ${change.requesterId}, ${change.approverId}, ${change.at})
              ON CONFLICT (singleton) DO UPDATE SET read_only = EXCLUDED.read_only, reason = EXCLUDED.reason, revision = EXCLUDED.revision,
                requester_id = EXCLUDED.requester_id, approver_id = EXCLUDED.approver_id, changed_at = EXCLUDED.changed_at
            `;
          }
          await tx`
            INSERT INTO ops.console_mode_log
              (key, action, outcome, read_only_after, reason, revision_after, approval_id, requester_id, approver_id, policy_version, logged_at)
            VALUES (${change.key}, ${change.action}, ${moved ? 'changed' : 'noop'}, ${after.readOnly}, ${change.reason}, ${after.revision},
              ${change.approvalId}, ${change.requesterId}, ${change.approverId}, ${change.policyVersion}, ${change.at})
          `;
          return { state: after, outcome: moved ? ('changed' as const) : ('noop' as const) };
        },
      });
    }) as Promise<T>;
  }
}
