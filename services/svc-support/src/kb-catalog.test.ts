import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertKbArticle,
  getKb,
  getKbById,
  KbCatalogError,
  listPlatformKb,
  PLATFORM_KB_SPINE,
  searchKb,
  toPublicKb,
} from './kb-catalog.js';
import { SupportError, SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

describe('support Stage-2 KB catalog', () => {
  it('spine is non-empty and vendor-clean', () => {
    const list = listPlatformKb();
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.every((a) => a.titleKey.startsWith('support.kb.'))).toBe(true);
    for (const a of list) {
      expect(a).not.toHaveProperty('balance');
      expect(a).not.toHaveProperty('refundAmount');
    }
  });

  it('search finds by id fragment; unknown returns empty not invent', () => {
    expect(searchKb('account').some((a) => a.id === 'kb-account-access')).toBe(true);
    expect(searchKb('definitely-not-an-article-xyz')).toEqual([]);
    expect(searchKb('').length).toBe(PLATFORM_KB_SPINE.length);
  });

  it('empty catalog searchKb stays empty — no default article', () => {
    expect(searchKb('', [])).toEqual([]);
    expect(searchKb('account', [])).toEqual([]);
    expect(searchKb('help', [])).toEqual([]);
    expect(searchKb('kb-account-access', [])).toEqual([]);
  });

  it('getKbById null when missing', () => {
    expect(getKbById('kb-account-access')?.titleKey).toContain('account_access');
    expect(getKbById('nope')).toBeNull();
  });

  it('empty catalog getKbById is null — no default / first-spine fallback', () => {
    expect(getKbById('kb-account-access', [])).toBeNull();
    expect(getKbById('kb-default', [])).toBeNull();
    expect(getKbById('', [])).toBeNull();
    expect(getKbById('   ', PLATFORM_KB_SPINE)).toBeNull();
  });

  it('refuses vendor-named keys', () => {
    expect(() =>
      assertKbArticle({
        id: 'kb-binance-help',
        titleKey: 'support.kb.binance.title',
        bodyKey: 'support.kb.binance.body',
      }),
    ).toThrow(KbCatalogError);
  });

  it('toPublicKb carries revision and published from the store row', () => {
    expect(
      toPublicKb({
        id: 'kb-account-access',
        titleKey: 'support.kb.account_access.title',
        bodyKey: 'support.kb.account_access.body',
        revision: 3,
        published: true,
      }),
    ).toEqual({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      version: 3,
      revision: 3,
      published: true,
    });
  });

  it('refuses keys outside support.kb.*', () => {
    expect(() =>
      assertKbArticle({
        id: 'x',
        titleKey: 'other.foo',
        bodyKey: 'support.kb.ok.body',
      }),
    ).toThrow(KbCatalogError);
  });
});

