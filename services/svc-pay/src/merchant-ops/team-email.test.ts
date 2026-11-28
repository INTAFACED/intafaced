import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { scriptedSql } from '../scripted-sql.testkit.js';
import { TeamService } from './team.js';
import {
  emailInviteToken,
  isReservedTeamUserId,
  loadTeamEmailInviteLimit,
  normaliseTeamInviteEmail,
  plainTeamLabel,
  readStashedInviteEmail,
  stashInviteEmail,
  teamEventMemberUserId,
} from './team-email.js';

describe('team email invite normalisation and budget', () => {
  it('normalises case and refuses a shape that is not one mailbox', () => {
    expect(normaliseTeamInviteEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(emailInviteToken('ada@example.com')).toBe('email:ada@example.com');
    for (const raw of ['', 'not-an-email', 'a@b', 'ada@example.com extra', 'email:ada@example.com']) {
      expect(normaliseTeamInviteEmail(raw)).toBeNull();
    }
    // Kelvin sign and other non-ASCII letters are refused before case folding.
    expect(normaliseTeamInviteEmail('\u212Aelvin@example.com')).toBeNull();
    expect(normaliseTeamInviteEmail('\uFF21da@example.com')).toBeNull();
  });

  it('keeps the invited email on the display side of a bound row', () => {
    expect(plainTeamLabel(' Ada \u001e')).toBe('Ada');
    expect(plainTeamLabel(undefined)).toBeNull();
    const stored = stashInviteEmail('Ada', 'email:ada@example.com');
    expect(readStashedInviteEmail(stored)).toEqual({ token: 'email:ada@example.com', label: 'Ada' });
    expect(readStashedInviteEmail('Ada')).toBeNull();
    expect(teamEventMemberUserId('11111111-1111-4111-8111-111111111111', stored, 'invited')).toBe('email:ada@example.com');
    expect(teamEventMemberUserId('11111111-1111-4111-8111-111111111111', stored, 'removed')).toBe('email:ada@example.com');
    expect(teamEventMemberUserId('11111111-1111-4111-8111-111111111111', 'Ada', 'active')).toBe('11111111-1111-4111-8111-111111111111');
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
    expect(loadTeamEmailInviteLimit({ PAY_TEAM_EMAIL_INVITE_MAX: '2', PAY_TEAM_EMAIL_INVITE_WINDOW_MS: '60000' })).toBeUndefined();
    expect(
      loadTeamEmailInviteLimit({
        PAY_TEAM_EMAIL_INVITE_MAX: '2',
        PAY_TEAM_EMAIL_INVITE_WINDOW_MS: '60000',
        PAY_TEAM_EMAIL_INVITE_TTL_MS: '0',
      }),
    ).toBeUndefined();
    expect(
      loadTeamEmailInviteLimit({
        PAY_TEAM_EMAIL_INVITE_MAX: '2',
        PAY_TEAM_EMAIL_INVITE_WINDOW_MS: '60000',
        PAY_TEAM_EMAIL_INVITE_TTL_MS: '86400000',
      }),
    ).toEqual({
      maxPerWindow: 2,
      windowMs: 60_000,
      ttlMs: 86_400_000,
    });
  });

  it('the email invite path does not read an account table', async () => {
    // Two mailboxes, one that may hold an account and one that cannot, take the same path: the same questions to the
    // database, none of them about accounts, and no call to another service.
    const caller = { merchantId: 'm-1', userId: 'owner-1', role: 'owner', viaApiKey: false, interactive: true } as const;
    const limit = { maxPerWindow: 5, windowMs: 60_000, ttlMs: 86_400_000 };
    const fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the invite called out'));
    const invite = async (email: string) => {
      const { sql, calls } = scriptedSql<Sql>((call) => (call.text.includes('RETURNING id') ? [{ id: 'member-1' }] : []));
      const outcome = await new TeamService(sql, limit).invite(caller, { email, role: 'viewer' }).then(
        () => 'answered',
        (err: { code?: string }) => err.code ?? 'threw',
      );
      return { outcome, texts: calls.map((c) => c.text) };
    };
    try {
      const registered = await invite('owner-of-an-account@example.com');
      const unknown = await invite('nobody-registered@example.org');
      expect(registered.texts.length).toBeGreaterThan(0);
      expect(registered.texts.some((text) => text.includes('INSERT INTO pay.merchant_team_members'))).toBe(true);
      expect(unknown).toEqual(registered);
      for (const text of registered.texts) {
        expect(text).not.toMatch(/FROM users/i);
        expect(text).not.toMatch(/identity\./);
      }
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });
});
