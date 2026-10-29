/**
 * Account status (I-signin-sessions-22): what holds this account back, read straight from the states identity keeps
 * (`users.status` and its closure code, the owner's freeze, the security lock, the founder trading restriction), never a
 * copy. Each restriction names only what its own guard refuses today; see `@intafaced/contracts/identity-account-status`.
 * Reads only: nothing here writes, and every time comes from the database clock.
 */
import type { Sql } from 'postgres';
import {
  ACCOUNT_ACTIONS,
  type AccountAction,
  type AccountRestriction,
  type AccountStatus,
} from '@intafaced/contracts/identity-account-status';

/** What each restriction's guard refuses (the guard is named beside it), so the page never promises more. */
const BLOCKS = {
  // `users.status` not active: sign-in, the edge and every door refuse (`auth.account_frozen`).
  staff_freeze: [...ACCOUNT_ACTIONS],
  closed: [...ACCOUNT_ACTIONS],
  // `AuthService.createApiKey` refuses `identity.account_frozen_self`; the freeze revoked every session and key when set.
  self_freeze: ['create_api_key'],
  // `assertNotSecurityLocked` (password change, sign-in methods, password and second-factor resets, recovery keys) and
  // svc-bank's `bank.security_locked` (withdrawal addresses and sending to them).
  security_lock: [
    'change_password',
    'change_signin_methods',
    'reset_password',
    'reset_second_factor',
    'recovery_keys',
    'manage_withdrawal_addresses',
    'withdraw_to_address',
  ],
  // Founder controls, trading area: svc-trade refuses `trade.account_restricted`.
  trading_restricted: ['trade'],
} as const satisfies Record<AccountRestriction['kind'], readonly AccountAction[]>;

type UserRow = { status: 'active' | 'frozen' | 'closed'; closed_reason: string | null };
type FreezeRow = { reason: string; since: Date; available_at: Date | null };
type LockRow = { set_by: 'self' | 'support'; locked_at: Date; unlocks_at: Date | null };
type TradingRow = { updated_at: Date };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class AccountStatusDesk {
  constructor(
    private readonly sql: Sql,
    /** The owner's wait before a self-freeze may be lifted, in seconds; undefined when unpublished (a lift refuses). */
    private readonly selfFreezeLiftWaitSeconds: number | undefined,
  ) {}

  async read(userId: string): Promise<AccountStatus | null> {
    const wait = this.selfFreezeLiftWaitSeconds ?? null;
    const [[user], [freeze], [lock], [trading]] = await Promise.all([
      this.sql<UserRow[]>`SELECT status, closed_reason FROM users WHERE id = ${userId}`,
      this.sql<FreezeRow[]>`
        SELECT reason, since, CASE WHEN ${wait}::int IS NULL THEN NULL ELSE since + make_interval(secs => ${wait}::int) END AS available_at
        FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`,
      this.sql<LockRow[]>`
        SELECT set_by, locked_at, unlocks_at FROM account_security_locks
        WHERE user_id = ${userId} AND state = 'locked' AND (unlocks_at IS NULL OR unlocks_at > now())`,
      this.sql<TradingRow[]>`SELECT updated_at FROM trading_restrictions WHERE user_id = ${userId} AND restricted`,
    ]);
    if (!user) return null;
    const restrictions: AccountRestriction[] = [];
    if (user.status === 'closed')
      restrictions.push({ kind: 'closed', reasonCode: user.closed_reason, since: null, blocks: [...BLOCKS.closed], lift: { by: 'staff' } });
    if (user.status === 'frozen')
      restrictions.push({ kind: 'staff_freeze', reasonCode: null, since: null, blocks: [...BLOCKS.staff_freeze], lift: { by: 'staff' } });
    if (freeze)
      restrictions.push({
        kind: 'self_freeze',
        reasonCode: freeze.reason,
        since: iso(freeze.since),
        blocks: [...BLOCKS.self_freeze],
        lift: { by: 'owner_after_wait', availableAt: iso(freeze.available_at) },
      });
    if (lock)
      restrictions.push({
        kind: 'security_lock',
        reasonCode: lock.set_by === 'self' ? 'set_by_you' : 'set_by_support',
        since: iso(lock.locked_at),
        blocks: [...BLOCKS.security_lock],
        lift: { by: 'owner_unlock', endsAt: iso(lock.unlocks_at) },
      });
    if (trading)
      restrictions.push({
        kind: 'trading_restricted',
        reasonCode: null,
        since: iso(trading.updated_at),
        blocks: [...BLOCKS.trading_restricted],
        lift: { by: 'staff' },
      });
    const first = restrictions[0];
    const cannot = ACCOUNT_ACTIONS.flatMap((action) => {
      const by = restrictions.find((r) => r.blocks.includes(action));
      return by ? [{ action, kind: by.kind }] : [];
    });
    return {
      state: !first
        ? 'active'
        : first.kind === 'closed'
          ? 'closed'
          : first.kind === 'self_freeze' && user.status === 'active'
            ? 'frozen_self'
            : 'restricted',
      reasonCode: first?.reasonCode ?? null,
      since: first?.since ?? null,
      restrictions,
      canStill: ACCOUNT_ACTIONS.filter((action) => !cannot.some((c) => c.action === action)),
      cannot,
    };
  }
}
