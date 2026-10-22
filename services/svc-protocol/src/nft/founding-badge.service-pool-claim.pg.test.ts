import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import * as schema from '../db/schema.js';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { badgeClaimKey, badgeClaimMessage, type BadgeMinter } from './founding-badge.js';
import { PostgresBadgeStore } from './founding-badge.pg.js';

/**
 * RC-more-catalogue-04 auto-review minor: `badge.claim` output through the boot pool (`createDb` returns timestamptz as
 * text). A claim whose mint is in flight answers pending with `mintingSince` as an ISO string, not a 500.
 */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const available = URL ? await postgresAvailable(URL) : false;
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 2 }, schema) : null;
const ACCOUNT = 'bad9e000-abab-4bab-8bab-abababababab';
const KEY = badgeClaimKey(ACCOUNT);
const CHAIN_ID = 31337;
const ADDR = '0x00000000000000000000000000000000000000E2' as Address;
const OWNER = privateKeyToAccount(`0x${'66'.repeat(32)}`);
const SECRET = 'a-protocol-badge-service-pool-secret-xx';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });

function signed() {
  const raw = encodePrincipal({
    sub: ACCOUNT,
    userId: ACCOUNT,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
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
    id: 'req-badge-pool',
  });
}

describe.skipIf(!db)('badge.claim output on the service pool (createDb)', () => {
  beforeAll(async () => {
    await assertTestDatabase(db!.sql, 'svc-protocol founding-badge.service-pool-claim.pg.test');
    await db!.sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    await db!.sql.unsafe(readFileSync(join(here, '..', '..', 'drizzle', '0001_protocol_founding_badges.sql'), 'utf8'));
    await db!.sql`DELETE FROM protocol.founding_badge_claims WHERE key = ${KEY}`;
    await db!.sql`DELETE FROM protocol.founding_badge_list WHERE account_id = ${ACCOUNT}`;
    await db!.sql`INSERT INTO protocol.founding_badge_list (account_id) VALUES (${ACCOUNT})`;
    await db!.sql`
      INSERT INTO protocol.founding_badge_claims (key, account_id, chain_id, to_address, minting_at)
      VALUES (${KEY}, ${ACCOUNT}, ${CHAIN_ID}, ${ADDR}, '2026-10-22T03:00:00Z')`;
  });
  afterAll(async () => {
    await db!.sql`DELETE FROM protocol.founding_badge_claims WHERE key = ${KEY}`;
    await db!.sql`DELETE FROM protocol.founding_badge_list WHERE account_id = ${ACCOUNT}`;
    await db!.sql.end();
  });

  it('a claim with a mint in flight returns pending with mintingSince as ISO, and mints nothing', async () => {
    const mints: string[] = [];
    const minter: BadgeMinter = { signerFor: () => ({ mint: async (_to, key) => (mints.push(key), `0x${'ab'.repeat(32)}`) }) };
    const deps = {
      chain: { config: { chainId: CHAIN_ID }, isDeployed: async () => false },
      registry: {
        accountsOf: async () => [{ id: 'a', userId: ACCOUNT, chainId: CHAIN_ID, address: ADDR, owner: OWNER.address, deployed: true }],
      },
      relay: {},
      relayEnabled: () => true,
      ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
      swapSlippageBps: () => null,
      badge: {
        store: new PostgresBadgeStore(db!.sql),
        minter,
        window: () => ({ opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') }),
        mainnet: () => false,
        now: () => new Date('2026-10-22T04:00:00Z'),
      },
    } as unknown as ProtocolRouterDeps;
    const signature = await OWNER.signMessage({ message: badgeClaimMessage({ accountId: ACCOUNT, chainId: CHAIN_ID, address: ADDR }) });
    const out = await createProtocolRouter(deps).createCaller(signed()).badge.claim({ signature });
    expect(out).toMatchObject({ key: KEY, txHash: null, mintingSince: '2026-10-22T03:00:00.000Z', label: 'TEST', audited: false });
    expect(mints).toEqual([]);
  });
});
