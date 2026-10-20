import { describe, expect, it } from 'vitest';
import { SUPPORT_MONEY_TOOLS } from './guardrail.js';
import {
  accountProjectionHasInventMoney,
  invokeSupportDataTool,
  isSupportDataToolOk,
  supportAnswerOrEscalate,
  SUPPORT_DATA_TOOLS,
  type AccountProjectionFixture,
  type KbArticleFixture,
  type TicketFixture,
} from './data-tools.js';
import { createFixtureSupportDesk } from './desk-port.js';
import type { SupportTierLaw } from './tier-gate.js';

const USER = 'user-1';
const OTHER = 'user-2';

const law: SupportTierLaw = { published: true, matrix: { free: [...SUPPORT_DATA_TOOLS] } };

const articles: readonly KbArticleFixture[] = [
  { articleKey: 'kb.withdrawals.delayed', titleKey: 'kb.withdrawals.delayed.title', bodyKey: 'kb.withdrawals.delayed.body' },
];

const ticket: TicketFixture = { ticketId: 'tkt-1', ownerUserId: USER, status: 'open', category: 'withdrawals' };

const account: AccountProjectionFixture = { userId: USER, status: 'frozen', kycTier: 'tier-2' };

const desk = createFixtureSupportDesk({ articles, tickets: [ticket], accounts: [account] });

/** Everything an open call needs, so each test can vary exactly one thing. */
function call(overrides: Partial<Parameters<typeof invokeSupportDataTool>[0]> = {}) {
  return invokeSupportDataTool({
    tool: 'support.kb.search',
    plane: 'live',
    requesterUserId: USER,
    tierLaw: law,
    userTier: 'free',
    desk,
    kbSearchLimit: 20,
    articles,
    ticket,
    account,
    ...overrides,
  });
}

describe('support Stage-2 data tools — nothing is invented', () => {
  it('refuses every money tool by name, before any plane or tier work', async () => {
    for (const tool of SUPPORT_MONEY_TOOLS) {
      expect(await call({ tool }), tool).toEqual({
        status: 'refuse',
        tool,
        reason: 'money_tool',
        userMessageKey: 'agents.support.unavailable',
      });
    }
  });

  it('a dark desk plane refuses instead of answering from memory', async () => {
    expect(await call({ plane: 'dark' })).toMatchObject({ reason: 'desk_plane_dark', userMessageKey: 'agents.support.unavailable' });
  });

  it('live without a desk port refuses — fixtures are not a live KB', async () => {
    expect(await call({ desk: null })).toMatchObject({
      reason: 'no_live_kb',
      userMessageKey: 'agents.support.unavailable',
    });
  });

  it('a dark KB plane refuses even when article fixtures are supplied', async () => {
    expect(await call({ kbPlane: 'dark' })).toMatchObject({
      status: 'refuse',
      reason: 'kb_empty',
      userMessageKey: 'agents.support.unavailable',
    });
  });

  it('blank tier law refuses closed — no default grant', async () => {
    expect(await call({ tierLaw: null })).toMatchObject({ reason: 'tier_law_blank', userMessageKey: 'agents.support.tier_closed' });
    expect(await call({ userTier: '' })).toMatchObject({ reason: 'tier_not_granted' });
  });

  it('an undeclared tool refuses even when the tier matrix names it', async () => {
    expect(
      await call({ tool: 'support.ticket.delete', tierLaw: { published: true, matrix: { free: ['support.ticket.delete'] } } }),
    ).toMatchObject({ reason: 'tool_not_declared' });
  });

  it('a declared tool outside the tier refuses as tier-closed', async () => {
    expect(
      await call({ tool: 'support.ticket.read', tierLaw: { published: true, matrix: { free: ['support.kb.search'] } } }),
    ).toMatchObject({
      reason: 'tool_not_in_tier',
      userMessageKey: 'agents.support.tier_closed',
    });
  });

  it('refuses without a requester — the door is never optional', async () => {
    expect(await call({ requesterUserId: '  ' })).toMatchObject({ reason: 'missing_requester' });
  });
});

