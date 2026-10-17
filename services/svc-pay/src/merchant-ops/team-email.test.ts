import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emailInviteToken, isReservedTeamUserId, loadTeamEmailInviteLimit, normaliseTeamInviteEmail } from './team-email.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('team email invite normalisation and budget', () => {
  it('normalises case and refuses a shape that is not one mailbox', () => {
    expect(normaliseTeamInviteEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(emailInviteToken('ada@example.com')).toBe('email:ada@example.com');
    for (const raw of ['', 'not-an-email', 'a@b', 'ada@example.com extra', 'email:ada@example.com']) {
      expect(normaliseTeamInviteEmail(raw)).toBeNull();
    }
  });

  it('reserves the email token namespace for account ids', () => {
    expect(isReservedTeamUserId('email:ada@example.com')).toBe(true);
    expect(isReservedTeamUserId(' Email:ada@example.com ')).toBe(true);
    expect(isReservedTeamUserId('11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('publishes a window only when both positive integers are set', () => {
    expect(loadTeamEmailInviteLimit({})).toBeUndefined();
    expect(loadTeamEmailInviteLimit({ PAY_TEAM_EMAIL_INVITE_MAX: '2' })).toBeUndefined();
    expect(loadTeamEmailInviteLimit({ PAY_TEAM_EMAIL_INVITE_WINDOW_MS: '1000' })).toBeUndefined();
    expect(loadTeamEmailInviteLimit({ PAY_TEAM_EMAIL_INVITE_MAX: '0', PAY_TEAM_EMAIL_INVITE_WINDOW_MS: '1000' })).toBeUndefined();
    expect(loadTeamEmailInviteLimit({ PAY_TEAM_EMAIL_INVITE_MAX: '2', PAY_TEAM_EMAIL_INVITE_WINDOW_MS: '60000' })).toEqual({
      maxPerWindow: 2,
      windowMs: 60_000,
    });
  });

  it('the email invite path does not read an account table', () => {
    const src = readFileSync(join(here, 'team.ts'), 'utf8');
    const body = src.slice(src.indexOf('private async inviteByEmail'), src.indexOf('private assertEmailInviteConfigured'));
    expect(body).not.toMatch(/FROM users/i);
    expect(body).not.toMatch(/identity\./);
  });
});
