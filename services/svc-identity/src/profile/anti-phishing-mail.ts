/**
 * Identity's mails carry the account's anti-phishing code (I-signin-sessions-25, second half). A mail that goes to an
 * account's own confirmed address about that account gets the code its owner set; a phishing mail cannot know it.
 *
 * - Only purposes sent to the account's own proved address carry it. A mail to an address that is not yet proved (an
 *   email-confirm link, the new address of an email change, a sign-up code) or to an address with no account carries
 *   none, so the code never reaches an inbox its owner has not proved.
 * - The code is looked up when the mail is sent, so a code set or cleared after the request still applies. A sender that
 *   knows the account passes its id (the address-change notice goes to the old address, which no longer names it);
 *   otherwise the address the mail goes to names the account.
 * - A code this key cannot open (sealed under an older key) is left out, the same as no code; the Security card already
 *   says it is unreadable.
 * - A failed lookup sends the mail without the code. The relay has already cleared the row's one-time code when it
 *   sends, so a throw here would lose a reset or confirm mail for good; a mail without the code is one its owner is
 *   told to distrust, which is the safe side.
 */
import type { Sql } from 'postgres';
import type { MailPurpose, PasswordResetMail } from '../auth/password-reset.js';
import { openStoredCode } from './anti-phishing.js';

/** The purposes that go to an account's own address about that account. */
export const ANTI_PHISHING_MAIL_PURPOSES: ReadonlySet<MailPurpose> = new Set<MailPurpose>([
  'password-reset',
  'email-change-notice',
  'handle-recovery',
  'signup-existing',
  'login-code',
  'new-device-code',
  'withdraw-address-approval',
  'password-changed',
  'mfa-reset-code',
  'mfa-reset-started',
  'mfa-reset-cancelled',
  'mfa-reset-completed',
  'factor-changed',
  'support-recovery',
  'support-recovery-used',
  'appeal-decided',
]);

/** The code set on the account (by id, else by its address), or null (no account, no code, no key, or unreadable). */
export async function antiPhishingCodeFor(
  sql: Sql,
  key: Buffer | null,
  account: { readonly userId?: string; readonly email: string },
): Promise<string | null> {
  if (!key) return null;
  const rows = account.userId
    ? await sql<Array<{ ciphertext: Buffer; nonce: Buffer }>>`
        SELECT ciphertext, nonce FROM anti_phishing_codes WHERE user_id = ${account.userId}
      `
    : await sql<Array<{ ciphertext: Buffer; nonce: Buffer }>>`
        SELECT c.ciphertext, c.nonce FROM anti_phishing_codes c JOIN users u ON u.id = c.user_id
         WHERE u.email = ${account.email} AND u.email_verified_at IS NOT NULL
      `;
  const row = rows[0];
  return row ? openStoredCode(key, row) : null;
}

/** The same mail port, with the account's code added to the mails that carry it. */
export function withAntiPhishingCode(mail: PasswordResetMail, sql: Sql, key: Buffer | null): PasswordResetMail {
  return {
    async send(message) {
      const purpose = message.purpose ?? 'password-reset';
      if (!ANTI_PHISHING_MAIL_PURPOSES.has(purpose)) return mail.send(message);
      const antiPhishingCode = await antiPhishingCodeFor(sql, key, message).catch(() => null);
      return mail.send(antiPhishingCode ? { ...message, antiPhishingCode } : message);
    },
  };
}
