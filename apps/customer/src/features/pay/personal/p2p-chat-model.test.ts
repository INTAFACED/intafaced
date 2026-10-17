import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../shared/api';
import type { ChatMessage, ChatPage, ChatSent, Contacts } from '../schemas';
import {
  ChatStore,
  POLL_ACTIVE_MS,
  POLL_CLOSED_MS,
  POLL_ERROR_MAX_MS,
  POLL_IDLE_MAX_MS,
  blockAndUnfollow,
  changeContact,
  chatTime,
  contactStanding,
  firstUnreadId,
  mergeMessages,
  pollDelay,
  readUnreadCounts,
  sendRefusalIsDefinite,
  senderRole,
  serviceFailureKind,
  type ChatPorts,
  type UnreadCount,
} from './p2p-chat-model';

const ME = 'b0000000-0000-4000-8000-000000000001';
const THEM = 's0000000-0000-4000-8000-000000000002';
const MOD = 'm0000000-0000-4000-8000-000000000003';
const TRADE = '11111111-1111-4111-8111-111111111111';

let seq = 0;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    id: `00000000-0000-4000-8000-00000000${n}`,
    tradeId: TRADE,
    senderId: THEM,
    clientId: `client-${n}`,
    text: `message ${n}`,
    createdAt: `2026-10-18T10:00:${String(seq).padStart(2, '0')}.000Z`,
    ...over,
  };
};
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const refuse = (
  reason: Extract<ApiResult<never>, { ok: false }>['reason'],
  extra: { code?: string; status?: number } = {},
): ApiResult<never> => ({
  ok: false,
  reason,
  message: 'service text that must never reach the screen',
  ...extra,
});
const page = (messages: ChatMessage[], over: Partial<ChatPage> = {}): ApiResult<ChatPage> =>
  ok({ messages, nextCursor: null, unread: 0, ...over });
const sent = (message: ChatMessage, over: Partial<ChatSent> = {}): ApiResult<ChatSent> =>
  ok({
    ...message,
    created: true,
    notify: { delivered: false, code: 'p2p.chat_notify_unwired' },
    ...over,
  });

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('refusals in plain kinds', () => {
  it.each([
    [{ reason: 'error', code: 'p2p.trade_not_found', status: 404 }, 'notParty'],
    [{ reason: 'forbidden', code: 'p2p.not_a_party', status: 403 }, 'notParty'],
    [{ reason: 'forbidden', code: 'p2p.contact_self', status: 403 }, 'self'],
    [{ reason: 'error', code: 'p2p.chat_text_required', status: 400 }, 'textRequired'],
    [{ reason: 'error', code: 'p2p.chat_attachment_unwired', status: 412 }, 'attachment'],
    [{ reason: 'error', code: 'p2p.idempotency_conflict', status: 409 }, 'conflict'],
    [{ reason: 'error', code: 'p2p.idempotency_in_progress', status: 409 }, 'inProgress'],
    [{ reason: 'forbidden', code: 'denied.kyc_required', status: 403 }, 'verify'],
    [{ reason: 'forbidden', code: 'denied.region_blocked', status: 403 }, 'region'],
    [{ reason: 'forbidden', code: 'denied.region_unknown', status: 403 }, 'region'],
    [{ reason: 'forbidden', code: 'FORBIDDEN', status: 403 }, 'readOnly'],
    [{ reason: 'unauthorized', status: 401 }, 'signIn'],
    [{ reason: 'uncertain', status: 502 }, 'unconfirmed'],
    [{ reason: 'unreachable' }, 'noService'],
    [{ reason: 'not_supported', status: 501 }, 'noService'],
    [{ reason: 'aborted', code: 'pay.p2p_view_changed' }, 'viewChanged'],
    [{ reason: 'error', status: 500 }, 'generic'],
  ] as const)('%j reads as %s', (failure, kind) => {
    expect(serviceFailureKind(failure)).toBe(kind);
  });

  it('knows a refusal that stored nothing from one that may have', () => {
    expect(sendRefusalIsDefinite({ reason: 'forbidden', status: 403 })).toBe(true);
    expect(sendRefusalIsDefinite({ reason: 'error', code: 'p2p.chat_text_required', status: 400 })).toBe(true);
    expect(sendRefusalIsDefinite({ reason: 'aborted' })).toBe(true);
    expect(sendRefusalIsDefinite({ reason: 'uncertain', status: 502 })).toBe(false);
    expect(sendRefusalIsDefinite({ reason: 'uncertain' })).toBe(false);
    expect(sendRefusalIsDefinite({ reason: 'error', code: 'p2p.idempotency_in_progress', status: 409 })).toBe(false);
    expect(sendRefusalIsDefinite({ reason: 'error', status: 500 })).toBe(false);
  });
});

