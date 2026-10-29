import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { MailPurpose, PasswordResetMail } from './password-reset.js';
import { generateToken, hashToken } from './passwords.js';

/**
 * The freeze link (I-account-lifecycle-08, J-identity-11 #2). Every security notice mail carries a one-time link that
 * freezes the account without signing in, for "this was not me".
 *
 * - The link holds a 32-byte random token; only its SHA-256 is stored. Opening the page spends nothing: the person
 *   presses Freeze my account, which calls `freezeLink.redeem`.
 * - Its first use runs the same freeze as `auth.selfFreeze` (one open freeze, every session and API key revoked, in one
 *   transaction) and stores what it did on the link. A second use changes nothing and shows that stored result.
 * - A link has no lifetime of its own: nothing here invents one. Freezing is the safe side, and the mailbox that holds
 *   the link is the one the notice warned.
 * - An unknown token, or a link of a closed account, is one refusal (`identity.freeze_link_invalid`).
 * - A failed mint sends the notice without the link. The notice itself matters more than the shortcut in it.
 */

/** The notices about a change to the account's security. Each one carries a freeze link. */
export const FREEZE_LINK_PURPOSES: ReadonlySet<MailPurpose> = new Set<MailPurpose>([
  'password-changed',
  'factor-changed',
  'email-change-notice',
  'mfa-reset-started',
  'mfa-reset-cancelled',
  'mfa-reset-completed',
  'support-recovery-used',
]);

export const FREEZE_LINK_INVALID = 'identity.freeze_link_invalid';

/** The reason a freeze from a notice link records: the person said the change was not theirs. */
export const FREEZE_LINK_REASON = 'compromise';

export class FreezeLinkError extends Error {
  constructor(readonly code: typeof FREEZE_LINK_INVALID) {
    super('That freeze link does not work.');
    this.name = 'FreezeLinkError';
  }
}

export type SelfFreezeRow = { id: string; reason: 'compromise' | 'temporary' | 'personal'; since: Date; changed: boolean };

/**
 * The one freeze both doors run, inside the caller's transaction: the open freeze if there is one, else a new one with
 * every session and API key revoked. Locks the user row first so two freezes never race.
 */
export async function applySelfFreeze(tx: Sql, userId: string, reason: SelfFreezeRow['reason']): Promise<SelfFreezeRow> {
  await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  const open = await tx<Array<{ id: string; reason: SelfFreezeRow['reason']; since: Date }>>`
    SELECT id, reason, since FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`;
  if (open[0]) return { ...open[0], changed: false };
  const made = await tx<Array<{ id: string; since: Date }>>`
    INSERT INTO account_self_freezes (user_id, reason) VALUES (${userId}, ${reason}) RETURNING id, since`;
  await tx`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
  await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze' WHERE user_id = ${userId} AND revoked = false`;
  return { id: made[0]!.id, reason, since: made[0]!.since, changed: true };
}

/** The account a notice is about: the id the sender passed, else the account whose proved address it goes to. */
async function noticeAccount(sql: Sql, message: { readonly userId?: string; readonly email: string }): Promise<string | null> {
  const rows = message.userId
    ? await sql<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${message.userId} AND status <> 'closed'`
    : await sql<Array<{ id: string }>>`
        SELECT id FROM users WHERE email = ${message.email} AND email_verified_at IS NOT NULL AND status <> 'closed'`;
  return rows[0]?.id ?? null;
}

/** Mints one link for the account and returns its token, or null when the notice names no open account. */
export async function mintFreezeLink(
  sql: Sql,
  message: { readonly userId?: string; readonly email: string; readonly purpose?: MailPurpose },
): Promise<string | null> {
  const userId = await noticeAccount(sql, message);
  if (!userId) return null;
  const token = generateToken(32);
  await sql`
    INSERT INTO self_freeze_links (user_id, token_hash, purpose)
    VALUES (${userId}, ${hashToken(token)}, ${message.purpose ?? 'password-reset'})`;
  return token;
}

/** The same mail port, with a freeze link added to each security notice. */
export function withFreezeLink(mail: PasswordResetMail, sql: Sql): PasswordResetMail {
  return {
    async send(message) {
      if (!FREEZE_LINK_PURPOSES.has(message.purpose ?? 'password-reset')) return mail.send(message);
      const freezeToken = await mintFreezeLink(sql, message).catch(() => null);
      return mail.send(freezeToken ? { ...message, freezeToken } : message);
    },
  };
}

export type FreezeLinkResult = { userId: string; since: Date; firstUse: boolean; changed: boolean };

/**
 * Uses a link. The first use freezes (or finds the freeze already open) and stores its result on the link; any later use
 * returns that stored result and changes nothing. Idempotent on (userId, open freeze id).
 */
export async function redeemFreezeLink(sql: Sql, input: { token: string }): Promise<FreezeLinkResult> {
  const token = input.token.trim();
  if (token.length === 0 || token.length > 200) throw new FreezeLinkError(FREEZE_LINK_INVALID);
  const presented = hashToken(token);
  return transaction(sql, async (tx) => {
    const links = await tx<Array<{ id: string; user_id: string; used_at: Date | null; frozen_since: Date | null }>>`
        SELECT id, user_id, used_at, frozen_since FROM self_freeze_links WHERE token_hash = ${presented} FOR UPDATE`;
    const link = links[0];
    if (!link) throw new FreezeLinkError(FREEZE_LINK_INVALID);
    if (link.used_at && link.frozen_since) {
      return { userId: link.user_id, since: link.frozen_since, firstUse: false, changed: false };
    }
    const users = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${link.user_id}`;
    if (!users[0] || users[0].status === 'closed') throw new FreezeLinkError(FREEZE_LINK_INVALID);
    const freeze = await applySelfFreeze(tx, link.user_id, FREEZE_LINK_REASON);
    await tx`
        UPDATE self_freeze_links SET used_at = now(), freeze_id = ${freeze.id}, frozen_since = ${freeze.since}
        WHERE id = ${link.id}`;
    return { userId: link.user_id, since: freeze.since, firstUse: true, changed: freeze.changed };
  });
}
