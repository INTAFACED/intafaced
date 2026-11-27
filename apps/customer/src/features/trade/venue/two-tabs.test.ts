import { describe, expect, it, vi } from 'vitest';
import {
  answerSessionKeyAsks,
  freshKey,
  heldKey,
  keyFromOtherTab,
  orderKey,
  type HeldKey,
  type KeyChannel,
  type SessionView,
} from '../../protocol';
import { forgetDeviceSessionKeys } from '../../../shared/device-session-key';
import { startSession, type SessionStartDeps } from './session-signer';

// One tester, two tabs of one browser. The venue keeps one session key per account, so a second tab that made its
// own key took the first tab's away, and each switch back cost a passkey approval. Now a tab that sees this sign-in's
// session live under a key it does not hold asks the browser's other tabs for it (a same-origin channel: the key never
// leaves the browser), and each tab numbers its own orders in its own lane, so two tabs never reuse an order's key.

/** One browser: every tab's channel hears every other tab's messages, never its own (as BroadcastChannel does). */
function browser() {
  const open: Array<KeyChannel & { onmessage: ((event: { data: unknown }) => void) | null }> = [];
  return () => {
    const channel: KeyChannel & { onmessage: ((event: { data: unknown }) => void) | null } = {
      onmessage: null,
      postMessage: (data: unknown) => {
        for (const other of open) if (other !== channel) queueMicrotask(() => other.onmessage?.({ data: structuredClone(data) }));
      },
      close: () => void open.splice(open.indexOf(channel), 1),
    };
    open.push(channel);
    return channel;
  };
}

function tabStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
  };
}

const OWNER = '0x1111111111111111111111111111111111111111';
const liveView = (agentAddress: string): SessionView => ({
  sessionId: 'fam.1',
  actionKey: 'session-key:u:v:fam.1',
  agentAddress,
  validUntil: null,
  state: 'live',
  replacedBy: null,
  refusal: null,
});

describe('two tabs of one tester share the one session key', () => {
  it('a second tab gets the live key from the first, with no new approval, and numbers its orders in its own lane', async () => {
    const channel = browser();
    const tabA = tabStorage();
    const tabB = tabStorage();
    const keyA = freshKey('user-1', tabA);
    const stop = answerSessionKeyAsks({ open: channel, store: tabA });

    const keyB = await keyFromOtherTab('user-1', keyA.address, { open: channel, store: tabB, waitMs: 50 });
    expect(keyB).toMatchObject({ address: keyA.address, privateKey: keyA.privateKey, nextTicket: 1, pendingOrder: null, lane: '1' });
    expect(heldKey('user-1', tabB)).toEqual(keyB);
    // Tab A's own key and ticket are untouched.
    expect(heldKey('user-1', tabA)).toEqual(keyA);
    // The same ticket in each tab is a different order.
    expect(orderKey('user-1', 'fam.1', 1, keyA.lane)).toBe('order:user-1:session:fam.1:1');
    expect(orderKey('user-1', 'fam.1', 1, keyB!.lane)).toBe('order:user-1:session:fam.1:1-1');

    // A third tab gets the next lane from A, and a tab B hands on numbers under B's lane: no two tabs share one.
    const tabC = tabStorage();
    expect((await keyFromOtherTab('user-1', keyA.address, { open: channel, store: tabC, waitMs: 50 }))?.lane).toBe('2');
    stop();
    const stopB = answerSessionKeyAsks({ open: channel, store: tabB });
    const tabD = tabStorage();
    expect((await keyFromOtherTab('user-1', keyA.address, { open: channel, store: tabD, waitMs: 50 }))?.lane).toBe('1.1');
    stopB();
  });

  it('Start in the second tab joins the live session instead of approving a key that takes the first tab’s away', async () => {
    const channel = browser();
    const tabA = tabStorage();
    const keyA = freshKey('user-1', tabA);
    const stop = answerSessionKeyAsks({ open: channel, store: tabA });
    const tabB = tabStorage();
    const d = {
      sessions: { start: vi.fn<SessionStartDeps['sessions']['start']>() },
      submit: vi.fn<SessionStartDeps['submit']>(),
      sign: vi.fn<SessionStartDeps['sign']>(),
      userId: 'user-1',
      owner: OWNER,
      current: liveView(keyA.address),
      held: null as HeldKey | null,
      hold: vi.fn<SessionStartDeps['hold']>(),
      forget: vi.fn<SessionStartDeps['forget']>(),
      store: tabB,
      join: (address: string) => keyFromOtherTab('user-1', address, { open: channel, store: tabB, waitMs: 50 }),
    };
    expect(await startSession(d)).toEqual({ kind: 'joined' });
    expect(d.sessions.start).not.toHaveBeenCalled();
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.hold).toHaveBeenCalledWith(expect.objectContaining({ address: keyA.address, lane: '1' }));
    stop();
  });

  it('with no tab holding the live key, Start approves a fresh one as before', async () => {
    const channel = browser();
    const tabB = tabStorage();
    const elsewhere = '0x2222222222222222222222222222222222222222';
    expect(await keyFromOtherTab('user-1', elsewhere, { open: channel, store: tabB, waitMs: 20 })).toBeNull();
    expect(heldKey('user-1', tabB)).toBeNull();
  });

  it('an answer whose key does not sign for the address asked is not taken', async () => {
    const channel = browser();
    const tabA = tabStorage();
    const keyA = freshKey('user-1', tabA);
    const liar = channel();
    liar.onmessage = ({ data }) => {
      const ask = data as { ask: string; address: string };
      liar.postMessage({ type: 'give', ask: ask.ask, address: ask.address, privateKey: `0x${'22'.repeat(32)}`, lane: '1' });
    };
    const tabB = tabStorage();
    expect(await keyFromOtherTab('user-1', keyA.address, { open: channel, store: tabB, waitMs: 50 })).toBeNull();
    expect(heldKey('user-1', tabB)).toBeNull();
  });

  it('a tab that signed out holds nothing and hands nothing on', async () => {
    const channel = browser();
    const tabA = tabStorage();
    const keyA = freshKey('user-1', tabA);
    const stop = answerSessionKeyAsks({ open: channel, store: tabA });
    forgetDeviceSessionKeys(tabA);
    expect(tabA.length).toBe(0);
    expect(await keyFromOtherTab('user-1', keyA.address, { open: channel, store: tabStorage(), waitMs: 20 })).toBeNull();
    stop();
  });

  it('a tab asks only for its own person’s key: another person’s key in a tab is never handed on', async () => {
    const channel = browser();
    const tabA = tabStorage();
    const keyA = freshKey('user-1', tabA);
    const stop = answerSessionKeyAsks({ open: channel, store: tabA });
    expect(await keyFromOtherTab('user-2', keyA.address, { open: channel, store: tabStorage(), waitMs: 20 })).toBeNull();
    stop();
  });

  it('over the browser’s own channel, as the app opens it', async () => {
    const tabA = tabStorage();
    const keyA = freshKey('user-1', tabA);
    const stop = answerSessionKeyAsks({ store: tabA });
    const keyB = await keyFromOtherTab('user-1', keyA.address, { store: tabStorage(), waitMs: 2000 });
    expect(keyB).toMatchObject({ address: keyA.address, privateKey: keyA.privateKey, lane: '1' });
    stop();
  });
});
