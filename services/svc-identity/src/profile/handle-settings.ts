/**
 * HANDLE SETTINGS (PP-send-request-03): the owner changes their own @handle and chooses whether people can find them by it.
 *
 * - Rules: 3 to 32 characters, only letters, digits and underscore, the same shape sign-up takes. A handle that breaks a
 *   rule is refused with a code that names that rule (`identity.handle_characters`, `identity.handle_length`), so the
 *   screen can say which one. A taken handle is `identity.handle_taken`: handles are public, so saying so leaks nothing.
 * - Lifetime cap: `IDENTITY_HANDLE_CHANGE_MAX` changes per account, ever. The owner has not published it, so blank
 *   refuses every change with `identity.handle_change_cap_unset`; nothing is invented. At the cap the change is refused
 *   with `identity.handle_change_cap_reached`, and the answer carries how many changes were used.
 * - Compare and set: the caller names the handle it is changing from. A retry after a lost reply finds the new handle
 *   already in place and answers the same state without counting a second change; a handle changed elsewhere in
 *   between is `identity.handle_changed_elsewhere`.
 * - Discoverability: on by default (every account was findable by handle before this). Off, an exact handle lookup by
 *   anyone else answers the same `{ found: false }` as an unknown handle. It never stops a payment to the account id.
 * - The signed-in owner only, on a live session, never an API key or a sub-account, and never while a security lock
 *   holds. Every change writes an audit row in the same transaction.
 *
 * - Retired handles: a handle given up in a change is never handed to anyone else (`retired_handles`), so an old QR
 *   code, payment link or saved contact can never reach a stranger who claimed it. Its owner may take it back. Sign-up
 *   and a change claim a handle under the same per-handle advisory lock, so a race cannot slip a retired handle through.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { assertNotSecurityLocked } from '../auth/security-lock.js';

export type HandleSettingsCode =
  | 'identity.handle_characters'
  | 'identity.handle_length'
  | 'identity.handle_taken'
  | 'identity.handle_unchanged'
  | 'identity.handle_changed_elsewhere'
  | 'identity.handle_change_cap_unset'
  | 'identity.handle_change_cap_reached'
  | 'identity.delegated_refused'
  | 'identity.session_not_live'
  | 'auth.account_frozen'
  | 'auth.not_found';

export class HandleSettingsError extends Error {
  constructor(
    readonly code: HandleSettingsCode,
    message: string,
    /** Only on `identity.handle_change_cap_reached`: changes used and the cap. */
    readonly details?: { readonly used: number; readonly cap: number },
  ) {
    super(`${message} [${code}]`);
    this.name = 'HandleSettingsError';
  }
}

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;
const HANDLE_CHARS = /^[a-zA-Z0-9_]+$/;

/**
 * Hold the per-handle claim lock for the rest of the transaction. Sign-up and a handle change both take it before they
 * check and write a handle, so "retired?" and "taken?" are answered against settled rows.
 */
export async function lockHandleClaim(tx: Sql, handle: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${'identity.handle:' + handle.toLowerCase()}))`;
}

/** True when `handle` was given up by an account other than `userId` (null: any account, for sign-up). */
export async function handleRetiredByOther(tx: Sql, handle: string, userId: string | null): Promise<boolean> {
  const rows = await tx<Array<{ one: number }>>`
    SELECT 1 AS one FROM retired_handles
     WHERE handle = ${handle} AND (${userId}::uuid IS NULL OR user_id <> ${userId}::uuid) LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * The handle the owner asked for, or the rule it breaks. A single leading "@" is how the screen shows a handle, so it is
 * dropped; surrounding spaces are trimmed. Everything else counts: a space inside is a character the rule refuses.
 */
export function checkHandleRules(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!HANDLE_CHARS.test(bare) && bare.length > 0) {
    throw new HandleSettingsError('identity.handle_characters', 'A handle uses only letters, digits and underscore');
  }
  if (bare.length < HANDLE_MIN || bare.length > HANDLE_MAX) {
    throw new HandleSettingsError('identity.handle_length', `A handle has ${HANDLE_MIN} to ${HANDLE_MAX} characters`);
  }
  return bare;
}

export interface HandleSettings {
  readonly handle: string;
  readonly discoverable: boolean;
  readonly changesUsed: number;
  /** The published lifetime cap, or null while the owner has not published one (changes refuse). */
  readonly changeCap: number | null;
  /** Changes left under the cap, or null with no cap. */
  readonly changesLeft: number | null;
}

export interface HandleActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly apiKey: boolean;
  readonly subAccount: boolean;
}

type Row = { handle: string; handle_discoverable: boolean; handle_changes: number; status: string };

export class HandleSettingsService {
  constructor(
    private readonly sql: Sql,
    /** `IDENTITY_HANDLE_CHANGE_MAX`: lifetime handle changes per account. Null: unpublished, every change refuses. */
    private readonly changeCap: number | null,
  ) {}