describe('reading the thread', () => {
  it('keeps messages oldest first and never lists one twice', () => {
    const a = msg();
    const b = msg();
    const c = msg();
    const first = mergeMessages([a, c], [b, c]);
    expect(first.added).toBe(1);
    expect(first.messages.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(mergeMessages(first.messages, [a, b]).added).toBe(0);
  });

  it('names who wrote a message from the order, never from an id on screen', () => {
    const trade = { buyerId: ME, sellerId: THEM };
    expect(senderRole(ME, trade, ME)).toBe('you');
    expect(senderRole(THEM, trade, ME)).toBe('seller');
    expect(senderRole(ME, trade, THEM)).toBe('buyer');
    expect(senderRole(MOD, trade, ME)).toBe('moderator');
  });

  it('finds where the unread run starts from the count the service gave', () => {
    const a = msg({ senderId: THEM });
    const b = msg({ senderId: ME });
    const c = msg({ senderId: THEM });
    const d = msg({ senderId: ME });
    const e = msg({ senderId: THEM });
    expect(firstUnreadId([a, b, c, d, e], ME, 0)).toBeNull();
    expect(firstUnreadId([a, b, c, d, e], ME, 1)).toBe(e.id);
    expect(firstUnreadId([a, b, c, d, e], ME, 2)).toBe(c.id);
    expect(firstUnreadId([a, b, c, d, e], ME, 3)).toBe(a.id);
    expect(firstUnreadId([a, b, c, d, e], ME, 9)).toBeNull();
  });

  it('shows a clock time today and a date for older messages', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(chatTime('2026-10-18T10:05:00Z', 'en', now)).toMatch(/\d/);
    expect(chatTime('2026-10-10T10:05:00Z', 'en', now)).toMatch(/Oct/);
    expect(chatTime('garbage', 'en', now)).toBe('garbage');
  });

  it('polls quickly, slows when quiet, slows after errors and slows on a closed order', () => {
    expect(pollDelay({ quietRounds: 0, failures: 0, closed: false })).toBe(POLL_ACTIVE_MS);
    const quiet = [0, 1, 2, 3, 4, 5, 9].map((quietRounds) => pollDelay({ quietRounds, failures: 0, closed: false }));
    expect([...quiet].sort((x, y) => x - y)).toEqual(quiet);
    expect(quiet.at(-1)).toBe(POLL_IDLE_MAX_MS);
    expect(pollDelay({ quietRounds: 0, failures: 1, closed: false })).toBe(POLL_ACTIVE_MS * 2);
    expect(pollDelay({ quietRounds: 0, failures: 20, closed: false })).toBe(POLL_ERROR_MAX_MS);
    expect(pollDelay({ quietRounds: 0, failures: 0, closed: true })).toBe(POLL_CLOSED_MS);
  });
});

function harness(over: Partial<ChatPorts> = {}) {
  const list = vi.fn<ChatPorts['list']>(async () => page([]));
  const send = vi.fn<ChatPorts['send']>(async (text, clientId) => sent(msg({ senderId: ME, text, clientId })));
  let visible = true;
  let ids = 0;
  const store = new ChatStore({
    list,
    send,
    viewer: ME,
    newId: () => `id-${++ids}`,
    closed: () => false,
    visible: () => visible,
    ...over,
  });
  return {
    store,
    list,
    send,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
  };
}

