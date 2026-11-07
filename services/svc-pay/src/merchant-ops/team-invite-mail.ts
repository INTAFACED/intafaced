import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * How an email team invitation reaches the invited mailbox (J-merchant-11 #1, outside dependency vendor.email).
 *
 * No email provider is connected anywhere. The one transport this service implements writes a LOCAL-TEST line to a
 * file on this machine, and selecting it outside APP_ENV exactly `dev` or `test` refuses at boot, as svc-identity's
 * does. With no transport set, email invitations are off: sending one refuses `pay.team_email_invite_unconfigured`,
 * which the portal reads out in plain words, and nothing is stored.
 *
 * The link code is the secret; it is only in the mail line, never on the console and never stored (the row keeps its
 * SHA-256).
 */

export const TEAM_INVITE_MAIL_TRANSPORT = 'local-outbox';
export const TEAM_INVITE_MAIL_REFUSED = 'pay.team_invite_mail_refused';

export interface TeamInviteMail {
  send(message: { email: string; memberId: string; code: string; role: string; expiresAt: Date; resent: boolean }): Promise<void>;
}

export interface TeamInviteMailBoot {
  /** Raw APP_ENV. Unset is not dev. */
  readonly appEnv: string | undefined;
  readonly transport: string | undefined;
  readonly outboxPath: string | undefined;
}

export function openTeamInviteMail(input: TeamInviteMailBoot): TeamInviteMail | undefined {
  const transport = input.transport?.trim() ?? '';
  if (transport === '') return undefined;
  if (transport !== TEAM_INVITE_MAIL_TRANSPORT) throw new Error(`${TEAM_INVITE_MAIL_REFUSED}: mail transport is not available`);
  if (input.appEnv !== 'dev' && input.appEnv !== 'test') {
    throw new Error(`${TEAM_INVITE_MAIL_REFUSED}: local-outbox is allowed only when APP_ENV is exactly dev or test`);
  }
  const outboxPath = input.outboxPath?.trim() ?? '';
  if (!outboxPath || !path.isAbsolute(outboxPath)) {
    throw new Error(`${TEAM_INVITE_MAIL_REFUSED}: PAY_TEAM_INVITE_MAIL_OUTBOX must be an absolute file path`);
  }
  return createLocalTeamInviteOutbox(outboxPath);
}

/** One LOCAL-TEST line: the address as sent, when the link runs out, and the link the person opens. */
export function teamInviteMailLine(message: Parameters<TeamInviteMail['send']>[0]): string {
  const email = message.email.replace(/\s+/g, '');
  const role = message.role.replace(/[^a-z]/g, '');
  const link = `pay/team?invite=${encodeURIComponent(message.memberId)}&code=${encodeURIComponent(message.code)}`;
  const purpose = message.resent ? 'team-invite-resent' : 'team-invite';
  return `LOCAL-TEST purpose=${purpose} email=${email} role=${role} expires=${message.expiresAt.toISOString()} link=${link}\n`;
}

export function createLocalTeamInviteOutbox(filePath: string): TeamInviteMail {
  return {
    async send(message) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, teamInviteMailLine(message), { mode: 0o600 });
      process.stderr.write(`LOCAL-TEST mail written purpose=${message.resent ? 'team-invite-resent' : 'team-invite'}\n`);
    },
  };
}
