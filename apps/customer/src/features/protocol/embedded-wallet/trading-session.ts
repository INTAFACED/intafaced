import {
  builderFeeApprovalSchema,
  tradingDoorStatusSchema,
  tradingPreparedSchema,
  tradingSessionPreparedSchema,
  tradingSessionStatusSchema,
  tradingSubmitSchema,
  type TradingDoorStatus,
  type TradingPrepared,
  type TradingSessionState,
  type TradingSessionStatus,
  type TradingSessionView,
  type TradingSubmitAnswer,
} from '@intafaced/contracts/protocol-trading-session';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ApiClient } from '../../../shared/api';
import { DEVICE_SESSION_KEY_PREFIX } from '../../../shared/device-session-key';
import { heldSchema, keyAskSchema, keyGiveSchema, lanesGivenSchema } from './held-key';

/**
 * The trading session (J-wallet-22 #8, slice D-venue-09): one approval per session, signed by the person's wallet after
 * their passkey, for a FRESH session key made here, on this device, beside the wallet provider's client. The key can
 * trade on the venue and can never withdraw or approve; orders in the session are signed by it with no passkey.
 *
 * The key never leaves this browser in a form that can sign: svc-trade is told its address only
 * (`POST /api/v1/venue/session/start`), and the key itself is kept in each tab's sessionStorage, which the browser
 * clears when the tab closes, and which a sign-out empties at once (shared/device-session-key.ts). The venue keeps one
 * key per account, so the person's other tabs share it rather than each approving its own: a tab that sees the live
 * session under a key it does not hold asks the browser's other tabs for it over a same-origin channel
 * (`keyFromOtherTab`, answered by `answerSessionKeyAsks`). It is used only
 * while svc-trade's record for THIS sign-in names the same address and the venue lists it live; after a sign-out the
 * next sign-in has no session, and the next session approves a new key. A key once used is never approved again (svc-trade refuses it).
 */

export type {
  TradingDoorStatus as DoorStatus,
  TradingPrepared as Prepared,
  TradingSessionState as SessionState,
  TradingSessionStatus as SessionStatus,
  TradingSessionView as SessionView,
  TradingSubmitAnswer as SubmitAnswer,
};

export interface VenueSignature {
  readonly digest: string;
  readonly signature: string;
  readonly signedBy: string;
}

export function createTradingSessionApi(api: ApiClient) {
  const owner = (address: string) => ({ owner: address.toLowerCase() });
  return {
    door: (signal?: AbortSignal) => api.rest('/venue/status', tradingDoorStatusSchema, { signal }),
    session: (address: string, signal?: AbortSignal) =>
      api.rest('/venue/session', tradingSessionStatusSchema, { query: owner(address), signal }),
    builderFeeApproval: (address: string, signal?: AbortSignal) =>
      api.rest('/venue/builder-fee-approval', builderFeeApprovalSchema, { query: owner(address), signal }),
    start: (address: string, agentAddress: string) =>
      api.rest('/venue/session/start', tradingSessionPreparedSchema, {
        method: 'POST',
        body: { ...owner(address), agentAddress },
      }),
    end: (address: string) => api.rest('/venue/session/end', tradingSessionPreparedSchema, { method: 'POST', body: owner(address) }),
    prepare: (body: unknown) => api.rest('/venue/prepare', tradingPreparedSchema, { method: 'POST', body }),
    submit: (actionKey: string, signature: VenueSignature) =>
      api.rest('/venue/submit', tradingSubmitSchema, { method: 'POST', body: { actionKey, signature } }),
  };
}
export type TradingSessionApi = ReturnType<typeof createTradingSessionApi>;

// ── the session key, on this device only ────────────────────────────────────────────────────────────────────────────

/** An order sent with no definite answer yet: the next press re-sends this same order, whatever the form now says. */
export interface PendingOrder {
  readonly key: string;
  readonly intent: Record<string, unknown>;
}

