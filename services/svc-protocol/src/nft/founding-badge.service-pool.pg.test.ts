import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import * as schema from '../db/schema.js';
import { badgeClaimKey, BADGE_STUCK_APPROVAL_UNWIRED, resolveStuckBadgeMint } from './founding-badge.js';
import { PostgresBadgeStore } from './founding-badge.pg.js';

/**
 * RC-more-catalogue-04 running-app finding: the boot pool (`createDb`, as in index.ts) returns timestamptz as text, so
 * a stuck slot's `mintingSince` must still be a Date or the operator clear and the claim output 500.
 */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const available = URL ? await postgresAvailable(URL) : false;
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 2 }, schema) : null;
const ACCOUNT = 'bad9e000-eeee-4eee-8eee-eeeeeeeeeeee';
const KEY = badgeClaimKey(ACCOUNT);

describe.skipIf(!db)('founding badge store on the service pool (createDb)', () => {
  beforeAll(async () => {
    await assertTestDatabase(db!.sql, 'svc-protocol founding-badge.service-pool.pg.test');
    await db!.sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    for (const f of ['0001_protocol_founding_badges.sql', '0002_protocol_founding_badge_mint_clears.sql']) {
      await db!.sql.unsafe(readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));
    }
    await db!.sql`DELETE FROM protocol.founding_badge_claims WHERE key = ${KEY}`;
    await db!.sql`
      INSERT INTO protocol.founding_badge_claims (key, account_id, chain_id, to_address, minting_at)
      VALUES (${KEY}, ${ACCOUNT}, 31337, '0x00000000000000000000000000000000000000E1', now() - interval '1 hour')`;
  });
  afterAll(async () => {
    await db!.sql`DELETE FROM protocol.founding_badge_claims WHERE key = ${KEY}`;
    await db!.sql.end();
  });

  it('a stuck slot reads back as a Date and the clear refuses typed, not a TypeError', async () => {
    const store = new PostgresBadgeStore(db!.sql);
    expect((await store.findClaim(KEY))!.mintingSince).toBeInstanceOf(Date);
    await expect(
      resolveStuckBadgeMint(
        { store, approvals: null, staleAfterSeconds: 600, now: () => new Date() },
        {
          accountId: ACCOUNT,
          evidence: { kind: 'minted', txHash: `0x${'aa'.repeat(32)}` as Hex },
          reason: 'r',
          actorId: 'op',
          approvalId: 'a',
          operationId: 'o',
        },
      ),
    ).rejects.toMatchObject({ code: BADGE_STUCK_APPROVAL_UNWIRED });
  });
});
