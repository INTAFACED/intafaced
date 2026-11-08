import { afterEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import type { Principal } from '@intafaced/auth';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV } from '@intafaced/config';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import type { WalletSessionSetting } from '../address-book/session.js';
import {
  MemoryVenueConnectionStore,
  VENUE_CHALLENGE_TTL_MS,
  VenueConnectionRefusedError,
  assertVenueConnectionLive,
  issueVenueChallenge,
  openVenueConnection,
  venueConnectKey,
  venueConnectionTtlFromSetting,
  walletSanctionsFromSetting,
  type VenueConnectionDeps,
} from './connection.js';

/** J-wallet-09 #1 #2 #4: a signed-in person connects their own wallet, sees its expiry, and an expired one refuses. */
const CHAIN_ID = 84532;
const ORIGIN = 'http://127.0.0.1:3210';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const WALLET = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const LISTED = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const SESSION: WalletSessionSetting = { secret: 'a-venue-wallet-test-secret-of-length-40', ttlSeconds: 600, origins: [ORIGIN] };
const TTL = 60;
const T0 = new Date('2026-11-08T20:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function deps(over: Partial<VenueConnectionDeps> = {}): VenueConnectionDeps & { store: MemoryVenueConnectionStore } {
  return {
    chainId: () => CHAIN_ID,
    store: new MemoryVenueConnectionStore(),
    session: () => SESSION,
    ttlSeconds: () => TTL,
    sanctions: () => walletSanctionsFromSetting(LISTED.address),
    ...over,
  } as VenueConnectionDeps & { store: MemoryVenueConnectionStore };
}

