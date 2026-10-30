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
 * - A link has no lifetime of its own: nothing here invents one. Freezing is the safe side. It is bound to the account's
 *   address when it was minted and works only while that is still the account's address. The notice of an address change
 *   goes to the old address after the change, so its link is bound to the new one: it lets the old address's owner stop
 *   that change, and dies at the next one. Minting that notice's link also deletes the account's earlier unused links,
 *   so a link never comes back when an address returns.
 * - When a freeze is already open, the link keeps that freeze (one open freeze per account) and still ends every session
 *   and API key: the person said the change was not theirs, and a session made while frozen must not survive that.
 * - A second use returns the stored first result and says whether the account is still frozen now, so a freeze lifted
 *   since never reads as holding.
 * - An unknown token, a link of a closed account, or one whose address is no longer the account's is one refusal
 *   (`identity.freeze_link_invalid`).
 * - A failed mint sends the notice without the link, and logs it. The notice itself matters more than the shortcut.
 *   A relay retry of a notice mints a new link each attempt; each one works once.
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

const addressHash = (email: string) => hashToken(email.trim().toLowerCase());

/** The account a notice is about, and its address now: the id the sender passed, else the account whose proved address it goes to. */
async function noticeAccount(
  sql: Sql,
  message: { readonly userId?: string; readonly email: string },
): Promise<{ id: string; email: string } | null> {
  const rows = message.userId
    ? await sql<Array<{ id: string; email: string }>>`
        SELECT id, email::text AS email FROM users WHERE id = ${message.userId} AND status <> 'closed'`
    : await sql<Array<{ id: string; email: string }>>`
        SELECT id, email::text AS email FROM users
        WHERE email = ${message.email} AND email_verified_at IS NOT NULL AND status <> 'closed'`;
  return rows[0] ?? null;
}

/** Mints one link for the account and returns its token, or null when the notice names no open account. */
export async function mintFreezeLink(
  sql: Sql,
  message: { readonly userId?: string; readonly email: string; readonly purpose?: MailPurpose },
): Promise<string | null> {
  const account = await noticeAccount(sql, message);
  if (!account) return null;
  const token = generateToken(32);
  const purpose = message.purpose ?? 'password-reset';
  await transaction(sql, async (tx) => {
    if (purpose === 'email-change-notice') await tx`DELETE FROM self_freeze_links WHERE user_id = ${account.id} AND used_at IS NULL`;
    await tx`
      INSERT INTO self_freeze_links (user_id, token_hash, email_hash, purpose)
      VALUES (${account.id}, ${hashToken(token)}, ${addressHash(account.email)}, ${purpose})`;
  });
  return token;
}

/** The same mail port, with a freeze link added to each security notice. */
export function withFreezeLink(
  mail: PasswordResetMail,
  sql: Sql,
  log: { warn(obj: Record<string, unknown>, msg: string): void },
): PasswordResetMail {
  return {
    async send(message) {
      if (!FREEZE_LINK_PURPOSES.has(message.purpose ?? 'password-reset')) return mail.send(message);
      const freezeToken = await mintFreezeLink(sql, message).catch((err: unknown) => {
        log.warn({ purpose: message.purpose, err: err instanceof Error ? err.message : String(err) }, 'auth.freeze_link_mint_failed');
        return null;
      });
      return mail.send(freezeToken ? { ...message, freezeToken } : message);
    },
  };
}

export type FreezeLinkResult = {
  userId: string;
  since: Date;
  firstUse: boolean;
  /** A new freeze was opened, or a session or API key was ended, by this use. */
  changed: boolean;
  /** Whether the account is frozen by its owner right now. */
  frozenNow: boolean;
};

/**
 * Uses a link. The first use freezes (or keeps the freeze already open), ends every session and API key, and stores its
 * result on the link; any later use returns that stored result, changes nothing, and says whether it still holds.
 * Idempotent on (userId, open freeze id).
 */
export async function redeemFreezeLink(sql: Sql, input: { token: string }): Promise<FreezeLinkResult> {
  const token = input.token.trim();
  if (token.length === 0 || token.length > 200) throw new FreezeLinkError(FREEZE_LINK_INVALID);
  const presented = hashToken(token);
  return transaction(sql, async (tx) => {
    const links = await tx<
      Array<{
        id: string;
        user_id: string;
        purpose: string;
        email_hash: string;
        used_at: Date | null;
        freeze_id: string | null;
        frozen_since: Date | null;
      }>
    >`SELECT id, user_id, email_hash, used_at, freeze_id, frozen_since FROM self_freeze_links WHERE token_hash = ${presented} FOR UPDATE`;
    const link = links[0];
    if (!link) throw new FreezeLinkError(FREEZE_LINK_INVALID);
    // The status and address are read under the user lock, so a closure or an address change that commits first is seen.
    const users = await tx<Array<{ status: string; email: string }>>`
      SELECT status, email::text AS email FROM users WHERE id = ${link.user_id} FOR UPDATE`;
    const user = users[0];
    if (!user || user.status === 'closed' || addressHash(user.email) !== link.email_hash) throw new FreezeLinkError(FREEZE_LINK_INVALID);
    if (link.used_at && link.frozen_since) {
      const still = await tx`SELECT 1 FROM account_self_freezes WHERE id = ${link.freeze_id} AND state = 'frozen'`;
      return { userId: link.user_id, since: link.frozen_since, firstUse: false, changed: false, frozenNow: still.length > 0 };
    }
    const freeze = await applySelfFreeze(tx, link.user_id, FREEZE_LINK_REASON);
    let changed = freeze.changed;
    if (!changed) {
      // The freeze was already open: a session or key made while it held still ends now.
      const sessions = await tx`UPDATE sessions SET revoked = true WHERE user_id = ${link.user_id} AND revoked = false RETURNING id`;
      const keys = await tx`
        UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze'
        WHERE user_id = ${link.user_id} AND revoked = false RETURNING id`;
      changed = sessions.length + keys.length > 0;
    }
    await tx`
      UPDATE self_freeze_links SET used_at = now(), freeze_id = ${freeze.id}, frozen_since = ${freeze.since}
      WHERE id = ${link.id}`;
    return { userId: link.user_id, since: freeze.since, firstUse: true, changed, frozenNow: true };
  });
}
