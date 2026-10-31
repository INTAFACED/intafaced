import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { SUPPORT_LANGUAGES_UNSET, supportHelpCentreSetKey } from '@intafaced/contracts';
import { MemoryHelpCentreBook, helpCentreFingerprint } from './help-centre.js';
import { PLATFORM_KB_SPINE } from './kb-catalog.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/** SP-help-centre-03 — publish switch, languages and translation gaps. A blank field stays null. */

const authConfig = {
  secret: 'a-support-help-centre-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const BLANK = {
  name: null,
  address: null,
  defaultLanguage: null,
  languages: null,
  setupMode: null,
  theme: null,
  published: null,
  revision: 0,
  updatedAt: null,
};

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-help-centre' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-help-centre' };
}

async function desk() {
  const helpCentre = new MemoryHelpCentreBook();
  const support = new SupportService(undefined, undefined, undefined, new MemoryStaffBook());
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, undefined, undefined, helpCentre);
  const as = async (userId: string | null, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-1' });
  return { helpCentre, as, lead };
}

const reason = 'Owner set the help centre';

describe('help centre settings', () => {
  it('reads every field as null before the owner sets one, signed out, and does not treat the switch as on or off', async () => {
    const { as, helpCentre } = await desk();
    expect(await (await as(null)).helpCentre()).toEqual(BLANK);
    expect(helpCentre.log).toHaveLength(0);
  });

  it('a lead turns the switch off and a visitor still gets the record, with the switch false', async () => {
    const { as, lead } = await desk();
    const after = await lead.setHelpCentre({ reason, expectedRevision: 0, published: false, name: ' Help ' });
    expect(after).toMatchObject({ published: false, name: 'Help', revision: 1 });
    expect(await (await as(null)).helpCentre()).toEqual(after);
  });

  it('turning the switch on is one audit row naming the lead and the reason, and a repeat writes nothing more', async () => {
    const { helpCentre, lead } = await desk();
    const on = await lead.setHelpCentre({ reason: 'Publish the help centre', expectedRevision: 0, published: true });
    expect(on.published).toBe(true);
    expect(await lead.setHelpCentre({ reason: 'Publish the help centre', expectedRevision: 0, published: true })).toEqual(on);
    expect(helpCentre.log).toHaveLength(1);
    expect(helpCentre.log[0]).toMatchObject({
      key: supportHelpCentreSetKey(0),
      by: LEAD,
      reason: 'Publish the help centre',
    });
    const off = await lead.setHelpCentre({ reason: 'Switch the help centre off', expectedRevision: 1, published: false });
    expect(off.published).toBe(false);
    expect(helpCentre.log).toHaveLength(2);
  });

  it('only a staff lead may change settings', async () => {
    const { helpCentre, as } = await desk();
    const input = { reason, expectedRevision: 0, published: false };
    await expect((await as(AGENT)).setHelpCentre(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(CUSTOMER)).setHelpCentre(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(LEAD, ['support:read'])).setHelpCentre(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(null)).setHelpCentre(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await helpCentre.get()).toEqual(BLANK);
  });

  it('refuses a malformed address, an empty write and a default language that is not offered, and stores nothing', async () => {
    const { helpCentre, lead } = await desk();
    await expect(lead.setHelpCentre({ reason, expectedRevision: 0, address: 'http://help.example.test' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(lead.setHelpCentre({ reason, expectedRevision: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(lead.setHelpCentre({ reason, expectedRevision: 0, languages: ['en'], defaultLanguage: 'fr' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'support.help_centre_setting_invalid',
    });
    expect(await helpCentre.get()).toEqual(BLANK);
  });

  it('stores the https href, so a mixed-case or short address is not an untyped failure', async () => {
    const { helpCentre, lead } = await desk();
    const stored = await lead.setHelpCentre({ reason, expectedRevision: 0, address: 'HTTPS://help.example.com/home' });
    expect(stored.address).toBe('https://help.example.com/home');
    expect(await lead.setHelpCentre({ reason, expectedRevision: 0, address: 'HTTPS://help.example.com/home' })).toEqual(stored);
    expect(helpCentre.log).toHaveLength(1);
    const short = await lead.setHelpCentre({ reason: 'Short address', expectedRevision: 1, address: 'https://x' });
    expect(short.address).toBe('https://x/');
  });

  it('a stale revision is refused and a lost reply of the same change is the first answer', async () => {
    const { helpCentre, lead } = await desk();
    const first = await lead.setHelpCentre({ reason, expectedRevision: 0, name: 'Help' });
    expect(await lead.setHelpCentre({ reason, expectedRevision: 0, name: 'Help' })).toEqual(first);
    expect(helpCentre.log).toHaveLength(1);
    await expect(lead.setHelpCentre({ reason, expectedRevision: 0, name: 'Other' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.help_centre_revision_stale',
    });
    expect((await helpCentre.get()).name).toBe('Help');
  });

  it('a lost reply retried after a later change gets the change it made, not the later state', async () => {
    const { lead } = await desk();
    const off = await lead.setHelpCentre({ reason: 'Switch off', expectedRevision: 0, published: false });
    await lead.setHelpCentre({ reason: 'Switch on', expectedRevision: 1, published: true });
    expect(await lead.setHelpCentre({ reason: 'Switch off', expectedRevision: 0, published: false })).toEqual(off);
  });

  it('switched off, the public answer doors refuse support.help_centre_off to everyone but support staff', async () => {
    const { lead, as } = await desk();
    const visitor = await as(null);
    const customer = await as(CUSTOMER, ['support:read', 'support:write']);
    expect((await visitor.listKb({ limit: 100 })).length).toBeGreaterThan(0);
    await lead.setHelpCentre({ reason: 'Switch off', expectedRevision: 0, published: false });
    const off = { code: 'PRECONDITION_FAILED', message: 'support.help_centre_off' };
    for (const caller of [visitor, customer]) {
      await expect(caller.listKb({ limit: 100 })).rejects.toMatchObject(off);
      await expect(caller.searchKb({ q: 'sign', limit: 100 })).rejects.toMatchObject(off);
      await expect(caller.getKb({ id: 'kb-account-access' })).rejects.toMatchObject(off);
      await expect(caller.kbRelated({ id: 'kb-account-access' })).rejects.toMatchObject(off);
    }
    await expect(
      customer.kbFeedback({ id: 'kb-account-access', helpful: true, clientRequestId: 'vote-while-off-1' }),
    ).rejects.toMatchObject(off);
    await expect(
      visitor.kbFeedbackPublic({
        id: 'kb-account-access',
        helpful: true,
        clientRequestId: 'vote-while-off-2',
        readerToken: 'a-reader-token-1234567890',
      }),
    ).rejects.toMatchObject(off);
    await expect(visitor.kbAnswer({ q: 'sign', limit: 5 })).rejects.toMatchObject(off);
    await expect(
      visitor.kbSearchClick({ articleId: 'kb-account-access', query: 'sign', clientRequestId: 'click-while-off-1' }),
    ).rejects.toMatchObject(off);
    // The desk still reads its own answers, and the settings stay readable signed out.
    expect((await lead.listKb({ limit: 100 })).length).toBeGreaterThan(0);
    expect((await visitor.helpCentre()).published).toBe(false);
    await lead.setHelpCentre({ reason: 'Switch back on', expectedRevision: 1, published: true });
    expect((await visitor.listKb({ limit: 100 })).length).toBeGreaterThan(0);
  });

  it('asking for a language while none are offered refuses and lists no invented gaps', async () => {
    const { as, lead } = await desk();
    await expect((await as(null)).helpCentreLanguage({ language: 'en' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: SUPPORT_LANGUAGES_UNSET,
    });
    const list = await lead.helpCentreTranslations({ limit: 10 });
    expect(list).toEqual({ languages: null, total: null, rows: [] });
  });

  it('refuses a translation list with no page size', async () => {
    const { lead } = await desk();
    await lead.setHelpCentre({ reason, expectedRevision: 0, languages: ['en'], defaultLanguage: 'en' });
    await expect(lead.helpCentreTranslations({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.help_centre_list_limit_unset',
    });
  });

  it('offers two languages, keeps the switch visible when off, and lists a missing translation without storing a guess', async () => {
    const { as, helpCentre, lead } = await desk();
    await lead.setHelpCentre({
      reason,
      expectedRevision: 0,
      languages: ['en', 'fr'],
      defaultLanguage: 'en',
      published: false,
      address: 'https://help.example.test/help',
      setupMode: 'live',
    });
    const read = await (await as(null)).helpCentreLanguage({ language: 'fr', articleId: 'kb-account-access', version: 1 });
    expect(read).toMatchObject({
      language: 'fr',
      languages: ['en', 'fr'],
      published: false,
      defaultLanguage: 'en',
      address: 'https://help.example.test/help',
      translation: { articleId: 'kb-account-access', version: 1, state: 'missing' },
    });
    expect(helpCentre.translationLog).toHaveLength(0);
    const page = await lead.helpCentreTranslations({ limit: 2 });
    expect(page.languages).toEqual(['en', 'fr']);
    expect(page.total).toBe(PLATFORM_KB_SPINE.length * 2);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every((row) => row.state === 'missing')).toBe(true);
    await expect((await as(null)).helpCentreLanguage({ language: 'de' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'support.help_centre_setting_invalid',
    });
  });

  it('records one translation under the caller request id; a replay answers it, the same id with another state conflicts', async () => {
    const { helpCentre, lead, as } = await desk();
    await lead.setHelpCentre({ reason, expectedRevision: 0, languages: ['en'], defaultLanguage: 'en' });
    const input = {
      articleId: 'kb-account-access',
      version: 1,
      language: 'en',
      state: 'translated' as const,
      clientRequestId: 'translate-account-en-1',
      reason: 'English body is in the catalogue',
    };
    const first = await lead.setHelpCentreTranslation(input);
    expect(first).toEqual({ articleId: 'kb-account-access', version: 1, language: 'en', state: 'translated' });
    expect(await lead.setHelpCentreTranslation(input)).toEqual(first);
    await expect(lead.setHelpCentreTranslation({ ...input, state: 'missing' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.help_centre_idempotency_conflict',
    });
    expect(helpCentre.translationLog).toHaveLength(1);
    const again = await lead.setHelpCentreTranslation({ ...input, clientRequestId: 'translate-account-en-2', state: 'missing' });
    expect(again.state).toBe('missing');
    expect(helpCentre.translationLog).toHaveLength(2);
    await expect(
      lead.setHelpCentreTranslation({ ...input, articleId: 'kb-not-a-real-article', clientRequestId: 'translate-missing-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'support.not_found' });
    // A desk agent is not a lead, and a customer is not staff: neither records a translation.
    await expect((await as(AGENT)).setHelpCentreTranslation({ ...input, clientRequestId: 'translate-agent-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect((await as(CUSTOMER, ['support:write'])).setHelpCentreTranslation(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(helpCentre.translationLog).toHaveLength(2);
  });

  it('a committed translation answers its retry after the language stopped being offered', async () => {
    const { lead } = await desk();
    await lead.setHelpCentre({ reason, expectedRevision: 0, languages: ['en', 'es'], defaultLanguage: 'en' });
    const input = {
      articleId: 'kb-account-access',
      version: 1,
      language: 'es',
      state: 'translated' as const,
      clientRequestId: 'translate-account-es-1',
      reason: 'Spanish body is in the catalogue',
    };
    const first = await lead.setHelpCentreTranslation(input);
    await lead.setHelpCentre({ reason: 'Spanish withdrawn', expectedRevision: 1, languages: ['en'] });
    expect(await lead.setHelpCentreTranslation(input)).toEqual(first);
  });

  it('refuses a translation while languages are unset, and an unknown article stores nothing', async () => {
    const { helpCentre, lead } = await desk();
    const input = {
      articleId: 'kb-account-access',
      version: 1,
      language: 'en',
      state: 'translated' as const,
      clientRequestId: 'translate-account-en-1',
      reason: 'English body is in the catalogue',
    };
    await expect(lead.setHelpCentreTranslation(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: SUPPORT_LANGUAGES_UNSET,
    });
    expect(helpCentre.translationLog).toHaveLength(0);
  });

  it('fingerprints the fields and the reason, not the actor or the time', () => {
    expect(helpCentreFingerprint({ published: true }, 'r')).toBe(helpCentreFingerprint({ published: true }, 'r'));
    expect(helpCentreFingerprint({ published: true }, 'r')).not.toBe(helpCentreFingerprint({ published: false }, 'r'));
    expect(helpCentreFingerprint({ published: null }, 'r')).not.toBe(helpCentreFingerprint({}, 'r'));
    expect(helpCentreFingerprint({ languages: ['en', 'fr'] }, 'r')).not.toBe(helpCentreFingerprint({ languages: ['fr', 'en'] }, 'r'));
  });

  it('the fingerprint of a change without a theme is what it was before theme existed', () => {
    const legacy = createHash('sha256')
      .update(JSON.stringify([[null, null, null, null, null, ['published', true]], 'r']))
      .digest('hex');
    expect(helpCentreFingerprint({ published: true }, 'r')).toBe(legacy);
    expect(helpCentreFingerprint({ published: true, theme: 'dark' }, 'r')).not.toBe(legacy);
  });
});

describe('help centre theme (SP-help-centre-03)', () => {
  it('reads blank, a lead sets it with a reason, a repeat writes nothing more and null clears it', async () => {
    const { as, helpCentre, lead } = await desk();
    expect((await (await as(null)).helpCentre()).theme).toBeNull();
    const dark = await lead.setHelpCentre({ reason: 'Owner chose dark', expectedRevision: 0, theme: 'dark' });
    expect(dark).toMatchObject({ theme: 'dark', revision: 1 });
    expect(await (await as(null)).helpCentre()).toEqual(dark);
    expect(await lead.setHelpCentre({ reason: 'Owner chose dark', expectedRevision: 0, theme: 'dark' })).toEqual(dark);
    expect(helpCentre.log).toHaveLength(1);
    const cleared = await lead.setHelpCentre({ reason: 'Back to unset', expectedRevision: 1, theme: null });
    expect(cleared.theme).toBeNull();
    expect(helpCentre.log).toHaveLength(2);
  });

  it('refuses a theme outside system, light and dark, and stores nothing', async () => {
    const { helpCentre, lead } = await desk();
    await expect(lead.setHelpCentre({ reason, expectedRevision: 0, theme: 'neon' as 'dark' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await helpCentre.get()).toEqual(BLANK);
  });
});

describe('help centre change log (SP-help-centre-03)', () => {
  it('lists changes newest first with revision, who, reason, time, before, after and the fields changed', async () => {
    const { lead } = await desk();
    await lead.setHelpCentre({ reason: 'Name it', expectedRevision: 0, name: 'Help' });
    await lead.setHelpCentre({ reason: 'Switch it off', expectedRevision: 1, published: false, theme: 'light' });
    const log = await lead.helpCentreChanges({ limit: 10 });
    expect(log.map((row) => [row.revision, row.reason, row.by, row.changed])).toEqual([
      [2, 'Switch it off', LEAD, ['theme', 'published']],
      [1, 'Name it', LEAD, ['name']],
    ]);
    expect(log[0]).toMatchObject({ before: { published: null, theme: null }, after: { published: false, theme: 'light' } });
    expect(await lead.helpCentreChanges({ limit: 1 })).toHaveLength(1);
  });

  it('a blank page size refuses support.help_centre_list_limit_unset, and only the desk reads the log', async () => {
    const { as, lead } = await desk();
    await expect(lead.helpCentreChanges({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.help_centre_list_limit_unset',
    });
    await expect((await as(CUSTOMER, ['support:read', 'support:write'])).helpCentreChanges({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect((await as(null)).helpCentreChanges({ limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await (await as(AGENT)).helpCentreChanges({ limit: 10 })).toEqual([]);
  });
});
