/**
 * Access-token signing-key rotation with overlap (I-signin-sessions-31).
 *
 * Key material comes from the host: `JWT_ACCESS_SECRET` (the key named `legacy`, which
 * signed every token before rotation) plus `IDENTITY_AUTH_KEYS`, a comma list of
 * `id:secret`. The table `auth_signing_keys` only records which id signs and which ids
 * still verify. `rotate` makes a new id sign and keeps the previous one verify-only, so
 * nobody is signed out; `removeOld` drops the verify-only ids after the overlap. Both are
 * four-eyes (an action approval is consumed first). A crash between consuming the
 * approval and the write changes nothing; ask for a new approval.
 *
 * Other services check access tokens with their own configured secret. Run a rotation
 * only once each of them carries the same ring.
 */
import type { Sql } from 'postgres';
import type { TokenConfig } from '@intafaced/auth';
import type { ActionApprovalService } from './action-approval-service.js';
import { requirePrivilegedDualControl, PrivilegedDualControlError } from './privileged-dual-control.js';

export const LEGACY_KEY_ID = 'legacy';
export const AUTH_KEY_ROTATE_TARGET = 'identity.auth_key_rotate';
export const AUTH_KEY_REMOVE_OLD_TARGET = 'identity.auth_key_remove_old';

export type AuthKeyErrorCode =
  | 'auth_key.material_missing'
  | 'auth_key.already_known'
  | 'auth_key.nothing_to_remove'
  | 'auth_key.invalid_id'
  | 'auth_key.approval_required';

export class AuthKeyError extends Error {
  constructor(
    message: string,
    readonly code: AuthKeyErrorCode,
  ) {
    super(message);
    this.name = 'AuthKeyError';
  }
}

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** `id:secret,id2:secret2`. A bad entry fails boot; a blank list is no extra keys. */
export function parseAuthKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const at = entry.indexOf(':');
    const id = at < 0 ? '' : entry.slice(0, at);
    const secret = at < 0 ? '' : entry.slice(at + 1);
    if (!KEY_ID.test(id) || id === LEGACY_KEY_ID)
      throw new Error('IDENTITY_AUTH_KEYS: each entry is id:secret with a lowercase id other than "legacy"');
    if (secret.length < 32) throw new Error('IDENTITY_AUTH_KEYS: each secret must be at least 32 characters');
    if (keys.has(id)) throw new Error('IDENTITY_AUTH_KEYS: duplicate key id');
    keys.set(id, secret);
  }
  return keys;
}

export interface AuthKeyState {
  readonly activeKeyId: string;
  readonly previousKeyIds: string[];
  readonly activatedAt: string | null;
  /** The next removal is the previous keys; null when none remain. */
  readonly nextRemoval: string[] | null;
  readonly availableKeyIds: string[];
}

interface Row {
  key_id: string;
  state: 'active' | 'verify_only';
  activated_at: Date;
}

