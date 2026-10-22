import { describe, expect, it } from 'vitest';
import {
  OPS_MAIL_ALIAS_REFUSED,
  OPS_MAIL_NOT_CONNECTED_COPY,
  OPS_MAIL_SCOPE_INVALID,
  isAliasAddress,
  mailSettingsRefusal,
  mailSettingsSaveInputSchema,
  mailSettingsSchema,
  resolveMailSharing,
} from './ops-mail-settings.js';

/** TEST data only. */
const save = {
  slotId: '11111111-1111-4111-8111-111111111111',
  connection: {
    address: 'ops@example.test',
    signInMethod: 'incoming_mail',
    incomingProtocol: 'imap',
    outgoingProtocol: 'smtp',
    calendarProtocol: 'caldav',
  },
  contactCreation: 'sent_only',
  scope: { inbox: true, sent: true, customFolders: ['TEST deals'], exclusions: ['spam', 'trash'], cadenceMinutes: 15 },
};

describe('mail settings save', () => {
  it('accepts a complete save without a connection secret', () => {
    expect(mailSettingsSaveInputSchema.safeParse(save).success).toBe(true);
  });

  it('refuses an alias address with ops.mail.alias_refused', () => {
    const r = mailSettingsSaveInputSchema.safeParse({ ...save, connection: { ...save.connection, address: 'ops+deals@example.test' } });
    expect(r.success).toBe(false);
    if (!r.success) expect(mailSettingsRefusal(r.error)).toBe(OPS_MAIL_ALIAS_REFUSED);
    expect(isAliasAddress('ops@example.test')).toBe(false);
  });

  it.each([
    ['no folder at all', { inbox: false, sent: false, customFolders: [] }],
    ['duplicate folders', { customFolders: ['A', 'a'] }],
    ['duplicate exclusions', { exclusions: ['spam', 'spam'] }],
  ])('refuses a scope with %s as ops.mail.scope_invalid', (_l, patch) => {
    const r = mailSettingsSaveInputSchema.safeParse({ ...save, scope: { ...save.scope, ...patch } });
    expect(r.success).toBe(false);
    if (!r.success) expect(mailSettingsRefusal(r.error)).toBe(OPS_MAIL_SCOPE_INVALID);
  });

  it('refuses a blank cadence instead of inventing one', () => {
    const { cadenceMinutes: _c, ...noCadence } = save.scope;
    expect(mailSettingsSaveInputSchema.safeParse({ ...save, scope: noCadence }).success).toBe(false);
  });

  it('refuses a credential field: credentials are not part of this shape', () => {
    expect(mailSettingsSaveInputSchema.safeParse({ ...save, connection: { ...save.connection, password: 'TEST' } }).success).toBe(false);
  });

  it('other zod failures map to no mail refusal', () => {
    const r = mailSettingsSaveInputSchema.safeParse({ ...save, slotId: 'x' });
    expect(r.success).toBe(false);
    if (!r.success) expect(mailSettingsRefusal(r.error)).toBeNull();
  });
});

describe('sharing level', () => {
  it('a level not chosen is stored as metadata only, and says it was defaulted', () => {
    expect(resolveMailSharing({})).toEqual({
      mailSharing: 'metadata_only',
      mailSharingDefaulted: true,
      calendarSharing: 'date_and_participants',
      calendarSharingDefaulted: true,
    });
  });

  it('a chosen level is kept', () => {
    expect(resolveMailSharing({ mailSharing: 'full_content', calendarSharing: 'everything' })).toMatchObject({
      mailSharing: 'full_content',
      mailSharingDefaulted: false,
      calendarSharingDefaulted: false,
    });
  });
});

describe('read back', () => {
  it('is a draft with the sync off and never carries a credential', () => {
    const row = {
      slotId: save.slotId,
      ownerOperatorId: 'op-1',
      connection: save.connection,
      ...resolveMailSharing({}),
      contactCreation: 'never',
      scope: save.scope,
      syncState: 'off_draft',
      updatedAt: '2026-10-22T00:00:00.000Z',
    };
    expect(mailSettingsSchema.parse(row).syncState).toBe('off_draft');
    expect(mailSettingsSchema.safeParse({ ...row, syncState: 'live' }).success).toBe(false);
    expect(mailSettingsSchema.safeParse({ ...row, accessToken: 'TEST' }).success).toBe(false);
  });

  it('names the parked notice', () => {
    expect(OPS_MAIL_NOT_CONNECTED_COPY).toMatch(/switched off in this build/);
  });
});
