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
  type AccountStatusReason,
} from '@intafaced/contracts/identity-account-status';
import { KYC_CAPABILITIES, type KycCapability } from '@intafaced/contracts/identity-kyc-capabilities';
import type { KycCapabilityMap } from '../kyc/capabilities.js';
import type { KycRejectReasons } from '../kyc/cases.js';

/** What each restriction's guard refuses (the guard is named beside it), so the page never promises more. */
const BLOCKS = {
  // `users.status` not active: sign-in, the edge and every door refuse (`auth.account_frozen`).
  staff_freeze: [...ACCOUNT_ACTIONS],
  closed: [...ACCOUNT_ACTIONS],
  // `AuthService.createApiKey` refuses `identity.account_frozen_self`; the freeze revoked every session and key when set.
  self_freeze: ['create_api_key'],
  // `assertNotSecurityLocked` (password change, sign-in methods, password and second-factor resets, adding recovery keys
  // and setting their plan) and svc-bank's `bank.security_locked` (adding a withdrawal address, starting a send to one).
  // Removing an address and revoking a recovery key read no lock, so they are not listed.
  security_lock: [
    'change_password',
    'change_signin_methods',
    'reset_password',
    'reset_second_factor',
    'add_recovery_keys',
    'add_withdrawal_address',
    'withdraw_to_address',
  ],
  // Founder controls, trading area: recorded here, but svc-trade keeps its own restriction table and reads nothing of
  // this one, so it blocks nothing; the page says so rather than claim trading stops.
  trading_restricted: [],
  // KYC capability switched off: identity refuses a request for the level whose own list grants it (`assertRequestable`,
  // `kyc.capability_inactive`), so it blocks only while the owner's level map grants it somewhere; no service outside
  // identity reads capability states, so orders and transfers go on.
  capability_off: ['request_level_with_switched_off_capability'],
} as const satisfies Record<AccountRestriction['kind'], readonly AccountAction[]>;