describe('ChatStore: opening and polling', () => {
  it('reads every page, then reports the unread run it opened on', async () => {
    const a = msg();
    const b = msg({ senderId: ME });
    const c = msg();
    const h = harness();
    h.list
      .mockResolvedValueOnce(page([a, b], { nextCursor: b.id, unread: 2 }))
      .mockResolvedValueOnce(page([c], { nextCursor: null, unread: 2 }));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.list.mock.calls[0]![0]).toEqual({ cursor: null, limit: 100 });
    expect(h.list.mock.calls[1]![0]).toEqual({ cursor: b.id, limit: 100 });
    const state = h.store.getState();
    expect(state.phase).toBe('ready');
    expect(state.messages.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(state.unreadAtOpen).toBe(2);
    expect(state.firstUnread).toBe(a.id);
    h.store.stop();
  });

  it('asks only for what is new, and waits longer each quiet round', async () => {
    const a = msg();
    const h = harness();
    h.list.mockResolvedValueOnce(page([a]));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    // Messages just arrived, so the next read is quick.
    expect(h.store.getState().nextReadMs).toBe(POLL_ACTIVE_MS);
    await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.list.mock.calls[1]![0].cursor).toBe(a.id);
    // Nothing new: the wait grows.
    expect(h.store.getState().nextReadMs).toBe(Math.round(POLL_ACTIVE_MS * 1.5));
    await vi.advanceTimersByTimeAsync(7_500);
    expect(h.store.getState().nextReadMs).toBe(Math.round(POLL_ACTIVE_MS * 1.5 ** 2));
    h.store.stop();
  });

  it('returns to the quick pace when a message arrives', async () => {
    const h = harness();
    h.list.mockResolvedValue(page([]));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    const slow = h.store.getState().nextReadMs!;
    expect(slow).toBeGreaterThan(POLL_ACTIVE_MS);
    h.list.mockResolvedValueOnce(page([msg()]));
    await vi.advanceTimersByTimeAsync(slow);
    expect(h.store.getState().messages).toHaveLength(1);
    expect(h.store.getState().nextReadMs).toBe(POLL_ACTIVE_MS);
    h.store.stop();
  });

  it('does not read while the page is hidden, and reads at once when it is shown', async () => {
    const h = harness();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list).toHaveBeenCalledTimes(1);
    h.hide();
    h.store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.store.getState().nextReadMs).toBeNull();
    h.show();
    h.store.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list).toHaveBeenCalledTimes(2);
    h.store.stop();
  });

  it('stops reading when it is stopped', async () => {
    const h = harness();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    h.store.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it('reads a closed order slowly', async () => {
    const h = harness({ closed: () => true });
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().nextReadMs).toBe(POLL_CLOSED_MS);
    h.store.stop();
  });

  it('fails the first read without inventing an empty chat, then recovers', async () => {
    const h = harness();
    h.list.mockResolvedValueOnce(refuse('unreachable'));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().phase).toBe('failed');
    expect(h.store.getState().loadFailure).toBe('noService');
    h.list.mockResolvedValueOnce(page([msg()]));
    await h.store.refresh();
    expect(h.store.getState().phase).toBe('ready');
    expect(h.store.getState().loadFailure).toBeNull();
    expect(h.store.getState().messages).toHaveLength(1);
    h.store.stop();
  });

  it('keeps what was loaded when a later read fails, backs off, and clears the notice on success', async () => {
    const a = msg();
    const h = harness();
    h.list.mockResolvedValueOnce(page([a]));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    h.list.mockResolvedValue(refuse('unreachable'));
    await vi.advanceTimersByTimeAsync(7_500);
    expect(h.store.getState().refreshFailure).toBe('noService');
    expect(h.store.getState().messages).toEqual([a]);
    expect(h.store.getState().nextReadMs).toBe(POLL_ACTIVE_MS * 2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.getState().nextReadMs).toBe(POLL_ACTIVE_MS * 4);
    h.list.mockResolvedValue(page([]));
    await h.store.refresh();
    expect(h.store.getState().refreshFailure).toBeNull();
    h.store.stop();
  });

  it('maps a lost-access refusal on the first read to a plain kind', async () => {
    const h = harness();
    h.list.mockResolvedValueOnce(refuse('error', { code: 'p2p.trade_not_found', status: 404 }));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState()).toMatchObject({ phase: 'failed', loadFailure: 'notParty' });
    h.store.stop();
  });
});