  async get(actor: HandleActor): Promise<HandleSettings> {
    this.assertOwner(actor);
    const rows = await this.sql<Row[]>`
      SELECT handle::text AS handle, handle_discoverable, handle_changes, status FROM users WHERE id = ${actor.userId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new HandleSettingsError('auth.not_found', 'No such account');
    return this.view(row);
  }

  async change(actor: HandleActor, input: { readonly handle: string; readonly fromHandle: string }): Promise<HandleSettings> {
    this.assertOwner(actor);
    const next = checkHandleRules(input.handle);
    const cap = this.changeCap;
    if (cap === null) {
      throw new HandleSettingsError('identity.handle_change_cap_unset', 'Changing a handle is not available yet');
    }
    try {
      return await transaction(this.sql, async (tx) => {
        await this.requireLive(tx, actor);
        await assertNotSecurityLocked(tx, actor.userId);
        // Both handles, in one order, so two swaps between the same pair cannot deadlock.
        const current = await tx<Array<{ handle: string }>>`SELECT handle::text AS handle FROM users WHERE id = ${actor.userId}`;
        const claims = [...new Set([next, current[0]?.handle ?? next].map((h) => h.toLowerCase()))].sort();
        for (const claim of claims) await lockHandleClaim(tx, claim);
        const rows = await tx<Row[]>`
          SELECT handle::text AS handle, handle_discoverable, handle_changes, status
            FROM users WHERE id = ${actor.userId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new HandleSettingsError('auth.not_found', 'No such account');
        if (row.status !== 'active') throw new HandleSettingsError('auth.account_frozen', 'Account is unavailable');
        // Handles are citext: case never makes two handles. A retry of a change that already landed (the stored handle
        // is exactly the one asked for, and the caller still names the one before it) answers the same, not a second change.
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        if (row.handle === next && !same(input.fromHandle, row.handle)) return this.view(row);
        if (!same(row.handle, input.fromHandle)) {
          throw new HandleSettingsError('identity.handle_changed_elsewhere', 'Your handle was changed somewhere else');
        }
        if (next === row.handle) throw new HandleSettingsError('identity.handle_unchanged', 'That is already your handle');
        if (row.handle_changes >= cap) {
          throw new HandleSettingsError(
            'identity.handle_change_cap_reached',
            `You have changed your handle ${row.handle_changes} times, the most allowed`,
            { used: row.handle_changes, cap },
          );
        }
        // Another account's retired handle is taken for good; saying "taken" leaks nothing a sign-up would not.
        if (await handleRetiredByOther(tx, next, actor.userId)) {
          throw new HandleSettingsError('identity.handle_taken', 'That handle is taken');
        }
        const updated = await tx<Row[]>`
          UPDATE users
             SET handle = ${next}, handle_changes = handle_changes + 1, updated_at = now()
           WHERE id = ${actor.userId}
          RETURNING handle::text AS handle, handle_discoverable, handle_changes, status
        `;
        // Taking one's own old handle back un-retires it; the handle given up now is retired to this account.
        await tx`DELETE FROM retired_handles WHERE handle = ${next} AND user_id = ${actor.userId}`;
        await tx`
          INSERT INTO retired_handles (handle, user_id) VALUES (${row.handle}, ${actor.userId})
          ON CONFLICT (handle) DO NOTHING
        `;
        await tx`
          INSERT INTO handle_audit (user_id, session_id, event, old_handle, new_handle)
          VALUES (${actor.userId}, ${actor.sessionId}, 'changed', ${row.handle}, ${next})
        `;
        return this.view(updated[0]!);
      });
    } catch (err) {
      // Backstop: the unique index on users.handle decides any race the lock did not, and the loser hears it is taken.
      if ((err as { code?: string }).code === '23505') throw new HandleSettingsError('identity.handle_taken', 'That handle is taken');
      throw err;
    }
  }

  async setDiscoverable(actor: HandleActor, discoverable: boolean): Promise<HandleSettings> {
    this.assertOwner(actor);
    return transaction(this.sql, async (tx) => {
      await this.requireLive(tx, actor);
      await assertNotSecurityLocked(tx, actor.userId);
      const rows = await tx<Row[]>`
        SELECT handle::text AS handle, handle_discoverable, handle_changes, status
          FROM users WHERE id = ${actor.userId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new HandleSettingsError('auth.not_found', 'No such account');
      if (row.status !== 'active') throw new HandleSettingsError('auth.account_frozen', 'Account is unavailable');
      if (row.handle_discoverable === discoverable) return this.view(row);
      const updated = await tx<Row[]>`
        UPDATE users SET handle_discoverable = ${discoverable}, updated_at = now()
         WHERE id = ${actor.userId}
        RETURNING handle::text AS handle, handle_discoverable, handle_changes, status
      `;
      await tx`
        INSERT INTO handle_audit (user_id, session_id, event)
        VALUES (${actor.userId}, ${actor.sessionId}, ${discoverable ? 'discoverable_on' : 'discoverable_off'})
      `;
      return this.view(updated[0]!);
    });
  }

  private view(row: Row): HandleSettings {
    const cap = this.changeCap;
    return {
      handle: row.handle,
      discoverable: row.handle_discoverable,
      changesUsed: row.handle_changes,
      changeCap: cap,
      changesLeft: cap === null ? null : Math.max(0, cap - row.handle_changes),
    };
  }

  private assertOwner(actor: HandleActor): void {
    if (actor.apiKey || actor.subAccount) {
      throw new HandleSettingsError('identity.delegated_refused', 'Sign in on this device. An API key or a sub-account cannot change this');
    }
  }

  /** The session row must be unrevoked and unexpired, whatever its access token still says. */
  private async requireLive(q: Sql, actor: HandleActor): Promise<void> {
    const rows = await q<Array<{ live: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM sessions
        WHERE id::text = ${actor.sessionId} AND user_id = ${actor.userId} AND revoked = false AND expires_at > now()
      ) AS live
    `;
    if (!rows[0]?.live) throw new HandleSettingsError('identity.session_not_live', 'This sign-in has ended. Sign in again');
  }
}
