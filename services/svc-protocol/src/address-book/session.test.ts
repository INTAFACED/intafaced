import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import {
  WALLET_CHALLENGE_TTL_MS,
  WalletSessionRefusedError,
  issueWalletChallenge,
  openWalletSession,
  walletSessionFromSetting,
  walletSessionOwner,
  type WalletSessionSetting,
} from './session.js';

/** D-portfolio-wallet-03: the wallet session that proves a signed-out visitor owns the address whose book they open. */
const CHAIN_ID = 84532;
const ORIGIN = 'http://127.0.0.1:3210';
const WALLET = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const SETTING: WalletSessionSetting = { secret: 'a-wallet-session-test-secret-of-length-40', ttlSeconds: 600, origins: [ORIGIN] };
const T0 = new Date('2026-10-29T05:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

async function refusal(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (err instanceof WalletSessionRefusedError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

async function signedChallenge(account = WALLET, setting = SETTING, address: string = account.address) {
  const issued = issueWalletChallenge(setting, CHAIN_ID, { address, origin: ORIGIN }, T0);
  return { ...issued, signature: await account.signMessage({ message: issued.message }) };
}

describe('wallet session setting (owner values)', () => {
  it('any of secret, lifetime or origins blank is unset, which refuses every call', async () => {
    expect(walletSessionFromSetting('', 600, ORIGIN, 'test')).toBeNull();
    expect(walletSessionFromSetting(SETTING.secret, undefined, ORIGIN, 'test')).toBeNull();
    expect(walletSessionFromSetting(SETTING.secret, 600, ' , ', 'test')).toBeNull();
    expect(await refusal(() => issueWalletChallenge(null, CHAIN_ID, { address: WALLET.address, origin: ORIGIN }, T0))).toBe(
      'protocol.wallet_session_unset',
    );
    expect(await refusal(() => openWalletSession(null, CHAIN_ID, { challenge: 'x', signature: '0x' }, T0))).toBe(
      'protocol.wallet_session_unset',
    );
    expect(await refusal(() => walletSessionOwner(null, CHAIN_ID, 'x', T0))).toBe('protocol.wallet_session_unset');
  });

  it('refuses to boot on a short secret, a TEST secret outside dev or test, a bad lifetime or a non-origin', () => {
    expect(() => walletSessionFromSetting('short', 600, ORIGIN, 'test')).toThrow(/at least 32/);
    const testSecret = 'TEST-secret-wallet-session-local-stack-only';
    expect(walletSessionFromSetting(testSecret, 600, ORIGIN, 'dev')?.secret).toBe(testSecret);
    expect(() => walletSessionFromSetting(testSecret, 600, ORIGIN, 'production')).toThrow(/TEST secret/);
    expect(() => walletSessionFromSetting(testSecret, 600, ORIGIN, undefined)).toThrow(/TEST secret/);
    expect(() => walletSessionFromSetting(SETTING.secret, 30, ORIGIN, 'test')).toThrow(/60 to 86400/);
    expect(() => walletSessionFromSetting(SETTING.secret, 600, 'not an origin', 'test')).toThrow(/not an origin/);
    expect(() => walletSessionFromSetting(SETTING.secret, 600, 'http://127.0.0.1:3210/wallet', 'test')).toThrow(/bare http/);
    expect(() => walletSessionFromSetting(SETTING.secret, 600, 'ftp://files.test', 'test')).toThrow(/bare http/);
    expect(walletSessionFromSetting(SETTING.secret, 600, `${ORIGIN}, http://localhost:3210/`, 'test')?.origins).toEqual([
      ORIGIN,
      'http://localhost:3210',
    ]);
  });
});

describe('challenge and session', () => {
  it('writes an EIP-4361 message for the listed origin, the address and the chain, expiring in five minutes', () => {
    const issued = issueWalletChallenge(SETTING, CHAIN_ID, { address: WALLET.address.toLowerCase(), origin: ORIGIN }, T0);
    const parsed = parseSiweMessage(issued.message);
    expect(parsed.domain).toBe('127.0.0.1:3210');
    expect(parsed.uri).toBe(ORIGIN);
    expect(parsed.address).toBe(WALLET.address);
    expect(parsed.chainId).toBe(CHAIN_ID);
    expect(parsed.statement).toMatch(/grants no permission and moves no funds/);
    expect(issued.expiresAt.getTime() - T0.getTime()).toBe(WALLET_CHALLENGE_TTL_MS);
    // A fresh nonce each time: two challenges for the same wallet are different messages.
    expect(issueWalletChallenge(SETTING, CHAIN_ID, { address: WALLET.address, origin: ORIGIN }, T0).message).not.toBe(issued.message);
  });

  it('refuses an origin the owner has not listed', async () => {
    expect(await refusal(() => issueWalletChallenge(SETTING, CHAIN_ID, { address: WALLET.address, origin: 'https://evil.test' }, T0))).toBe(
      'protocol.wallet_session_origin_unlisted',
    );
  });

  it('opens a session only for the sealed address’s own signature, and the session names that address', async () => {
    const { challenge, signature } = await signedChallenge();
    const opened = await openWalletSession(SETTING, CHAIN_ID, { challenge, signature }, later(1_000));
    expect(opened.address).toBe(WALLET.address);
    expect(opened.expiresAt.getTime()).toBe(later(1_000).getTime() + 600_000);
    expect(walletSessionOwner(SETTING, CHAIN_ID, opened.session, later(2_000))).toBe(WALLET.address);
  });

  it('refuses a signature from another key over the same message', async () => {
    const issued = issueWalletChallenge(SETTING, CHAIN_ID, { address: WALLET.address, origin: ORIGIN }, T0);
    const signature = await OTHER.signMessage({ message: issued.message });
    expect(await refusal(() => openWalletSession(SETTING, CHAIN_ID, { challenge: issued.challenge, signature }, T0))).toBe(
      'protocol.wallet_signature_not_owner',
    );
  });

  it('refuses a challenge naming someone else’s address, even signed by the caller', async () => {
    // OTHER asks for a challenge for WALLET's address and signs it with its own key: the sealed address is WALLET.
    const { challenge, signature } = await signedChallenge(OTHER, SETTING, WALLET.address);
    expect(await refusal(() => openWalletSession(SETTING, CHAIN_ID, { challenge, signature }, T0))).toBe(
      'protocol.wallet_signature_not_owner',
    );
  });

  it('refuses a challenge that is expired, altered, for another chain, sealed with another secret or no longer listed', async () => {
    const { challenge, signature } = await signedChallenge();
    const open = (token: string, setting = SETTING, chainId = CHAIN_ID, at = T0) =>
      refusal(() => openWalletSession(setting, chainId, { challenge: token, signature }, at));
    expect(await open(challenge, SETTING, CHAIN_ID, later(WALLET_CHALLENGE_TTL_MS))).toBe('protocol.wallet_challenge_invalid');
    expect(await open(challenge, SETTING, 1)).toBe('protocol.wallet_challenge_invalid');
    expect(await open(challenge, { ...SETTING, secret: 'another-wallet-session-test-secret-40ch' })).toBe(
      'protocol.wallet_challenge_invalid',
    );
    expect(await open(challenge, { ...SETTING, origins: ['http://localhost:3210'] })).toBe('protocol.wallet_challenge_invalid');
    const [v, body, mac] = challenge.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...payload, e: (payload.e as number) + 3_600_000 })).toString('base64url');
    expect(await open(`${v}.${forged}.${mac}`)).toBe('protocol.wallet_challenge_invalid');
    expect(await open('garbage')).toBe('protocol.wallet_challenge_invalid');
    expect(await open(`v1.${body}`)).toBe('protocol.wallet_challenge_invalid');
  });

  it('a session token is not a challenge and a challenge is not a session token', async () => {
    const { challenge, signature } = await signedChallenge();
    const opened = await openWalletSession(SETTING, CHAIN_ID, { challenge, signature }, T0);
    expect(await refusal(() => walletSessionOwner(SETTING, CHAIN_ID, challenge, T0))).toBe('protocol.wallet_session_invalid');
    expect(await refusal(() => openWalletSession(SETTING, CHAIN_ID, { challenge: opened.session, signature }, T0))).toBe(
      'protocol.wallet_challenge_invalid',
    );
  });

  it('refuses a session that is expired, altered, for another chain or sealed with another secret', async () => {
    const { challenge, signature } = await signedChallenge();
    const { session } = await openWalletSession(SETTING, CHAIN_ID, { challenge, signature }, T0);
    const owner = (token: string, setting = SETTING, chainId = CHAIN_ID, at = T0) =>
      refusal(() => walletSessionOwner(setting, chainId, token, at));
    expect(await owner(session, SETTING, CHAIN_ID, later(600_000))).toBe('protocol.wallet_session_invalid');
    expect(await owner(session, SETTING, 1)).toBe('protocol.wallet_session_invalid');
    expect(await owner(session, { ...SETTING, secret: 'another-wallet-session-test-secret-40ch' })).toBe('protocol.wallet_session_invalid');
    const [v, body, mac] = session.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    const swapped = Buffer.from(JSON.stringify({ ...payload, a: OTHER.address })).toString('base64url');
    expect(await owner(`${v}.${swapped}.${mac}`)).toBe('protocol.wallet_session_invalid');
    expect(await owner('')).toBe('protocol.wallet_session_invalid');
  });
});
