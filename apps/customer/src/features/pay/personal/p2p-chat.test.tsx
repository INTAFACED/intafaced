import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { createApiClient } from '../../../shared/api';
import { createPayMutationGuard, createPersonalPayApi } from '../pay-api';
import type { ChatMessage } from '../schemas';
import { BlockConfirmBody, ContactButtons, type ContactsView } from './ContactActions';
import { ChatView } from './OrderChat';
import { UnreadBadge } from './Unread';
import { p2pChatCopy } from './p2p-chat-copy';
import { p2pDepth } from './p2p-depth-copy';
import type { ChatState, PendingMessage, ServiceFailure } from './p2p-chat-model';

const ME = 'b0000000-0000-4000-8000-000000000001';
const THEM = 's0000000-0000-4000-8000-000000000002';
const MOD = 'm0000000-0000-4000-8000-000000000003';
const TRADE = '11111111-1111-4111-8111-111111111111';
const trade = { buyerId: ME, sellerId: THEM, status: 'escrowed' as const };
const NOW = Date.parse('2026-10-18T12:00:00Z');

const message = (n: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  tradeId: TRADE,
  senderId: THEM,
  clientId: `c${n}`,
  text: `message number ${n}`,
  createdAt: `2026-10-18T10:0${n}:00.000Z`,
  ...over,
});
const state = (over: Partial<ChatState> = {}): ChatState => ({
  phase: 'ready',
  loadFailure: null,
  refreshFailure: null,
  messages: [],
  pending: [],
  unreadAtOpen: 0,
  firstUnread: null,
  lastNotified: null,
  nextReadMs: 5000,
  unreadBelow: null,
  ...over,
});
const view = (over: Partial<Parameters<typeof ChatView>[0]> = {}) =>
  renderToString(
    <ChatView
      state={state()}
      trade={trade}
      viewer={ME}
      now={NOW}
      counterparty="@test_friend"
      draft=""
      onDraft={() => {}}
      onQuick={() => {}}
      onSend={() => {}}
      onRefresh={() => {}}
      onResend={() => {}}
      onEdit={() => {}}
      onDiscard={() => {}}
      {...over}
    />,
  );
const held = (over: Partial<PendingMessage> = {}): PendingMessage => ({
  clientId: 'id-1',
  text: 'my held words',
  status: 'sending',
  failure: null,
  ...over,
});

