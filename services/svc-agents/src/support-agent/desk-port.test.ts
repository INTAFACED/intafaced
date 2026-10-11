import { describe, expect, it, vi } from 'vitest';
import { createFixtureSupportDesk, createHttpSupportDeskPort } from './desk-port.js';

const ARTICLE = {
  id: 'kb-account-access',
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'support.kb.account_access.body',
};

describe('createFixtureSupportDesk', () => {
  it('searches fixture rows and invents none', async () => {
    const desk = createFixtureSupportDesk({
      articles: [{ articleKey: ARTICLE.id, titleKey: ARTICLE.titleKey, bodyKey: ARTICLE.bodyKey }],
    });
    expect(await desk.searchKb('account', 20)).toEqual({
      status: 'ok',
      articles: [{ articleKey: ARTICLE.id, titleKey: ARTICLE.titleKey, bodyKey: ARTICLE.bodyKey }],
    });
    expect(await desk.searchKb('definitely-not-an-article-xyz', 20)).toEqual({ status: 'ok', articles: [] });
  });

  it('searchKb omit limit refuses named — never invents 100', async () => {
    const desk = createFixtureSupportDesk({
      articles: [{ articleKey: ARTICLE.id, titleKey: ARTICLE.titleKey, bodyKey: ARTICLE.bodyKey }],
    });
    expect(await desk.searchKb('account')).toEqual({
      status: 'refuse',
      reason: 'kb_search_limit_unset',
      userMessageKey: 'agents.refused.kb_search_limit_unset',
    });
  });
});

describe('createHttpSupportDeskPort', () => {
  it('searchKb unwraps tRPC articles from the support URL', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      expect(href).toContain('/trpc/searchKb');
      const input = JSON.parse(decodeURIComponent(new URL(href).searchParams.get('input') ?? 'null')) as unknown;
      expect(input).toEqual({ q: 'account', limit: 20 });
      return new Response(JSON.stringify({ result: { data: [ARTICLE] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl,
    });
    expect(await desk.searchKb('account', 20)).toEqual({
      status: 'ok',
      articles: [{ articleKey: ARTICLE.id, titleKey: ARTICLE.titleKey, bodyKey: ARTICLE.bodyKey }],
    });
  });

  it('searchKb omit limit refuses named and does not fetch — never a 400-as-unreachable', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl,
    });
    expect(await desk.searchKb('account')).toEqual({
      status: 'refuse',
      reason: 'kb_search_limit_unset',
      userMessageKey: 'agents.refused.kb_search_limit_unset',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('searchKb transport failure is unreachable, not invented hits', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl,
    });
    expect(await desk.searchKb('account', 20)).toEqual({ status: 'unreachable' });
  });

  it('readAccount without IDENTITY_URL is unread — never "account is fine"', async () => {
    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(await desk.readAccount('11111111-1111-4111-8111-111111111111')).toEqual({ status: 'unread' });
  });

  it('readAccount maps identity projection with no money fields', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/internal/account/${userId}`);
      return new Response(JSON.stringify({ userId, status: 'frozen', kycTier: 'basic' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      identityUrl: 'http://identity.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl,
    });
    expect(await desk.readAccount(userId)).toEqual({
      status: 'ok',
      account: { userId, status: 'frozen', kycTier: 'basic' },
    });
  });

  it('readTicket returns missing when the parsed ticket id is not the requested ticketId', async () => {
    const requestedTicketId = '11111111-1111-4111-8111-111111111111';
    const otherTicketId = '22222222-2222-4222-8222-222222222222';
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          result: {
            data: {
              id: otherTicketId,
              userId: '33333333-3333-4333-8333-333333333333',
              category: 'account',
              subject: 'Cannot sign in',
              body: 'Locked out after reset.',
              status: 'open',
              assigneeId: null,
              createdAt: '2026-10-09T00:00:00.000Z',
              updatedAt: '2026-10-09T00:00:00.000Z',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl,
    });
    expect(await desk.readTicket(requestedTicketId)).toEqual({ status: 'missing' });
  });

  it('readTicket returns the ticket when the parsed id is the requested ticketId', async () => {
    const ticketId = '11111111-1111-4111-8111-111111111111';
    const userId = '33333333-3333-4333-8333-333333333333';
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          result: {
            data: {
              id: ticketId,
              userId,
              category: 'account',
              subject: 'Cannot sign in',
              body: 'Locked out after reset.',
              status: 'open',
              assigneeId: null,
              createdAt: '2026-10-09T00:00:00.000Z',
              updatedAt: '2026-10-09T00:00:00.000Z',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const desk = createHttpSupportDeskPort({
      supportUrl: 'http://support.test',
      internalSecret: 'a'.repeat(32),
      fetchImpl,
    });
    expect(await desk.readTicket(ticketId)).toEqual({
      status: 'ok',
      ticket: { ticketId, ownerUserId: userId, status: 'open', category: 'account' },
    });
  });
});
