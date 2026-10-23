import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { outreachPublicProblem, outreachPublicSettingsSetInputSchema, type Context } from '@intafaced/contracts';
import { OutreachCrm } from './crm.js';
import { OutreachError } from './config.js';
import { MemoryPublicSettingsBook, PublicSettingsStaleError } from './public-settings.js';
import { createOutreachRouter } from './router.js';

// SP-pages-02: the join address and partner terms the public partner page reads. Blank is null, a founder sets them from
// the revision they read, with a reason, and a malformed value never reaches the store.

const userId = randomUUID();
const founder: Context = {
  principal: {
    userId,
    sub: userId,
    sid: randomUUID(),
    scopes: ['ops:read', 'ops:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60000),
  },
  service: null,
  region: 'ID',
  requestId: randomUUID(),
};
const visitor: Context = { ...founder, principal: null };
const AT = '2026-10-23T09:00:00.000Z';

function api(book = new MemoryPublicSettingsBook(), allowed = true) {
  const authority = vi.fn(async () => {
    if (!allowed) throw new OutreachError('ops.crm.operator_forbidden');
    return userId;
  });
  return { book, authority, router: createOutreachRouter(new OutreachCrm(null, null), authority, book) };
}

describe('outreach public settings', () => {
  it('a signed-out visitor reads both values as null before anything is set', async () => {
    const { router } = api();
    expect(await router.createCaller(visitor).publicSettings()).toEqual({
      joinUrl: null,
      partnerTerms: null,
      revision: 0,
      updatedAt: null,
    });
  });

  it('a founder sets the join address with a reason; the visitor reads it, and the change is logged once', async () => {
    const { router, book } = api();
    const after = await router
      .createCaller(founder)
      .setPublicSettings({ joinUrl: 'https://join.example.org/', expectedRevision: 0, reason: 'Invitation site is live' });
    expect(after).toMatchObject({ joinUrl: 'https://join.example.org', partnerTerms: null, revision: 1 });
    expect(await router.createCaller(visitor).publicSettings()).toMatchObject({ joinUrl: 'https://join.example.org', revision: 1 });
    expect(book.log).toHaveLength(1);
    expect(book.log[0]).toMatchObject({ key: 'ops.public_settings:r0', by: userId, reason: 'Invitation site is live' });
  });

  it('only a founder session writes: a visitor is unauthorised and a non-founder is forbidden, and nothing is stored', async () => {
    const input = { joinUrl: 'https://join.example.org', expectedRevision: 0, reason: 'x' };
    const open = api();
    await expect(open.router.createCaller(visitor).setPublicSettings(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const shut = api(new MemoryPublicSettingsBook(), false);
    await expect(shut.router.createCaller(founder).setPublicSettings(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await shut.book.get()).toMatchObject({ joinUrl: null, revision: 0 });
    expect(shut.book.log).toHaveLength(0);
  });

  it('refuses a join address that is not an https origin, and stores nothing', async () => {
    const { router, book } = api();
    for (const bad of [
      'http://join.example.org',
      'javascript:alert(1)',
      'https://u:p@join.example.org',
      'https://join.example.org/partner',
      'join.example.org',
    ]) {
      await expect(
        router.createCaller(founder).setPublicSettings({ joinUrl: bad, expectedRevision: 0, reason: 'x' }),
        bad,
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(book.log).toHaveLength(0);
    // A local stack serves the invitation site on a loopback http origin; that is the only http allowed.
    expect(outreachPublicProblem('joinUrl', 'http://127.0.0.1:3220')).toBeNull();
    expect(outreachPublicProblem('joinUrl', 'http://10.0.0.1:3220')).toBe('not_https');
  });

  it('terms are plain text: control characters are refused, newlines kept', () => {
    expect(outreachPublicProblem('partnerTerms', 'Line one\nLine two')).toBeNull();
    expect(outreachPublicProblem('partnerTerms', 'bad‮text')).toBe('not_text');
    expect(outreachPublicSettingsSetInputSchema.safeParse({ expectedRevision: 0, reason: 'nothing' }).success).toBe(false);
  });

  it('a lost reply replays the same change; a different change from the old revision is stale', async () => {
    const book = new MemoryPublicSettingsBook();
    const change = { changes: { partnerTerms: 'TEST terms' }, expectedRevision: 0, by: userId, reason: 'publish', at: AT };
    const first = await book.set(change);
    expect(await book.set(change)).toEqual(first);
    await expect(book.set({ ...change, changes: { partnerTerms: 'other' } })).rejects.toBeInstanceOf(PublicSettingsStaleError);
    const { router } = api(book);
    await expect(
      router.createCaller(founder).setPublicSettings({ partnerTerms: 'other', expectedRevision: 0, reason: 'late' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'ops.public_settings_revision_stale' });
    expect(book.log).toHaveLength(1);
  });

  it('clearing a value with null makes the page say it is not set again', async () => {
    const book = new MemoryPublicSettingsBook();
    await book.set({ changes: { joinUrl: 'https://join.example.org' }, expectedRevision: 0, by: userId, reason: 'on', at: AT });
    const cleared = await book.set({ changes: { joinUrl: null }, expectedRevision: 1, by: userId, reason: 'off', at: AT });
    expect(cleared).toMatchObject({ joinUrl: null, revision: 2 });
  });

  it('without its database the read refuses with a named code instead of answering blank', async () => {
    const router = createOutreachRouter(
      new OutreachCrm(null, null),
      vi.fn(async () => userId),
    );
    await expect(router.createCaller(visitor).publicSettings()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ops.crm.storage_unconfigured',
    });
  });
});
