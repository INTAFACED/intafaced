import { describe, expect, it } from 'vitest';
import {
  getKbArticleInputSchema,
  publicKbArticleOrNull,
  publishedKbArticles,
  createTicketInputSchema,
  searchKbInputSchema,
  SUPPORT_LABELS_MAX,
  SUPPORT_MESSAGE_HEADERS_MAX,
  setTicketPropertiesInputSchema,
  supportLabelSchema,
  supportTicketPropertiesSchema,
  supportTicketPrioritySchema,
  supportTicketLifecycleSchema,
  supportTicketStatusSchema,
  supportWaitingOnSchema,
  supportTicketTypeSchema,
  supportTicketCategorySchema,
  supportTicketSchema,
  supportKbArticleSchema,
  type SupportContract,
  type SupportKbArticle,
} from './support.js';

const LIVE: SupportKbArticle = {
  id: 'kb-account-access',
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'support.kb.account_access.body',
  revision: 1,
  published: true,
};

const DRAFT: SupportKbArticle = {
  id: 'kb-draft-only',
  titleKey: 'support.kb.draft_only.title',
  bodyKey: 'support.kb.draft_only.body',
  revision: 2,
  published: false,
};

const SPINE: SupportKbArticle = {
  id: 'kb-security-basics',
  titleKey: 'support.kb.security_basics.title',
  bodyKey: 'support.kb.security_basics.body',
};

function publicKbDoors(catalog: readonly SupportKbArticle[]): Pick<SupportContract, 'listKb' | 'searchKb' | 'getKbArticle'> {
  return {
    async listKb() {
      return publishedKbArticles(catalog);
    },
    async searchKb(query: string) {
      const rows = publishedKbArticles(catalog);
      const q = query.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter(
        (a) => a.id.toLowerCase().includes(q) || a.titleKey.toLowerCase().includes(q) || a.bodyKey.toLowerCase().includes(q),
      );
    },
    async getKbArticle(id: string) {
      return publicKbArticleOrNull(catalog.find((a) => a.id === id) ?? null);
    },
  };
}

describe('supportKbArticleSchema — revision and published', () => {
  it('parses spine rows without revision or published', () => {
    expect(supportKbArticleSchema.parse(SPINE)).toEqual(SPINE);
  });

  it('accepts optional positive revision and boolean published', () => {
    expect(supportKbArticleSchema.parse(LIVE)).toEqual(LIVE);
    expect(supportKbArticleSchema.parse(DRAFT).published).toBe(false);
  });

  it('refuses non-positive revision', () => {
    expect(supportKbArticleSchema.safeParse({ ...SPINE, revision: 0 }).success).toBe(false);
    expect(supportKbArticleSchema.safeParse({ ...SPINE, revision: -1 }).success).toBe(false);
    expect(supportKbArticleSchema.safeParse({ ...SPINE, revision: 1.5 }).success).toBe(false);
  });

  it('accepts optional positive version', () => {
    expect(supportKbArticleSchema.parse({ ...SPINE, version: 1 })).toEqual({ ...SPINE, version: 1 });
    expect(supportKbArticleSchema.safeParse({ ...SPINE, version: 0 }).success).toBe(false);
  });

  it('refuses non-boolean published', () => {
    expect(supportKbArticleSchema.safeParse({ ...SPINE, published: 'yes' }).success).toBe(false);
  });
});

