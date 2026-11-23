import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresTrustDeskStore } from './trust-desk.pg.js';
import { PostgresAddressRiskStore } from './risk.pg.js';
import { addToBlocklist, approveChecklist, openChecklist, readBlocklist, requireRoutable } from './trust-desk.js';

/** The token blocklist (20261122090000) and the permissioned tokens beside it, on a real test database. Deletes only this file's rows. */
// CI provides the database; this test runs unconditionally and fails where none answers.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrations = ['20261113040000_protocol_trust_desk.sql', '20261122090000_protocol_token_blocklist.sql'].map((f) =>
  join(here, '..', '..', 'drizzle', f),
);
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db = createDb({ url: URL, schema: 'protocol', max: 4 }, {});
const sql: Sql = db.sql;
const CHAIN_ID = 991_220;
const BLOCKED = '0x00000000000000000000000000000000000ba5e0';
const OTHER = '0x000000000000000000000000000000000000beef';
const GATED = '0x000000000000000000000000000000000000a11c';
const CHECKER = '0x000000000000000000000000000000000000c4ec';

describe('token blocklist (Postgres)', () => {
  const store = new PostgresTrustDeskStore(sql);
  const risk = new PostgresAddressRiskStore(sql);
  const cleanup = async () => {
    await sql`DELETE FROM protocol.token_blocklist WHERE chain_id = ${CHAIN_ID}`;
    await sql`DELETE FROM protocol.pool_onboarding WHERE chain_id = ${CHAIN_ID}`;
  };
  beforeAll(async () => {
    await assertTestDatabase(sql, 'svc-protocol blocklist.pg.test');
    await sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    for (const m of migrations) await sql.unsafe(readFileSync(m, 'utf8'));
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it('a blocked token is listed once with who and why, refuses routing, and shows on its address read', async () => {
    await requireRoutable(store, CHAIN_ID, [BLOCKED, OTHER]);
    const entry = await addToBlocklist(store, {
      chainId: CHAIN_ID,
      token: BLOCKED.toUpperCase().replace('0X', '0x'),
      reason: ' TEST phishing token ',
      actorId: 'founder-a',
    });
    expect(entry).toMatchObject({ token: BLOCKED, reason: 'TEST phishing token', addedBy: 'founder-a' });
    // The business key: a second add of the same token refuses and changes nothing.
    await expect(
      addToBlocklist(store, { chainId: CHAIN_ID, token: BLOCKED, reason: 'TEST again', actorId: 'founder-b' }),
    ).rejects.toMatchObject({
      code: 'protocol.blocklist.already_blocked',
    });
    const read = await readBlocklist(store, CHAIN_ID, new Date());
    expect(read.blocked.map((b) => [b.token, b.reason, b.addedBy])).toEqual([[BLOCKED, 'TEST phishing token', 'founder-a']]);
    // Not routed: a route naming it refuses by name; one that does not still passes.
    await expect(requireRoutable(store, CHAIN_ID, [OTHER, BLOCKED.toUpperCase().replace('0X', '0x')])).rejects.toMatchObject({
      code: 'protocol.token_blocked',
      tokens: [BLOCKED],
    });
    await requireRoutable(store, CHAIN_ID, [OTHER]);
    // Only this chain's list counts.
    await requireRoutable(store, CHAIN_ID + 1, [BLOCKED]);
    const standing = await risk.tokenStanding(CHAIN_ID, BLOCKED as `0x${string}`);
    expect(standing.blocked).toMatchObject({ reason: 'TEST phishing token' });
    expect(standing.permissioned).toBeNull();
  });

  it('a token is permissioned only once its checklist is approved, gated by that checklist checker', async () => {
    const opened = await openChecklist(store, {
      chainId: CHAIN_ID,
      pool: 'TEST permissioned pool',
      legalEntity: 'TEST Issuer Ltd',
      tokenContract: GATED,
      checkerAddress: CHECKER,
      wrapperAddress: '0x000000000000000000000000000000000000a7a9',
      routingRegistration: 'TEST registry entry',
      openedBy: 'founder-a',
    });
    expect((await readBlocklist(store, CHAIN_ID, new Date())).permissioned).toEqual([]);
    expect((await risk.tokenStanding(CHAIN_ID, GATED as `0x${string}`)).permissioned).toBeNull();
    await approveChecklist(store, { chainId: CHAIN_ID, checklistId: opened.id, approverId: 'founder-b', reason: 'TEST checked' });
    const permissioned = (await readBlocklist(store, CHAIN_ID, new Date())).permissioned;
    expect(permissioned.map((p) => [p.token, p.pool, p.checkerAddress])).toEqual([[GATED, 'TEST permissioned pool', CHECKER]]);
    expect((await risk.tokenStanding(CHAIN_ID, GATED as `0x${string}`)).permissioned).toMatchObject({
      pool: 'TEST permissioned pool',
      checkerAddress: CHECKER,
    });
  });
});
