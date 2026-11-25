import { describe, expect, it, vi } from 'vitest';
import type { HeldKey, SessionView } from '../../protocol';
import type { VenueIntent } from '../venue-api';
import { SESSION_SIGNED_KINDS, chooseSigner, sessionLine, signerOfSignature, startSession, type SessionStartDeps } from './session-signer';

// The beta's "place an order" step on a venue whose orders the owner's wallet cannot sign (Hyperliquid's L1 actions name
// chain 1337): who signs each desk action, what the desk says about the session, and every branch of starting one.

const OWNER = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const live: HeldKey = { address: AGENT, privateKey: `0x${'ab'.repeat(32)}`, nextTicket: 1, pendingOrder: null };

const ALL_KINDS: VenueIntent['kind'][] = [
  'place_order',
  'place_orders',
  'cancel_order',
  'amend_order',
  'replace_order',
  'cancel_orders',
  'schedule_cancel',
  'update_leverage',
  'approve_builder_fee',
  'withdraw',
  'create_sub_account',
  'sub_account_transfer',
  'market_margin_transfer',
  'update_isolated_margin',
  'spot_perps_transfer',
  'set_account_mode',
  'set_position_mode',
  'move_position',
  'vault_transfer',
  'staking_transfer',
  'staking_delegate',
];
/** What svc-trade's door refuses from an agent key (venue-contracts OWNER_ONLY_INTENTS), and orders signed together. */
const OWNER_ONLY: VenueIntent['kind'][] = [
  'withdraw',
  'approve_builder_fee',
  'create_sub_account',
  'sub_account_transfer',
  'market_margin_transfer',
  'spot_perps_transfer',
  'set_account_mode',
  'set_position_mode',
  'move_position',
  'vault_transfer',
  'staking_transfer',
  'staking_delegate',
  'place_orders',
];

describe('who signs a desk action', () => {
  const sessionVenue = { tradesSignedBy: 'session_key' as const, live };

  it('with a live session key, orders, cancels, closes, changes and leverage are prepared for the key', () => {
    for (const kind of ['place_order', 'cancel_order', 'cancel_orders', 'amend_order', 'replace_order', 'update_leverage'] as const)
      expect(chooseSigner(kind, OWNER, sessionVenue)).toEqual({ signer: { role: 'agent', address: AGENT } });
  });

  it('never the key for an approval, a withdrawal, any move of funds or orders signed together, even while it is live', () => {
    for (const kind of OWNER_ONLY) {
      expect(SESSION_SIGNED_KINDS.has(kind)).toBe(false);
      expect(chooseSigner(kind, OWNER, sessionVenue)).toEqual({ signer: { role: 'owner', address: OWNER } });
      expect(chooseSigner(kind, OWNER, { tradesSignedBy: 'session_key', live: null })).toEqual({
        signer: { role: 'owner', address: OWNER },
      });
    }
    // Every kind is either the key's or the owner's: a new kind is the owner's until someone adds it here.
    expect(ALL_KINDS.filter((k) => !SESSION_SIGNED_KINDS.has(k)).sort()).toEqual([...OWNER_ONLY].sort());
  });

  it('on a venue the wallet signs, the owner signs as before; with no live key there, nothing changes', () => {
    expect(chooseSigner('place_order', OWNER, null)).toEqual({ signer: { role: 'owner', address: OWNER } });
    expect(chooseSigner('place_order', OWNER, { tradesSignedBy: 'owner_wallet', live: null })).toEqual({
      signer: { role: 'owner', address: OWNER },
    });
  });

  it('on a venue only a session key trades on, with no live key, an order has no signer: the desk offers the session', () => {
    expect(chooseSigner('place_order', OWNER, { tradesSignedBy: 'session_key', live: null })).toEqual({ needs: 'session' });
    expect(chooseSigner('cancel_order', OWNER, { tradesSignedBy: 'session_key', live: null })).toEqual({ needs: 'session' });
  });

  it('a key already prepared keeps its signer, whatever the session is now (the door stores the signer with the action)', () => {
    const asOwner = { role: 'owner' as const, address: OWNER };
    expect(chooseSigner('place_order', OWNER, sessionVenue, asOwner)).toEqual({ signer: asOwner });
    const asKey = { role: 'agent' as const, address: AGENT };
    expect(chooseSigner('place_order', OWNER, { tradesSignedBy: 'session_key', live: null }, asKey)).toEqual({ signer: asKey });
  });

  it('a kept signature names its signer, so a resend after a reload is the same action', () => {
    expect(signerOfSignature(OWNER, OWNER.toUpperCase().replace('0X', '0x'))).toEqual({ role: 'owner', address: OWNER });
    expect(signerOfSignature(OWNER, AGENT)).toEqual({ role: 'agent', address: AGENT });
  });
});