describe('the order chat', () => {
  it('says it is loading, and keeps send off with the reason', () => {
    const out = view({ state: state({ phase: 'loading' }) });
    expect(out).toContain('Loading messages…');
    expect(out).not.toContain('data-testid="chat-empty"');
    expect(out).toMatch(/<button[^>]*\sdisabled=""[^>]*>Send message/);
    expect(out).toMatch(/<p[^>]*id="[^"]+">Loading messages…/);
  });

  it('shows a load failure in plain words with a retry, and no empty chat', () => {
    const out = view({ state: state({ phase: 'failed', loadFailure: 'notParty' }) });
    expect(out).toContain('data-testid="chat-load-failed"');
    expect(out).toContain('Messages couldn’t be loaded');
    expect(out).toContain('This isn’t open to your account');
    expect(out).toContain('Try again');
    expect(out).not.toContain('data-testid="chat-empty"');
    expect(out).toContain('Sending is off because the messages couldn’t be loaded');
    expect(out).not.toContain('service text');
  });

  it('shows an honest empty chat', () => {
    const out = view();
    expect(out).toContain('data-testid="chat-empty"');
    expect(out).toContain('No messages yet.');
    expect(out).toContain('Write the first one below.');
  });

  it('lists messages oldest first with who wrote each, the service’s time, and a divider at the first unread', () => {
    const out = view({
      state: state({
        messages: [message(1), message(2, { senderId: ME }), message(3), message(4, { senderId: MOD })],
        unreadAtOpen: 2,
        firstUnread: message(3).id,
      }),
    });
    expect(out.indexOf('message number 1')).toBeLessThan(out.indexOf('message number 2'));
    expect(out.indexOf('message number 3')).toBeLessThan(out.indexOf('message number 4'));
    expect(out).toContain('data-role="seller"');
    expect(out).toContain('data-role="you"');
    expect(out).toContain('data-role="moderator"');
    for (const label of ['Seller', 'You', 'Moderator']) expect(out).toContain(label);
    expect(out).toContain('dateTime="2026-10-18T10:01:00.000Z"');
    expect(out).toContain('New messages (2)');
    expect(out.indexOf('New messages (2)')).toBeLessThan(out.indexOf('message number 3'));
    expect(out.indexOf('New messages (2)')).toBeGreaterThan(out.indexOf('message number 2'));
    expect(out).not.toContain(THEM);
    expect(out).not.toContain(MOD);
    expect(out).toContain('role="log"');
    expect(out).toContain('tabindex="0"');
  });

  it('shows no divider when nothing was unread', () => {
    expect(view({ state: state({ messages: [message(1)] }) })).not.toContain('data-testid="chat-new-divider"');
  });

  it('keeps send off until there is text, and says why', () => {
    const empty = view();
    expect(empty).toMatch(/<button[^>]*\sdisabled=""[^>]*>Send message/);
    expect(empty).toContain('Send is off while the box is empty. Press Enter to send, Shift+Enter for a new line.');
    expect(empty).toContain('maxLength="2000"');
    const typed = view({ draft: 'hello' });
    expect(typed).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Send message/);
    expect(typed).toContain('5 of 2,000 characters');
    expect(view({ draft: '   ' })).toMatch(/<button[^>]*\sdisabled=""[^>]*>Send message/);
  });

  it('ties both the box and the button to the reason line', () => {
    const out = view();
    const hint = out.match(/aria-describedby="([^"]+)"/)![1]!;
    expect(out.split(`aria-describedby="${hint}"`).length).toBe(3);
    expect(out).toContain(`id="${hint}"`);
  });

  it('shows a message on its way, with no way to send it twice', () => {
    const out = view({ state: state({ pending: [held()] }) });
    expect(out).toContain('my held words');
    expect(out).toContain('Sending…');
    expect(out).not.toContain('Check and send');
    expect(out).not.toContain('Send again');
  });

  it('shows a message with a lost reply as not confirmed, and offers to check first', () => {
    const out = view({ state: state({ pending: [held({ status: 'unconfirmed', failure: 'unconfirmed' })] }) });
    expect(out).toContain('Not confirmed');
    expect(out).toContain('can’t be sent twice');
    expect(out).toContain('Check and send');
    expect(out).toContain('Edit');
    expect(out).toContain('Discard');
  });

  it.each([
    ['readOnly', 'Your session isn’t allowed to do this.', true],
    ['noService', 'We can’t reach the service right now.', true],
    ['attachment', 'Files and images can’t be sent.', false],
    ['textRequired', 'between 1 and 2,000 characters', false],
    ['notParty', 'This isn’t open to your account.', false],
  ] as Array<[ServiceFailure, string, boolean]>)(
    'shows a refused message (%s) in words, with retry only when it can help',
    (failure, words, retry) => {
      const out = view({ state: state({ pending: [held({ status: 'failed', failure })] }) });
      expect(out).toContain('Not sent');
      expect(out).toContain(words);
      expect(out.includes('Send again')).toBe(retry);
      expect(out).toContain('Discard');
    },
  );

  it('points to verification when the service asks for it', () => {
    const out = view({ state: state({ pending: [held({ status: 'failed', failure: 'verify' })] }) });
    expect(out).toContain('Verify your identity to use P2P.');
    expect(out).toContain('href="/verification"');
  });

  it('keeps showing messages when a background read fails, and offers to check now', () => {
    const out = view({ state: state({ messages: [message(1)], refreshFailure: 'noService' }) });
    expect(out).toContain('message number 1');
    expect(out).toContain('data-testid="chat-refresh-failed"');
    expect(out).toContain('Check now');
  });

  it('says when the other person was not alerted, only after a send', () => {
    expect(view()).not.toContain('data-testid="chat-not-notified"');
    expect(view({ state: state({ lastNotified: true }) })).not.toContain('data-testid="chat-not-notified"');
    expect(view({ state: state({ lastNotified: false }) })).toContain('The other person isn’t alerted outside the app');
  });

  it('states why there are no attachments and no system messages, and how new messages arrive', () => {
    const out = view();
    expect(out).toContain('Files and images can’t be attached: this chat stores text only.');
    expect(out).toContain('Order status changes are shown in “Where this order is”.');
    expect(out).toContain('New messages appear while this page is open.');
  });

  it('has a refresh button that works from the keyboard', () => {
    expect(view()).toMatch(/<button[^>]*>Refresh messages<\/button>/);
  });

  it('keeps people’s own words as text, never as markup', () => {
    const out = view({ state: state({ messages: [message(1, { text: '<img src=x onerror=alert(1)>' })] }) });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('copy', () => {
  it('is written in Spanish and French for every key', () => {
    for (const locale of ['es', 'fr'] as const) {
      expect(p2pChatCopy.coverage(locale).missing).toEqual([]);
      expect(p2pDepth.coverage(locale).missing).toEqual([]);
    }
  });

  it('no longer says chat or follow and block are missing from the page', () => {
    for (const key of ['chatPickBody'] as const) {
      expect(p2pDepth.t(key)).not.toMatch(/isn['’]t offered|isn['’]t on this page/i);
    }
    const catalogue = p2pDepth as unknown as { forLocale: (locale: 'en') => { t: (key: string) => string } };
    for (const dead of ['chatReasonTitle', 'chatReasonBody', 'chatSendOff', 'cpReason']) {
      expect(() => catalogue.forLocale('en').t(dead)).toThrow(/No message for key/);
    }
  });
});

describe('unread mark on the order list', () => {
  it('shows a count, nothing for zero, and a plain note when it could not be read', () => {
    const some = renderToString(<UnreadBadge count={{ status: 'ready', count: 3 }} />);
    expect(some).toContain('3 new');
    expect(some).toContain('aria-label="Unread messages: 3"');
    expect(renderToString(<UnreadBadge count={{ status: 'ready', count: 0 }} />)).toBe('');
    expect(renderToString(<UnreadBadge count={undefined} />)).toBe('');
    const off = renderToString(<UnreadBadge count={{ status: 'failed' }} />);
    expect(off).toContain('Unread count unavailable');
    expect(off).not.toContain('0 new');
  });
});

const buttons = (over: Partial<Parameters<typeof ContactButtons>[0]> = {}) =>
  renderToString(
    <ContactButtons
      view={{ status: 'ready', following: false, blocking: false }}
      self={false}
      busy={null}
      saved={null}
      failure={null}
      onChange={() => {}}
      onAskBlock={() => {}}
      onReload={() => {}}
      {...over}
    />,
  );
const disabledCount = (html: string) => (html.match(/<button[^>]*\sdisabled/g) ?? []).length;

describe('follow and block', () => {
  it('offers both while neither is set, with the note on what following means', () => {
    const out = buttons();
    expect(out).toContain('Follow');
    expect(out).toContain('Block');
    expect(disabledCount(out)).toBe(0);
    expect(out).toContain('Following is your own list. The other person isn’t told.');
    expect(out).not.toContain('data-testid="contact-status"');
  });

  it('reflects what the service holds: following shows Unfollow, blocked shows Unblock', () => {
    const out = buttons({ view: { status: 'ready', following: true, blocking: true } });
    expect(out).toContain('Unfollow');
    expect(out).toContain('Unblock');
    expect(out).toContain('You follow this member');
    expect(out).toContain('You blocked this member');
  });

  it('turns both off while the list loads, and says why', () => {
    const out = buttons({ view: { status: 'loading' } });
    expect(disabledCount(out)).toBe(2);
    expect(out).toContain('Checking your follow and block list…');
  });

  it('turns both off when the list cannot be read, says why, and offers to read it again', () => {
    const out = buttons({ view: { status: 'failed', kind: 'noService' } satisfies ContactsView });
    expect(disabledCount(out)).toBe(2);
    expect(out).toContain('Your follow and block list couldn’t be read, so these buttons are off.');
    expect(out).toContain('We can’t reach the service right now.');
    expect(out).toContain('Read the list again');
  });

  it('turns both off on your own account, and says why', () => {
    const out = buttons({ self: true });
    expect(disabledCount(out)).toBe(2);
    expect(out).toContain('This is your own account');
  });

  it('turns both off while a change is saving', () => {
    const out = buttons({ busy: 'follow' });
    expect(disabledCount(out)).toBe(2);
    expect(out).toContain('Saving…');
  });

  it('ties each button to the reason line', () => {
    const out = buttons({ view: { status: 'loading' } });
    const id = out.match(/aria-describedby="([^"]+)"/)![1]!;
    expect(out.split(`aria-describedby="${id}"`).length).toBe(3);
    expect(out).toContain(`id="${id}"`);
  });

  it('confirms a saved change and states a refusal in words', () => {
    expect(buttons({ saved: 'block' })).toContain('You blocked this member.');
    expect(buttons({ saved: 'unfollow' })).toContain('You no longer follow this member.');
    const refused = buttons({ failure: 'readOnly' });
    expect(refused).toContain('data-testid="contact-failure"');
    expect(refused).toContain('Your session isn’t allowed to do this.');
  });

  it('asks before blocking, and says what blocking does and does not do', () => {
    const out = renderToString(<BlockConfirmBody busy={false} failure={null} onConfirm={() => {}} onCancel={() => {}} />);
    expect(out).toContain('Their offers are hidden from you and yours from them');
    expect(out).toContain('Orders that are already open stay open, with their chat.');
    expect(out).toContain('If you follow them, blocking also unfollows them. You can unblock them any time.');
    expect(out).toContain('Cancel');
    expect(out).toContain('>Block<');
    const busy = renderToString(<BlockConfirmBody busy failure="unconfirmed" onConfirm={() => {}} onCancel={() => {}} />);
    expect(busy).toContain('Saving…');
    expect(disabledCount(busy)).toBe(2);
    expect(busy).toContain('We couldn’t confirm the result.');
  });
});

// ── The calls themselves: procedure names, inputs and error codes as svc-p2p defines them ─────────────────────────

const ok = (data: unknown) => new Response(JSON.stringify({ result: { data } }));
const refusal = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { message: 'raw service text', data: { intafacedCode: code } } }), { status });

