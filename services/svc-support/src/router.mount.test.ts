import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { IDENTITY_GROUNDING_UNPROBED, IDENTITY_GROUNDING_UNWIRED } from './identity-grounding-honesty.js';
import { QUEUE_TIMING_KIND } from './sla-honesty.js';
import {
  SupportError,
  assertListAllTicketsLimit,
  assertListCommentsLimit,
  assertListEventsLimit,
  assertListKbLimit,
  assertListMineTicketsLimit,
  assertOperatorQueueLimit,
  SupportService,
} from './support-service.js';
import { userCopy } from './user-copy.js';

const SECRET = 'a-support-mount-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['support:read', 'support:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function stubSupport(overrides: Partial<SupportService> = {}): SupportService {
  return {
    createTicket: vi.fn(async () => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: USER,
      category: 'other' as const,
      subject: 'S',
      body: 'B',
      status: 'open' as const,
      assigneeId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    listMyTickets: vi.fn(async () => []),
    listAllTickets: vi.fn(async () => []),
    getTicket: vi.fn(),
    comment: vi.fn(),
    listComments: vi.fn(async () => []),
    setStatus: vi.fn(),
    listKb: vi.fn(async () => [
      {
        id: 'kb-account-access',
        titleKey: 'support.kb.account_access.title',
        bodyKey: 'support.kb.account_access.body',
        revision: 1,
        published: true,
      },
    ]),
    searchKb: vi.fn(async () => [
      {
        id: 'kb-account-access',
        titleKey: 'support.kb.account_access.title',
        bodyKey: 'support.kb.account_access.body',
        revision: 1,
        published: true,
      },
    ]),
    getKbArticle: vi.fn(async (q: string | { id: string }) => {
      const id = typeof q === 'string' ? q : q.id;
      return id === 'kb-account-access'
        ? {
            id: 'kb-account-access',
            titleKey: 'support.kb.account_access.title',
            bodyKey: 'support.kb.account_access.body',
            version: 1,
            revision: 1,
            published: true,
          }
        : null;
    }),
    listOperatorQueue: vi.fn(async () => ({ status: 'empty' as const })),
    peekNext: vi.fn(async () => null),
    claimForOperator: vi.fn(),
    listTicketEvents: vi.fn(async () => []),
    readAccountState: vi.fn(async () => ({ status: 'unread' as const, reason: 'plane_dark' as const })),
    escalate: vi.fn(),
    getCaseFile: vi.fn(async () => null),
    publishKb: vi.fn(async () => ({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      revision: 2,
      published: true,
    })),
    unpublishKb: vi.fn(async () => ({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      revision: 1,
      published: false,
    })),
    ...overrides,
  } as unknown as SupportService;
}

const CITATION = {
  kind: 'kb_article' as const,
  ref: 'kb-account-access',
  digest: 'a'.repeat(64),
  readAt: '2026-08-09T10:00:00.000Z',
};

afterEach(() => vi.unstubAllEnvs());

describe('svc-support mount', () => {
  it('opens and reads a real ticket without a money or balance door', async () => {
    const support = new SupportService();
    const router = createSupportRouter(support);
    const caller = router.createCaller(signed());
    const opened = await caller.create({
      category: 'account',
      subject: 'Card charge posted twice',
      body: 'Please investigate the repeated charge.',
    });
    const ticket = await caller.get({ ticketId: opened.id });
    expect(ticket).toMatchObject({
      id: opened.id,
      userId: USER,
      status: 'open',
      category: 'account',
      subject: 'Card charge posted twice',
      assigneeId: null,
    });
    for (const field of ['balance', 'amount', 'currency']) expect(ticket).not.toHaveProperty(field);
    expect(Object.keys(router._def.procedures)).not.toContain('balance');
    expect(await caller.getKb({ id: 'unpublished-fixture-article' })).toBeNull();
    expect(await caller.events({ ticketId: opened.id, limit: 100 })).toMatchObject([{ kind: 'opened', actorId: USER, actorRole: 'user' }]);
  });

  it('refuses operator rating and attachment reads without support:ops', async () => {
    const caller = createSupportRouter(stubSupport()).createCaller(signed());
    const ticketId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(caller.ratingOps({ ticketId })).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'scope.denied' } });
    await expect(caller.attachmentOps({ attachmentId: ticketId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'scope.denied' },
    });
  });

  it('refuses signed unauthorized ops and settlement before effects with strict policy flags', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST', '');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', '');
    const setStatus = vi.fn();
    const attemptSettlement = vi.fn();
    const caller = createSupportRouter(stubSupport({ setStatus, attemptSettlement })).createCaller(signed());
    await expect(caller.setStatus({ ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'resolved' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'scope.denied' },
    });
    await expect(caller.settle({ act: 'move_money' })).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'scope.denied' } });
    expect(setStatus).not.toHaveBeenCalled();
    expect(attemptSettlement).not.toHaveBeenCalled();
  });
  it('refuses anonymous create', async () => {
    let created = false;
    const support = stubSupport({
      createTicket: async () => {
        created = true;
        throw new Error('should not run');
      },
    });
    await expect(
      createSupportRouter(support).createCaller(anonymous()).create({
        category: 'other',
        subject: 'S',
        body: 'B',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(created).toBe(false);
  });

  it('allows signed create with support:write', async () => {
    const support = stubSupport();
    const ticket = await createSupportRouter(support).createCaller(signed()).create({
      category: 'account',
      subject: 'Help',
      body: 'Please',
    });
    expect(ticket.subject).toBe('S');
    expect(support.createTicket).toHaveBeenCalled();
  });

  it('deskPolicy is public and reports split, queue honesty, and identity grounding', async () => {
    const support = stubSupport();
    const wired = await createSupportRouter(support, undefined, 'an-internal-service-secret-long-enough')
      .createCaller(anonymous())
      .deskPolicy();
    expect(wired.split.deskMountain).toBe('ops.support');
    expect(wired.split.agentAssist).toBe('agents.support');
    expect(wired.queue.timingKind).toBe(QUEUE_TIMING_KIND);
    expect(wired.queue.sla).toBe(false);
    expect(wired.identityGrounding).toEqual({ status: 'configured', code: IDENTITY_GROUNDING_UNPROBED });
    expect(wired.settlement.canSettle).toBe(false);
    expect(wired.settlement.canCiteArticles).toBe(true);
    expect(wired.settlement.forbiddenActs).toEqual(['complete_withdrawal', 'unfreeze_account', 'move_money']);

    const unwired = await createSupportRouter(support).createCaller(anonymous()).deskPolicy();
    expect(unwired.identityGrounding).toEqual({ status: 'absent', code: IDENTITY_GROUNDING_UNWIRED });
  });

  it('kbPolicy is public and reports spine catalog honesty without SLA fields', async () => {
    const support = stubSupport();
    const policy = await createSupportRouter(support).createCaller(anonymous()).kbPolicy();
    expect(policy.spineArticleCount).toBeGreaterThan(0);
    expect(policy.keysUnderSupportKb).toBe(true);
    expect(policy.slaTimingsForbidden).toBe(true);
    expect(policy.inventsRefundAmounts).toBe(false);
    expect(policy.refuseCodes).toContain('support.kb_vendor_name');
    expect(JSON.stringify(policy)).not.toMatch(/slaMinutes|dueAt|eta/i);
  });

  it('listKb is public and returns Stage-2 spine from service', async () => {
    const support = stubSupport();
    const kb = await createSupportRouter(support).createCaller(anonymous()).listKb({ limit: 100 });
    expect(kb).toHaveLength(1);
    expect(kb[0]!.titleKey).toMatch(/^support\.kb\./);
    expect(kb[0]).toMatchObject({ revision: 1, published: true });
    expect(support.listKb).toHaveBeenCalledWith({ limit: 100, viewer: { signedIn: false, staff: false } });
  });

  it('listKb omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      listKb: async (options?: { limit?: number }) => {
        assertListKbLimit(options?.limit);
        return [];
      },
    });
    const caller = createSupportRouter(support).createCaller(anonymous());
    await expect(caller.listKb({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_kb_limit_unset',
    });
    await expect(caller.listKb()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_kb_limit_unset',
    });
    await expect(caller.listKb({ limit: 100 })).resolves.toEqual([]);
  });

  it('refuses publishKb / unpublishKb without support:ops', async () => {
    const support = stubSupport();
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(
      caller.publishKb({
        id: 'kb-account-access',
        titleKey: 'support.kb.account_access.title',
        bodyKey: 'support.kb.account_access.body',
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.unpublishKb({ id: 'kb-account-access', baseRevision: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(support.publishKb).not.toHaveBeenCalled();
    expect(support.unpublishKb).not.toHaveBeenCalled();
  });

  it('publishKb requires support:ops and reaches the service', async () => {
    const support = stubSupport();
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    const published = await createSupportRouter(support).createCaller(signed(op)).publishKb({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      baseRevision: 1,
    });
    expect(published.revision).toBe(2);
    expect(support.publishKb).toHaveBeenCalledWith({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      baseRevision: 1,
    });
  });

  it('searchKb omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      searchKb: async (query: string, options?: { limit?: number }) => {
        assertListKbLimit(options?.limit);
        return [];
      },
    });
    const caller = createSupportRouter(support).createCaller(anonymous());
    await expect(caller.searchKb({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_kb_limit_unset',
    });
    await expect(caller.searchKb()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_kb_limit_unset',
    });
    await expect(caller.searchKb({ q: 'account' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_kb_limit_unset',
    });
    await expect(caller.searchKb({ q: 'account', limit: 100 })).resolves.toEqual([]);
  });

  it('searchKb and getKb are public', async () => {
    const support = stubSupport();
    const caller = createSupportRouter(support).createCaller(anonymous());
    const found = await caller.searchKb({ q: 'account', limit: 100 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ revision: 1, published: true });
    expect(support.searchKb).toHaveBeenCalledWith('account', { limit: 100, viewer: { signedIn: false, staff: false } });
    const one = await caller.getKb({ id: 'kb-account-access' });
    expect(one).toMatchObject({ id: 'kb-account-access', revision: 1, published: true });
    expect(support.getKbArticle).toHaveBeenCalledWith(
      { id: 'kb-account-access', version: undefined },
      { viewer: { signedIn: false, staff: false } },
    );
    const missing = await caller.getKb({ id: 'nope' });
    expect(missing).toBeNull();
  });

  it('getKb passes an explicit version and maps unknown-version refuse by name', async () => {
    const support = stubSupport({
      getKbArticle: vi.fn(async (q: { id: string; version?: number }) => {
        if (q.version === 99) throw new SupportError('support.kb_version_unknown', 'support.kb_version_unknown');
        return {
          id: q.id,
          titleKey: 'support.kb.account_access.title',
          bodyKey: 'support.kb.account_access.body',
          version: q.version ?? 1,
          revision: q.version ?? 1,
          published: true,
        };
      }),
    });
    const caller = createSupportRouter(support).createCaller(anonymous());
    const v1 = await caller.getKb({ id: 'kb-account-access', version: 1 });
    expect(v1).toMatchObject({ version: 1 });
    expect(support.getKbArticle).toHaveBeenCalledWith(
      { id: 'kb-account-access', version: 1 },
      { viewer: { signedIn: false, staff: false } },
    );
    await expect(caller.getKb({ id: 'kb-account-access', version: 99 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('support.kb_version_unknown'),
    });
  });

  it('searchKb/getKb stay empty when the desk has no published articles', async () => {
    const support = stubSupport({
      searchKb: vi.fn(async () => []),
      getKbArticle: vi.fn(async () => null),
    });
    const caller = createSupportRouter(support).createCaller(anonymous());
    expect(await caller.searchKb({ q: '', limit: 100 })).toEqual([]);
    expect(await caller.searchKb({ q: 'account', limit: 100 })).toEqual([]);
    expect(await caller.getKb({ id: 'kb-account-access' })).toBeNull();
    expect(await caller.getKb({ id: 'kb-default' })).toBeNull();
  });

  it('listMine omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      listMyTickets: async (input: { userId: string; limit?: number }) => {
        assertListMineTicketsLimit(input.limit);
        return [];
      },
    });
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(caller.listMine({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_mine_limit_unset',
    });
    await expect(caller.listMine()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_mine_limit_unset',
    });
    await expect(caller.listMine({ limit: 100 })).resolves.toEqual([]);
  });

  it('refuses listAll without support:ops', async () => {
    const support = stubSupport();
    await expect(createSupportRouter(support).createCaller(signed()).listAll()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(support.listAllTickets).not.toHaveBeenCalled();
  });

  it('allows listAll with support:ops', async () => {
    const support = stubSupport({
      listAllTickets: vi.fn(async () => [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId: USER,
          category: 'other' as const,
          subject: 'S',
          body: 'B',
          status: 'open' as const,
          assigneeId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    });
    const op = principal({ scopes: ['support:read', 'support:write', 'support:ops'] });
    const tickets = await createSupportRouter(support).createCaller(signed(op)).listAll({ limit: 100 });
    expect(tickets).toHaveLength(1);
    expect(support.listAllTickets).toHaveBeenCalledWith({ limit: 100 });
  });

  it('listAll omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      listAllTickets: async (options?: { limit?: number }) => {
        assertListAllTicketsLimit(options?.limit);
        return [];
      },
    });
    const op = principal({ scopes: ['support:read', 'support:write', 'support:ops'] });
    const caller = createSupportRouter(support).createCaller(signed(op));
    await expect(caller.listAll({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_all_limit_unset',
    });
    await expect(caller.listAll()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_all_limit_unset',
    });
    await expect(caller.listAll({ limit: 100 })).resolves.toEqual([]);
  });

  it('settle is always PRECONDITION_FAILED for ops — the desk cannot pay', async () => {
    const support = stubSupport({
      attemptSettlement: vi.fn(async () => {
        throw new SupportError('support cannot settle', 'support.settle.refused');
      }),
    });
    const op = principal({ scopes: ['support:read', 'support:write', 'support:ops'] });
    const caller = createSupportRouter(support).createCaller(signed(op));
    for (const act of ['complete_withdrawal', 'unfreeze_account', 'move_money'] as const) {
      await expect(caller.settle({ act })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
    expect(support.attemptSettlement).toHaveBeenCalledTimes(3);
  });

  it('refuses settle without support:ops', async () => {
    const support = stubSupport({
      attemptSettlement: vi.fn(async () => {
        throw new Error('should not run');
      }),
    });
    await expect(createSupportRouter(support).createCaller(signed()).settle({ act: 'complete_withdrawal' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses setStatus without support:ops', async () => {
    const support = stubSupport({
      setStatus: vi.fn(async () => {
        throw new Error('should not run');
      }),
    });
    await expect(
      createSupportRouter(support)
        .createCaller(signed())
        .setStatus({ ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'resolved' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps a terminal user comment to PRECONDITION_FAILED', async () => {
    const support = stubSupport({
      comment: vi.fn(async () => {
        throw new SupportError('comment refused: ticket is terminal', 'support.comment.terminal');
      }),
    });
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(caller.comment({ ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: 'Please reopen.' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('maps a missing ticket to catalog not-found copy, not invented English', async () => {
    const support = stubSupport({
      getTicket: vi.fn(async () => {
        throw new SupportError('ticket not found', 'support.not_found');
      }),
    });
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(caller.get({ ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: userCopy('support.not_found'),
    });
  });

  it('maps a KB stale-revision refuse to the dotted key, not English', async () => {
    const support = stubSupport({
      publishKb: vi.fn(async () => {
        throw new SupportError('KB revision is stale', 'support.kb.revision_stale');
      }),
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    const caller = createSupportRouter(support).createCaller(signed(op));
    await expect(
      caller.publishKb({
        id: 'kb-account-access',
        titleKey: 'support.kb.account_access.title',
        bodyKey: 'support.kb.account_access.body',
        baseRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: userCopy('support.kb.revision_stale'),
    });
  });

  it('listComments requires authentication', async () => {
    const support = stubSupport();
    await expect(
      createSupportRouter(support).createCaller(anonymous()).listComments({ ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(support.listComments).not.toHaveBeenCalled();
  });

  it('listComments omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      listComments: async (input: { userId: string; ticketId: string; asOperator?: boolean; limit?: number }) => {
        assertListCommentsLimit(input.limit);
        return [];
      },
    });
    const caller = createSupportRouter(support).createCaller(signed());
    const ticketId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(caller.listComments({ ticketId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_comments_limit_unset',
    });
    await expect(caller.listComments({ ticketId, limit: 100 })).resolves.toEqual([]);
  });

  it('refuses listQueue / next / claim without support:ops', async () => {
    const support = stubSupport();
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(caller.listQueue()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.next()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.claim({ ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(support.listOperatorQueue).not.toHaveBeenCalled();
    expect(support.peekNext).not.toHaveBeenCalled();
    expect(support.claimForOperator).not.toHaveBeenCalled();
  });

  it('allows listQueue / next / claim with support:ops', async () => {
    const ticketId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const createdAt = '2026-08-07T10:00:00.000Z';
    const support = stubSupport({
      listOperatorQueue: vi.fn(async () => ({
        status: 'ok' as const,
        entries: [
          {
            ticketId,
            userId: USER,
            category: 'deposit_withdraw',
            status: 'open' as const,
            subject: 'S',
            score: 70,
            ageMs: 0,
            createdAt,
            timingKind: 'score_not_promise' as const,
            sla: false as const,
          },
        ],
      })),
      peekNext: vi.fn(async () => ({
        ticketId,
        userId: USER,
        category: 'deposit_withdraw',
        status: 'open' as const,
        subject: 'S',
        score: 70,
        ageMs: 0,
        createdAt,
        timingKind: 'score_not_promise' as const,
        sla: false as const,
      })),
      claimForOperator: vi.fn(async () => ({
        id: ticketId,
        userId: USER,
        category: 'deposit_withdraw' as const,
        subject: 'S',
        body: 'B',
        status: 'pending' as const,
        assigneeId: OP,
        createdAt,
        updatedAt: createdAt,
      })),
    });
    const op = principal({
      userId: OP,
      sub: OP,
      scopes: ['support:read', 'support:write', 'support:ops'],
    });
    const caller = createSupportRouter(support).createCaller(signed(op));
    const q = await caller.listQueue({ limit: 100 });
    expect(q).toMatchObject({ status: 'ok' });
    expect(await caller.next()).toMatchObject({ ticketId });
    const claimed = await caller.claim({ ticketId });
    expect(claimed.assigneeId).toBe(OP);
    expect(support.claimForOperator).toHaveBeenCalledWith({ operatorId: OP, ticketId });
  });

  it('listQueue omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      listOperatorQueue: async (options?: { limit?: number }) => {
        assertOperatorQueueLimit(options?.limit);
        return { status: 'empty' as const };
      },
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    const caller = createSupportRouter(support).createCaller(signed(op));
    await expect(caller.listQueue({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.queue_list_limit_unset',
    });
    await expect(caller.listQueue()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.queue_list_limit_unset',
    });
    await expect(caller.listQueue({ limit: 100 })).resolves.toEqual({ status: 'empty' });
  });

  /* ----------------------------------------------------------------- *
   * Stage-4 — audit trail, grounding, case file
   *
   * These hit the ROUTE through the real edge context and the real scope
   * middleware. A test that constructed the router and called the service
   * directly would pass on a procedure nothing had mounted, which is how seven
   * guards in this repo were correct in isolation and unreachable in place.
   * ----------------------------------------------------------------- */

  const TICKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('events requires authentication', async () => {
    const support = stubSupport();
    await expect(createSupportRouter(support).createCaller(anonymous()).events({ ticketId: TICKET })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(support.listTicketEvents).not.toHaveBeenCalled();
  });

  it('events is reachable for the ticket OWNER on support:read alone', async () => {
    // The owner seeing what happened to their own complaint is the point of
    // keeping the trail, so this must NOT be an ops-only route.
    const support = stubSupport({
      listTicketEvents: vi.fn(async () => [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ticketId: TICKET,
          sequence: 1,
          kind: 'opened' as const,
          actorId: USER,
          actorRole: 'user' as const,
          fromStatus: null,
          toStatus: null,
          note: null,
          occurredAt: '2026-08-09T10:00:00.000Z',
        },
      ]),
    });
    const trail = await createSupportRouter(support).createCaller(signed()).events({ ticketId: TICKET, limit: 100 });
    expect(trail).toHaveLength(1);
    expect(support.listTicketEvents).toHaveBeenCalledWith({
      userId: USER,
      ticketId: TICKET,
      asOperator: false,
      limit: 100,
    });
  });

  it('an operator reading a trail is passed asOperator from the PRINCIPAL', async () => {
    const support = stubSupport();
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    await createSupportRouter(support).createCaller(signed(op)).events({ ticketId: TICKET, limit: 100 });
    expect(support.listTicketEvents).toHaveBeenCalledWith({
      userId: OP,
      ticketId: TICKET,
      asOperator: true,
      limit: 100,
    });
  });

  it('events omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const support = stubSupport({
      listTicketEvents: async (input: { userId: string; ticketId: string; asOperator?: boolean; limit?: number }) => {
        assertListEventsLimit(input.limit);
        return [];
      },
    });
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(caller.events({ ticketId: TICKET })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.list_events_limit_unset',
    });
    await expect(caller.events({ ticketId: TICKET, limit: 100 })).resolves.toEqual([]);
  });

  it('refuses accountState / escalate / caseFile without support:ops', async () => {
    const support = stubSupport();
    const caller = createSupportRouter(support).createCaller(signed());
    await expect(caller.accountState({ ticketId: TICKET })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.escalate({ ticketId: TICKET, reason: 'other', summary: 'S' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.caseFile({ ticketId: TICKET })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(support.readAccountState).not.toHaveBeenCalled();
    expect(support.escalate).not.toHaveBeenCalled();
    expect(support.getCaseFile).not.toHaveBeenCalled();
  });

  it('accountState is reachable with support:ops and takes the operator from the principal', async () => {
    const support = stubSupport({
      readAccountState: vi.fn(async () => ({
        status: 'read' as const,
        state: { userId: USER, status: 'frozen' as const, kycTier: 'basic' as const },
        readAt: '2026-08-09T10:00:00.000Z',
      })),
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    const grounding = await createSupportRouter(support).createCaller(signed(op)).accountState({ ticketId: TICKET });
    expect(grounding).toMatchObject({ status: 'read' });
    expect(support.readAccountState).toHaveBeenCalledWith({ operatorId: OP, ticketId: TICKET });
  });

  it('accountState names identity grounding unwired as PRECONDITION_FAILED, not unread', async () => {
    const support = stubSupport({
      readAccountState: vi.fn(async () => {
        throw new SupportError(
          'identity grounding unwired: INTERNAL_SERVICE_SECRET missing (named refuse, not plane_dark)',
          'support.identity_grounding_unwired',
        );
      }),
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    await expect(createSupportRouter(support).createCaller(signed(op)).accountState({ ticketId: TICKET })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('support.identity_grounding_unwired'),
    });
  });

  it('accountState takes NO userId — there is no platform-wide account lookup here', async () => {
    const support = stubSupport();
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    const caller = createSupportRouter(support).createCaller(signed(op));
    // The input schema is strict about this on purpose: `support:ops` plus a
    // free-text user id would be an authority no scope grants.
    await expect(caller.accountState({ ticketId: TICKET, userId: USER } as unknown as { ticketId: string })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(support.readAccountState).not.toHaveBeenCalled();
  });

  it('escalate is reachable and returns the case file it wrote', async () => {
    const support = stubSupport({
      escalate: vi.fn(async () => ({
        ticketId: TICKET,
        escalatedBy: OP,
        reason: 'money_request' as const,
        citations: [CITATION],
        grounding: { status: 'unread' as const, reason: 'plane_dark' as const },
        summary: 'User asks for a refund.',
        createdAt: '2026-08-09T10:00:00.000Z',
      })),
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    const file = await createSupportRouter(support)
      .createCaller(signed(op))
      .escalate({ ticketId: TICKET, reason: 'money_request', summary: 'User asks for a refund.' });
    expect(file.citations).toHaveLength(1);
    expect(support.escalate).toHaveBeenCalledWith({
      operatorId: OP,
      ticketId: TICKET,
      reason: 'money_request',
      summary: 'User asks for a refund.',
    });
  });

  it('a case file with zero citations cannot pass the route contract', async () => {
    // The refusal is at the WIRE, so an ungrounded file cannot reach a client
    // even if a future service implementation stopped refusing it.
    const support = stubSupport({
      escalate: vi.fn(async () => ({
        ticketId: TICKET,
        escalatedBy: OP,
        reason: 'other' as const,
        citations: [],
        grounding: { status: 'unread' as const, reason: 'not_attempted' as const },
        summary: 'Escalating.',
        createdAt: '2026-08-09T10:00:00.000Z',
      })),
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    await expect(
      createSupportRouter(support).createCaller(signed(op)).escalate({ ticketId: TICKET, reason: 'other', summary: 'Escalating.' }),
    ).rejects.toThrow();
  });

  it('caseFile returns null for a ticket never escalated — never a fabricated empty file', async () => {
    const support = stubSupport();
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    expect(await createSupportRouter(support).createCaller(signed(op)).caseFile({ ticketId: TICKET })).toBeNull();
  });

  it('setStatus carries an optional note through to the service', async () => {
    const support = stubSupport({
      setStatus: vi.fn(async () => ({
        id: TICKET,
        userId: USER,
        category: 'other' as const,
        subject: 'S',
        body: 'B',
        status: 'resolved' as const,
        assigneeId: OP,
        createdAt: '2026-08-09T10:00:00.000Z',
        updatedAt: '2026-08-09T10:00:00.000Z',
      })),
    });
    const op = principal({ userId: OP, sub: OP, scopes: ['support:read', 'support:write', 'support:ops'] });
    await createSupportRouter(support).createCaller(signed(op)).setStatus({ ticketId: TICKET, status: 'resolved', note: 'fixed upstream' });
    expect(support.setStatus).toHaveBeenCalledWith({
      operatorId: OP,
      ticketId: TICKET,
      status: 'resolved',
      note: 'fixed upstream',
    });
  });
});