describe('support Stage-2 kb.search', () => {
  it('echoes the port article keys and invents none', async () => {
    const result = await call();
    expect(isSupportDataToolOk(result)).toBe(true);
    expect(result).toEqual({ status: 'ok', tool: 'support.kb.search', articles });
  });

  it('live + port returns only what the port searched', async () => {
    const portArticles: readonly KbArticleFixture[] = [
      { articleKey: 'support.kb.account_access', titleKey: 'support.kb.account_access.title', bodyKey: 'support.kb.account_access.body' },
    ];
    const result = await call({
      desk: createFixtureSupportDesk({ articles: portArticles }),
      articles: [{ articleKey: 'kb.caller.fixture', titleKey: 'kb.caller.fixture.title', bodyKey: 'kb.caller.fixture.body' }],
    });
    expect(result).toEqual({ status: 'ok', tool: 'support.kb.search', articles: portArticles });
  });

  it('empty port KB is kb_empty, not invented copy', async () => {
    expect(await call({ desk: createFixtureSupportDesk({ articles: [] }) })).toMatchObject({ reason: 'kb_empty' });
  });

  it('omit kbSearchLimit refuses named — never invent 100', async () => {
    expect(await call({ kbSearchLimit: undefined })).toEqual({
      status: 'refuse',
      tool: 'support.kb.search',
      reason: 'kb_search_limit_unset',
      userMessageKey: 'agents.refused.kb_search_limit_unset',
    });
  });

  it('fixture desk still works in tests (test-only port)', async () => {
    expect(await call({ desk, kbQuery: 'withdrawals' })).toEqual({ status: 'ok', tool: 'support.kb.search', articles });
  });

  it('refuses rendered prose where an i18n key belongs', async () => {
    expect(
      await call({
        desk: createFixtureSupportDesk({
          articles: [{ articleKey: 'Your withdrawal is delayed', titleKey: 'kb.a.title', bodyKey: 'kb.a.body' }],
        }),
      }),
    ).toMatchObject({
      reason: 'incomplete_article',
    });
  });
});

describe('support Stage-2 ticket.read — ownership at the door', () => {
  const read = (o: Partial<Parameters<typeof invokeSupportDataTool>[0]> = {}) => call({ tool: 'support.ticket.read', ...o });

  it('reads the requester’s own ticket from the port', async () => {
    expect(await read()).toEqual({ status: 'ok', tool: 'support.ticket.read', ticket });
  });

  it('reads a ticket that is on hold (SP-tickets-04)', async () => {
    const held: TicketFixture = { ...ticket, status: 'on_hold' };
    expect(await read({ desk: createFixtureSupportDesk({ tickets: [held] }) })).toEqual({
      status: 'ok',
      tool: 'support.ticket.read',
      ticket: held,
    });
  });

  it('refuses another user’s ticket — a guessable id is not a grant', async () => {
    expect(
      await read({
        desk: createFixtureSupportDesk({ tickets: [{ ...ticket, ownerUserId: OTHER }] }),
        ticket: { ...ticket, ownerUserId: OTHER },
      }),
    ).toMatchObject({ reason: 'not_ticket_owner' });
  });

  it('refuses a missing or half-filled ticket', async () => {
    expect(await read({ ticket: null })).toMatchObject({ reason: 'missing_fixture' });
    expect(
      await read({
        desk: createFixtureSupportDesk({ tickets: [{ ...ticket, category: '' }] }),
        ticket,
      }),
    ).toMatchObject({ reason: 'incomplete_ticket' });
  });

  it('refuses a port ticket whose id trims to blank', async () => {
    const blankId = createFixtureSupportDesk({ tickets: [ticket] });
    blankId.readTicket = async () => ({
      status: 'ok',
      ticket: { ticketId: '   ', ownerUserId: USER, status: 'open', category: 'withdrawals' },
    });
    expect(await read({ desk: blankId })).toEqual({
      status: 'refuse',
      tool: 'support.ticket.read',
      reason: 'incomplete_ticket',
      userMessageKey: 'agents.support.unavailable',
    });
  });

  it('refuses a port ticket whose id is not the one requested', async () => {
    const otherId = createFixtureSupportDesk({ tickets: [ticket] });
    otherId.readTicket = async () => ({
      status: 'ok',
      ticket: { ticketId: 'tkt-other', ownerUserId: USER, status: 'open', category: 'withdrawals' },
    });
    expect(await read({ desk: otherId })).toEqual({
      status: 'refuse',
      tool: 'support.ticket.read',
      reason: 'missing_fixture',
      userMessageKey: 'agents.support.unavailable',
    });
  });
});