async function refusal(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (err instanceof VenueConnectionRefusedError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

async function signed(d: VenueConnectionDeps, account = WALLET, userId = ALICE, at = T0) {
  const issued = issueVenueChallenge(d, { userId, address: account.address, origin: ORIGIN }, at);
  return { ...issued, signature: await account.signMessage({ message: issued.message }) };
}

describe('venue wallet connection owner settings', () => {
  it('a blank lifetime or sanctions list reads unset; `none` is a reviewed empty list; a bad entry or lifetime refuses to boot', () => {
    expect(venueConnectionTtlFromSetting(undefined)).toBeNull();
    expect(venueConnectionTtlFromSetting(60)).toBe(60);
    expect(() => venueConnectionTtlFromSetting(5)).toThrow(/Refusing to boot/);
    expect(walletSanctionsFromSetting(undefined)).toBeNull();
    expect(walletSanctionsFromSetting('  ')).toBeNull();
    expect(walletSanctionsFromSetting(' , ')).toBeNull();
    expect(walletSanctionsFromSetting('none')?.addresses.size).toBe(0);
    expect(walletSanctionsFromSetting(`${LISTED.address}, ${OTHER.address}`)?.addresses.has(OTHER.address.toLowerCase())).toBe(true);
    expect(() => walletSanctionsFromSetting('0xnot-an-address')).toThrow(/Refusing to boot/);
  });

  it('step 1 refuses by name while any owner setting is blank, before a message is written', async () => {
    expect(await refusal(() => signed(deps({ session: () => null })))).toBe('protocol.wallet_session_unset');
    expect(await refusal(() => signed(deps({ ttlSeconds: () => null })))).toBe('protocol.venue_connection_ttl_unset');
    expect(await refusal(() => signed(deps({ sanctions: () => null })))).toBe('protocol.wallet_sanctions_unset');
  });
});

describe('connect (J-wallet-09 #1, #2)', () => {
  it('writes an EIP-4361 message naming INTAFACED, the address, the chain, a nonce and the expiry', () => {
    const issued = issueVenueChallenge(deps(), { userId: ALICE, address: WALLET.address.toLowerCase(), origin: ORIGIN }, T0);
    const parsed = parseSiweMessage(issued.message);
    expect(parsed.address).toBe(WALLET.address);
    expect(parsed.chainId).toBe(CHAIN_ID);
    expect(parsed.domain).toBe('127.0.0.1:3210');
    expect(parsed.nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(parsed.expirationTime?.toISOString()).toBe(later(TTL * 1000).toISOString());
    expect(issued.expiresAt.toISOString()).toBe(later(TTL * 1000).toISOString());
    expect(parsed.statement).toMatch(/INTAFACED/);
    expect(parsed.statement).toMatch(/no key and cannot move this wallet’s funds/);
    // A fresh nonce each time: two presses are two different messages.
    expect(issueVenueChallenge(deps(), { userId: ALICE, address: WALLET.address, origin: ORIGIN }, T0).message).not.toBe(issued.message);
  });

  it('a wallet on the sanctions list is refused with its reason, at the message and again at the signature', async () => {
    expect(await refusal(() => signed(deps(), LISTED))).toBe('protocol.wallet_sanctioned');
    // Listed after the message was written: the signature does not connect it either.
    let list = walletSanctionsFromSetting('none');
    const d = deps({ sanctions: () => list });
    const s = await signed(d, OTHER);
    list = walletSanctionsFromSetting(OTHER.address);
    expect(await refusal(() => openVenueConnection(d, { userId: ALICE, ...s }, T0))).toBe('protocol.wallet_sanctioned');
    expect(d.store.rows.size).toBe(0);
  });

  it('an origin the owner does not list is refused', async () => {
    expect(
      await refusal(() => issueVenueChallenge(deps(), { userId: ALICE, address: WALLET.address, origin: 'https://evil.example' }, T0)),
    ).toBe('protocol.wallet_session_origin_unlisted');
  });

  it('the wallet signs and the connection records the address and expiry, and no key', async () => {
    const d = deps();
    const s = await signed(d);
    const row = await openVenueConnection(d, { userId: ALICE, ...s }, later(1000));
    expect(row).toEqual({
      userId: ALICE,
      chainId: CHAIN_ID,
      address: WALLET.address,
      connectedAt: later(1000),
      expiresAt: later(TTL * 1000),
      revokedAt: null,
    });
    // Nothing key-like is kept: the record's fields are these and only these.
    expect(Object.keys(row).sort()).toEqual(['address', 'chainId', 'connectedAt', 'expiresAt', 'revokedAt', 'userId']);
    expect(JSON.stringify([...d.store.rows.values()])).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(d.store.spent.has(venueConnectKey(CHAIN_ID, parseSiweMessage(s.message).nonce!))).toBe(true);
  });

  it('refuses a signature from another wallet, an altered challenge, another person, and an expired challenge', async () => {
    const d = deps();
    const s = await signed(d);
    const wrong = await OTHER.signMessage({ message: s.message });
    expect(await refusal(() => openVenueConnection(d, { userId: ALICE, challenge: s.challenge, signature: wrong }, T0))).toBe(
      'protocol.wallet_signature_not_owner',
    );
    expect(await refusal(() => openVenueConnection(d, { userId: ALICE, challenge: `${s.challenge}x`, signature: s.signature }, T0))).toBe(
      'protocol.wallet_challenge_invalid',
    );
    // A message written for Alice cannot connect the wallet to Bob's account.
    expect(await refusal(() => openVenueConnection(d, { userId: BOB, ...s }, T0))).toBe('protocol.wallet_challenge_invalid');
    // Past half the connection's lifetime (one minute here, so thirty seconds), so a connection never opens nearly spent.
    expect(await refusal(() => openVenueConnection(d, { userId: ALICE, ...s }, later((TTL * 1000) / 2)))).toBe(
      'protocol.wallet_challenge_invalid',
    );
    // Past the five-minute bound when the connection lasts longer.
    const long = deps({ ttlSeconds: () => 3600 });
    const l = await signed(long);
    expect(await refusal(() => openVenueConnection(long, { userId: ALICE, ...l }, later(VENUE_CHALLENGE_TTL_MS)))).toBe(
      'protocol.wallet_challenge_invalid',
    );
    // Another chain.
    expect(await refusal(() => openVenueConnection(deps({ chainId: () => 1, store: d.store }), { userId: ALICE, ...s }, T0))).toBe(
      'protocol.wallet_challenge_invalid',
    );
    expect(d.store.rows.size).toBe(0);
  });

  it('a replayed challenge is refused: one signed message opens one connection once', async () => {
    const d = deps();
    const s = await signed(d);
    await openVenueConnection(d, { userId: ALICE, ...s }, T0);
    expect(await refusal(() => openVenueConnection(d, { userId: ALICE, ...s }, later(1000)))).toBe('protocol.venue_challenge_used');
    expect(d.store.rows.size).toBe(1);
  });

  it('a double press of Connect makes one connection: two signatures renew the same row', async () => {
    const d = deps();
    const [a, b] = await Promise.all([signed(d), signed(d)]);
    await Promise.all([openVenueConnection(d, { userId: ALICE, ...a }, T0), openVenueConnection(d, { userId: ALICE, ...b }, T0)]);
    expect(d.store.rows.size).toBe(1);
    expect(await d.store.list(ALICE, CHAIN_ID)).toHaveLength(1);
  });
});

describe('expiry (J-wallet-09 #4)', () => {
  it('every signed action refuses once the expiry passes, until the wallet signs again', async () => {
    const d = deps();
    await openVenueConnection(d, { userId: ALICE, ...(await signed(d)) }, T0);
    expect((await assertVenueConnectionLive(d, { userId: ALICE, address: WALLET.address }, later(TTL * 1000 - 1))).address).toBe(
      WALLET.address,
    );
    const expired = later(TTL * 1000);
    expect(await refusal(() => assertVenueConnectionLive(d, { userId: ALICE, address: WALLET.address }, expired))).toBe(
      'protocol.venue_connection_expired',
    );
    // Signing again connects it again, with a new expiry.
    await openVenueConnection(d, { userId: ALICE, ...(await signed(d, WALLET, ALICE, expired)) }, expired);
    const live = await assertVenueConnectionLive(d, { userId: ALICE, address: WALLET.address }, expired);
    expect(live.expiresAt.toISOString()).toBe(later(2 * TTL * 1000).toISOString());
  });

  it('a wallet never connected, connected by someone else, disconnected, or listed since refuses', async () => {
    const d = deps();
    expect(await refusal(() => assertVenueConnectionLive(d, { userId: ALICE, address: WALLET.address }, T0))).toBe(
      'protocol.venue_connection_none',
    );
    await openVenueConnection(d, { userId: ALICE, ...(await signed(d)) }, T0);
    expect(await refusal(() => assertVenueConnectionLive(d, { userId: BOB, address: WALLET.address }, T0))).toBe(
      'protocol.venue_connection_none',
    );
    let list = walletSanctionsFromSetting('none');
    const listed = deps({ store: d.store, sanctions: () => list });
    list = walletSanctionsFromSetting(WALLET.address);
    expect(await refusal(() => assertVenueConnectionLive(listed, { userId: ALICE, address: WALLET.address }, T0))).toBe(
      'protocol.wallet_sanctioned',
    );
    await d.store.revoke(ALICE, CHAIN_ID, WALLET.address, T0);
    expect(await refusal(() => assertVenueConnectionLive(d, { userId: ALICE, address: WALLET.address }, T0))).toBe(
      'protocol.venue_connection_none',
    );
  });
});

// ── Mounted: the procedures as the edge calls them ──────────────────────────────────────────────────────────────

const EDGE_SECRET = 'a-protocol-venue-wallet-test-edge-secret';
const edge = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-protocol' });
function signedIn(userId: string, region = 'DE') {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, region),
      'x-intafaced-region': region,
    },
    id: 'req-signed',
  });
}
const signedOut = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-public' });