describe('ops.kb-workflow Stage-1 published catalog', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const OP = '33333333-3333-4333-8333-333333333333';

  it('listKb omits unpublished revisions', async () => {
    const svc = new SupportService();
    const before = await svc.listKb({ limit: 100 });
    expect(before.some((a) => a.id === 'kb-paper-vs-live')).toBe(true);
    await svc.unpublishKb({ id: 'kb-paper-vs-live', baseRevision: 1 });
    const after = await svc.listKb({ limit: 100 });
    expect(after.some((a) => a.id === 'kb-paper-vs-live')).toBe(false);
    expect(after.every((a) => a.published === true && typeof a.revision === 'number' && a.revision >= 1)).toBe(true);
    expect(after.length).toBe(before.length - 1);
  });

  it('getKb returns null for unpublished, never invents', async () => {
    const svc = new SupportService();
    expect(await svc.getKbArticle('kb-orders-status')).not.toBeNull();
    await svc.unpublishKb({ id: 'kb-orders-status', baseRevision: 1 });
    expect(await svc.getKbArticle('kb-orders-status')).toBeNull();
    expect(await svc.getKbArticle('kb-invented-never-existed')).toBeNull();
  });

  it('searchKb/getKb refuse invent when every article is unpublished', async () => {
    const svc = new SupportService();
    for (const article of await svc.listKb({ limit: 100 })) {
      await svc.unpublishKb({ id: article.id, baseRevision: 1 });
    }
    expect(await svc.listKb({ limit: 100 })).toEqual([]);
    expect(await svc.searchKb('', { limit: 100 })).toEqual([]);
    expect(await svc.searchKb('account', { limit: 100 })).toEqual([]);
    expect(await svc.getKbArticle('kb-account-access')).toBeNull();
    expect(await svc.getKbArticle('kb-default')).toBeNull();
  });

  it('searchKb empty query returns published only', async () => {
    const svc = new SupportService();
    await svc.unpublishKb({ id: 'kb-security-basics', baseRevision: 1 });
    const empty = await svc.searchKb('', { limit: 100 });
    expect(empty.every((a) => a.published === true && typeof a.revision === 'number' && a.revision >= 1)).toBe(true);
    expect(empty.some((a) => a.id === 'kb-security-basics')).toBe(false);
    expect(empty.length).toBe((await svc.listKb({ limit: 100 })).length);
  });

  it('escalate citing unpublished id contributes no citation', async () => {
    const svc = new SupportService();
    const ticket = await svc.createTicket({
      userId: USER,
      category: 'other',
      subject: 'S',
      body: 'B',
    });
    await svc.comment({ userId: USER, ticketId: ticket.id, body: 'still stuck' });
    await svc.unpublishKb({ id: 'kb-account-access', baseRevision: 1 });
    const file = await svc.escalate({
      operatorId: OP,
      ticketId: ticket.id,
      reason: 'technical',
      summary: 'Citing a draft by mistake.',
      citedArticleIds: ['kb-account-access'],
    });
    expect(file.citations.map((c) => c.kind)).toEqual(['ticket_comment']);
  });

  it('publishKb bumps revision and refuses stale baseRevision', async () => {
    const svc = new SupportService();
    const bumped = await svc.publishKb({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      baseRevision: 1,
    });
    expect(bumped).toEqual({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      version: 2,
      revision: 2,
      published: true,
    });
    await expect(
      svc.publishKb({
        id: 'kb-account-access',
        titleKey: 'support.kb.account_access.title',
        bodyKey: 'support.kb.account_access.body',
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'support.kb.revision_stale' });
    const still = await svc.getKbArticle('kb-account-access');
    expect(still).toEqual(bumped);
    expect(still).toMatchObject({ revision: 2, published: true });
  });

  it('unpublishKb hides the article on public listKb', async () => {
    const svc = new SupportService();
    await svc.unpublishKb({ id: 'kb-deposit-withdraw-honest', baseRevision: 1 });
    expect((await svc.listKb({ limit: 100 })).some((a) => a.id === 'kb-deposit-withdraw-honest')).toBe(false);
    expect(await svc.getKbArticle('kb-deposit-withdraw-honest')).toBeNull();
  });

  it('assertKbArticle still refuses vendor keys after persist', async () => {
    const svc = new SupportService();
    await expect(
      svc.publishKb({
        id: 'kb-binance-help',
        titleKey: 'support.kb.binance.title',
        bodyKey: 'support.kb.binance.body',
        baseRevision: 0,
      }),
    ).rejects.toBeInstanceOf(SupportError);
    await expect(
      svc.publishKb({
        id: 'kb-binance-help',
        titleKey: 'support.kb.binance.title',
        bodyKey: 'support.kb.binance.body',
        baseRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'support.kb_vendor_name' });
    expect(await svc.getKbArticle('kb-binance-help')).toBeNull();
    expect((await svc.listKb({ limit: 100 })).some((a) => a.id.includes('binance'))).toBe(false);
  });

  it('kb_articles table has no amount/balance/currency column', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '..', 'drizzle', '0003_kb_articles.sql'), 'utf8');
    const create = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf(';', sql.indexOf('CREATE TABLE')) + 1);
    expect(create.toLowerCase()).not.toMatch(/\bamount\b/);
    expect(create.toLowerCase()).not.toMatch(/\bbalance\b/);
    expect(create.toLowerCase()).not.toMatch(/\bcurrency\b/);
    expect(create).toMatch(/title_key/);
    expect(create).toMatch(/revision/);
    expect(create).toMatch(/published/);
  });
});