export interface HeldKey {
  readonly address: string;
  readonly privateKey: `0x${string}`;
  /** The session ticket's next order count: kept with the key, so a reload never reuses an order's business key. */
  readonly nextTicket: number;
  readonly pendingOrder: PendingOrder | null;
  /** This tab's own ticket lane under the key ('' for the tab that made it), so two tabs never number one order alike. */
  readonly lane?: string;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storeKey = (userId: string) => `${DEVICE_SESSION_KEY_PREFIX}${userId}`;
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The key this tab holds for the person, if any. */
export function heldKey(userId: string, store: Storage | null = storage()): HeldKey | null {
  try {
    const raw = store?.getItem(storeKey(userId));
    const parsed = raw ? heldSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? { ...parsed.data, privateKey: parsed.data.privateKey as `0x${string}` } : null;
  } catch {
    return null;
  }
}

/** A fresh key, made here and kept in this tab. Never sent anywhere; its address is what svc-trade is told. */
export function freshKey(userId: string, store: Storage | null = storage(), make: () => `0x${string}` = generatePrivateKey): HeldKey {
  const privateKey = make();
  return keepKey(
    userId,
    { address: privateKeyToAccount(privateKey).address.toLowerCase(), privateKey, nextTicket: 1, pendingOrder: null, lane: '' },
    store,
  );
}

/** Keep the key's ticket state in this tab. */
export function keepKey(userId: string, key: HeldKey, store: Storage | null = storage()): HeldKey {
  try {
    store?.setItem(storeKey(userId), JSON.stringify(key));
  } catch {
    /* a tab that cannot keep it still signs with it until it is closed or reloaded */
  }
  return key;
}

export function dropKey(userId: string, store: Storage | null = storage()): void {
  try {
    store?.removeItem(storeKey(userId));
  } catch {
    /* nothing kept */
  }
}

/**
 * Whether the key this tab holds is this sign-in's session key: svc-trade's record for this sign-in names the same
 * address. A key for an approval still out (awaiting the wallet, or sent with no answer) is kept, so the retry is the
 * same approval. Any other key (a session that ended, expired or was replaced, or one from an earlier sign-in) is
 * dropped and never offered again: the next session makes a new one.
 */
export function keyFor(current: TradingSessionView | null, held: HeldKey | null): 'use' | 'pending' | 'drop' | 'none' {
  if (!held) return 'none';
  if (!current || current.agentAddress.toLowerCase() !== held.address) return 'drop';
  if (current.state === 'live') return 'use';
  if (current.state === 'awaiting_signature' || current.state === 'approving') return 'pending';
  return 'drop';
}

/** The session key signs a prepared action itself: no passkey, no provider, nothing leaves the tab but the signature. */
export async function signWithSessionKey(key: HeldKey, prepared: TradingPrepared['prepared']): Promise<VenueSignature> {
  const t = prepared.typedData as Parameters<ReturnType<typeof privateKeyToAccount>['signTypedData']>[0];
  const signature = await privateKeyToAccount(key.privateKey).signTypedData(t);
  return { digest: prepared.digest, signature, signedBy: key.address };
}

/**
 * The business key of one order from the session's ticket: the session, the tab's lane under the key and the ticket's
 * own count, never a random id.
 */
export const orderKey = (userId: string, sessionId: string, ticket: number, lane = '') =>
  `order:${userId}:session:${sessionId}:${lane ? `${lane}-` : ''}${ticket}`;

// ── the one key, shared by the person's tabs ────────────────────────────────────────────────────────────────────────

/** The browser's same-origin channel between this person's tabs: nothing on it reaches a server. */
export type KeyChannel = {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
const SESSION_KEY_CHANNEL = 'intafaced.venue-session-key';
function browserChannel(): KeyChannel | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    const channel = new BroadcastChannel(SESSION_KEY_CHANNEL);
    let heard: KeyChannel['onmessage'] = null;
    return {
      postMessage: (message) => channel.postMessage(message),
      close: () => channel.close(),
      get onmessage() {
        return heard;
      },
      set onmessage(handler) {
        heard = handler;
        channel.onmessage = handler ? (event) => handler({ data: event.data }) : null;
      },
    };
  } catch {
    return null;
  }
}
type ChannelDeps = { open?: () => KeyChannel | null; store?: Storage | null };
const lanesKey = (userId: string) => `${storeKey(userId)}:lanes`;

