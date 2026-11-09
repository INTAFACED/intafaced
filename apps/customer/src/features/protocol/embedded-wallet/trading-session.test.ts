import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { decimalAtLeast } from './TradingSession';
import { testProviderClient } from './provider-client';
import { dropKey, freshKey, heldKey, keepKey, keyFor, orderKey, signWithSessionKey, type SessionView } from './trading-session';

// J-wallet-22 #8 on the page: the session key is made here and kept in this tab; it is used only for this sign-in's live
// session; it signs orders itself with no passkey; the owner's approval goes to the provider as typed data.

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

const view = (agentAddress: string, state: SessionView['state']): SessionView => ({
  sessionId: 'fam.1',
  actionKey: 'session-key:u:v:fam.1',
  agentAddress,
  validUntil: null,
  state,
  replacedBy: null,
  refusal: null,
});

const typedData = {
  domain: { name: 'INTAFACED TEST venue simulator', version: '1', chainId: 1337000 },
  types: { Action: [{ name: 'kind', type: 'string' }] },
  primaryType: 'Action' as const,
  message: { kind: 'place_order' },
};

describe('the trading session key, on this device only', () => {
  it('a fresh key is kept in this tab under the person, and only its address is what anyone else is told', () => {
    const store = memoryStorage();
    const key = freshKey('user-1', store);
    expect(key.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(heldKey('user-1', store)).toEqual(key);
    expect(heldKey('user-2', store)).toBeNull();
    const second = freshKey('user-1', store);
    expect(second.address).not.toBe(key.address);
    dropKey('user-1', store);
    expect(heldKey('user-1', store)).toBeNull();
    // A tampered entry is not a key.
    store.setItem('intafaced.venue-session-key:user-1', JSON.stringify({ address: 'x', privateKey: 'y' }));
    expect(heldKey('user-1', store)).toBeNull();
  });

  it('the ticket count and an order still waiting for its answer are kept with the key, so a reload never reuses an order key', () => {
    const store = memoryStorage();
    const key = freshKey('user-1', store);
    expect(key).toMatchObject({ nextTicket: 1, pendingOrder: null });
    const pendingOrder = {
      key: orderKey('user-1', 'fam.1', 1),
      intent: { kind: 'place_order', clientOrderKey: orderKey('user-1', 'fam.1', 1) },
    };
    keepKey('user-1', { ...key, pendingOrder }, store);
    // A reload reads the same pending order back: the next press re-sends it, not a new one.
    expect(heldKey('user-1', store)).toEqual({ ...key, pendingOrder });
    keepKey('user-1', { ...key, pendingOrder: null, nextTicket: 2 }, store);
    expect(heldKey('user-1', store)).toMatchObject({ nextTicket: 2, pendingOrder: null });
  });

  it('the held key is used only for this sign-in’s live session; an approval still out keeps it; anything else drops it', () => {
    const held = {
      address: '0x00000000000000000000000000000000000000a1',
      privateKey: `0x${'1'.repeat(64)}` as const,
      nextTicket: 1,
      pendingOrder: null,
    };
    expect(keyFor(view(held.address, 'live'), held)).toBe('use');
    expect(keyFor(view(held.address, 'awaiting_signature'), held)).toBe('pending');
    expect(keyFor(view(held.address, 'approving'), held)).toBe('pending');
    for (const state of ['expired', 'ended', 'replaced', 'refused'] as const) expect(keyFor(view(held.address, state), held)).toBe('drop');
    // After a sign-out, the next sign-in has no session (or another key): the old key is never this session's.
    expect(keyFor(null, held)).toBe('drop');
    expect(keyFor(view('0x00000000000000000000000000000000000000b2', 'live'), held)).toBe('drop');
    expect(keyFor(view(held.address, 'live'), null)).toBe('none');
  });

  it('the session key signs a prepared action itself, recoverable to its own address', async () => {
    const key = freshKey('user-1', memoryStorage());
    const digest = hashTypedData(typedData);
    const signed = await signWithSessionKey(key, { digest, typedData, venueClientOrderId: null });
    expect(signed.digest).toBe(digest);
    expect(signed.signedBy).toBe(key.address);
    expect((await recoverTypedDataAddress({ ...typedData, signature: signed.signature as `0x${string}` })).toLowerCase()).toBe(key.address);
  });

  it('order keys are business keys from the session and the ticket count', () => {
    expect(orderKey('u1', 'fam.2', 3)).toBe('order:u1:session:fam.2:3');
  });

  it('compares basis points exactly, as decimal strings', () => {
    expect(decimalAtLeast('1', '1')).toBe(true);
    expect(decimalAtLeast('0.9', '1')).toBe(false);
    expect(decimalAtLeast('0.30000000000000001', '0.3')).toBe(true);
    expect(decimalAtLeast('0.3', '0.30000000000000001')).toBe(false);
    expect(decimalAtLeast('not', '1')).toBe(false);
  });

  it('the owner’s approval is signed at the provider as typed data, only after the passkey answers that exact payload', async () => {
    const calls: Array<[string, unknown]> = [];
    const client = testProviderClient({
      post: async (path, body) => {
        calls.push([path, body]);
        if (path === 'challenge') return { status: 200, body: { challenge: 'Y2g', allowCredentials: ['Y3JlZA'] } };
        return { status: 200, body: { signature: '0xsig', address: '0xabc' } };
      },
      assert: async () => ({ ok: true, data: { credentialId: 'Y3JlZA', clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } }),
    });
    expect(await client.signTypedData('w1', typedData)).toEqual({ ok: true, data: { signature: '0xsig', address: '0xabc' } });
    expect(
      calls.map(([path, body]) => [
        path,
        (body as { action?: string; payload: unknown }).action ?? null,
        (body as { payload: unknown }).payload,
      ]),
    ).toEqual([
      ['challenge', 'signtyped', { typedData }],
      ['signtyped', null, { typedData }],
    ]);
    // The passkey check does not pass: nothing is signed.
    const noPasskey = testProviderClient({
      post: async (path) =>
        path === 'challenge' ? { status: 200, body: { challenge: 'Y2g', allowCredentials: [] } } : { status: 200, body: {} },
      assert: async () => ({ ok: false, failure: 'passkey' }),
    });
    expect(await noPasskey.signTypedData('w1', typedData)).toEqual({ ok: false, failure: 'passkey' });
  });
});
