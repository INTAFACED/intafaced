/**
 * Recovery keys (RC-identity-07, J-identity-05 #7).
 *
 * The account owner names one heir account, sets how many keys must sign a claim (the threshold), and adds keys that
 * they hand to people they trust. After a confirmed death notice those keys, and only those, can claim the trading
 * balances for the heir (RC-identity-08). Staff are never a voter: no procedure here takes a staff scope, and a session
 * that holds one is refused `identity.recovery_staff_forbidden`. An API key or a sub-account is not the owner and is
 * refused too.
 *
 * Only the SHA-256 fingerprint of a key's public half is stored. Every change spends the security step-up
 * `recovery_key_change`, which binds the change and its target; what would refuse a change is checked before the
 * step-up, so a refusal spends no confirmation, and again under the users row lock that every writer here holds.
 * Adding and revoking are idempotent on (account, fingerprint) and (account, key): a retry of a change that already
 * happened answers the current setup and asks for nothing. A revoked key never counts again and cannot be re-added.
 */
import { createPublicKey } from 'node:crypto';
import { transaction } from '@intafaced/db';
import {
  recoveryKeyFingerprint,
  recoveryPlanTarget,
  recoveryPublicJwkSchema,
  RECOVERY_HANDLE_RE,
  RECOVERY_KEY_STEP_UP_SCOPE,
  type RecoveryKeyKind,
  type RecoveryPublicJwk,
  type RecoveryRefusalCode,
  type RecoveryView,
} from '@intafaced/contracts/identity-recovery';
import type { Sql } from 'postgres';
import { isOperatorPrincipal } from './action-approval-audience.js';
import { assertNotSecurityLocked } from './security-lock.js';
import { SecurityStepUpError, type SecurityStepUp, type SecurityStepUpPrincipal } from './security-step-up.js';

export type RecoveryKeyCode = RecoveryRefusalCode | 'auth.account_frozen' | 'auth.not_found';

export class RecoveryKeyError extends Error {
  constructor(
    readonly code: RecoveryKeyCode,
    message: string = RECOVERY_COPY[code],
  ) {
    super(message);
    this.name = 'RecoveryKeyError';
  }
}

/** The sentence a person reads for each refusal. Kept beside the codes until a catalog PR moves them. */
export const RECOVERY_COPY: Readonly<Record<RecoveryKeyCode, string>> = {
  'identity.recovery_staff_forbidden':
    'Staff can never set, use or vote with recovery keys. Sign in to your own account without staff access.',
  'identity.recovery_key_invalid': 'That is not a recovery key we can use. Make a new one on this page.',
  'identity.recovery_key_revoked': 'That key was revoked on this account and cannot be added again. Make a new one.',
  'identity.recovery_key_not_found': 'That recovery key is not on this account.',
  'identity.recovery_kind_not_wired': 'Only recovery keys made on the Security page can be added.',
  'identity.recovery_heir_unknown': 'No active account has that handle. Check it with the person.',
  'identity.recovery_heir_self': 'Name another person’s account. Your own account cannot receive your balances.',
  'identity.recovery_threshold_too_high': 'You cannot ask for more signatures than you have live keys. Add keys first.',
  'auth.account_frozen': 'This account is frozen, so its recovery keys cannot change.',
  'auth.not_found': 'This account was not found.',
};

export type RecoveryPrincipal = SecurityStepUpPrincipal & { readonly scopes: readonly string[]; readonly mfa: boolean };

/**
 * A delegated caller first (an API key or a sub-account is not the owner at the keyboard), then staff: a founder, or a
 * session holding an `admin:*`, `market:ops` or `support:ops` scope, is the platform, never a recovery party.
 */
export function refuseNonOwner(principal: RecoveryPrincipal, founders: readonly string[] = []): void {
  if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
  const { userId, mfa, scopes } = principal;
  if (isOperatorPrincipal({ userId, mfa, scopes }, founders)) throw new RecoveryKeyError('identity.recovery_staff_forbidden');
}

/**
 * The public half as the service checks it: a real point on P-256, else `identity.recovery_key_invalid`. The
 * fingerprint is taken over the key as Node writes it back, so other spellings of the same point (a coordinate's last
 * base64url character carries spare bits) are one key with one fingerprint.
 */
export async function fingerprintOf(jwk: RecoveryPublicJwk): Promise<string> {
  let canonical: RecoveryPublicJwk;
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not P-256');
    const out = key.export({ format: 'jwk' });
    canonical = recoveryPublicJwkSchema.parse({ kty: out.kty, crv: out.crv, x: out.x, y: out.y });
  } catch {
    throw new RecoveryKeyError('identity.recovery_key_invalid');
  }
  return recoveryKeyFingerprint(canonical);
}

