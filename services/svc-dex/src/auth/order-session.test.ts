import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { OrderSessions, checkOrderSessionSetting, type OrderSessionSetting } from './order-session.js';
import { FileSessionStore } from './session-store.js';
import { parseCapSchedule } from './settings.js';
import type { DexTypedData } from '@intafaced/contracts/protocol-dex-orders';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const OTHER = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const wallet = privateKeyToAccount(KEY);
const TOKEN_A = '0x00000000000000000000000000000000000a11ce';
const SETTING: OrderSessionSetting = {
  secret: 'TEST-order-session-secret-0123456789abcdef',
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 86_400,
  cap: [{ token: TOKEN_A, symbol: 'TEST A', max: '10000' }],
};

function sessions(setting: OrderSessionSetting = SETTING, at = { now: new Date('2026-11-07T08:00:00Z') }) {
  const dir = mkdtempSync(join(tmpdir(), 'dex-auth-'));
  return { at, svc: new OrderSessions(setting, new FileSessionStore(dir, () => at.now.getTime()), () => at.now), dir };
}

async function sign(typed: DexTypedData, key = KEY) {
  const { EIP712Domain: _d, ...types } = typed.types;
  const m = typed.message as Record<string, string>;
  return privateKeyToAccount(key).signTypedData({
    domain: typed.domain,
    types: types as never,
    primaryType: 'OrderSession',
    message: { ...m, expiresAt: BigInt(m.expiresAt!) } as never,
  });
}

describe('the order session (D-limit-dca-01, SIG-1..SIG-3)', () => {
  it('shows the scope, the session expiry and the cap before anything is signed, and signs them', () => {
    const { svc } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    expect(c.scope).toMatch(/moves no funds/);
    expect(c.sessionExpiresAt).toBe('2026-11-07T09:00:00.000Z');
    expect(c.cap).toEqual(SETTING.cap);
    expect(c.typedData.message).toMatchObject({ wallet: wallet.address, scope: c.scope, cap: '10000 TEST A open at once' });
    expect(c.typedData.types.EIP712Domain!.map((f) => f.name)).toEqual(['name', 'version', 'chainId']);
  });

  it('verifies the wallet signature once; the same signed challenge again is refused as replayed', async () => {
    const { svc } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    const signature = await sign(c.typedData);
    const session = await svc.verify({ challenge: c.challenge, signature });
    expect(session.wallet).toBe(wallet.address);
    expect(svc.principal(session.accessToken).wallet).toBe(wallet.address.toLowerCase());
    await expect(svc.verify({ challenge: c.challenge, signature })).rejects.toMatchObject({ code: 'dex.auth.challenge_replayed' });
  });

  it('a replay is refused after a restart too: the spent nonce is on disk', async () => {
    const { svc, dir, at } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    const signature = await sign(c.typedData);
    await svc.verify({ challenge: c.challenge, signature });
    const restarted = new OrderSessions(SETTING, new FileSessionStore(dir, () => at.now.getTime()), () => at.now);
    await expect(restarted.verify({ challenge: c.challenge, signature })).rejects.toMatchObject({ code: 'dex.auth.challenge_replayed' });
  });

  it('refuses a signature from another wallet, and spends nothing', async () => {
    const { svc } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    await expect(svc.verify({ challenge: c.challenge, signature: await sign(c.typedData, OTHER) })).rejects.toMatchObject({
      code: 'dex.auth.signature_not_owner',
    });
    // The owner can still use the challenge: a wrong signature did not burn it.
    await expect(svc.verify({ challenge: c.challenge, signature: await sign(c.typedData) })).resolves.toMatchObject({
      wallet: wallet.address,
    });
  });

  it('refuses an altered or expired challenge', async () => {
    const { svc, at } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    const signature = await sign(c.typedData);
    await expect(svc.verify({ challenge: `${c.challenge}x`, signature })).rejects.toMatchObject({ code: 'dex.auth.challenge_invalid' });
    at.now = new Date(at.now.getTime() + 6 * 60 * 1000);
    await expect(svc.verify({ challenge: c.challenge, signature })).rejects.toMatchObject({ code: 'dex.auth.challenge_invalid' });
  });

  it('logout revokes the access and refresh tokens at once; refresh is single use', async () => {
    const { svc } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    const first = await svc.verify({ challenge: c.challenge, signature: await sign(c.typedData) });
    const second = svc.refresh(first.refreshToken);
    expect(() => svc.refresh(first.refreshToken)).toThrow(expect.objectContaining({ code: 'dex.auth.unauthenticated' }));
    svc.logout(second.accessToken);
    expect(() => svc.principal(second.accessToken)).toThrow(expect.objectContaining({ code: 'dex.auth.unauthenticated' }));
    expect(() => svc.refresh(second.refreshToken)).toThrow(expect.objectContaining({ code: 'dex.auth.unauthenticated' }));
  });

  it('logoutAll ends every earlier session of the wallet', async () => {
    const { svc, at } = sessions();
    const open = async () => {
      const c = svc.challenge({ address: wallet.address, chainId: 84532 });
      return svc.verify({ challenge: c.challenge, signature: await sign(c.typedData) });
    };
    const a = await open();
    const b = await open();
    at.now = new Date(at.now.getTime() + 1000);
    svc.logoutAll(b.accessToken);
    expect(() => svc.principal(a.accessToken)).toThrow(expect.objectContaining({ code: 'dex.auth.unauthenticated' }));
    expect(() => svc.principal(b.accessToken)).toThrow(expect.objectContaining({ code: 'dex.auth.unauthenticated' }));
  });

  it('an expired access token is refused', async () => {
    const { svc, at } = sessions();
    const c = svc.challenge({ address: wallet.address, chainId: 84532 });
    const s = await svc.verify({ challenge: c.challenge, signature: await sign(c.typedData) });
    at.now = new Date(at.now.getTime() + 3601 * 1000);
    expect(() => svc.principal(s.accessToken)).toThrow(expect.objectContaining({ code: 'dex.auth.unauthenticated' }));
  });

  it('blank owner settings refuse by name; nothing is written', () => {
    expect(() => sessions({ ...SETTING, secret: undefined }).svc.challenge({ address: wallet.address, chainId: 84532 })).toThrow(
      expect.objectContaining({ code: 'dex.auth.session_unset' }),
    );
    expect(() => sessions({ ...SETTING, accessTtlSeconds: undefined }).svc.challenge({ address: wallet.address, chainId: 84532 })).toThrow(
      expect.objectContaining({ code: 'dex.auth.lifetime_unset' }),
    );
    expect(() => sessions({ ...SETTING, cap: undefined }).svc.challenge({ address: wallet.address, chainId: 84532 })).toThrow(
      expect.objectContaining({ code: 'dex.order.cap_unset' }),
    );
  });

  it('a TEST secret refuses to boot outside dev or test; a malformed cap schedule refuses to boot', () => {
    expect(() => checkOrderSessionSetting(SETTING, 'production')).toThrow(/TEST secret/);
    expect(() => checkOrderSessionSetting(SETTING, 'dev')).not.toThrow();
    expect(() => parseCapSchedule('[]')).toThrow(/non-empty/);
    expect(() => parseCapSchedule('[{"token":"0x1","symbol":"A","max":"1"}]')).toThrow(/token, symbol, max/);
    expect(parseCapSchedule(`[{"token":"${TOKEN_A}","symbol":"TEST A","max":"10000"}]`)).toEqual(SETTING.cap);
  });
});
