import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { badgeClaimKey, badgeClaimMessage, BadgeMintNotSentError, type BadgeMinter } from './founding-badge.js';
import { PostgresBadgeStore } from './founding-badge.pg.js';

/**
 * RC-more-catalogue-04 on a real test database, through the mounted router.
 * Applies 0001 (idempotent DDL) and deletes only this file's rows.
 */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '0001_protocol_founding_badges.sql');
const identityMigration = join(here, '..', '..', 'drizzle', '20261031001739_protocol_badge_chain_identity.sql');
const available = URL ? await postgresAvailable(URL) : false;
const sql: Sql | null = URL && available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

const USER = 'bad9e000-1111-4111-8111-111111111111';
const OTHER = 'bad9e000-2222-4222-8222-222222222222';
const STRANGER = 'bad9e000-3333-4333-8333-333333333333';
const ADDR = '0x00000000000000000000000000000000000000B1' as Address;
const CHAIN_ID = 31337;
const OWNER_KEY = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const sig = (accountId: string) => OWNER_KEY.signMessage({ message: badgeClaimMessage({ accountId, chainId: CHAIN_ID, address: ADDR }) });
const SECRET = 'a-protocol-badge-test-edge-secret-length';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });
const WINDOW = { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') };

function signedAs(userId: string, scopes: string[] = ['protocol:read']) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-badge',
  });
}

function build(opts: { window?: typeof WINDOW | null; mainnet?: boolean; signer?: boolean; failMint?: boolean } = {}) {
  const mints: Array<{ to: Address; key: string }> = [];
  const minter: BadgeMinter = {
    signerFor: () =>
      opts.signer === false
        ? null
        : {
            mint: async (to, key) => {
              if (opts.failMint) throw new BadgeMintNotSentError('crash after claim stored');
              mints.push({ to, key });
              return `0x${'ab'.repeat(31)}${String(mints.length).padStart(2, '0')}` as Hex;
            },
          },
  };
  const deps = {
    chain: { config: { chainId: CHAIN_ID }, isDeployed: async () => false, genesisHash: async () => `0x${'e'.repeat(64)}` as const },
    registry: {
      accountsOf: async (userId: string) =>
        userId === STRANGER ? [] : [{ id: 'a', userId, chainId: CHAIN_ID, address: ADDR, owner: OWNER_KEY.address, deployed: true }],
    },
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    badge: {
      store: new PostgresBadgeStore(sql!),
      minter,
      window: () => (opts.window === undefined ? WINDOW : opts.window),
      mainnet: () => opts.mainnet ?? false,
      now: () => new Date('2026-10-22T04:00:00Z'),
    },
  } as unknown as ProtocolRouterDeps;
  return { router: createProtocolRouter(deps), mints };
}

async function cleanup() {
  await sql!`DELETE FROM protocol.founding_badge_claims WHERE account_id IN (${USER}, ${OTHER}, ${STRANGER})`;
  await sql!`DELETE FROM protocol.founding_badge_list WHERE account_id IN (${USER}, ${OTHER}, ${STRANGER})`;
}

describe.skipIf(!sql)('founding badge (Postgres + router)', () => {
  beforeAll(async () => {
    await assertTestDatabase(sql!, 'svc-protocol founding-badge.pg.test');
    await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
    await sql!.unsafe(readFileSync(migration, 'utf8'));
    await sql!.unsafe(readFileSync(identityMigration, 'utf8'));
    await cleanup();
    await sql!`INSERT INTO protocol.founding_badge_list (account_id) VALUES (${USER}), (${OTHER}), (${STRANGER})`;
  });
  afterAll(async () => {
    await cleanup();
    await sql!.end();
  });

  it('blank window: badge.window_unset and no row, no mint', async () => {
    const { router, mints } = build({ window: null });
    await expect(router.createCaller(signedAs(USER)).badge.claim({ signature: await sig(USER) })).rejects.toThrow(/badge\.window_unset/);
    await expect(router.createCaller(signedAs(USER)).badge.eligibility()).rejects.toThrow(/badge\.window_unset/);
    expect(mints).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM protocol.founding_badge_claims WHERE account_id = ${USER}`).toHaveLength(0);
  });

  it('mainnet: audit.external; no signer: rail.crypto', async () => {
    await expect(
      build({ mainnet: true })
        .router.createCaller(signedAs(USER))
        .badge.claim({ signature: await sig(USER) }),
    ).rejects.toThrow(/audit\.external/);
    await expect(
      build({ signer: false })
        .router.createCaller(signedAs(USER))
        .badge.claim({ signature: await sig(USER) }),
    ).rejects.toThrow(/rail\.crypto/);
  });

  it('no registered own account: badge.not_eligible', async () => {
    await expect(
      build()
        .router.createCaller(signedAs(STRANGER))
        .badge.claim({ signature: await sig(STRANGER) }),
    ).rejects.toThrow(/badge\.not_eligible/);
  });

  it('signer refused before sending (BadgeMintNotSentError): slot released, retry mints once with the stored key; second claim returns the stored claim', async () => {
    await expect(
      build({ failMint: true })
        .router.createCaller(signedAs(USER))
        .badge.claim({ signature: await sig(USER) }),
    ).rejects.toBeTruthy();
    const pending = await sql!`SELECT tx_hash FROM protocol.founding_badge_claims WHERE key = ${badgeClaimKey(USER)}`;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.tx_hash).toBeNull();

    const { router, mints } = build();
    const first = await router.createCaller(signedAs(USER)).badge.claim({ signature: await sig(USER) });
    const second = await router.createCaller(signedAs(USER)).badge.claim({ signature: await sig(USER) });
    expect(mints).toEqual([{ to: ADDR, key: badgeClaimKey(USER) }]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ key: badgeClaimKey(USER), to: ADDR, label: 'TEST', audited: false });
    const elig = await router.createCaller(signedAs(USER)).badge.eligibility();
    expect(elig).toEqual({ eligible: true, claimed: true, label: 'TEST', audited: false, txHash: first.txHash });
  });

  it('another account claiming to the same address: badge.already_claimed', async () => {
    const { router, mints } = build();
    await expect(router.createCaller(signedAs(OTHER)).badge.claim({ signature: await sig(OTHER) })).rejects.toThrow(
      /badge\.already_claimed/,
    );
    expect(mints).toHaveLength(0);
  });

  it('an unsigned claim is refused badge.not_eligible and stores nothing', async () => {
    const { router, mints } = build();
    await expect(router.createCaller(signedAs(OTHER)).badge.claim()).rejects.toThrow(/badge\.not_eligible/);
    await expect(router.createCaller(signedAs(OTHER)).badge.claim({})).rejects.toThrow(/badge\.not_eligible/);
    expect(mints).toHaveLength(0);
    expect(await sql!`SELECT 1 FROM protocol.founding_badge_claims WHERE account_id = ${OTHER}`).toHaveLength(0);
  });

  it('eligibility needs no signer', async () => {
    await expect(build({ signer: false }).router.createCaller(signedAs(USER)).badge.eligibility()).resolves.toMatchObject({
      eligible: true,
    });
  });

  it('anonymous caller is refused', async () => {
    const anon = edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' });
    await expect(build().router.createCaller(anon).badge.claim()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