type UserRow = {
  status: 'active' | 'frozen' | 'closed';
  closed_reason: AccountStatusReason | null;
  customer_closed_at: Date | null;
};
type FreezeRow = { reason: string; since: Date; available_at: Date | null };
type LockRow = { set_by: 'self' | 'support'; locked_at: Date; unlocks_at: Date | null };
type TradingRow = { restricted: true };
type CapabilityRow = { capability: KycCapability; reason_code: string; at: Date };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class AccountStatusDesk {
  constructor(
    private readonly sql: Sql,
    /** The owner's wait before a self-freeze may be lifted, in seconds; undefined when unpublished (a lift refuses). */
    private readonly selfFreezeLiftWaitSeconds: number | undefined,
    /** The owner's capability reason list (`IDENTITY_KYC_CAPABILITY_REASONS`): code to words and next step. */
    private readonly capabilityReasons: KycRejectReasons,
    /** The owner's level-to-capability map (`IDENTITY_KYC_CAPABILITIES_BY_LEVEL`), as `assertRequestable` reads it. */
    private readonly capabilityMap: KycCapabilityMap,
  ) {}

  /**
   * `view: 'owner'` is the account's own read: a staff closure code other than the person's own request is not shown to
   * them (sign-in says only "closed" too), so a fraud finding is never tipped off. Staff reads see the code. The view is
   * required: any read on the account holder's behalf passes `'owner'`; only a staff door (`accountStatus.of`) passes
   * `'staff'`.
   */
  async read(userId: string, view: 'owner' | 'staff'): Promise<AccountStatus | null> {
    const wait = this.selfFreezeLiftWaitSeconds ?? null;
    const [[user], [freeze], [lock], [trading], capabilities] = await Promise.all([
      // A customer-closed account carries no staff code: the closure flow's finalisation is its code and its time.
      this.sql<UserRow[]>`
        SELECT status, closed_reason,
          (SELECT MAX(finalized_at) FROM account_closures c WHERE c.user_id = users.id AND c.status = 'closed') AS customer_closed_at
        FROM users WHERE id = ${userId}`,
      this.sql<FreezeRow[]>`
        SELECT reason, since, CASE WHEN ${wait}::int IS NULL THEN NULL ELSE since + make_interval(secs => ${wait}::int) END AS available_at
        FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`,
      this.sql<LockRow[]>`
        SELECT set_by, locked_at, unlocks_at FROM account_security_locks
        WHERE user_id = ${userId} AND state = 'locked' AND (unlocks_at IS NULL OR unlocks_at > now())`,
      // `updated_at` moves on every write, even a repeat, so it is not when the restriction began: no start is shown.
      this.sql<TradingRow[]>`SELECT restricted FROM trading_restrictions WHERE user_id = ${userId} AND restricted`,
      this.sql<CapabilityRow[]>`SELECT capability, reason_code, at FROM kyc_capabilities WHERE user_id = ${userId} AND state = 'inactive'`,
    ]);
    if (!user) return null;
    const restrictions: AccountRestriction[] = [];
    const closedCode = user.closed_reason ?? (user.customer_closed_at ? 'customer_request' : null);
    if (user.status === 'closed')
      restrictions.push({
        kind: 'closed',
        reasonCode: view === 'owner' && closedCode !== 'customer_request' ? null : closedCode,
        since: user.closed_reason ? null : iso(user.customer_closed_at),
        blocks: [...BLOCKS.closed],
        lift: { by: 'staff' },
        capability: null,
        owner: null,
      });
    if (user.status === 'frozen')
      restrictions.push({
        kind: 'staff_freeze',
        reasonCode: null,
        since: null,
        blocks: [...BLOCKS.staff_freeze],
        lift: { by: 'staff' },
        capability: null,
        owner: null,
      });
    if (freeze)
      restrictions.push({
        kind: 'self_freeze',
        reasonCode: freeze.reason as AccountStatusReason,
        since: iso(freeze.since),
        blocks: [...BLOCKS.self_freeze],
        lift: { by: 'owner_after_wait', availableAt: iso(freeze.available_at) },
        capability: null,
        owner: null,
      });
    if (lock)
      restrictions.push({
        kind: 'security_lock',
        reasonCode: lock.set_by === 'self' ? 'set_by_you' : 'set_by_support',
        since: iso(lock.locked_at),
        blocks: [...BLOCKS.security_lock],
        lift: { by: 'owner_unlock', endsAt: iso(lock.unlocks_at) },
        capability: null,
        owner: null,
      });
    if (trading)
      restrictions.push({
        kind: 'trading_restricted',
        reasonCode: null,
        since: null,
        blocks: [...BLOCKS.trading_restricted],
        lift: { by: 'staff' },
        capability: null,
        owner: null,
      });
    // In the contract's capability order, so the list reads the same every time.
    for (const row of [...capabilities].sort((a, b) => KYC_CAPABILITIES.indexOf(a.capability) - KYC_CAPABILITIES.indexOf(b.capability))) {
      const listed = this.capabilityReasons.get(row.reason_code);
      const granted = [...this.capabilityMap.values()].some((own) => own.includes(row.capability));
      restrictions.push({
        kind: 'capability_off',
        reasonCode: null,
        since: iso(row.at),
        blocks: granted ? [...BLOCKS.capability_off] : [],
        lift: { by: 'none' },
        capability: row.capability,
        owner: { code: row.reason_code, text: listed?.reason ?? null, guidance: listed?.guidance ?? null },
      });
    }
    // The state and summary name only what blocks something; one that blocks nothing is listed, not counted.
    const first = restrictions.find((r) => r.blocks.length > 0);
    const cannot = ACCOUNT_ACTIONS.flatMap((action) => {
      const by = restrictions.find((r) => r.blocks.includes(action));
      return by ? [{ action, kind: by.kind }] : [];
    });
    return {
      state: !first
        ? 'active'
        : first.kind === 'closed'
          ? 'closed'
          : first.kind === 'staff_freeze'
            ? 'frozen'
            : first.kind === 'self_freeze'
              ? 'frozen_self'
              : 'restricted',
      reasonCode: first?.reasonCode ?? null,
      since: first?.since ?? null,
      restrictions,
      // Asking for a level with a switched-off capability is listed only for an account that has one.
      canStill: ACCOUNT_ACTIONS.filter(
        (action) =>
          !cannot.some((c) => c.action === action) &&
          (action !== 'request_level_with_switched_off_capability' || restrictions.some((r) => r.kind === 'capability_off')),
      ),
      cannot,
    };
  }
}