describe('support Stage-2 account.read — status only, never a balance', () => {
  const read = (o: Partial<Parameters<typeof invokeSupportDataTool>[0]> = {}) => call({ tool: 'identity.account.read', ...o });

  it('returns status and KYC tier and no other field', async () => {
    const result = await read();
    expect(result).toEqual({ status: 'ok', tool: 'identity.account.read', account });
    expect(Object.keys(result.status === 'ok' && result.tool === 'identity.account.read' ? result.account : {})).toEqual([
      'userId',
      'status',
      'kycTier',
    ]);
  });

  it('unread identity plane refuses rather than inventing that the account is fine', async () => {
    expect(await read({ desk: createFixtureSupportDesk({ unreadAccounts: true }) })).toMatchObject({
      reason: 'account_plane_dark',
    });
  });

  it('refuses another user’s account projection', async () => {
    const mismatch = createFixtureSupportDesk({ accounts: [account] });
    mismatch.readAccount = async () => ({ status: 'ok', account: { ...account, userId: OTHER } });
    expect(await read({ desk: mismatch })).toMatchObject({
      reason: 'account_owner_mismatch',
    });
  });

  it('refuses a missing or half-filled projection', async () => {
    expect(await read({ desk: createFixtureSupportDesk({ accounts: [{ ...account, kycTier: '' }] }) })).toMatchObject({
      reason: 'incomplete_account',
    });
  });

  it('refuses a projection that carries camelCase money keys — that payload is not returned as ok', async () => {
    for (const key of ['creditLimit', 'fundsAvailable', 'equityValue', 'unrealizedPnl'] as const) {
      const smuggled = { ...account, [key]: '1.00' };
      expect(accountProjectionHasInventMoney(smuggled), key).toBe(true);
      expect(await read({ desk: createFixtureSupportDesk({ accounts: [smuggled as AccountProjectionFixture] }) }), key).toEqual({
        status: 'refuse',
        tool: 'identity.account.read',
        reason: 'balance_field_forbidden',
        userMessageKey: 'agents.support.unavailable',
      });
    }
  });

  it('userId and kycTier are not invent-money, and snake_case money keys still are', async () => {
    expect(accountProjectionHasInventMoney({ userId: USER, kycTier: 'tier-2' })).toBe(false);
    expect(await read()).toEqual({ status: 'ok', tool: 'identity.account.read', account });
    for (const key of ['balance', 'available_balance'] as const) {
      const smuggled = { ...account, [key]: '1.00' };
      expect(accountProjectionHasInventMoney(smuggled), key).toBe(true);
      expect(await read({ desk: createFixtureSupportDesk({ accounts: [smuggled as AccountProjectionFixture] }) }), key).toMatchObject({
        status: 'refuse',
        reason: 'balance_field_forbidden',
      });
    }
  });
});

describe('support Stage-2 escalate path', () => {
  it('answers only when the KB actually hit, citing what it read', async () => {
    expect(supportAnswerOrEscalate({ kbResult: await call() })).toEqual({
      status: 'answer',
      citedArticleKeys: ['kb.withdrawals.delayed'],
    });
  });

  it('an empty KB escalates to a person', async () => {
    expect(supportAnswerOrEscalate({ kbResult: await call({ desk: createFixtureSupportDesk({ articles: [] }) }) })).toEqual({
      status: 'escalate',
      reason: 'kb_no_hit',
      userMessageKey: 'agents.support.escalated',
    });
  });

  it('any other desk refusal escalates rather than guessing', async () => {
    expect(supportAnswerOrEscalate({ kbResult: await call({ plane: 'dark' }) })).toMatchObject({ reason: 'desk_refused' });
  });

  it('a money request escalates even when the KB hit', async () => {
    expect(supportAnswerOrEscalate({ kbResult: await call(), moneyRequest: true })).toMatchObject({ reason: 'money_request' });
  });

  it('a non-KB read is never treated as an answer', async () => {
    expect(supportAnswerOrEscalate({ kbResult: await call({ tool: 'identity.account.read' }) })).toMatchObject({
      reason: 'desk_refused',
    });
  });
});