type Call = { procedure: string; method: string; input?: unknown; body?: unknown };
function service(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const api = createApiClient({
    fetch: async (url, options) => {
      const parsed = new URL(String(url), 'http://isolated.invalid');
      const procedure = decodeURIComponent(parsed.pathname.split('/trpc/')[1]!);
      const call: Call = {
        procedure,
        method: options?.method ?? 'GET',
        ...(parsed.searchParams.get('input') ? { input: JSON.parse(parsed.searchParams.get('input')!) } : {}),
        ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}),
      };
      calls.push(call);
      const route = routes[procedure];
      if (!route) throw new Error(`unexpected call ${procedure}`);
      return route(call);
    },
  });
  return { calls, pay: createPersonalPayApi(api, ME, createPayMutationGuard()) };
}
const stored = (n: number) => ({
  ...message(n, { senderId: ME }),
  created: true,
  notify: { delivered: false, code: 'p2p.chat_notify_unwired' },
});

describe('calling svc-p2p', () => {
  it('lists chat messages with the cursor and a limit, and parses the page', async () => {
    const svc = service({ 'chat.messages.list': () => ok({ messages: [message(1)], nextCursor: null, unread: 1 }) });
    const first = await svc.pay.chatMessages(TRADE, { cursor: null, limit: 100 });
    const next = await svc.pay.chatMessages(TRADE, { cursor: message(1).id, limit: 100 });
    expect(first).toMatchObject({ ok: true, data: { unread: 1 } });
    expect(next.ok).toBe(true);
    expect(svc.calls[0]).toEqual({ procedure: 'chat.messages.list', method: 'GET', input: { tradeId: TRADE, limit: 100 } });
    expect(svc.calls[1]!.input).toEqual({ tradeId: TRADE, limit: 100, cursor: message(1).id });
  });

  it('sends text with a client id as the idempotency key', async () => {
    const svc = service({ 'chat.messages.send': () => ok(stored(1)) });
    const result = await svc.pay.chatSend(TRADE, 'hello', 'client-1');
    expect(result.ok).toBe(true);
    expect(svc.calls).toEqual([
      { procedure: 'chat.messages.send', method: 'POST', body: { tradeId: TRADE, text: 'hello', clientId: 'client-1' } },
    ]);
  });

  it('reads the unread count for one order', async () => {
    const svc = service({ 'chat.unread': () => ok({ tradeId: TRADE, unread: 4 }) });
    expect(await svc.pay.chatUnread(TRADE)).toEqual({ ok: true, data: { tradeId: TRADE, unread: 4 } });
    expect(svc.calls[0]).toEqual({ procedure: 'chat.unread', method: 'GET', input: { tradeId: TRADE } });
  });

  it('rejects a reply that is not a chat page rather than showing it', async () => {
    const svc = service({ 'chat.messages.list': () => ok({ messages: [{ id: 'nope' }], nextCursor: null, unread: 0 }) });
    const result = await svc.pay.chatMessages(TRADE, { cursor: null, limit: 100 });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
  });

  it('lists contacts and changes them with an idempotency key', async () => {
    const lists = { following: [THEM], blocking: [] };
    const svc = service({
      'contacts.list': () => ok(lists),
      'contacts.follow': () => ok(lists),
      'contacts.unfollow': () => ok({ following: [], blocking: [] }),
      'contacts.block': () => ok({ following: [], blocking: [THEM] }),
      'contacts.unblock': () => ok({ following: [], blocking: [] }),
    });
    expect(await svc.pay.contacts()).toEqual({ ok: true, data: lists });
    await svc.pay.setContact('follow', THEM, 'contact:follow:abcdefgh');
    await svc.pay.setContact('unfollow', THEM, 'contact:unfollow:abcdefgh');
    await svc.pay.setContact('block', THEM, 'contact:block:abcdefgh');
    await svc.pay.setContact('unblock', THEM, 'contact:unblock:abcdefgh');
    expect(svc.calls.map((call) => call.procedure)).toEqual([
      'contacts.list',
      'contacts.follow',
      'contacts.unfollow',
      'contacts.block',
      'contacts.unblock',
    ]);
    expect(svc.calls[1]).toEqual({
      procedure: 'contacts.follow',
      method: 'POST',
      body: { peerId: THEM, idempotencyKey: 'contact:follow:abcdefgh' },
    });
  });

  it('reads the service’s typed refusal codes through to plain kinds', async () => {
    const { serviceFailureKind } = await import('./p2p-chat-model');
    const svc = service({
      'chat.messages.list': () => refusal(404, 'p2p.trade_not_found'),
      'chat.messages.send': () => refusal(412, 'p2p.chat_attachment_unwired'),
      'contacts.follow': () => refusal(403, 'p2p.contact_self'),
      'contacts.block': () => refusal(403, 'denied.kyc_required'),
    });
    const read = await svc.pay.chatMessages(TRADE, { cursor: null, limit: 100 });
    const send = await svc.pay.chatSend(TRADE, 'x', 'c');
    const self = await svc.pay.setContact('follow', ME, 'contact:follow:abcdefgh');
    const verify = await svc.pay.setContact('block', THEM, 'contact:block:abcdefgh');
    for (const result of [read, send, self, verify]) expect(result.ok).toBe(false);
    expect([read, send, self, verify].map((r) => (r.ok ? '' : serviceFailureKind(r)))).toEqual([
      'notParty',
      'attachment',
      'self',
      'verify',
    ]);
  });

  it('sends nothing when signed out', async () => {
    const svc = service({});
    const signedOut = createPersonalPayApi(createApiClient({ fetch: async () => new Response('') }), null, createPayMutationGuard());
    expect(await signedOut.chatMessages(TRADE, { cursor: null, limit: 1 })).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(await signedOut.chatSend(TRADE, 'x', 'c')).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(await signedOut.contacts()).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(svc.calls).toHaveLength(0);
  });
});