const view = (agentAddress: string, state: SessionView['state'], extra: Partial<SessionView> = {}): SessionView => ({
  sessionId: 'fam.1',
  actionKey: 'session-key:u:v:fam.1',
  agentAddress,
  validUntil: '2026-11-25T10:00:00.000Z',
  state,
  replacedBy: null,
  refusal: null,
  ...extra,
});

describe('what the desk says about the session', () => {
  it('live and held in this tab: on, with End', () => {
    expect(sessionLine(view(AGENT, 'live'), live)).toEqual({ line: 'live', offer: 'end', validUntil: '2026-11-25T10:00:00.000Z' });
  });
  it('none yet, or held nowhere: why, and Start', () => {
    expect(sessionLine(null, null)).toEqual({ line: 'none', offer: 'start' });
    expect(sessionLine(null, live)).toEqual({ line: 'none', offer: 'start' });
  });
  it('live on the venue but its key is not in this tab: on elsewhere, and Start here', () => {
    expect(sessionLine(view(OTHER, 'live'), live)).toEqual({ line: 'elsewhere', offer: 'start' });
    expect(sessionLine(view(AGENT, 'live'), null)).toEqual({ line: 'elsewhere', offer: 'start' });
  });
  it('an approval still out: Start sends the same one again', () => {
    expect(sessionLine(view(AGENT, 'awaiting_signature'), live)).toEqual({ line: 'pending', offer: 'start' });
    expect(sessionLine(view(AGENT, 'approving'), null)).toEqual({ line: 'pending', offer: 'start' });
  });
  it('ended, expired, superseded or refused: says which, and offers a new start', () => {
    for (const state of ['ended', 'expired', 'replaced', 'refused'] as const)
      expect(sessionLine(view(AGENT, state), live)).toEqual({ line: state, offer: 'start' });
  });
});

// ── starting a session ────────────────────────────────────────────────────────────────────────────────────────────

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const prepared = (over: { signed?: boolean; lastOutcome?: unknown } = {}) => ({
  actionKey: 'session-key:u:v:fam.1',
  sessionId: 'fam.1',
  prepared: {
    venueId: 'hyperliquid-testnet',
    signer: { role: 'owner', address: OWNER },
    nonce: '1',
    venueClientOrderId: null,
    typedData: {
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614, verifyingContract: `0x${'0'.repeat(40)}` },
      types: { 'HyperliquidTransaction:ApproveAgent': [{ name: 'agentAddress', type: 'address' }] },
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: { agentAddress: AGENT },
    },
    digest: `0x${'cd'.repeat(32)}`,
  },
  reused: false,
  signed: over.signed ?? false,
  lastOutcome: over.lastOutcome ?? null,
});
const accepted = { definite: true, accepted: true, venueRef: null, order: null, asOf: '2026-11-25T02:00:00.000Z' } as const;

function deps(over: Partial<SessionStartDeps> = {}) {
  const d = {
    sessions: { start: vi.fn<SessionStartDeps['sessions']['start']>(async () => ({ ok: true, data: prepared() })) },
    submit: vi.fn<SessionStartDeps['submit']>(async () => ({ ok: true, data: { actionKey: 'k', outcome: accepted, readBack: null } })),
    sign: vi.fn<SessionStartDeps['sign']>(async () => ({ status: 'signed', signature: '0xsig' })),
    userId: 'user-1',
    owner: OWNER,
    current: null as SessionView | null,
    held: null as HeldKey | null,
    hold: vi.fn<SessionStartDeps['hold']>(),
    forget: vi.fn<SessionStartDeps['forget']>(),
    store: memoryStorage(),
    make: () => `0x${'11'.repeat(32)}` as const,
  };
  return { ...d, ...over } as typeof d;
}