describe('SupportContract searchKb / getKbArticle — public doors', () => {
  const desk = publicKbDoors([LIVE, DRAFT, SPINE]);

  it('searchKb omits unpublished; empty query is the published list', async () => {
    const all = await desk.searchKb('');
    expect(all.map((a) => a.id)).toEqual(['kb-account-access', 'kb-security-basics']);
    const hits = await desk.searchKb('account');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('kb-account-access');
    expect(await desk.searchKb('draft')).toEqual([]);
  });

  it('getKbArticle returns null for unknown and unpublished — it does not throw', async () => {
    await expect(desk.getKbArticle('kb-account-access')).resolves.toEqual(LIVE);
    await expect(desk.getKbArticle('kb-draft-only')).resolves.toBeNull();
    await expect(desk.getKbArticle('kb-does-not-exist')).resolves.toBeNull();
  });

  it('listKb matches search with empty query', async () => {
    expect(await desk.listKb()).toEqual(await desk.searchKb(''));
  });

  it('router inputs match search/get doors', () => {
    expect(searchKbInputSchema.parse(undefined)).toBeUndefined();
    expect(searchKbInputSchema.parse({ q: 'account' })).toEqual({ q: 'account' });
    expect(searchKbInputSchema.parse({})).toEqual({});
    expect(searchKbInputSchema.parse({ q: 'account', limit: 100 })).toEqual({ q: 'account', limit: 100 });
    expect(searchKbInputSchema.parse({ limit: 50 })).toEqual({ limit: 50 });
    expect(searchKbInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(searchKbInputSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(getKbArticleInputSchema.parse({ id: 'kb-account-access' }).id).toBe('kb-account-access');
    expect(getKbArticleInputSchema.parse({ id: 'kb-account-access', version: 2 })).toEqual({
      id: 'kb-account-access',
      version: 2,
    });
    expect(getKbArticleInputSchema.safeParse({ id: '' }).success).toBe(false);
    expect(getKbArticleInputSchema.safeParse({ id: 'kb-account-access', version: 0 }).success).toBe(false);
  });
});

describe('phishing report contract (I-signin-sessions-27)', () => {
  it('accepts phishing as a category and still accepts the four older ones', () => {
    for (const category of ['account', 'trading', 'deposit_withdraw', 'other', 'phishing']) {
      expect(supportTicketCategorySchema.safeParse(category).success, category).toBe(true);
    }
    expect(supportTicketCategorySchema.safeParse('scam').success).toBe(false);
  });

  it('create takes pasted headers and a client key, and older bodies still parse', () => {
    const base = { category: 'phishing', subject: 'Fake sign-in email', body: 'Forwarded below' } as const;
    expect(createTicketInputSchema.safeParse(base).success).toBe(true);
    expect(createTicketInputSchema.safeParse({ ...base, messageHeaders: 'Received: from mx', clientRequestId: 'k1' }).success).toBe(true);
  });

  it('refuses headers over the cap and an empty client key', () => {
    const base = { category: 'phishing', subject: 's', body: 'b' } as const;
    expect(createTicketInputSchema.safeParse({ ...base, messageHeaders: 'x'.repeat(SUPPORT_MESSAGE_HEADERS_MAX + 1) }).success).toBe(false);
    expect(createTicketInputSchema.safeParse({ ...base, messageHeaders: 'x'.repeat(SUPPORT_MESSAGE_HEADERS_MAX) }).success).toBe(true);
    expect(createTicketInputSchema.safeParse({ ...base, clientRequestId: '' }).success).toBe(false);
  });

  it('a stored ticket may carry headers or none', () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      category: 'phishing',
      subject: 's',
      body: 'b',
      status: 'open',
      assigneeId: null,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
    expect(supportTicketSchema.safeParse(row).success).toBe(true);
    expect(supportTicketSchema.safeParse({ ...row, messageHeaders: null }).success).toBe(true);
    expect(supportTicketSchema.safeParse({ ...row, messageHeaders: 'Received: from mx' }).success).toBe(true);
  });
});

describe('ticket properties contract (SP-tickets-04)', () => {
  const ticketId = '11111111-1111-4111-8111-111111111111';

  it('priority and type are closed sets', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) expect(supportTicketPrioritySchema.safeParse(p).success, p).toBe(true);
    expect(supportTicketPrioritySchema.safeParse('critical').success).toBe(false);
    for (const t of ['question', 'problem', 'incident']) expect(supportTicketTypeSchema.safeParse(t).success, t).toBe(true);
    expect(supportTicketTypeSchema.safeParse('task').success).toBe(false);
  });

  it('a label is letters, digits, hyphen and underscore; a space or empty is refused', () => {
    for (const l of ['vip', 'chargeback-2026', 'needs_kyc', 'A1']) expect(supportLabelSchema.safeParse(l).success, l).toBe(true);
    for (const l of ['two words', '', 'tag!', 'x'.repeat(65)]) expect(supportLabelSchema.safeParse(l).success, l).toBe(false);
  });

  it('set takes any one field, clears with null, and refuses an empty change', () => {
    const base = { ticketId, clientRequestId: 'k-1' };
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, priority: 'high' }).success).toBe(true);
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, priority: null }).success).toBe(true);
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, labels: [] }).success).toBe(true);
    expect(setTicketPropertiesInputSchema.safeParse(base).success).toBe(false);
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, priority: 'high', clientRequestId: '' }).success).toBe(false);
  });

  it('refuses more labels than the bound and a bad label inside the list', () => {
    const base = { ticketId, clientRequestId: 'k-1' };
    const ok = Array.from({ length: SUPPORT_LABELS_MAX }, (_, i) => `l${i}`);
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, labels: ok }).success).toBe(true);
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, labels: [...ok, 'extra'] }).success).toBe(false);
    expect(setTicketPropertiesInputSchema.safeParse({ ...base, labels: ['fine', 'not fine'] }).success).toBe(false);
  });

  it('stored properties are null until set, and the owner-read ticket schema carries none of them', () => {
    expect(
      supportTicketPropertiesSchema.safeParse({ ticketId, priority: null, ticketType: null, labels: [], updatedAt: null }).success,
    ).toBe(true);
    const shape = Object.keys((supportTicketSchema as unknown as { shape: Record<string, unknown> }).shape);
    for (const key of ['priority', 'ticketType', 'labels']) expect(shape).not.toContain(key);
  });
});