// ── Items from the live trade walk ───────────────────────────────────────────────────────────────────────────────

import { EscrowPath, TradeStatus } from './P2PDepth';
import { escrowView } from './p2p-model';
import { findRoom, resolveAlias } from '../../../app/navigation';
import { features } from '../../../app/feature-registry';
import { matchPath } from '../../../app/path-match';
import { OrderResult } from '../P2POrder';
import { orderCopy } from '../p2p-order-copy';
import type { Trade } from '../schemas';

const fullTrade = (over: Partial<Trade> = {}): Trade => ({
  id: TRADE,
  offerId: '22222222-2222-4222-8222-222222222222',
  sellerId: THEM,
  buyerId: ME,
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'USD',
  fiatAmount: '10',
  price: '1',
  method: 'local_test_bank',
  status: 'escrowed',
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-18T10:00:00Z',
  escrowedAt: '2026-10-18T10:00:01Z',
  resolvedAt: null,
  settledAt: null,
  ...over,
});

describe('chat on a closed order', () => {
  const closedTrade = (status: 'released' | 'cancelled') => ({ ...trade, status });

  it('keeps the box and send button on a cancelled order, and says messages still reach the other person', () => {
    const out = view({ trade: closedTrade('cancelled'), state: state({ messages: [message(1)] }) });
    expect(out).toContain('message number 1');
    expect(out).toContain('<textarea');
    expect(out).toMatch(/Send message/);
    expect(out).toContain('data-testid="chat-closed"');
    expect(out).toContain('Messages still reach the other person. If you paid and the order was cancelled, ask for the refund here');
  });

  it('keeps the box on a released order, with its own note', () => {
    const out = view({ trade: closedTrade('released'), draft: 'thanks' });
    expect(out).toContain('This order is released. Messages still reach the other person.');
    expect(out).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Send message/);
  });

  it('shows no closed note on an open order', () => {
    expect(view()).not.toContain('data-testid="chat-closed"');
  });
});

