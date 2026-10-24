/**
 * W-withdraw-09 (wallet-withdraw-015), the customer security lock: the account owner's own switch that stops withdrawals
 * and changes to withdrawal addresses, the password and verification.
 *
 * Locking applies at once and needs no step-up: it only takes power away, and a person who fears for the account must
 * not be slowed down. Unlocking is a request. It needs a fresh step-up (`identity.step_up.security_lock_unlock`, spent by
 * the router) and the owner-set wait (IDENTITY_SECURITY_LOCK_UNLOCK_WAIT_SECONDS). `unlocks_at` is fixed on the database
 * clock (`clock_timestamp()`, after the row lock is held, not the transaction start) when the request is made and is never
 * moved earlier: asking again answers the time already set, and a later
 * change to the owner's wait does not touch it. Locking again while an unlock waits withdraws that request. A blank wait
 * refuses the unlock (`identity.security_lock_unlock_wait_unset`); it never means "no wait".
 *
 * Every time check runs on the database clock, never a wall-clock read in the app. Writes take the user row lock, as
 * password changes do, so a change and a lock never interleave. This is not the staff freeze, the self-freeze or the
 * ledger posting freeze.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { SecurityLockView } from '@intafaced/contracts';

export type SecurityLockCode = 'identity.security_locked' | 'identity.security_lock_unlock_wait_unset' | 'identity.security_lock_not_found';

export class SecurityLockError extends Error {
  constructor(
    readonly code: SecurityLockCode,
    /** For `identity.security_locked`: when the lock ends, or null while no unlock is requested. */
    readonly unlocksAt: Date | null = null,
  ) {
    super(code);
    this.name = 'SecurityLockError';
  }
}

/** Owner value in whole seconds. Blank / unset → undefined (refuse). Zero is a published "no wait". */
export function parseSecurityLockUnlockWait(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error('IDENTITY_SECURITY_LOCK_UNLOCK_WAIT_SECONDS must be whole seconds');
  const n = Number(raw.trim());
  if (n > 30 * 24 * 3600) throw new Error('IDENTITY_SECURITY_LOCK_UNLOCK_WAIT_SECONDS is above 30 days');
  return n;
}

type LockRow = {
  set_by: 'self' | 'support';
  locked_at: Date;
  unlock_requested_at: Date | null;
  unlocks_at: Date | null;
  holds: boolean;
};

/** The open lock row, with whether it still holds on the database clock. `tx` may be a transaction or the pool. */
async function openLock(tx: Sql, userId: string): Promise<(LockRow & { id: string }) | null> {
  const rows = await tx<Array<LockRow & { id: string }>>`
    SELECT id, set_by, locked_at, unlock_requested_at, unlocks_at,
           (unlocks_at IS NULL OR unlocks_at > now()) AS holds
      FROM account_security_locks WHERE user_id = ${userId} AND state = 'locked'`;
  return rows[0] ?? null;
}

function viewOf(userId: string, row: LockRow | null): SecurityLockView {
  if (!row || !row.holds) {
    return { userId, locked: false, lockedAt: null, setBy: null, unlockRequestedAt: null, unlocksAt: null };
  }
  return {
    userId,
    locked: true,
    lockedAt: row.locked_at.toISOString(),
    setBy: row.set_by,
    unlockRequestedAt: row.unlock_requested_at ? row.unlock_requested_at.toISOString() : null,
    unlocksAt: row.unlocks_at ? row.unlocks_at.toISOString() : null,
  };
}

/**
 * Refuses `identity.security_locked` while the account's lock holds. Call it inside the writer's transaction after the
 * user row lock, so the answer stands until the write commits.
 */
export async function assertNotSecurityLocked(tx: Sql, userId: string): Promise<void> {
  const row = await openLock(tx, userId);
  if (row?.holds) throw new SecurityLockError('identity.security_locked', row.unlocks_at);
}

/** Whether the account's lock holds now, for a writer that waits on it instead of refusing. */
export async function securityLockHolds(tx: Sql, userId: string): Promise<boolean> {
  return (await openLock(tx, userId))?.holds === true;
}

type WarnLog = { warn(obj: Record<string, unknown>, msg: string): void };

