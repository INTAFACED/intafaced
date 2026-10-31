import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemorySupportStore } from './store.js';

const authConfig = {
  secret: 'a-support-kb-audience-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-visitor' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-kb' };
}

async function desk() {
  const store = new MemorySupportStore();
  const support = new SupportService(store);
  const router = createSupportRouter(support);
  const visitor = router.createCaller(await ctx(null, []));
  const customer = router.createCaller(await ctx(CUSTOMER, ['support:read', 'support:write']));
  const staff = router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const publish = async (id: string, extra: Record<string, unknown> = {}) =>
    staff.publishKb({ id, titleKey: `support.kb.${id}.title`, bodyKey: `support.kb.${id}.body`, baseRevision: 0, ...extra });
  return { store, support, visitor, customer, staff, publish };
}

// The memory store also holds the platform articles; the tests look only at their own.
const ids = (articles: { id: string }[]) =>
  articles
    .map((a) => a.id)
    .filter((id) => id.startsWith('zz-'))
    .sort();

describe('help article audiences (SP-help-centre-02)', () => {
  it('a new article is public and everyone sees it', async () => {
    const { visitor, publish } = await desk();
    const a = await publish('zz-open');
    expect(a.audience ?? 'public').toBe('public');
    expect(ids(await visitor.listKb({ limit: 500 }))).toEqual(['zz-open']);
  });

  it('a signed-in article is hidden from a visitor in list, search, get, version and related, and shown to a customer', async () => {
    const { visitor, customer, staff, publish } = await desk();
    await publish('zz-open', { category: 'account' });
    const a = await publish('zz-members', { category: 'account' });
    await staff.setKbAudience({ id: 'zz-members', baseRevision: a.revision!, audience: 'signed_in' });

    expect(ids(await visitor.listKb({ limit: 500 }))).toEqual(['zz-open']);
    expect(ids(await visitor.searchKb({ q: 'zz-', limit: 500 }))).toEqual(['zz-open']);
    expect(await visitor.getKb({ id: 'zz-members' })).toBeNull();
    expect(await visitor.getKb({ id: 'zz-members', version: 1 })).toBeNull();
    expect(await visitor.getKb({ id: 'zz-members', version: 99 })).toBeNull();
    expect(await visitor.getKb({ id: 'does-not-exist' })).toBeNull();
    expect(ids(await visitor.kbRelated({ id: 'zz-open' }))).toEqual([]);

    expect(ids(await customer.listKb({ limit: 500 }))).toEqual(['zz-members', 'zz-open']);
    expect((await customer.getKb({ id: 'zz-members' }))?.audience).toBe('signed_in');
    expect(ids(await customer.kbRelated({ id: 'zz-open' }))).toEqual(['zz-members']);
  });

  it('a staff article is hidden from a visitor and a customer and answers like a missing id, shown to the desk', async () => {
    const { visitor, customer, staff, publish } = await desk();
    const a = await publish('zz-desk-only');
    await staff.setKbAudience({ id: 'zz-desk-only', baseRevision: a.revision!, audience: 'staff' });

    for (const reader of [visitor, customer]) {
      expect(ids(await reader.listKb({ limit: 500 }))).toEqual([]);
      expect(ids(await reader.searchKb({ q: 'desk', limit: 500 }))).toEqual([]);
      expect(await reader.getKb({ id: 'zz-desk-only' })).toEqual(await reader.getKb({ id: 'never-existed' }));
    }
    expect(ids(await staff.listKb({ limit: 500 }))).toEqual(['zz-desk-only']);
  });

  it('the page limit counts only what the reader can see', async () => {
    const { visitor, staff, publish } = await desk();
    const a = await publish('zz-a');
    await staff.setKbAudience({ id: 'zz-a', baseRevision: a.revision!, audience: 'staff' });
    await publish('zz-b');
    await publish('zz-c');
    const everything = (await visitor.listKb({ limit: 500 })).length;
    // Two own articles are visible; a page of exactly everything the visitor can see holds both and not the hidden one.
    const page = await visitor.listKb({ limit: everything });
    expect(ids(page)).toEqual(['zz-b', 'zz-c']);
    expect(page).toHaveLength(everything);
  });

  it('feedback on a hidden article refuses like feedback on a missing one', async () => {
    const { customer, staff, publish } = await desk();
    const a = await publish('zz-desk-only');
    await staff.setKbAudience({ id: 'zz-desk-only', baseRevision: a.revision!, audience: 'staff' });
    const hidden = await customer.kbFeedback({ id: 'zz-desk-only', helpful: true, clientRequestId: 'r-1' }).catch((e: Error) => e.message);
    const missing = await customer
      .kbFeedback({ id: 'never-existed', helpful: true, clientRequestId: 'r-2' })
      .catch((e: Error) => e.message);
    expect(hidden).toBe(missing);
  });

  it('a change bumps the revision, keeps the keys, and the same audience again changes nothing', async () => {
    const { store, staff, publish } = await desk();
    const a = await publish('zz-members');
    const changed = await staff.setKbAudience({ id: 'zz-members', baseRevision: a.revision!, audience: 'signed_in' });
    expect(changed.revision).toBe(a.revision! + 1);
    expect(changed.titleKey).toBe(a.titleKey);
    const again = await staff.setKbAudience({ id: 'zz-members', baseRevision: changed.revision!, audience: 'signed_in' });
    expect(again.revision).toBe(changed.revision);
    const trail = await store.listKbAudienceChanges('zz-members');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ fromAudience: 'public', toAudience: 'signed_in', actorId: AGENT, fromRevision: 1, toRevision: 2 });
  });

  it('refuses a stale revision and an unknown article, and needs support:ops', async () => {
    const { customer, staff, publish } = await desk();
    const a = await publish('zz-members');
    await expect(staff.setKbAudience({ id: 'zz-members', baseRevision: a.revision! + 5, audience: 'staff' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(staff.setKbAudience({ id: 'nope', baseRevision: 1, audience: 'staff' })).rejects.toThrow();
    await expect(customer.setKbAudience({ id: 'zz-members', baseRevision: 1, audience: 'staff' })).rejects.toThrow();
    // An audience outside the list never reaches the service: the contract refuses it.
    await expect(staff.setKbAudience({ id: 'zz-members', baseRevision: 1, audience: 'everyone' as never })).rejects.toThrow();
  });

  it('a republish and an unpublish keep the audience', async () => {
    const { visitor, staff, publish } = await desk();
    const a = await publish('zz-members');
    const set = await staff.setKbAudience({ id: 'zz-members', baseRevision: a.revision!, audience: 'signed_in' });
    const next = await staff.publishKb({
      id: 'zz-members',
      titleKey: a.titleKey,
      bodyKey: 'support.kb.zz-members.body2',
      baseRevision: set.revision!,
    });
    expect(next.audience).toBe('signed_in');
    const hidden = await staff.unpublishKb({ id: 'zz-members', baseRevision: next.revision! });
    expect(hidden.audience).toBe('signed_in');
    expect(await visitor.getKb({ id: 'zz-members' })).toBeNull();
  });

  it('kbAudienceChanges gives the desk one row per change with the old and the new audience, and the same audience twice one row', async () => {
    const { customer, visitor, staff, publish } = await desk();
    const a = await publish('zz-members');
    const changed = await staff.setKbAudience({ id: 'zz-members', baseRevision: a.revision!, audience: 'signed_in' });
    await staff.setKbAudience({ id: 'zz-members', baseRevision: changed.revision!, audience: 'signed_in' });
    const trail = await staff.kbAudienceChanges({ id: 'zz-members' });
    expect(trail).toEqual([
      {
        articleId: 'zz-members',
        fromAudience: 'public',
        toAudience: 'signed_in',
        fromRevision: 1,
        toRevision: 2,
        actorId: AGENT,
        createdAt: expect.any(String),
      },
    ]);
    await staff.setKbAudience({ id: 'zz-members', baseRevision: changed.revision!, audience: 'staff' });
    expect((await staff.kbAudienceChanges({ id: 'zz-members' })).map((row) => [row.fromAudience, row.toAudience])).toEqual([
      ['public', 'signed_in'],
      ['signed_in', 'staff'],
    ]);
    expect(await staff.kbAudienceChanges({ id: 'never-existed' })).toEqual([]);
    await expect(customer.kbAudienceChanges({ id: 'zz-members' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(visitor.kbAudienceChanges({ id: 'zz-members' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