describe('the chat header, quick replies and warning', () => {
  it('names the other side and shows the order status in words', () => {
    const out = view();
    expect(out).toContain('data-testid="chat-head"');
    expect(out).toContain('@test_friend');
    expect(out).toContain('Seller');
    expect(out).toContain('>In escrow<');
  });

  it('offers the buyer “I have paid” and “Please release” as text to insert, not as sends', () => {
    const out = view();
    expect(out).toContain('data-testid="chat-quick"');
    expect(out).toContain('>I have paid<');
    expect(out).toContain('>Please release<');
    expect(out).not.toContain('Payment received');
    expect(out).toMatch(/<button type="button">I have paid<\/button>/);
  });

  it('offers the seller “Payment received” and “Please send the payment proof in chat”', () => {
    const out = view({ viewer: THEM });
    expect(out).toContain('>Payment received<');
    expect(out).toContain('>Please send the payment proof in chat<');
    expect(out).not.toContain('>I have paid<');
  });

  it('warns the seller, and only the seller, before releasing', () => {
    const warning = 'Don’t release until the money is in your account. Check your bank, not a screenshot.';
    expect(view({ viewer: THEM })).toContain(warning);
    expect(view({ viewer: THEM, trade: { ...trade, status: 'fiat_sent' } })).toContain(warning);
    expect(view({ viewer: ME })).not.toContain(warning);
    expect(view({ viewer: THEM, trade: { ...trade, status: 'released' } })).not.toContain(warning);
  });

  it('shows the quick replies and warning in Spanish and French too', () => {
    for (const locale of ['es', 'fr'] as const) {
      const copy = p2pChatCopy.forLocale(locale);
      for (const key of ['quickPaid', 'quickRelease', 'quickReceived', 'quickProof', 'sellerWarning', 'closedCancelledNote'] as const)
        expect(copy.t(key)).not.toBe(p2pChatCopy.forLocale('en').t(key));
    }
  });

  it('marks a dispute with the warning colour, not the neutral one', () => {
    expect(renderToString(<TradeStatus status="disputed" />)).toContain('data-status="pending"');
    expect(renderToString(<TradeStatus status="escrowed" />)).toContain('data-status="working"');
  });

  it('says how many unread messages wait below while the chat is out of view', () => {
    expect(view({ state: state({ unreadBelow: 3 }) })).toContain('3 new below.');
    expect(view()).not.toContain('data-testid="chat-unread-below"');
  });
});

