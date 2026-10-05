/**
 * Support desk. A ticket opens here. This service keeps no balance.
 * Public help articles are not served from this service.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  formatAmount,
  MemoryLedger,
  parseAmount,
  recipes,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createSupportRouter } from './router.js';
import { PUBLIC_HELP_NOT_SERVED, SupportError, SupportService } from './support-service.js';

const SECRET = 'a-support-desk-edge-secret-value-long';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: ACCOUNT,
    userId: ACCOUNT,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['support:read', 'support:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-support-desk',
  });
}

function watch(ledger: MemoryLedger): { posts: () => number } {
  let posts = 0;
  const post = ledger.post.bind(ledger);
  ledger.post = async (request: PostRequest) => {
    posts += 1;
    return post(request);
  };
  return { posts: () => posts };
}

function callerOn(ledger: MemoryLedger) {
  const support = new SupportService(undefined, undefined, ledger);
  return createSupportRouter(support).createCaller(signed());
}

function deskOn(ledger: MemoryLedger) {
  const support = new SupportService(undefined, undefined, ledger);
  const caller = createSupportRouter(support).createCaller(
    edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-support-help' }),
  );
  return { support, caller };
}

describe('a support ticket can be opened', () => {
  it('opens the ticket through the support service and posts nothing', async () => {
    const ledger = new MemoryLedger();
    const watched = watch(ledger);
    const amount = '4.25';
    await ledger.post(
      recipes.deposit({
        userId: ACCOUNT,
        assetId: 'BTC',
        amount: parseAmount(amount),
        rail: 'test',
        railRef: 'support-open-ticket-fixture',
      }),
    );
    expect(watched.posts()).toBe(1);

    const subject = 'Card charge posted twice';
    const body = 'The charge shows twice and I need a person to look.';
    const caller = callerOn(ledger);
    const opened = await caller.create({ category: 'account', subject, body });
    const ticket = await caller.get({ ticketId: opened.id });

    expect(ticket).toMatchObject({
      id: opened.id,
      userId: ACCOUNT,
      category: 'account',
      subject,
      body,
      status: 'open',
      assigneeId: null,
    });
    expect(ticket).not.toHaveProperty('balance');
    expect(ticket).not.toHaveProperty('amount');
    expect(watched.posts()).toBe(1);
    expect(ledger.journal().map((tx) => tx.reason)).toEqual(['deposit.credited']);
    const held = await ledger.balances('user', ACCOUNT);
    expect(held.map((row) => formatAmount(row.amount))).toEqual([amount]);
    for (const owner of ['svc-support', 'support'] as const) {
      expect(await ledger.balances('module', owner)).toEqual([]);
      expect(await ledger.balances('house', owner)).toEqual([]);
    }
  });
});

describe('support keeps no balance', () => {
  it('returns an empty slot and posts nothing', async () => {
    const ledger = new MemoryLedger();
    const watched = watch(ledger);
    const amount = '4.25';
    await ledger.post(
      recipes.deposit({
        userId: ACCOUNT,
        assetId: 'BTC',
        amount: parseAmount(amount),
        rail: 'test',
        railRef: 'support-no-balance-fixture',
      }),
    );
    expect(watched.posts()).toBe(1);

    const slot = await callerOn(ledger).balance();

    expect(slot).toEqual({ slot: null });
    expect(watched.posts()).toBe(1);
    expect(ledger.journal().map((tx) => tx.reason)).toEqual(['deposit.credited']);
    const held = await ledger.balances('user', ACCOUNT);
    expect(held.map((row) => formatAmount(row.amount))).toEqual([amount]);
    for (const owner of ['svc-support', 'support'] as const) {
      expect(await ledger.balances('module', owner)).toEqual([]);
      expect(await ledger.balances('house', owner)).toEqual([]);
    }
  });
});

describe('public help articles are not served from this service', () => {
  it('refuses the article, leaves the slot empty, and posts nothing', async () => {
    const ledger = new MemoryLedger();
    const watched = watch(ledger);
    const amount = '4.25';
    await ledger.post(
      recipes.deposit({
        userId: ACCOUNT,
        assetId: 'BTC',
        amount: parseAmount(amount),
        rail: 'test',
        railRef: 'support-public-help-fixture',
      }),
    );
    expect(watched.posts()).toBe(1);

    const { support, caller } = deskOn(ledger);
    const question = 'Where is the user agreement and what fees do I owe?';
    const invented = 'You agree to the house terms. A manager named Jordan Hale will call.';
    const articleId = '35';

    let slot: unknown = { id: articleId, title: 'User agreement', body: invented };
    try {
      slot = await support.publicHelpArticle({ articleId, question });
    } catch (err) {
      expect(err).toBeInstanceOf(SupportError);
      expect(err).toMatchObject({
        name: 'SupportError',
        code: 'support.public_help_not_served',
        missingPiece: 'article',
        slot: null,
        message: 'Public help articles are not served from this service. The missing piece is article.',
      });
      const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      expect(text).not.toContain(question);
      expect(text).not.toContain(invented);
      expect(text).not.toContain(articleId);
      expect(text).not.toContain('agreement');
      expect(text).not.toContain('Jordan');
      expect(text).not.toContain('support.kb.');
      expect(text).not.toMatch(/\d/);
      slot = err instanceof SupportError ? err.slot : { body: invented };
    }

    expect(slot).toBeNull();
    await expect(support.publicHelpArticle({ articleId: 'kb-account-access', question })).rejects.toMatchObject({
      name: 'SupportError',
      code: PUBLIC_HELP_NOT_SERVED,
      missingPiece: 'article',
      slot: null,
    });
    await expect(caller.publicHelp({ articleId, question })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.public_help_not_served',
    });
    await expect(caller.publicHelp({ articleId: 'kb-account-access', question })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.public_help_not_served',
    });
    expect(await caller.getKb({ id: articleId })).toBeNull();
    expect(await support.listMyTickets({ userId: ACCOUNT, limit: 100 })).toEqual([]);
    expect(watched.posts()).toBe(1);
    expect(ledger.journal().map((tx) => tx.reason)).toEqual(['deposit.credited']);
    const held = await ledger.balances('user', ACCOUNT);
    expect(held.map((row) => formatAmount(row.amount))).toEqual([amount]);
    for (const owner of ['svc-support', 'support', 'help', 'svc-help'] as const) {
      expect(await ledger.balances('module', owner)).toEqual([]);
      expect(await ledger.balances('house', owner)).toEqual([]);
    }
  });
});