describe('starting a trading session', () => {
  it('a fresh key, kept in this tab; svc-trade is told its address; the wallet signs the one approval; the venue accepts', async () => {
    const d = deps();
    expect(await startSession(d)).toEqual({ kind: 'sent', answer: 'accepted', detail: null });
    const key = d.hold.mock.calls[0]![0]!;
    expect(key.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(d.sessions.start).toHaveBeenCalledWith(OWNER, key.address);
    expect(d.sign).toHaveBeenCalledTimes(1);
    expect(d.sign.mock.calls[0]![0]).toMatchObject({ primaryType: 'HyperliquidTransaction:ApproveAgent', domain: { chainId: 421614 } });
    expect(d.submit).toHaveBeenCalledWith('session-key:u:v:fam.1', { digest: `0x${'cd'.repeat(32)}`, signature: '0xsig', signedBy: OWNER });
  });

  it('svc-trade refuses the start: nothing is signed, and its words are kept', async () => {
    const d = deps({
      sessions: {
        start: vi.fn(async () => ({
          ok: false as const,
          reason: 'error' as const,
          code: 'trade.venue_session_pending',
          message: 'send it again',
        })),
      },
    });
    expect(await startSession(d)).toEqual({ kind: 'refused', code: 'trade.venue_session_pending', message: 'send it again' });
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.forget).not.toHaveBeenCalled();
  });

  it('a key svc-trade refuses as used before is forgotten, so the next press makes a new one', async () => {
    const d = deps({
      sessions: {
        start: vi.fn(async () => ({
          ok: false as const,
          reason: 'error' as const,
          code: 'trade.venue_session_key_reused',
          message: 'used',
        })),
      },
    });
    expect(await startSession(d)).toMatchObject({ kind: 'refused', code: 'trade.venue_session_key_reused' });
    expect(d.forget).toHaveBeenCalledTimes(1);
    expect(d.sign).not.toHaveBeenCalled();
  });

  it('an answer that is not a prepared approval is refused, and the wallet is never asked', async () => {
    const d = deps({ sessions: { start: vi.fn(async () => ({ ok: true as const, data: { actionKey: 'k' } as never })) } });
    expect(await startSession(d)).toEqual({ kind: 'refused', code: null, message: '' });
    expect(d.sign).not.toHaveBeenCalled();
  });

  it('the person declines in the wallet, or the wallet fails: nothing is sent', async () => {
    const declined = deps({ sign: vi.fn(async () => ({ status: 'rejected' as const })) });
    expect(await startSession(declined)).toEqual({ kind: 'rejected' });
    expect(declined.submit).not.toHaveBeenCalled();
    const failed = deps({
      sign: vi.fn(async () => ({ status: 'failed' as const, reason: 'chain_mismatch' as const, message: 'another network' })),
    });
    expect(await startSession(failed)).toEqual({ kind: 'wallet_failed', message: 'another network' });
    expect(failed.submit).not.toHaveBeenCalled();
  });

  it('a send with no answer is not definite; a definite refusal of the send keeps its words', async () => {
    const lost = deps({ submit: vi.fn(async () => ({ ok: false as const, reason: 'uncertain' as const, message: 'timeout' })) });
    expect(await startSession(lost)).toEqual({ kind: 'sent', answer: 'unknown', detail: null });
    const refused = deps({
      submit: vi.fn(async () => ({
        ok: false as const,
        reason: 'error' as const,
        code: 'trade.venue_session_superseded',
        message: 'newer',
      })),
    });
    expect(await startSession(refused)).toEqual({ kind: 'refused', code: 'trade.venue_session_superseded', message: 'newer' });
  });

  it('the venue refuses the approval: its words are kept', async () => {
    const d = deps({
      submit: vi.fn(async () => ({
        ok: true as const,
        data: {
          actionKey: 'k',
          outcome: {
            definite: true,
            accepted: false,
            refusal: { venueId: 'hl', code: 'signer_not_authorised', detail: 'no' },
            asOf: '2026-11-25T02:00:00.000Z',
          } as const,
          readBack: null,
        },
      })),
    });
    expect(await startSession(d)).toEqual({ kind: 'sent', answer: 'refused', detail: 'no' });
  });

  it('an approval still out for the key this tab holds is the same key and the same approval: no fresh key', async () => {
    const d = deps({ current: view(AGENT, 'awaiting_signature'), held: live });
    await startSession(d);
    expect(d.hold).toHaveBeenCalledWith(live);
    expect(d.sessions.start).toHaveBeenCalledWith(OWNER, AGENT);
  });

  it('an approval sent with no answer, whose key this tab does not hold, is read back with no prompt and no new key', async () => {
    const d = deps({
      current: view(AGENT, 'approving'),
      held: null,
      sessions: { start: vi.fn(async () => ({ ok: true as const, data: prepared({ signed: true }) })) },
    });
    expect(await startSession(d)).toEqual({ kind: 'sent', answer: 'accepted', detail: null });
    expect(d.hold).not.toHaveBeenCalled();
    expect(d.sessions.start).toHaveBeenCalledWith(OWNER, AGENT);
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.submit).toHaveBeenCalledWith('session-key:u:v:fam.1', expect.objectContaining({ signedBy: OWNER }));
  });

  it('a signed approval with a definite answer stands: nothing is signed or sent again', async () => {
    const d = deps({
      sessions: { start: vi.fn(async () => ({ ok: true as const, data: prepared({ signed: true, lastOutcome: accepted }) })) },
    });
    expect(await startSession(d)).toEqual({ kind: 'sent', answer: 'accepted', detail: null });
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
  });
});