describe('the address /p2p/orders/<id>', () => {
  it('resolves to the order page instead of “Page not found”', () => {
    const room = findRoom(`/p2p/orders/${TRADE}`);
    expect(room).toBeDefined();
    expect(resolveAlias(room!, `/p2p/orders/${TRADE}`)).toBe(`/uc/order?tradeId=${TRADE}`);
    const list = findRoom('/p2p/orders');
    expect(resolveAlias(list!, '/p2p/orders')).toBe('/uc/order');
  });

  it('belongs to the person-to-person feature', () => {
    const paths = features.find((feature) => feature.id === 'p2p')!.paths;
    expect(paths).toContain('/p2p/orders/*');
    expect(matchPath('/p2p/orders/*', `/p2p/orders/${TRADE}`)).toBeDefined();
  });
});

describe('order status in words', () => {
  it.each([
    ['created', 'Waiting for escrow'],
    ['escrowed', 'In escrow'],
    ['fiat_sent', 'Payment marked sent'],
    ['released', 'Released'],
    ['cancelled', 'Cancelled'],
    ['disputed', 'In dispute'],
  ] as const)('%s reads “%s”', (status, words) => {
    const out = renderToString(<TradeStatus status={status} />);
    expect(out).toContain(`>${words}<`);
    expect(out).not.toContain('fiat sent');
    expect(out).not.toMatch(/>(escrowed|released|cancelled|created|disputed)</);
  });

  it('has a Spanish and French word for every status', () => {
    const names = ['statusCreated', 'statusEscrowed', 'statusFiatSent', 'statusReleased', 'statusCancelled', 'statusDisputed'] as const;
    for (const locale of ['es', 'fr'] as const)
      for (const key of names) expect(p2pDepth.forLocale(locale).t(key)).not.toBe(p2pDepth.forLocale('en').t(key));
  });
});

