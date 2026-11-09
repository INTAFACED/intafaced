import { describe, expect, it } from 'vitest';
import type { ProtocolEmbeddedWalletProvider } from '@intafaced/contracts/protocol-embedded-wallet';
import { clientRefusal, embeddedRefusal } from './EmbeddedWalletRoom';
import { embeddedWalletCopy } from './embedded-wallet-copy';
import { embeddedWalletClient, testProviderClient } from './provider-client';

/** J-wallet-22: the room's refusals name the provider in words; the TEST client never acts without the person's passkey. */
const { t } = embeddedWalletCopy.forLocale('en');
const TEST: ProtocolEmbeddedWalletProvider = {
  id: 'test',
  displayName: 'TEST wallet provider',
  test: true,
  capabilities: { export: true, recovery: true },
};
const failed = (code: string | undefined, message = '', reason: 'error' | 'unreachable' = 'error') =>
  ({ ok: false, reason, code, message }) as Parameters<typeof embeddedRefusal>[0];
const PASSKEY = { credentialId: 'Y3JlZA', publicKey: 'cHVi', algorithm: -7 as const };
const ASSERTION = { credentialId: 'Y3JlZA', clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' };

describe('embedded wallet refusals', () => {
  it('#1 a blank provider setting refuses by its code; #7 the provider down names it in words', () => {
    expect(embeddedRefusal(failed('wallet.embedded_provider_unset'), null, t)).toEqual({
      variant: 'refused',
      title: 'No wallet provider is set',
      body: 'No embedded-wallet provider is set, so no wallet can be made. Nothing was made.',
      reference: 'wallet.embedded_provider_unset',
    });
    const down = embeddedRefusal(failed('wallet.embedded_provider_down'), TEST, t);
    expect(down.variant).toBe('unreachable');
    expect(down.body).toBe('TEST wallet provider is not answering. Nothing was made, signed or sent. Try again in a moment.');
    expect(clientRefusal('down', TEST, t)).toMatchObject({ body: down.body, reference: 'wallet.embedded_provider_down' });
  });

  it('#1 a blocked region names its reason', () => {
    const r = embeddedRefusal(failed('denied.region_blocked', 'TEST region, not served at launch'), TEST, t);
    expect(r).toMatchObject({ title: 'Not available in your region', reference: 'denied.region_blocked' });
    expect(r.body).toContain('TEST region, not served at launch');
  });

  it('#6 a device whose passkey check does not pass is told it cannot sign', () => {
    expect(clientRefusal('passkey', TEST, t).title).toBe('Your passkey check did not pass');
    expect(clientRefusal('refused', TEST, t).body).toBe(
      'TEST wallet provider did not accept the passkey check. Nothing was signed or sent.',
    );
  });
});

describe('the TEST provider client', () => {
  it('is used only for the labelled TEST provider; an unwired provider has no client', () => {
    expect(embeddedWalletClient(TEST)).not.toBeNull();
    expect(embeddedWalletClient({ ...TEST, test: false })).toBeNull();
    expect(embeddedWalletClient({ ...TEST, id: 'privy', test: false })).toBeNull();
    expect(embeddedWalletClient(null)).toBeNull();
  });

  it('signs only after the passkey answers the provider’s challenge for that exact message', async () => {
    const calls: Array<[string, unknown]> = [];
    const client = testProviderClient({
      post: async (path, body) => {
        calls.push([path, body]);
        if (path === 'challenge') return { status: 200, body: { challenge: 'Y2g', allowCredentials: ['Y3JlZA'] } };
        return { status: 200, body: { signature: '0xsig', address: '0xabc' } };
      },
      assert: async (challenge, allow) => {
        expect([challenge, allow]).toEqual(['Y2g', ['Y3JlZA']]);
        return { ok: true, data: ASSERTION };
      },
    });
    expect(await client.signMessage('w1', 'hello')).toEqual({ ok: true, data: { signature: '0xsig', address: '0xabc' } });
    expect(calls).toEqual([
      ['challenge', { walletId: 'w1', action: 'sign', payload: { message: 'hello' } }],
      ['sign', { walletId: 'w1', payload: { message: 'hello' }, challenge: 'Y2g', assertion: ASSERTION }],
    ]);
  });

  it('planted faults: a passkey that does not pass, a provider that does not answer or refuses, signs nothing', async () => {
    const calls: string[] = [];
    const record = (status: number, body: unknown) => async (path: string) => {
      calls.push(path);
      return path === 'challenge' ? { status: 200, body: { challenge: 'Y2g', allowCredentials: [] } } : { status, body };
    };
    const noPasskey = testProviderClient({ post: record(200, {}), assert: async () => ({ ok: false, failure: 'passkey' }) });
    expect(await noPasskey.signMessage('w1', 'm')).toEqual({ ok: false, failure: 'passkey' });
    expect(calls).toEqual(['challenge']);
    const down = testProviderClient({ post: async () => null, assert: async () => ({ ok: true, data: ASSERTION }) });
    expect(await down.signMessage('w1', 'm')).toEqual({ ok: false, failure: 'down' });
    const unreachable = testProviderClient({
      post: record(502, { error: 'provider_unreachable' }),
      assert: async () => ({ ok: true, data: ASSERTION }),
    });
    expect(await unreachable.exportKey('w1')).toEqual({ ok: false, failure: 'down' });
    const refused = testProviderClient({
      post: record(403, { error: 'assertion_invalid' }),
      assert: async () => ({ ok: true, data: ASSERTION }),
    });
    expect(await refused.signMessage('w1', 'm')).toEqual({ ok: false, failure: 'refused' });
  });

  it('a recovery passkey is made on this device and approved with the bound passkey', async () => {
    const calls: Array<[string, unknown]> = [];
    const client = testProviderClient({
      create: async () => ({ ok: true, data: PASSKEY }),
      assert: async () => ({ ok: true, data: ASSERTION }),
      post: async (path, body) => {
        calls.push([path, body]);
        return path === 'challenge'
          ? { status: 200, body: { challenge: 'Y2g', allowCredentials: ['b2xk'] } }
          : { status: 200, body: { added: true, passkeys: 2 } };
      },
    });
    expect(await client.addRecoveryPasskey('w1')).toEqual({ ok: true, data: { added: true, passkeys: 2 } });
    expect(calls[0]).toEqual(['challenge', { walletId: 'w1', action: 'recovery', payload: { passkey: PASSKEY } }]);
  });
});