describe('ChatStore: sending without double-posting', () => {
  async function ready() {
    const h = harness();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    return h;
  }

  it('sends trimmed text under a client id, shows it once, and notes when the other side was not alerted', async () => {
    const h = await ready();
    const outcome = await h.store.send('  hello there  ');
    expect(outcome).toEqual({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith('hello there', 'id-1');
    const state = h.store.getState();
    expect(state.pending).toEqual([]);
    expect(state.messages.map((m) => m.text)).toEqual(['hello there']);
    expect(state.lastNotified).toBe(false);
    // The next read returns the same message: still one.
    h.list.mockResolvedValueOnce(page(state.messages));
    await h.store.refresh();
    expect(h.store.getState().messages).toHaveLength(1);
    h.store.stop();
  });

  it('shows the message as sending while the service has not answered', async () => {
    const h = await ready();
    let answer!: (value: ApiResult<ChatSent>) => void;
    h.send.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const pending = h.store.send('slow one');
    expect(h.store.getState().pending).toMatchObject([{ text: 'slow one', status: 'sending' }]);
    answer(sent(msg({ senderId: ME, text: 'slow one', clientId: 'id-1' })));
    await pending;
    expect(h.store.getState().pending).toEqual([]);
    h.store.stop();
  });

  it('refuses an empty or over-long message before any request', async () => {
    const h = await ready();
    expect(await h.store.send('   ')).toEqual({ ok: false, kind: 'empty' });
    expect(await h.store.send('x'.repeat(2001))).toEqual({ ok: false, kind: 'tooLong' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.store.getState().pending).toEqual([]);
    h.store.stop();
  });

  it('after a lost reply, reads first: a message the service stored is not sent again', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain', { status: 502 }));
    expect(await h.store.send('pay is on its way')).toEqual({ ok: false, kind: 'unconfirmed' });
    expect(h.store.getState().pending).toMatchObject([{ clientId: 'id-1', status: 'unconfirmed', failure: 'unconfirmed' }]);
    // The service did store it under that client id.
    const stored = msg({ senderId: ME, text: 'pay is on its way', clientId: 'id-1' });
    h.list.mockResolvedValueOnce(page([stored]));
    expect(await h.store.resend('id-1')).toEqual({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.store.getState().pending).toEqual([]);
    expect(h.store.getState().messages.map((m) => m.text)).toEqual(['pay is on its way']);
    h.store.stop();
  });

  it('when the service has no such message, sends again under the SAME client id', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain'));
    await h.store.send('hello');
    expect(await h.store.resend('id-1')).toEqual({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]).toEqual(['hello', 'id-1']);
    expect(h.store.getState().messages).toHaveLength(1);
    expect(h.store.getState().pending).toEqual([]);
    h.store.stop();
  });

  it('does not send blind when the re-read itself fails', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain'));
    await h.store.send('hello');
    h.list.mockResolvedValueOnce(refuse('unreachable'));
    expect(await h.store.resend('id-1')).toEqual({ ok: false, kind: 'noService' });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.store.getState().pending).toMatchObject([{ status: 'unconfirmed' }]);
    h.store.stop();
  });

  it('keeps a clearly refused message as not sent, with the reason, and lets it be edited or dropped', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('forbidden', { code: 'FORBIDDEN', status: 403 }));
    expect(await h.store.send('hello')).toEqual({ ok: false, kind: 'readOnly' });
    expect(h.store.getState().pending).toMatchObject([{ status: 'failed', failure: 'readOnly', text: 'hello' }]);
    expect(await h.store.take('id-1')).toEqual({ status: 'text', text: 'hello', clientId: 'id-1' });
    expect(h.store.getState().pending).toEqual([]);
    expect(await h.store.take('id-1')).toEqual({ status: 'sent' });
    h.store.stop();
  });

  it('looks for an unconfirmed message before giving its text back, so editing cannot post it twice', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain', { status: 502 }));
    await h.store.send('paid');
    // The service had stored it under that client id.
    h.list.mockResolvedValueOnce(page([msg({ senderId: ME, text: 'paid', clientId: 'id-1' })]));
    expect(await h.store.take('id-1')).toEqual({ status: 'sent' });
    expect(h.store.getState().pending).toEqual([]);
    expect(h.store.getState().messages.map((m) => m.text)).toEqual(['paid']);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.store.stop();
  });

  it('gives an unconfirmed message’s text back only after a read that finished without it', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain'));
    await h.store.send('paid');
    h.list.mockResolvedValueOnce(page([]));
    expect(await h.store.take('id-1')).toEqual({ status: 'text', text: 'paid', clientId: 'id-1' });
    expect(h.store.getState().pending).toEqual([]);
    h.store.stop();
  });

  it('keeps an unconfirmed message when the check itself fails, and says why', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain'));
    await h.store.send('paid');
    h.list.mockResolvedValueOnce(refuse('unreachable'));
    expect(await h.store.take('id-1')).toEqual({ status: 'unchecked', kind: 'noService' });
    expect(h.store.getState().pending).toMatchObject([{ status: 'unconfirmed', failure: 'noService', text: 'paid' }]);
    h.store.stop();
  });

  it('does not resend after a read that did not finish', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('uncertain'));
    await h.store.send('hello');
    h.list.mockResolvedValueOnce(refuse('aborted', { code: 'pay.p2p_view_changed' }));
    expect(await h.store.resend('id-1')).toEqual({ ok: false, kind: 'unconfirmed' });
    expect(h.send).toHaveBeenCalledTimes(1);
    h.store.stop();
  });

  it('gives text a fresh client id when the old one was already used for different text', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('error', { code: 'p2p.idempotency_conflict', status: 409 }));
    await h.store.send('hello');
    const [held] = h.store.getState().pending;
    expect(held).toMatchObject({ status: 'failed', failure: 'conflict' });
    expect(held!.clientId).not.toBe('id-1');
    h.store.stop();
  });

  it('treats “still being saved” as unconfirmed, so the check runs before another send', async () => {
    const h = await ready();
    h.send.mockResolvedValueOnce(refuse('error', { code: 'p2p.idempotency_in_progress', status: 409 }));
    await h.store.send('hello');
    expect(h.store.getState().pending).toMatchObject([{ status: 'unconfirmed', failure: 'inProgress' }]);
    h.store.stop();
  });

  it('two different messages get two different client ids', async () => {
    const h = await ready();
    await h.store.send('one');
    await h.store.send('two');
    expect(h.send.mock.calls.map((call) => call[1])).toEqual(['id-1', 'id-2']);
    h.store.stop();
  });

  it('removes a held message when a background read lists it, however its own reply went', async () => {
    const h = await ready();
    let answer!: (value: ApiResult<ChatSent>) => void;
    h.send.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const pending = h.store.send('hello');
    h.list.mockResolvedValueOnce(page([msg({ senderId: ME, text: 'hello', clientId: 'id-1' })]));
    await h.store.refresh();
    expect(h.store.getState().pending).toEqual([]);
    answer(refuse('uncertain'));
    await pending;
    // The late failure patches nothing that is no longer held.
    expect(h.store.getState().messages).toHaveLength(1);
    expect(h.store.getState().pending).toMatchObject([]);
    h.store.stop();
  });
});