describe('the order timeline says what is being waited for', () => {
  it('after payment is marked sent, the buyer waits for the seller, not “Order closed: Now”', () => {
    const out = renderToString(<EscrowPath trade={fullTrade({ status: 'fiat_sent' })} userId={ME} />);
    expect(out).toContain('Waiting for the seller to release');
    expect(out).not.toContain('Order closed');
    expect(escrowView(fullTrade({ status: 'fiat_sent' }), ME).steps.at(-1)?.state).toBe('current');
  });

  it('tells the seller it is their release that is awaited', () => {
    expect(renderToString(<EscrowPath trade={fullTrade({ status: 'fiat_sent' })} userId={THEM} />)).toContain('Waiting for you to release');
  });

  it('while escrowed, says who still has to mark payment sent', () => {
    expect(renderToString(<EscrowPath trade={fullTrade()} userId={ME} />)).toContain('Waiting for you to mark payment sent');
    expect(renderToString(<EscrowPath trade={fullTrade()} userId={THEM} />)).toContain('Waiting for the buyer to mark payment sent');
  });

  it('names the closing step once the order is closed', () => {
    const out = renderToString(<EscrowPath trade={fullTrade({ status: 'released', resolution: 'released' })} userId={ME} />);
    expect(out).toContain('Asset released to the buyer');
    expect(out).not.toContain('Waiting for the seller');
  });
});