export class AuthKeyRing {
  private active: { keyId?: string; secret: string } = { secret: '' };
  private verifyOnly: { keyId: string; secret: string }[] = [];
  private activatedAt: Date | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly legacySecret: string,
    private readonly keys: ReadonlyMap<string, string>,
    private readonly approvals: Pick<ActionApprovalService, 'consume'>,
  ) {
    this.active = { secret: legacySecret };
  }

  /** A live token config: signing and verification read the ring as it stands. */
  tokenConfig<T extends object>(base: T): T & Pick<TokenConfig, 'secret' | 'keyId' | 'verifyOnly'> {
    return Object.create(null, {
      ...Object.getOwnPropertyDescriptors(base),
      secret: { enumerable: true, get: () => this.active.secret },
      keyId: { enumerable: true, get: () => this.active.keyId },
      verifyOnly: { enumerable: true, get: () => this.verifyOnly },
    }) as T & Pick<TokenConfig, 'secret' | 'keyId' | 'verifyOnly'>;
  }

  private material(keyId: string): string | undefined {
    return keyId === LEGACY_KEY_ID ? this.legacySecret : this.keys.get(keyId);
  }

  private refreshSeq = 0;
  private appliedSeq = 0;

  async refresh(query: Sql = this.sql): Promise<void> {
    const seq = ++this.refreshSeq;
    const rows = await query<Row[]>`SELECT key_id, state, activated_at FROM auth_signing_keys ORDER BY activated_at`;
    const active = rows.find((r) => r.state === 'active');
    const activeSecret = active ? this.material(active.key_id) : this.legacySecret;
    // A listed key whose material is gone from the host is skipped, never replaced by a guess;
    // with no usable signing key the ring keeps what it had.
    if (!activeSecret || seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    const verify: { keyId: string; secret: string }[] = [];
    for (const r of rows) {
      if (r.state !== 'verify_only') continue;
      const secret = this.material(r.key_id);
      if (secret) verify.push({ keyId: r.key_id, secret });
    }
    // Before the first rotation the legacy secret is the only key; once another key signs,
    // legacy stays verify-only until removed, so tokens issued before ids existed keep working.
    this.active = active ? { keyId: active.key_id, secret: activeSecret } : { secret: this.legacySecret };
    this.verifyOnly = verify;
    this.activatedAt = active?.activated_at ?? null;
  }

  start(everyMs = 5000): void {
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async state(): Promise<AuthKeyState> {
    await this.refresh();
    const previous = this.verifyOnly.map((k) => k.keyId);
    return {
      activeKeyId: this.active.keyId ?? LEGACY_KEY_ID,
      previousKeyIds: previous,
      activatedAt: this.activatedAt?.toISOString() ?? null,
      nextRemoval: previous.length > 0 ? previous : null,
      availableKeyIds: [LEGACY_KEY_ID, ...this.keys.keys()],
    };
  }

  private async approve(targetId: string, fields: Record<string, string>, approvalId: string, operationId: string) {
    try {
      return await requirePrivilegedDualControl(this.approvals, { approvalId, operationId, targetId, fields });
    } catch (err) {
      if (err instanceof PrivilegedDualControlError) throw new AuthKeyError(err.message, 'auth_key.approval_required');
      throw err;
    }
  }

  /** New id signs from now; the current signer (or `legacy`) turns verify-only. */
  async rotate(input: { keyId: string; actorId: string; approvalId: string; operationId: string }): Promise<AuthKeyState> {
    if (!KEY_ID.test(input.keyId) || input.keyId === LEGACY_KEY_ID) throw new AuthKeyError('Key id is not valid', 'auth_key.invalid_id');
    if (!this.keys.has(input.keyId)) throw new AuthKeyError('No key material for that id on this host', 'auth_key.material_missing');
    await this.approve(AUTH_KEY_ROTATE_TARGET, { keyId: input.keyId }, input.approvalId, input.operationId);
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('identity.auth_signing_keys'))`;
      const [known] = await tx<Array<{ key_id: string }>>`SELECT key_id FROM auth_signing_keys WHERE key_id = ${input.keyId}`;
      if (known) throw new AuthKeyError('That key id was already used', 'auth_key.already_known');
      const retired = await tx<Array<{ key_id: string }>>`
        UPDATE auth_signing_keys SET state = 'verify_only', retired_at = now() WHERE state = 'active' RETURNING key_id`;
      if (retired.length === 0) {
        // First rotation: the legacy secret keeps verifying.
        await tx`INSERT INTO auth_signing_keys (key_id, state, retired_at, actor_id, approval_id)
          VALUES (${LEGACY_KEY_ID}, 'verify_only', now(), ${input.actorId}, ${input.approvalId})
          ON CONFLICT (key_id) DO NOTHING`;
      }
      await tx`INSERT INTO auth_signing_keys (key_id, state, actor_id, approval_id)
        VALUES (${input.keyId}, 'active', ${input.actorId}, ${input.approvalId})`;
    });
    return this.state();
  }

  /** Second action after the overlap: verify-only ids stop verifying, so their tokens fail. */
  async removeOld(input: { actorId: string; approvalId: string; operationId: string }): Promise<AuthKeyState> {
    await this.refresh();
    const ids = this.verifyOnly.map((k) => k.keyId);
    if (ids.length === 0) throw new AuthKeyError('There is no previous key to remove', 'auth_key.nothing_to_remove');
    await this.approve(AUTH_KEY_REMOVE_OLD_TARGET, { keyIds: [...ids].sort().join(',') }, input.approvalId, input.operationId);
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('identity.auth_signing_keys'))`;
      await tx`UPDATE auth_signing_keys SET state = 'removed', retired_at = now() WHERE state = 'verify_only' AND key_id = ANY(${ids})`;
    });
    return this.state();
  }
}
