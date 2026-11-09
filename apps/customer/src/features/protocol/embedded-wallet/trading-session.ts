// hand-declared-ok: svc-trade's user-venue door and session-key answers are declared in svc-trade (src/venue/session-key.ts), not in @intafaced/contracts.
import { z } from 'zod';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ApiClient } from '../../../shared/api';
import { DEVICE_SESSION_KEY_PREFIX } from '../../../shared/device-session-key';

/**
 * The trading session (J-wallet-22 #8, slice D-venue-09): one approval per session, signed by the person's wallet after
 * their passkey, for a FRESH session key made here, on this device, beside the wallet provider's client. The key can
 * trade on the venue and can never withdraw or approve; orders in the session are signed by it with no passkey.
 *
 * The key never leaves this tab in a form that can sign: svc-trade is told its address only
 * (`POST /api/v1/venue/session/start`), and the key itself is kept in this tab's sessionStorage, which the browser
 * clears when the tab closes, and which a sign-out empties at once (shared/device-session-key.ts). It is used only
 * while svc-trade's record for THIS sign-in names the same address and the venue lists it live; after a sign-out the
 * next sign-in has no session, and the next session approves a new key. A key once used is never approved again (svc-trade refuses it).
 */

// ── svc-trade's user-venue door, as this room reads it (services/svc-trade/src/venue/user-venue-rest.ts) ──────────────

const doorStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(false),
    refusal: z.object({ code: z.string(), detail: z.string() }).passthrough(),
  }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(true),
    venue: z.object({ id: z.string(), displayName: z.string(), proofLevel: z.string() }),
    test: z.boolean(),
    builder: z.object({ address: z.string(), feeBps: z.string() }).nullable(),
  }),
]);
export type DoorStatus = z.infer<typeof doorStatusSchema>;

const sessionStateSchema = z.enum(['awaiting_signature', 'approving', 'live', 'expired', 'ended', 'replaced', 'refused']);
export type SessionState = z.infer<typeof sessionStateSchema>;
const sessionViewSchema = z
  .object({
    sessionId: z.string(),
    actionKey: z.string(),
    agentAddress: z.string(),
    validUntil: z.string().nullable(),
    state: sessionStateSchema,
    replacedBy: z.enum(['this_sign_in', 'another_sign_in']).nullable(),
    refusal: z.object({ code: z.string(), detail: z.string() }).passthrough().nullable(),
  })
  .passthrough();
export type SessionView = z.infer<typeof sessionViewSchema>;
const sessionStatusSchema = z.object({ venueId: z.string(), owner: z.string(), current: sessionViewSchema.nullable(), asOf: z.string() });
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

const preparedSchema = z
  .object({
    actionKey: z.string(),
    reused: z.boolean(),
    signed: z.boolean(),
    prepared: z.object({ digest: z.string(), typedData: z.unknown(), venueClientOrderId: z.string().nullable() }).passthrough(),
  })
  .passthrough();
export type Prepared = z.infer<typeof preparedSchema>;
const outcomeSchema = z.union([
  z
    .object({ definite: z.literal(true), accepted: z.literal(true), order: z.object({ status: z.string() }).passthrough().nullable() })
    .passthrough(),
  z
    .object({
      definite: z.literal(true),
      accepted: z.literal(false),
      refusal: z.object({ code: z.string(), detail: z.string() }).passthrough(),
    })
    .passthrough(),
  z.object({ definite: z.literal(false), reason: z.string() }).passthrough(),
]);
const submitSchema = z.object({ actionKey: z.string(), outcome: outcomeSchema }).passthrough();
export type SubmitAnswer = z.infer<typeof submitSchema>;
const approvalSchema = z.object({ value: z.string() }).passthrough();

export interface VenueSignature {
  readonly digest: string;
  readonly signature: string;
  readonly signedBy: string;
}

export function createTradingSessionApi(api: ApiClient) {
  const owner = (address: string) => ({ owner: address.toLowerCase() });
  return {
    door: (signal?: AbortSignal) => api.rest('/venue/status', doorStatusSchema, { signal }),
    session: (address: string, signal?: AbortSignal) => api.rest('/venue/session', sessionStatusSchema, { query: owner(address), signal }),
    builderFeeApproval: (address: string, signal?: AbortSignal) =>
      api.rest('/venue/builder-fee-approval', approvalSchema, { query: owner(address), signal }),
    start: (address: string, agentAddress: string) =>
      api.rest('/venue/session/start', preparedSchema.and(z.object({ sessionId: z.string() })), {
        method: 'POST',
        body: { ...owner(address), agentAddress },
      }),
    end: (address: string) =>
      api.rest('/venue/session/end', preparedSchema.and(z.object({ sessionId: z.string() })), { method: 'POST', body: owner(address) }),
    prepare: (body: unknown) => api.rest('/venue/prepare', preparedSchema, { method: 'POST', body }),
    submit: (actionKey: string, signature: VenueSignature) =>
      api.rest('/venue/submit', submitSchema, { method: 'POST', body: { actionKey, signature } }),
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
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storeKey = (userId: string) => `${DEVICE_SESSION_KEY_PREFIX}${userId}`;
const heldSchema = z.object({
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  privateKey: z.string().regex(/^0x[0-9a-f]{64}$/),
  nextTicket: z.number().int().positive().default(1),
  pendingOrder: z
    .object({ key: z.string(), intent: z.record(z.string(), z.unknown()) })
    .nullable()
    .default(null),
});

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
    { address: privateKeyToAccount(privateKey).address.toLowerCase(), privateKey, nextTicket: 1, pendingOrder: null },
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
export function keyFor(current: SessionView | null, held: HeldKey | null): 'use' | 'pending' | 'drop' | 'none' {
  if (!held) return 'none';
  if (!current || current.agentAddress.toLowerCase() !== held.address) return 'drop';
  if (current.state === 'live') return 'use';
  if (current.state === 'awaiting_signature' || current.state === 'approving') return 'pending';
  return 'drop';
}

/** The session key signs a prepared action itself: no passkey, no provider, nothing leaves the tab but the signature. */
export async function signWithSessionKey(key: HeldKey, prepared: Prepared['prepared']): Promise<VenueSignature> {
  const t = prepared.typedData as Parameters<ReturnType<typeof privateKeyToAccount>['signTypedData']>[0];
  const signature = await privateKeyToAccount(key.privateKey).signTypedData(t);
  return { digest: prepared.digest, signature, signedBy: key.address };
}

/** The business key of one order from the session's ticket: the session and the ticket's own count, never a random id. */
export const orderKey = (userId: string, sessionId: string, ticket: number) => `order:${userId}:session:${sessionId}:${ticket}`;