describe('ops.kb-workflow article versions', () => {
  const v1 = {
    id: 'kb-account-access',
    titleKey: 'support.kb.account_access.title',
    bodyKey: 'support.kb.account_access.body',
    version: 1,
    revision: 1,
    published: true,
  };
  const v2 = {
    ...v1,
    bodyKey: 'support.kb.account_access.body_v2',
    version: 2,
    revision: 2,
  };

  it('spine articles carry version ≥ 1 and immutable id', () => {
    for (const a of listPlatformKb()) {
      expect(a.id.length).toBeGreaterThan(0);
      expect(a.version).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(a.version)).toBe(true);
    }
  });

  it('omitted version returns latest published; explicit version returns that body', () => {
    const catalog = [v1, v2];
    expect(getKb({ id: 'kb-account-access' }, catalog)?.bodyKey).toBe('support.kb.account_access.body_v2');
    expect(getKb({ id: 'kb-account-access', version: 1 }, catalog)?.bodyKey).toBe('support.kb.account_access.body');
    expect(getKb({ id: 'kb-account-access', version: 2 }, catalog)?.version).toBe(2);
  });

  it('unknown version is a named refuse, not a silent older body', () => {
    const catalog = [v1, v2];
    expect(() => getKb({ id: 'kb-account-access', version: 9 }, catalog)).toThrow(KbCatalogError);
    try {
      getKb({ id: 'kb-account-access', version: 9 }, catalog);
    } catch (err) {
      expect(err).toMatchObject({ code: 'support.kb_version_unknown' });
    }
  });

  it('searchKb returns latest only — no duplicate ids after a bump', () => {
    const catalog = [...PLATFORM_KB_SPINE, v2];
    const found = searchKb('account', catalog);
    const ids = found.map((a) => a.id);
    expect(ids.filter((id) => id === 'kb-account-access')).toHaveLength(1);
    expect(found.find((a) => a.id === 'kb-account-access')?.version).toBe(2);
  });

  it('publishKb bumps version and prior version stays readable', async () => {
    const svc = new SupportService();
    const bumped = await svc.publishKb({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body_v2',
      baseRevision: 1,
    });
    expect(bumped).toMatchObject({ id: 'kb-account-access', version: 2, revision: 2, published: true });
    const latest = await svc.getKbArticle({ id: 'kb-account-access' });
    expect(latest?.version).toBe(2);
    expect(latest?.bodyKey).toBe('support.kb.account_access.body_v2');
    const prior = await svc.getKbArticle({ id: 'kb-account-access', version: 1 });
    expect(prior).toMatchObject({ version: 1, bodyKey: 'support.kb.account_access.body' });
    await expect(svc.getKbArticle({ id: 'kb-account-access', version: 9 })).rejects.toMatchObject({
      code: 'support.kb_version_unknown',
    });
    const hits = await svc.searchKb('account', { limit: 100 });
    expect(hits.filter((a) => a.id === 'kb-account-access')).toHaveLength(1);
    expect(hits.find((a) => a.id === 'kb-account-access')?.version).toBe(2);
  });
});

describe('I-signin-sessions-26 scam guides', () => {
  const GUIDES = ['kb-security-scam-tactics', 'kb-security-spoofed-sms', 'kb-security-dusting', 'kb-security-email-compromise'];

  it('serves the four guides under Security, published, from the public door', () => {
    const served = listPlatformKb();
    for (const id of GUIDES) {
      const hit = served.find((a) => a.id === id);
      expect(hit, id).toBeDefined();
      expect(hit).toMatchObject({ published: true, category: 'security', version: 1 });
    }
    expect(served.some((a) => a.id === 'kb-security-basics')).toBe(true);
  });

  it('finds the guides by topic word, and an unknown word stays empty', () => {
    expect(searchKb('spoofed').map((a) => a.id)).toEqual(['kb-security-spoofed-sms']);
    expect(searchKb('dusting').map((a) => a.id)).toEqual(['kb-security-dusting']);
    expect(searchKb('zzz-no-such-guide')).toEqual([]);
  });

  it('every guide key resolves to catalogue copy, with no partner name and no safety promise', () => {
    for (const id of GUIDES) {
      const article = getKbById(id);
      expect(article, id).not.toBeNull();
      for (const key of [article!.titleKey, article!.bodyKey]) {
        const copy = userCopy(key);
        expect(copy, key).not.toBe(key);
        expect(copy).not.toMatch(/\b(binance|coinbase|kraken|okx|bybit|deriv|metatrader|tradingview)\b/i);
        expect(copy).not.toMatch(/\b(guaranteed|safe|safely|risk-free)\b/i);
      }
    }
  });
});

describe('I-signin-sessions-26 migration matches the spine', () => {
  it('0013 seeds exactly the scam guides the spine serves, with the same keys', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '..', 'drizzle', '0013_kb_scam_guides.sql'), 'utf8');
    const rows = [
      ...sql.matchAll(/\('(kb-security-[a-z-]+)', 'support\.kb\.([a-z_]+)\.title', 'support\.kb\.([a-z_]+)\.body', 1, true\)/g),
    ];
    const guides = PLATFORM_KB_SPINE.filter((a) => a.tags?.includes('scams'));
    expect(rows.map((m) => m[1])).toEqual(guides.map((a) => a.id));
    for (const [, id, titleKey, bodyKey] of rows) {
      const hit = guides.find((a) => a.id === id)!;
      expect(hit.titleKey).toBe(`support.kb.${titleKey}.title`);
      expect(hit.bodyKey).toBe(`support.kb.${bodyKey}.body`);
    }
  });
});