function caller(d: Omit<VenueConnectionDeps, 'chainId'>, ctx = signedIn(ALICE)) {
  const routerDeps = {
    chain: { config: { chainId: CHAIN_ID, factory: ZERO, implementation: ZERO }, isDeployed: async () => false },
    registry: { accountsOf: async () => [] },
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
    venueWallet: d,
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(routerDeps).createCaller(ctx);
}

describe('venueWallet.* mounted', () => {
  const saved = { regions: process.env[SANCTIONS_REGIONS_ENV], source: process.env[SANCTIONS_SOURCE_ENV] };
  afterEach(() => {
    if (saved.regions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
    else process.env[SANCTIONS_REGIONS_ENV] = saved.regions;
    if (saved.source === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
    else process.env[SANCTIONS_SOURCE_ENV] = saved.source;
  });

  it('connects a signed-in person’s wallet; status shows it live with its expiry and holdsKey false', async () => {
    const d = deps();
    const alice = caller(d);
    const issued = await alice.venueWallet.challenge({ address: WALLET.address, origin: ORIGIN });
    const signature = await WALLET.signMessage({ message: issued.message });
    const opened = await alice.venueWallet.open({ challenge: issued.challenge, signature });
    expect(opened).toMatchObject({ address: WALLET.address, chainId: CHAIN_ID, status: 'live', holdsKey: false });
    expect(opened.expiresAt).toBe(issued.expiresAt);
    const status = await alice.venueWallet.status();
    expect(status.connections).toHaveLength(1);
    // Bob sees none of Alice's wallets.
    expect((await caller(d, signedIn(BOB)).venueWallet.status()).connections).toEqual([]);
    // A live connection reaches the venue check, which refuses by name until a venue is wired.
    await expect(alice.venueWallet.authorize({ address: WALLET.address, action: 'deposit' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^protocol\.venue_unwired:/),
    });
    await alice.venueWallet.disconnect({ address: WALLET.address });
    expect((await alice.venueWallet.status()).connections).toEqual([]);
    await expect(alice.venueWallet.authorize({ address: WALLET.address, action: 'withdraw' })).rejects.toMatchObject({
      message: expect.stringMatching(/^protocol\.venue_connection_none:/),
    });
  });

  it('status reads a wallet listed since it connected as blocked, the same answer an action gets', async () => {
    let list = walletSanctionsFromSetting('none');
    const d = deps({ sanctions: () => list });
    const alice = caller(d);
    const issued = await alice.venueWallet.challenge({ address: WALLET.address, origin: ORIGIN });
    await alice.venueWallet.open({ challenge: issued.challenge, signature: await WALLET.signMessage({ message: issued.message }) });
    list = walletSanctionsFromSetting(WALLET.address);
    expect((await alice.venueWallet.status()).connections.map((c) => c.status)).toEqual(['blocked']);
    await expect(alice.venueWallet.authorize({ address: WALLET.address, action: 'deposit' })).rejects.toMatchObject({
      message: expect.stringMatching(/^protocol\.wallet_sanctioned:/),
    });
  });

  it('refuses a listed wallet with its code, FORBIDDEN', async () => {
    await expect(caller(deps()).venueWallet.challenge({ address: LISTED.address, origin: ORIGIN })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/^protocol\.wallet_sanctioned:/),
    });
  });

  it('refuses a visitor from a region on the per-country switch, with its reason, before any message (OWNER 237)', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'US:TEST blocked at launch';
    process.env[SANCTIONS_SOURCE_ENV] = 'TEST fixture for J-wallet-09';
    const d = deps();
    const err = await caller(d, signedIn(ALICE, 'US'))
      .venueWallet.challenge({ address: WALLET.address, origin: ORIGIN })
      .then(
        () => null,
        (e: unknown) => e as { code: string; message: string; cause?: { code?: string } },
      );
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: 'TEST blocked at launch', cause: { code: 'denied.region_blocked' } });
    // The same person from a region not on the switch is served.
    await expect(caller(d, signedIn(ALICE, 'DE')).venueWallet.challenge({ address: WALLET.address, origin: ORIGIN })).resolves.toBeTruthy();
  });

  it('a signed-out visitor cannot connect a wallet', async () => {
    await expect(caller(deps(), signedOut()).venueWallet.challenge({ address: WALLET.address, origin: ORIGIN })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('with nothing wired, connecting refuses by name', async () => {
    const routerDeps = {
      chain: { config: { chainId: CHAIN_ID, factory: ZERO, implementation: ZERO }, isDeployed: async () => false },
      registry: { accountsOf: async () => [] },
      relay: {},
      relayEnabled: () => true,
      ammFactoryAddress: () => ZERO,
      swapSlippageBps: () => null,
    } as unknown as ProtocolRouterDeps;
    await expect(
      createProtocolRouter(routerDeps).createCaller(signedIn(ALICE)).venueWallet.challenge({ address: WALLET.address, origin: ORIGIN }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringMatching(/^protocol\.wallet_session_unset:/) });
  });
});
