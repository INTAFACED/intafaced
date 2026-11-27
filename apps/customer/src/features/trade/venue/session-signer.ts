import { freshKey, joinLiveSession, keyFor, type HeldKey, type SessionView, type SignResult, type TradingSessionApi } from '../../protocol';
import type { TypedDataDocument } from '../../protocol';
import type { ApiResult } from '../../../shared/api';
import { preparedAnswerSchema, walletTypedData, type SubmitAnswer, type VenueIntent } from '../venue-api';

/**
 * Who signs a desk action on a venue whose orders the owner's wallet cannot sign (status `tradesSignedBy: session_key`:
 * Hyperliquid's L1 actions name chain 1337, which a wallet refuses as another network). The owner's wallet signs one
 * approval for a fresh key made on this device (the trading session, features/protocol trading-session.ts); that key
 * signs the person's orders, cancels, changes and leverage here with no wallet prompt. Approvals (our builder fee, the
 * session itself) and every move of funds stay with the owner's wallet: svc-trade refuses them from an agent key
 * (`OWNER_ONLY_INTENTS`), and this list never offers them to one. Orders signed together stay the owner's too
 * (svc-trade `assertTogetherIntent`: an agent signs each order on its own, under its cap).
 */
export const SESSION_SIGNED_KINDS: ReadonlySet<VenueIntent['kind']> = new Set<VenueIntent['kind']>([
  'place_order',
  'cancel_order',
  'amend_order',
  'replace_order',
  'cancel_orders',
  'schedule_cancel',
  'update_leverage',
  'update_isolated_margin',
]);

export type DeskSigner = { readonly role: 'owner' | 'agent'; readonly address: string };

/** What the desk knows of the trading session: who the venue says signs trades, and this tab's live key for this owner. */
export interface SessionSigning {
  readonly tradesSignedBy: 'owner_wallet' | 'session_key';
  /** This tab's session key, only while svc-trade's record for this sign-in names it and the venue lists it live. */
  readonly live: HeldKey | null;
}

export type SignerChoice = { readonly signer: DeskSigner } | { readonly needs: 'session' };

/**
 * The signer for one action. A key this page already prepared keeps the signer it was prepared with (svc-trade stores
 * the signer with the action: the same key under another signer is a different action, refused `idempotency.conflict`).
 * Otherwise: the live session key for an action it may sign; the owner's wallet for everything else; and, on a venue
 * whose trades only a session key signs, no signer at all until a session is on (nothing is prepared or signed).
 */
export function chooseSigner(kind: VenueIntent['kind'], owner: string, session: SessionSigning | null, earlier?: DeskSigner): SignerChoice {
  const asOwner = { signer: { role: 'owner', address: owner.toLowerCase() } } as const;
  if (!SESSION_SIGNED_KINDS.has(kind)) return asOwner;
  if (earlier) return { signer: earlier };
  if (session?.live) return { signer: { role: 'agent', address: session.live.address.toLowerCase() } };
  if (session?.tradesSignedBy === 'session_key') return { needs: 'session' };
  return asOwner;
}

/** The signer a kept signature was made by: the owner's wallet, or the session key whose address it names. */
export function signerOfSignature(owner: string, signedBy: string): DeskSigner {
  const by = signedBy.toLowerCase();
  return by === owner.toLowerCase() ? { role: 'owner', address: by } : { role: 'agent', address: by };
}

// ── The session as the desk shows it ───────────────────────────────────────────────────────────────────────────────

/** The desk's one line about the session, and the one control it offers. */
export type SessionLine =
  | { readonly line: 'live'; readonly offer: 'end'; readonly validUntil: string | null }
  | { readonly line: 'none' | 'pending' | 'expired' | 'ended' | 'replaced' | 'refused' | 'elsewhere'; readonly offer: 'start' };

/**
 * What the desk says about this sign-in's session, from svc-trade's record and the key this tab holds (`keyFor`):
 * live and held here: on, with End; an approval still out for the key held here: the same Start again; a session the
 * venue lists live whose key this tab does not hold: on elsewhere, so this tab starts its own; ended, expired, replaced
 * or refused: says which, and offers a new start.
 */
export function sessionLine(current: SessionView | null, held: HeldKey | null): SessionLine {
  const use = keyFor(current, held);
  if (current && use === 'use') return { line: 'live', offer: 'end', validUntil: current.validUntil };
  if (!current) return { line: 'none', offer: 'start' };
  if (use === 'pending' || current.state === 'awaiting_signature' || current.state === 'approving')
    return { line: 'pending', offer: 'start' };
  if (current.state === 'live') return { line: 'elsewhere', offer: 'start' };
  if (current.state === 'expired' || current.state === 'ended' || current.state === 'replaced' || current.state === 'refused')
    return { line: current.state, offer: 'start' };
  return { line: 'none', offer: 'start' };
}