describe('unread counts for the order list', () => {
  it('reads each order, at most four at once, and marks a failed read as failed rather than zero', async () => {
    let running = 0;
    let most = 0;
    const seen: Record<string, UnreadCount> = {};
    const ids = Array.from({ length: 10 }, (_, i) => `order-${i}`);
    await readUnreadCounts(
      async (id) => {
        running += 1;
        most = Math.max(most, running);
        await Promise.resolve();
        running -= 1;
        return id === 'order-3' ? refuse('unreachable') : ok({ unread: id === 'order-5' ? 7 : 0 });
      },
      [...ids, 'order-1'],
      new AbortController().signal,
      (id, count) => {
        seen[id] = count;
      },
    );
    expect(most).toBeLessThanOrEqual(4);
    expect(Object.keys(seen)).toHaveLength(10);
    expect(seen['order-5']).toEqual({ status: 'ready', count: 7 });
    expect(seen['order-0']).toEqual({ status: 'ready', count: 0 });
    expect(seen['order-3']).toEqual({ status: 'failed' });
  });

  it('stops asking when the page leaves', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {
      controller.abort();
      return ok({ unread: 1 });
    });
    const seen = vi.fn();
    await readUnreadCounts(read, ['a', 'b', 'c', 'd', 'e', 'f'], controller.signal, seen, 1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('follow and block', () => {
  it('sends the account id in lower case', async () => {
    const setContact = vi.fn<(change: string, peer: string, key: string) => Promise<ApiResult<Contacts>>>(async () =>
      ok({ following: [], blocking: [] }),
    );
    await changeContact({ setContact }, new Map(), () => 'k', 'block', THEM.toUpperCase());
    expect(setContact).toHaveBeenCalledWith('block', THEM, 'contact:block:k');
  });

  it('unfollows first when blocking someone you follow, each change under its own key', async () => {
    const setContact = vi
      .fn<(change: string, peer: string, key: string) => Promise<ApiResult<Contacts>>>()
      .mockResolvedValueOnce(ok({ following: [], blocking: [] }))
      .mockResolvedValueOnce(ok({ following: [], blocking: [THEM] }));
    const outcome = await blockAndUnfollow({ setContact }, new Map(), () => 'k', THEM, true);
    expect(outcome).toEqual({ ok: true, contacts: { following: [], blocking: [THEM] } });
    expect(setContact.mock.calls.map((call) => call[0])).toEqual(['unfollow', 'block']);
    expect(new Set(setContact.mock.calls.map((call) => call[2])).size).toBe(2);
  });

  it('only blocks when you did not follow them', async () => {
    const setContact = vi.fn<(change: string, peer: string, key: string) => Promise<ApiResult<Contacts>>>(async () =>
      ok({ following: [], blocking: [THEM] }),
    );
    await blockAndUnfollow({ setContact }, new Map(), () => 'k', THEM, false);
    expect(setContact.mock.calls.map((call) => call[0])).toEqual(['block']);
  });

  it('does not block when the unfollow fails', async () => {
    const setContact = vi.fn(async () => refuse('forbidden', { code: 'FORBIDDEN', status: 403 }));
    expect(await blockAndUnfollow({ setContact }, new Map(), () => 'k', THEM, true)).toEqual({ ok: false, kind: 'readOnly' });
    expect(setContact).toHaveBeenCalledTimes(1);
  });

  it('returns the lists after the unfollow when the block then fails', async () => {
    const setContact = vi
      .fn<(change: string, peer: string, key: string) => Promise<ApiResult<Contacts>>>()
      .mockResolvedValueOnce(ok({ following: [], blocking: [] }))
      .mockResolvedValueOnce(refuse('uncertain', { status: 502 }));
    expect(await blockAndUnfollow({ setContact }, new Map(), () => 'k', THEM, true)).toEqual({
      ok: false,
      kind: 'unconfirmed',
      contacts: { following: [], blocking: [] },
    });
  });

  const lists = (over: Partial<Contacts> = {}): Contacts => ({ following: [], blocking: [], ...over });

  it('reads standing from the service lists, without regard to case', () => {
    const contacts = lists({ following: [THEM.toUpperCase()], blocking: [MOD] });
    expect(contactStanding(contacts, THEM)).toEqual({ following: true, blocking: false });
    expect(contactStanding(contacts, MOD)).toEqual({ following: false, blocking: true });
    expect(contactStanding(contacts, ME)).toEqual({ following: false, blocking: false });
  });

  it('returns the service’s own lists after a change, and sends one idempotency key per change', async () => {
    const setContact = vi.fn(async () => ok(lists({ following: [THEM] })));
    const keys = new Map<string, string>();
    const outcome = await changeContact({ setContact }, keys, () => 'abc', 'follow', THEM);
    expect(outcome).toEqual({ ok: true, contacts: lists({ following: [THEM] }) });
    expect(setContact).toHaveBeenCalledWith('follow', THEM, 'contact:follow:abc');
    expect(keys.size).toBe(0);
  });

  it('repeats the same key after a lost reply, so the change cannot be made twice', async () => {
    const setContact = vi
      .fn<(change: string, peer: string, key: string) => Promise<ApiResult<Contacts>>>()
      .mockResolvedValueOnce(refuse('uncertain', { status: 502 }))
      .mockResolvedValueOnce(ok(lists({ blocking: [THEM] })));
    const keys = new Map<string, string>();
    let n = 0;
    const newId = () => `k${++n}`;
    expect(await changeContact({ setContact }, keys, newId, 'block', THEM)).toEqual({ ok: false, kind: 'unconfirmed' });
    expect(await changeContact({ setContact }, keys, newId, 'block', THEM)).toMatchObject({ ok: true });
    expect(setContact.mock.calls.map((call) => call[2])).toEqual(['contact:block:k1', 'contact:block:k1']);
  });

  it('uses a new key after a clear refusal', async () => {
    const setContact = vi
      .fn<(change: string, peer: string, key: string) => Promise<ApiResult<Contacts>>>()
      .mockResolvedValueOnce(refuse('forbidden', { code: 'FORBIDDEN', status: 403 }))
      .mockResolvedValueOnce(ok(lists({ following: [THEM] })));
    const keys = new Map<string, string>();
    let n = 0;
    const newId = () => `k${++n}`;
    expect(await changeContact({ setContact }, keys, newId, 'follow', THEM)).toEqual({ ok: false, kind: 'readOnly' });
    await changeContact({ setContact }, keys, newId, 'follow', THEM);
    expect(setContact.mock.calls.map((call) => call[2])).toEqual(['contact:follow:k1', 'contact:follow:k2']);
  });

  it('maps the service’s self refusal and sign-in refusal to plain kinds', async () => {
    const keys = new Map<string, string>();
    const self = { setContact: async () => refuse('forbidden', { code: 'p2p.contact_self', status: 403 }) };
    expect(await changeContact(self, keys, () => 'x', 'follow', ME)).toEqual({ ok: false, kind: 'self' });
    const signedOut = { setContact: async () => refuse('unauthorized', { status: 401 }) };
    expect(await changeContact(signedOut, keys, () => 'x', 'follow', THEM)).toEqual({ ok: false, kind: 'signIn' });
  });
});

describe('text handed back after an unconfirmed send', () => {
  it('keeps its message id, so sending it unchanged cannot post twice even if the service finished saving late', async () => {
    const h = harness();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    h.send.mockResolvedValueOnce(refuse('uncertain'));
    await h.store.send('paid');
    // The check finds nothing (the row had not committed yet), so the text is released with its id.
    h.list.mockResolvedValueOnce(page([]));
    const taken = await h.store.take('id-1');
    expect(taken).toEqual({ status: 'text', text: 'paid', clientId: 'id-1' });
    // Sent again unchanged under that id: the service, which has by now stored the first, answers created:false.
    h.send.mockImplementationOnce(async (text, clientId) => sent(msg({ senderId: ME, text, clientId }), { created: false }));
    if (taken.status === 'text') await h.store.send(taken.text, taken.clientId);
    expect(h.send.mock.calls.map((call) => call[1])).toEqual(['id-1', 'id-1']);
    expect(h.store.getState().messages).toHaveLength(1);
    h.store.stop();
  });

  it('uses a fresh id for a new message', async () => {
    const h = harness();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.store.send('one');
    await h.store.send('two');
    expect(h.send.mock.calls.map((call) => call[1])).toEqual(['id-1', 'id-2']);
    h.store.stop();
  });
});

describe('reading only what is on screen', () => {
  function viewing() {
    let inView = false;
    const unread = vi.fn<NonNullable<ChatPorts['unread']>>(async () => ok({ unread: 3 }));
    const h = harness({ inView: () => inView, unread });
    return {
      ...h,
      unread,
      see: () => {
        inView = true;
        h.store.visibilityChanged();
      },
      leave: () => {
        inView = false;
        h.store.visibilityChanged();
      },
    };
  }

  it('counts unread without reading the thread while the chat is off screen, so nothing is marked read', async () => {
    const h = viewing();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.unread).toHaveBeenCalledTimes(1);
    expect(h.store.getState().unreadBelow).toBe(3);
    expect(h.store.getState().phase).toBe('loading');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.unread.mock.calls.length).toBeGreaterThan(1);
    h.store.stop();
  });

  it('reads the thread when it comes into view, and clears the count below', async () => {
    const h = viewing();
    h.list.mockResolvedValue(page([msg()], { unread: 3 }));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    h.see();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.store.getState()).toMatchObject({ phase: 'ready', unreadBelow: null, unreadAtOpen: 3 });
    h.store.stop();
  });

  it('goes back to counting when the chat scrolls out of view', async () => {
    const h = viewing();
    h.store.start();
    h.see();
    await vi.advanceTimersByTimeAsync(0);
    const reads = h.list.mock.calls.length;
    h.leave();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.list.mock.calls.length).toBe(reads);
    expect(h.unread).toHaveBeenCalled();
    h.store.stop();
  });

  it.each([
    ['notParty', refuse('error', { code: 'p2p.trade_not_found', status: 404 })],
    ['signIn', refuse('unauthorized', { status: 401 })],
  ] as const)('stops counting unread after %s', async (_name, failure) => {
    const h = viewing();
    h.unread.mockResolvedValue(failure);
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.unread).toHaveBeenCalledTimes(1);
    expect(h.store.getState().nextReadMs).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.unread).toHaveBeenCalledTimes(1);
    h.store.stop();
  });

  it('keeps counting after a failure that can pass', async () => {
    const h = viewing();
    h.unread.mockResolvedValueOnce(refuse('unreachable'));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().nextReadMs).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.unread.mock.calls.length).toBeGreaterThan(1);
    h.store.stop();
  });

  it('still reads the thread when the person presses refresh', async () => {
    const h = viewing();
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.store.refresh();
    expect(h.list).toHaveBeenCalledTimes(1);
    h.store.stop();
  });
});

