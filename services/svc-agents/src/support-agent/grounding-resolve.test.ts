import { describe, expect, it } from 'vitest';
import type { SupportAccountGrounding, SupportKbArticle } from '@intafaced/contracts';
import {
  accountFromGrounding,
  accountFromState,
  kbArticleFromContract,
  resolveSupportAskFixtures,
  searchKbCatalog,
} from './grounding-resolve.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const CATALOG: readonly SupportKbArticle[] = [
  {
    id: 'kb-account-access',
    titleKey: 'support.kb.account_access.title',
    bodyKey: 'support.kb.account_access.body',
  },
  {
    id: 'kb-orders-status',
    titleKey: 'support.kb.orders_status.title',
    bodyKey: 'support.kb.orders_status.body',
  },
];

describe('kbArticleFromContract / searchKbCatalog', () => {
  it('maps contract articles to key-only fixtures', () => {
    expect(kbArticleFromContract(CATALOG[0]!)).toEqual({
      articleKey: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
    });
  });

  it('searches by fragment and never invents a miss as a hit', () => {
    expect(searchKbCatalog('account', CATALOG).map((a) => a.articleKey)).toEqual(['kb-account-access']);
    expect(searchKbCatalog('definitely-not-an-article-xyz', CATALOG)).toEqual([]);
  });

  it('empty query returns the full catalog', () => {
    expect(searchKbCatalog('', CATALOG)).toHaveLength(CATALOG.length);
  });
});

describe('accountFromGrounding', () => {
  it('projects a read grounding that matches the requester', () => {
    const grounding: SupportAccountGrounding = {
      status: 'read',
      state: { userId: USER, status: 'active', kycTier: 'basic' },
      readAt: '2026-08-12T00:00:00.000Z',
    };
    expect(accountFromGrounding(grounding, USER)).toEqual({
      status: 'ok',
      account: { userId: USER, status: 'active', kycTier: 'basic' },
    });
  });

  it('refuses unread plane_dark / not_attempted instead of inventing active', () => {
    expect(accountFromGrounding({ status: 'unread', reason: 'plane_dark' }, USER)).toEqual({
      status: 'refuse',
      reason: 'account_plane_dark',
    });
    expect(accountFromGrounding({ status: 'unread', reason: 'not_attempted' }, USER)).toEqual({
      status: 'refuse',
      reason: 'account_not_attempted',
    });
  });

  it('refuses owner mismatch and invent money keys on state', () => {
    expect(accountFromState({ userId: OTHER, status: 'active', kycTier: 'basic' }, USER)).toMatchObject({
      status: 'refuse',
      reason: 'account_owner_mismatch',
    });
    expect(accountFromState({ userId: USER, status: 'active', kycTier: 'basic', balance: '99.00' } as never, USER)).toMatchObject({
      status: 'refuse',
      reason: 'balance_field_forbidden',
    });
  });

  it('refuses sanctionsList and an unrecognized money key instead of stripping them', () => {
    expect(
      accountFromState({ userId: USER, status: 'active', kycTier: 'basic', sanctionsList: [] } as never, USER),
    ).toEqual({
      status: 'refuse',
      reason: 'balance_field_forbidden',
    });
    expect(
      accountFromState({ userId: USER, status: 'active', kycTier: 'basic', notional: '1.00' } as never, USER),
    ).toEqual({
      status: 'refuse',
      reason: 'balance_field_forbidden',
    });
  });
});

describe('resolveSupportAskFixtures', () => {
  it('resolves kbQuery against catalog when articles omitted', () => {
    const resolved = resolveSupportAskFixtures({
      ask: { tool: 'support.kb.search', kbQuery: 'orders' },
      requesterUserId: USER,
      kbCatalog: CATALOG,
    });
    expect(resolved).toMatchObject({
      status: 'ok',
      articles: [{ articleKey: 'kb-orders-status' }],
    });
  });

  it('prefers explicit articles over kbQuery', () => {
    const resolved = resolveSupportAskFixtures({
      ask: {
        tool: 'support.kb.search',
        kbQuery: 'orders',
        articles: [
          {
            articleKey: 'support.kb.explicit',
            titleKey: 'support.kb.explicit.title',
            bodyKey: 'support.kb.explicit.body',
          },
        ],
      },
      requesterUserId: USER,
      kbCatalog: CATALOG,
    });
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.articles?.[0]?.articleKey).toBe('support.kb.explicit');
  });

  it('empty catalog + kbQuery → empty articles (escalate path), not invent', () => {
    const resolved = resolveSupportAskFixtures({
      ask: { tool: 'support.kb.search', kbQuery: 'account' },
      requesterUserId: USER,
      kbCatalog: [],
    });
    expect(resolved).toEqual({ status: 'ok', articles: [], ticket: null, account: null });
  });

  it('accountGrounding unread refuses before tool invent', () => {
    const resolved = resolveSupportAskFixtures({
      ask: {
        tool: 'identity.account.read',
        accountGrounding: { status: 'unread', reason: 'plane_dark' },
      },
      requesterUserId: USER,
    });
    expect(resolved).toEqual({ status: 'refuse', reason: 'account_plane_dark' });
  });
});