export type SecurityLockChange = SecurityLockView & { changed: boolean };

export class SecurityLock {
  /** Structured warn sink, as AuthService: one JSON line on stderr until index.ts swaps in the Fastify logger. */
  private log: WarnLog = {
    warn: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'warn', ...obj, msg })}\n`),
  };

  constructor(
    private readonly sql: Sql,
    private readonly unlockWaitSeconds: number | undefined,
  ) {}

  useLogger(log: WarnLog): void {
    this.log = log;
  }

  async read(userId: string): Promise<SecurityLockView | null> {
    const user = await this.sql<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId}`;
    if (!user[0]) return null;
    return viewOf(userId, await openLock(this.sql, userId));
  }

  /**
   * Locks the account now. Already locked: nothing changes, except that a waiting unlock request is withdrawn (the
   * person chose to stay locked). A lock whose unlock time has passed is closed first and a new one opened.
   */
  async lock(userId: string, by: { kind: 'self' | 'support'; userId: string }): Promise<SecurityLockChange> {
    const result = await transaction(this.sql, async (tx) => {
      const user = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!user[0]) throw new SecurityLockError('identity.security_lock_not_found');
      const open = await openLock(tx, userId);
      if (open?.holds) {
        if (!open.unlocks_at) return { view: viewOf(userId, open), changed: false };
        const kept = await tx<LockRow[]>`
          UPDATE account_security_locks SET unlock_requested_at = NULL, unlocks_at = NULL
           WHERE id = ${open.id}
          RETURNING set_by, locked_at, unlock_requested_at, unlocks_at, true AS holds`;
        return { view: viewOf(userId, kept[0]!), changed: true };
      }
      if (open) await tx`UPDATE account_security_locks SET state = 'ended', ended_at = unlocks_at WHERE id = ${open.id}`;
      const made = await tx<LockRow[]>`
        INSERT INTO account_security_locks (user_id, set_by, set_by_user_id) VALUES (${userId}, ${by.kind}, ${by.userId})
        RETURNING set_by, locked_at, unlock_requested_at, unlocks_at, true AS holds`;
      return { view: viewOf(userId, made[0]!), changed: true };
    });
    // Logged after commit: a lock that rolled back is never reported.
    if (result.changed) this.log.warn({ userId, setBy: by.kind, byUserId: by.userId }, 'identity.security_locked');
    return { ...result.view, changed: result.changed };
  }

  /** The wait must be published before the router spends a step-up on an unlock that cannot be asked for. */
  assertUnlockConfigured(): void {
    if (this.unlockWaitSeconds === undefined) throw new SecurityLockError('identity.security_lock_unlock_wait_unset');
  }

  /**
   * Asks for the lock to end after the owner's wait. Nothing holds: answers unlocked, changes nothing. An unlock already
   * waiting: answers the time already set (never earlier, never later). Otherwise fixes `unlocks_at = now() + wait`.
   */
  async requestUnlock(userId: string): Promise<SecurityLockChange> {
    const wait = this.unlockWaitSeconds;
    if (wait === undefined) throw new SecurityLockError('identity.security_lock_unlock_wait_unset');
    const result = await transaction(this.sql, async (tx) => {
      const user = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!user[0]) throw new SecurityLockError('identity.security_lock_not_found');
      const open = await openLock(tx, userId);
      if (!open?.holds || open.unlocks_at) return { view: viewOf(userId, open), changed: false, unlocksAt: open?.unlocks_at ?? null };
      const asked = await tx<LockRow[]>`
        UPDATE account_security_locks
           SET unlock_requested_at = asked.at, unlocks_at = asked.at + make_interval(secs => ${wait})
          FROM (SELECT clock_timestamp() AS at) AS asked
         WHERE id = ${open.id}
        RETURNING set_by, locked_at, unlock_requested_at, unlocks_at, (unlocks_at > asked.at) AS holds`;
      return { view: viewOf(userId, asked[0]!), changed: true, unlocksAt: asked[0]!.unlocks_at };
    });
    if (result.changed) {
      this.log.warn({ userId, unlocksAt: result.unlocksAt?.toISOString() ?? null }, 'identity.security_unlock_requested');
    }
    return { ...result.view, changed: result.changed };
  }
}