type KeyRow = {
  id: string;
  kind: RecoveryKeyKind;
  label: string;
  public_material_hash: string;
  created_at: Date;
  revoked_at: Date | null;
};
type PlanRow = { threshold: number | null; heir_handle: string | null; heir_active: boolean | null };

export class RecoveryKeys {
  constructor(
    private readonly sql: Sql,
    private readonly stepUp: Pick<SecurityStepUp, 'require'>,
    /** The founder pair: founders are the platform and can never be a recovery party. */
    private readonly founders: readonly string[] = [],
  ) {}

  /** The owner check every procedure starts with, the list included. */
  refuse(principal: RecoveryPrincipal): void {
    refuseNonOwner(principal, this.founders);
  }

  async view(userId: string, sql: Sql = this.sql): Promise<RecoveryView> {
    const [plan] = await sql<PlanRow[]>`
      SELECT p.threshold, h.handle AS heir_handle, h.status = 'active' AS heir_active
        FROM recovery_plans p LEFT JOIN users h ON h.id = p.heir_user_id
       WHERE p.user_id = ${userId}`;
    const keys = await sql<KeyRow[]>`
      SELECT id, kind, label, public_material_hash, created_at, revoked_at
        FROM recovery_keys WHERE user_id = ${userId}
       ORDER BY revoked_at IS NOT NULL, created_at, id`;
    const activeKeys = keys.filter((k) => k.revoked_at === null).length;
    const threshold = plan?.threshold ?? null;
    const heir = plan?.heir_handle ? { handle: plan.heir_handle, active: plan.heir_active === true } : null;
    const missing: RecoveryView['missing'] = [];
    // A heir whose account was frozen or closed since cannot receive: the owner names another.
    if (!heir?.active) missing.push('heir');
    if (threshold === null) missing.push('threshold');
    if (activeKeys === 0 || (threshold !== null && activeKeys < threshold)) missing.push('keys');
    return {
      heir,
      threshold,
      keys: keys.map((k) => ({
        id: k.id,
        kind: k.kind,
        label: k.label,
        fingerprint: k.public_material_hash,
        createdAt: k.created_at.toISOString(),
        revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null,
      })),
      activeKeys,
      ready: missing.length === 0,
      missing,
    };
  }

  /** Add one key. The same key again answers the setup unchanged; a revoked one is refused. */
  async add(
    principal: RecoveryPrincipal,
    input: {
      kind: RecoveryKeyKind;
      label: string;
      publicKey: RecoveryPublicJwk;
      clientRequestId: string;
      stepUpApprovalId?: string | null;
    },
  ): Promise<RecoveryView> {
    this.refuse(principal);
    if (input.kind !== 'key') throw new RecoveryKeyError('identity.recovery_kind_not_wired');
    const fingerprint = await fingerprintOf(input.publicKey);
    const label = input.label.trim();
    const check = async (tx: Sql) => {
      await this.lockActive(tx, principal.userId, { securityLock: true });
      const [row] = await tx<Array<{ revoked_at: Date | null }>>`
        SELECT revoked_at FROM recovery_keys WHERE user_id = ${principal.userId} AND public_material_hash = ${fingerprint}`;
      if (row?.revoked_at) throw new RecoveryKeyError('identity.recovery_key_revoked');
      return Boolean(row);
    };
    if (await transaction(this.sql, check)) return this.view(principal.userId);
    await this.stepUp.require(
      principal,
      RECOVERY_KEY_STEP_UP_SCOPE,
      { change: 'add', target: fingerprint, clientRequestId: input.clientRequestId },
      input.stepUpApprovalId,
    );
    return transaction(this.sql, async (tx) => {
      if (!(await check(tx))) {
        await tx`
          INSERT INTO recovery_keys (user_id, kind, public_material_hash, label)
          VALUES (${principal.userId}, ${input.kind}, ${fingerprint}, ${label})
          ON CONFLICT (user_id, public_material_hash) DO NOTHING`;
      }
      return this.view(principal.userId, tx);
    });
  }

