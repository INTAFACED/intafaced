import { describe, expect, it } from 'vitest';
import {
  getKbArticleInputSchema,
  publicKbArticleOrNull,
  kbAudienceVisibleTo,
  setKbAudienceInputSchema,
  setKbSegmentInputSchema,
  kbAudienceChangesInputSchema,
  supportKbAudienceChangeSchema,
  supportKbAudienceSchema,
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
import { supportHelpCentreChangesInputSchema, supportHelpCentreSchema, supportHelpCentreSetInputSchema } from './support-help-centre.js';

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
  it('a request can be on hold, and an unknown status still fails', () => {
    expect(supportTicketStatusSchema.safeParse('on_hold').success).toBe(true);
    expect(supportTicketStatusSchema.safeParse('paused').success).toBe(false);
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

describe('help article audiences (SP-help-centre-02)', () => {
  const visitor = { signedIn: false, staff: false };
  const customer = { signedIn: true, staff: false };
  const desk = { signedIn: true, staff: true };

  it('shows each audience to exactly the readers it names', () => {
    expect(kbAudienceVisibleTo('public', visitor)).toBe(true);
    expect(kbAudienceVisibleTo(undefined, visitor)).toBe(true);
    expect(kbAudienceVisibleTo('signed_in', visitor)).toBe(false);
    expect(kbAudienceVisibleTo('signed_in', customer)).toBe(true);
    expect(kbAudienceVisibleTo('staff', visitor)).toBe(false);
    expect(kbAudienceVisibleTo('staff', customer)).toBe(false);
    expect(kbAudienceVisibleTo('staff', desk)).toBe(true);
  });

  it('closes the audience list and parses an article without one as before', () => {
    expect(supportKbAudienceSchema.safeParse('everyone').success).toBe(false);
    expect(supportKbArticleSchema.safeParse({ id: 'a', titleKey: 't', bodyKey: 'b' }).success).toBe(true);
    expect(supportKbArticleSchema.safeParse({ id: 'a', titleKey: 't', bodyKey: 'b', audience: 'staff' }).success).toBe(true);
  });

  it('setKbAudience needs a positive base revision and a known audience', () => {
    expect(setKbAudienceInputSchema.safeParse({ id: 'a', baseRevision: 1, audience: 'signed_in' }).success).toBe(true);
    expect(setKbAudienceInputSchema.safeParse({ id: 'a', baseRevision: 0, audience: 'signed_in' }).success).toBe(false);
    expect(setKbAudienceInputSchema.safeParse({ id: 'a', baseRevision: 1, audience: 'all' }).success).toBe(false);
  });
});

describe('help article audience trail and segments (SP-help-centre-02)', () => {
  it('an audience change row names the old and the new audience', () => {
    const row = {
      articleId: 'a',
      fromAudience: 'public',
      toAudience: 'signed_in',
      fromRevision: 1,
      toRevision: 2,
      actorId: 'op',
      createdAt: '2026-10-31T12:00:00.000Z',
    };
    expect(supportKbAudienceChangeSchema.safeParse(row).success).toBe(true);
    expect(supportKbAudienceChangeSchema.safeParse({ ...row, toAudience: 'everyone' }).success).toBe(false);
    expect(kbAudienceChangesInputSchema.safeParse({ id: 'a' }).success).toBe(true);
    expect(kbAudienceChangesInputSchema.safeParse({}).success).toBe(false);
  });

  it('a segment needs an article and a name', () => {
    expect(setKbSegmentInputSchema.safeParse({ id: 'a', segment: 'TEST vip' }).success).toBe(true);
    expect(setKbSegmentInputSchema.safeParse({ id: 'a', segment: '  ' }).success).toBe(false);
  });
});

describe('help centre theme and change log (SP-help-centre-03)', () => {
  const blank = {
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

  it('the theme is blank or one of system, light and dark', () => {
    expect(supportHelpCentreSchema.safeParse(blank).success).toBe(true);
    expect(supportHelpCentreSchema.safeParse({ ...blank, theme: 'dark' }).success).toBe(true);
    expect(supportHelpCentreSchema.safeParse({ ...blank, theme: 'neon' }).success).toBe(false);
    const { theme: _theme, ...withoutTheme } = blank;
    expect(supportHelpCentreSchema.safeParse(withoutTheme).success).toBe(false);
  });

  it('a theme alone is a change, and null clears it', () => {
    expect(supportHelpCentreSetInputSchema.safeParse({ theme: 'light', expectedRevision: 0, reason: 'r' }).success).toBe(true);
    expect(supportHelpCentreSetInputSchema.safeParse({ theme: null, expectedRevision: 0, reason: 'r' }).success).toBe(true);
    expect(supportHelpCentreSetInputSchema.safeParse({ theme: 'neon', expectedRevision: 0, reason: 'r' }).success).toBe(false);
  });

  it('the change log page size may be left out so the service names the refusal', () => {
    expect(supportHelpCentreChangesInputSchema.safeParse({}).success).toBe(true);
    expect(supportHelpCentreChangesInputSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});