// ── Starting a session ──────────────────────────────────────────────────────────────────────────────────────────────

export type SessionStartResult =
  /** The session is live under a key another of the person's tabs holds: this tab now holds it too, with no approval. */
  | { readonly kind: 'joined' }
  /** The approval reached the venue: accepted, refused (with the venue's words), or with no definite answer yet. */
  | { readonly kind: 'sent'; readonly answer: 'accepted' | 'refused' | 'unknown'; readonly detail: string | null }
  /** svc-trade refused to prepare or send the approval; nothing was signed, or what was signed was not sent. */
  | { readonly kind: 'refused'; readonly code: string | null; readonly message: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'wallet_failed'; readonly message: string };

type Store = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SessionStartDeps {
  readonly sessions: Pick<TradingSessionApi, 'start'>;
  readonly submit: (
    actionKey: string,
    signature: { digest: string; signature: string; signedBy: string },
  ) => Promise<ApiResult<SubmitAnswer>>;
  /** The owner's wallet signs the approval's typed data (a user-signed action, on the network the wallet is on). */
  readonly sign: (typedData: TypedDataDocument) => Promise<SignResult>;
  readonly userId: string;
  readonly owner: string;
  readonly current: SessionView | null;
  readonly held: HeldKey | null;
  /** Called with the key this tab now holds for the session (a fresh one, or the same one for an approval still out). */
  readonly hold: (key: HeldKey | null) => void;
  /** Called to forget the key this tab holds (one svc-trade refuses as used before). */
  readonly forget: () => void;
  readonly store?: Store | null;
  readonly make?: () => `0x${string}`;
  /** Asks the person's other tabs for the live key at an address (trading-session.ts `keyFromOtherTab`). */
  readonly join?: (address: string) => Promise<HeldKey | null>;
}

/**
 * Start (or finish starting) this sign-in's session, as the wallet room's trading session does: the key for an approval
 * still out is the same key, so a retry is the same approval and one prompt; an approval sent with no answer whose key
 * this tab does not hold is read back by sending the stored approval again, with no prompt; a session live under a key
 * another of the person's tabs holds is joined, since a new key would take that tab's away (the venue keeps one per
 * account); otherwise a fresh key. A key svc-trade refuses as used before is forgotten, so the next press makes a new one.
 */
export async function startSession(d: SessionStartDeps): Promise<SessionStartResult> {
  const joined = await joinLiveSession(d.userId, d.current, d.held, d.join);
  if (joined) {
    d.hold(joined);
    return { kind: 'joined' };
  }
  const use = keyFor(d.current, d.held);
  const readBack = use !== 'pending' && d.current?.state === 'approving';
  const key = use === 'pending' && d.held ? d.held : readBack ? null : freshKey(d.userId, d.store, d.make);
  if (key) d.hold(key);
  const address = key?.address ?? d.current?.agentAddress ?? '';
  const started = await d.sessions.start(d.owner, address);
  if (!started.ok) {
    if (started.code === 'trade.venue_session_key_reused') d.forget();
    return { kind: 'refused', code: started.code ?? null, message: started.message };
  }
  const parsed = preparedAnswerSchema.safeParse(started.data);
  if (!parsed.success) return { kind: 'refused', code: null, message: '' };
  const answer = parsed.data;
  const p = answer.prepared;
  // A signed approval with a definite answer stands; one with none is sent again as its stored bytes (the door re-sends
  // what it stored under the key), never signed a second time.
  if (answer.signed && answer.lastOutcome?.definite) return sentOf(answer.lastOutcome);
  let signature = { digest: p.digest, signature: '0x', signedBy: d.owner.toLowerCase() };
  if (!answer.signed) {
    const signed = await d.sign(walletTypedData(p.typedData));
    if (signed.status === 'rejected') return { kind: 'rejected' };
    if (signed.status !== 'signed') return { kind: 'wallet_failed', message: signed.status === 'failed' ? signed.message : '' };
    signature = { digest: p.digest, signature: signed.signature, signedBy: d.owner.toLowerCase() };
  }
  const sent = await d.submit(answer.actionKey, signature);
  if (!sent.ok) {
    if (sent.reason === 'uncertain') return { kind: 'sent', answer: 'unknown', detail: null };
    return { kind: 'refused', code: sent.code ?? null, message: sent.message };
  }
  return sentOf(sent.data.outcome);
}

function sentOf(outcome: SubmitAnswer['outcome']): SessionStartResult {
  if (!outcome.definite) return { kind: 'sent', answer: 'unknown', detail: null };
  return outcome.accepted
    ? { kind: 'sent', answer: 'accepted', detail: null }
    : { kind: 'sent', answer: 'refused', detail: outcome.refusal.detail };
}