describe('who a counterparty is', () => {
  it('shows the handle when there is one, a dash only when identity says there is none, and “Member” when it cannot say', async () => {
    const { TraderName } = await import('./Trader');
    const record = (handle: string | null, profile?: 'unwired' | 'absent' | 'found') => ({
      ok: true as const,
      data: {
        tradesTotal: 0,
        completed: 0,
        cancelled: 0,
        disputed: 0,
        disputesLost: 0,
        completionRate: 0,
        avgReleaseSecs: 0,
        badges: [],
        merchant: null,
        handle,
        memberSince: null,
        ...(profile ? { profile: { status: profile } } : {}),
      },
    });
    expect(renderToString(<TraderName record={record('test_friend', 'found')} />)).toContain('@test_friend');
    const absent = renderToString(<TraderName record={record(null, 'absent')} />);
    expect(absent).toContain('—');
    expect(absent).toContain('No public handle');
    for (const unknown of [record(null, 'unwired'), record(null)]) {
      const out = renderToString(<TraderName record={unknown} />);
      expect(out).toContain('Member');
      expect(out).not.toContain('No public handle');
    }
  });

  it('reads the profile status the service sends alongside a missing handle', async () => {
    const { reputationSchema } = await import('../schemas');
    const parsed = reputationSchema.safeParse({
      tradesTotal: 0,
      completed: 0,
      cancelled: 0,
      disputed: 0,
      disputesLost: 0,
      completionRate: 0,
      avgReleaseSecs: 0,
      badges: [],
      merchant: null,
      handle: null,
      memberSince: null,
      profile: { status: 'unwired', code: 'p2p.public_profile_unwired' },
      trades30d: 0,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('your own offer reads from the maker side', () => {
  it('says what you are doing, on both sides of the book', async () => {
    expect(p2pDepth.t('ownSell', { asset: 'USDT' })).toBe('Your offer: you sell USDT');
    expect(p2pDepth.t('ownBuy', { asset: 'USDT' })).toBe('Your offer: you buy USDT');
    expect(p2pDepth.t('sideBuyFrom', { asset: 'USDT' })).toBe('Buy USDT from this seller');
  });
});

describe('a completed order', () => {
  const done = fullTrade({ status: 'released', resolution: 'released', settledAt: '2026-10-18T10:05:00Z' });
  const recorded = fullTrade({ status: 'released', resolution: 'released', settledAt: null });
  it('tells the buyer what they received and paid, once the ledger has settled', () => {
    const out = renderToString(<OrderResult trade={done} seller={false} />);
    expect(out).toContain('You received');
    expect(out).toContain('10 USDT released from escrow, before any service fee');
    expect(out).toContain('You paid (external payment)');
    expect(out).toContain('10 USD');
  });
  it('tells the seller what left their escrow, with no fee row, since the fee comes out of the buyer’s share', () => {
    const out = renderToString(<OrderResult trade={done} seller />);
    expect(out).toContain('You sent');
    expect(out).toContain('10 USDT released from your escrow');
    expect(out).toContain('You received (external payment)');
    expect(out).not.toContain('Service fee');
    expect(out).not.toContain('released to the buyer');
  });
  it('does not invent a fee for the buyer, and never mentions a quote', () => {
    const out = renderToString(<OrderResult trade={done} seller={false} />);
    expect(out).toContain('Service fee');
    expect(out).toContain('Not on the order record this page reads. It is taken from the released amount.');
    expect(out).not.toMatch(/quote/i);
  });
  it('claims nothing was received until the ledger has settled', () => {
    for (const seller of [false, true]) {
      const out = renderToString(<OrderResult trade={recorded} seller={seller} />);
      expect(out).toContain('data-testid="order-result-unsettled"');
      expect(out).toContain('Release recorded. The ledger payout isn’t confirmed.');
      expect(out).not.toContain('You received');
      expect(out).not.toContain('You sent');
    }
  });
  it('words the unsettled line in Spanish and French', () => {
    for (const locale of ['es', 'fr'] as const)
      expect(orderCopy.forLocale(locale).t('releasePending')).not.toBe(orderCopy.forLocale('en').t('releasePending'));
  });
});

describe('an address segment placed in a query', () => {
  it('stays one value however it is written', () => {
    const room = findRoom('/p2p/orders/abc')!;
    const out = resolveAlias(room, '/p2p/orders/a%26next%3D%2Fevil');
    expect(out).toBeDefined();
    const query = new URLSearchParams(out!.split('?')[1]);
    expect([...query.keys()]).toEqual(['tradeId']);
  });
});