describe('a reply no retry can change', () => {
  it.each([
    ['notParty', refuse('error', { code: 'p2p.trade_not_found', status: 404 })],
    ['signIn', refuse('unauthorized', { status: 401 })],
  ] as const)('stops polling after %s, and “Try again” still works', async (_name, failure) => {
    const h = harness();
    h.list.mockResolvedValueOnce(failure);
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().phase).toBe('failed');
    expect(h.store.getState().nextReadMs).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.list).toHaveBeenCalledTimes(1);
    h.list.mockResolvedValueOnce(page([msg()]));
    await h.store.refresh();
    expect(h.store.getState().phase).toBe('ready');
    h.store.stop();
  });

  it('keeps polling after a failure that can pass', async () => {
    const h = harness();
    h.list.mockResolvedValueOnce(refuse('unreachable'));
    h.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.getState().nextReadMs).not.toBeNull();
  });
});

describe('which orders get an unread timer', () => {
  it('reads every order once and re-reads only the open ones', async () => {
    const { unreadTargets } = await import('./Unread');
    const targets = unreadTargets([
      { id: 'a', status: 'escrowed' },
      { id: 'b', status: 'released' },
      { id: 'c', status: 'cancelled' },
      { id: 'd', status: 'disputed' },
      { id: 'a', status: 'escrowed' },
    ]);
    expect(targets.all).toBe('a,b,c,d');
    expect(targets.open).toBe('a,d');
  });
});