  /** Revoke one key. It stops counting at once; revoking it again answers the setup unchanged. */
  async revoke(
    principal: RecoveryPrincipal,
    input: { keyId: string; clientRequestId: string; stepUpApprovalId?: string | null },
  ): Promise<RecoveryView> {
    this.refuse(principal);
    const check = async (tx: Sql) => {
      await this.lockActive(tx, principal.userId);
      const [row] = await tx<Array<{ revoked_at: Date | null }>>`
        SELECT revoked_at FROM recovery_keys WHERE id = ${input.keyId} AND user_id = ${principal.userId}`;
      if (!row) throw new RecoveryKeyError('identity.recovery_key_not_found');
      return row.revoked_at !== null;
    };
    if (await transaction(this.sql, check)) return this.view(principal.userId);
    await this.stepUp.require(
      principal,
      RECOVERY_KEY_STEP_UP_SCOPE,
      { change: 'revoke', target: input.keyId, clientRequestId: input.clientRequestId },
      input.stepUpApprovalId,
    );
    return transaction(this.sql, async (tx) => {
      if (!(await check(tx))) {
        await tx`
          UPDATE recovery_keys SET revoked_at = now(), updated_at = now()
           WHERE id = ${input.keyId} AND user_id = ${principal.userId} AND revoked_at IS NULL`;
      }
      return this.view(principal.userId, tx);
    });
  }

  /**
   * Name the heir and the threshold. The heir is found by handle after the step-up, so the handle space is not probed
   * without a confirmation; an unknown, frozen or closed handle is one refusal.
   */
  async setPlan(
    principal: RecoveryPrincipal,
    input: { heirHandle: string; threshold: number; clientRequestId: string; stepUpApprovalId?: string | null },
  ): Promise<RecoveryView> {
    this.refuse(principal);
    const handle = input.heirHandle.replace(/^@/, '');
    if (!RECOVERY_HANDLE_RE.test(handle)) throw new RecoveryKeyError('identity.recovery_heir_unknown');
    /** True when the plan already is this heir and threshold, so a retry answers it unchanged. */
    const check = async (tx: Sql) => {
      await this.lockActive(tx, principal.userId, { securityLock: true });
      const [count] = await tx<Array<{ live: number }>>`
        SELECT count(*)::int AS live FROM recovery_keys WHERE user_id = ${principal.userId} AND revoked_at IS NULL`;
      if (input.threshold > (count?.live ?? 0)) throw new RecoveryKeyError('identity.recovery_threshold_too_high');
      const [same] = await tx<Array<{ one: number }>>`
        SELECT 1 AS one FROM recovery_plans p JOIN users h ON h.id = p.heir_user_id
         WHERE p.user_id = ${principal.userId} AND p.threshold = ${input.threshold}
           AND h.handle = ${handle} AND h.status = 'active'`;
      return Boolean(same);
    };
    if (await transaction(this.sql, check)) return this.view(principal.userId);
    await this.stepUp.require(
      principal,
      RECOVERY_KEY_STEP_UP_SCOPE,
      { change: 'plan', target: recoveryPlanTarget(handle, input.threshold), clientRequestId: input.clientRequestId },
      input.stepUpApprovalId,
    );
    return transaction(this.sql, async (tx) => {
      await check(tx);
      // A handle its owner hid (PP-send-request-03) is the same miss as an unknown one, unless it is already this plan's heir.
      const [heir] = await tx<Array<{ id: string }>>`
        SELECT id FROM users
         WHERE handle = ${handle} AND status = 'active'
           AND (handle_discoverable OR id IN (SELECT heir_user_id FROM recovery_plans WHERE user_id = ${principal.userId}))
         LIMIT 1`;
      if (!heir) throw new RecoveryKeyError('identity.recovery_heir_unknown');
      if (heir.id === principal.userId) throw new RecoveryKeyError('identity.recovery_heir_self');
      await tx`
        INSERT INTO recovery_plans (user_id, heir_user_id, threshold)
        VALUES (${principal.userId}, ${heir.id}, ${input.threshold})
        ON CONFLICT (user_id) DO UPDATE
          SET heir_user_id = EXCLUDED.heir_user_id, threshold = EXCLUDED.threshold, updated_at = now()`;
      return this.view(principal.userId, tx);
    });
  }

  /**
   * The users row lock every writer of an account's recovery setup holds; a frozen or closed account changes nothing.
   * Adding a key and naming the heir also wait for the owner's security lock; revoking a key never does, because it
   * only takes power away.
   */
  private async lockActive(tx: Sql, userId: string, options: { securityLock?: boolean } = {}): Promise<void> {
    const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!user) throw new RecoveryKeyError('auth.not_found');
    if (user.status !== 'active') throw new RecoveryKeyError('auth.account_frozen');
    if (options.securityLock) await assertNotSecurityLocked(tx, userId);
  }
}