describe('ticket lifecycle (SP-tickets-04)', () => {
  const ticketId = '11111111-1111-4111-8111-111111111111';
  it('on_hold is a status beside open, pending, resolved and closed', () => {
    for (const s of ['open', 'pending', 'on_hold', 'resolved', 'closed'])
      expect(supportTicketStatusSchema.safeParse(s).success, s).toBe(true);
    for (const s of ['on-hold', 'new', 'solved', '']) expect(supportTicketStatusSchema.safeParse(s).success, s).toBe(false);
  });
  it('waiting on is the team or the customer, and null until set', () => {
    expect(supportWaitingOnSchema.safeParse('team').success).toBe(true);
    expect(supportWaitingOnSchema.safeParse('customer').success).toBe(true);
    expect(supportWaitingOnSchema.safeParse('nobody').success).toBe(false);
    const empty = { ticketId, waitingOn: null, waitingSince: null, firstPublicReplyAt: null, followsTicketId: null };
    expect(supportTicketLifecycleSchema.safeParse(empty).success).toBe(true);
    expect(supportTicketLifecycleSchema.safeParse({ ...empty, waitingOn: 'team', waitingSince: '2026-10-20T01:00:00.000Z' }).success).toBe(
      true,
    );
    expect(supportTicketLifecycleSchema.safeParse({ ...empty, waitingSince: 'yesterday' }).success).toBe(false);
  });
  it('a follow-up names the closed request it follows by id', () => {
    const base = { category: 'other', subject: 's', body: 'b' };
    expect(createTicketInputSchema.safeParse({ ...base, followsTicketId: ticketId }).success).toBe(true);
    expect(createTicketInputSchema.safeParse({ ...base, followsTicketId: 'x' }).success).toBe(false);
    expect(createTicketInputSchema.safeParse(base).success).toBe(true);
  });
  it('the owner-read ticket schema carries no desk lifecycle fact', () => {
    const shape = Object.keys((supportTicketSchema as unknown as { shape: Record<string, unknown> }).shape);
    for (const key of ['waitingOn', 'waitingSince', 'firstPublicReplyAt']) expect(shape).not.toContain(key);
  });
});