/** The next lane under `held` for a tab this one hands the key to: `1`, `2`, … under the maker, `1.1` under lane `1`. */
function nextLane(userId: string, held: HeldKey, store: Storage | null): string {
  let given = 0;
  try {
    const raw = store?.getItem(lanesKey(userId));
    const parsed = raw ? lanesGivenSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success && parsed.data.address === held.address) given = parsed.data.given;
    store?.setItem(lanesKey(userId), JSON.stringify({ address: held.address, given: given + 1 }));
  } catch {
    /* a tab that cannot count its lanes still hands on a distinct one this time */
  }
  return held.lane ? `${held.lane}.${given + 1}` : `${given + 1}`;
}

/**
 * This tab answers the person's other tabs: an ask for the key it holds for that person, at that address, is answered
 * with the key and a lane of the asker's own. Started once with the app (main.tsx); a key this tab no longer holds (a
 * sign-out, an ended session) is never handed on.
 */
export function answerSessionKeyAsks({ open = browserChannel, store = storage() }: ChannelDeps = {}): () => void {
  const channel = open();
  if (!channel) return () => {};
  channel.onmessage = (event) => {
    const ask = keyAskSchema.safeParse(event.data);
    if (!ask.success) return;
    const held = heldKey(ask.data.userId, store);
    if (!held || held.address !== ask.data.address) return;
    channel.postMessage({
      type: 'give',
      ask: ask.data.ask,
      address: held.address,
      privateKey: held.privateKey,
      lane: nextLane(ask.data.userId, held, store),
    });
  };
  return () => channel.close();
}

/**
 * The live session key at `address`, from another of the person's tabs, kept in this tab with its own lane; null when
 * no tab answers within `waitMs`. An answer whose key does not sign for that address is not taken.
 */
export function keyFromOtherTab(
  userId: string,
  address: string,
  { open = browserChannel, store = storage(), waitMs = 750 }: ChannelDeps & { waitMs?: number } = {},
): Promise<HeldKey | null> {
  const channel = open();
  if (!channel) return Promise.resolve(null);
  const wanted = address.toLowerCase();
  // The reply's address on the channel, never a business key: it only pairs this ask with its answer.
  const ask = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const done = (key: HeldKey | null) => {
      clearTimeout(timer);
      channel.onmessage = null;
      channel.close();
      resolve(key);
    };
    const timer = setTimeout(() => done(null), waitMs);
    channel.onmessage = (event) => {
      const give = keyGiveSchema.safeParse(event.data);
      if (!give.success || give.data.ask !== ask || give.data.address !== wanted) return;
      const privateKey = give.data.privateKey as `0x${string}`;
      if (privateKeyToAccount(privateKey).address.toLowerCase() !== wanted) return;
      const mine = heldKey(userId, store);
      done(
        mine?.address === wanted
          ? mine
          : keepKey(userId, { address: wanted, privateKey, nextTicket: 1, pendingOrder: null, lane: give.data.lane }, store),
      );
    };
    channel.postMessage({ type: 'ask', ask, userId, address: wanted });
  });
}

/** This sign-in's session is live under a key this tab does not hold: the key another tab holds, if one does. */
export function joinLiveSession(
  userId: string,
  current: TradingSessionView | null,
  held: HeldKey | null,
  join: (address: string) => Promise<HeldKey | null> = (address) => keyFromOtherTab(userId, address),
): Promise<HeldKey | null> {
  if (current?.state !== 'live' || keyFor(current, held) === 'use') return Promise.resolve(null);
  return join(current.agentAddress);
}
