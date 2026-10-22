import postgres from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAIM_UPSERT_SQL_SHAPE } from './dispute-casework.js';

/**
 * P-disputes-security-05: the claim upsert is one atomic statement. The table is
 * created here (no migration exists yet; the migration lands with the wiring
 * slice). Needs TEST_DATABASE_URL (the shared PG test harness); PG-hard, no skip.
 */
const CLAIM = CLAIM_UPSERT_SQL_SHAPE.replace('$id', '$1').replace('$agent', '$2').replace('$lease', '$3');

describe('dispute case claim upsert (Postgres)', () => {
  let db: TestDatabase | undefined;
  let sql!: ReturnType<typeof postgres>;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', migrations: [] });
    sql = postgres(db.url, { max: 12, onnotice: () => undefined });
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS p2p');
    await sql.unsafe('CREATE TABLE p2p.p2p_dispute_assignments (dispute_id text PRIMARY KEY, agent_id text, lease_until timestamptz)');
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.drop();
  });

  const claim = (id: string, agent: string, lease: number) => sql.unsafe(CLAIM, [id, agent, lease]);

  it('binds $lease as integer seconds (make_interval) and the first claim needs no row', async () => {
    const rows = await claim('d-first', 'a1', 300);
    expect(rows.map((r) => r.agent_id)).toEqual(['a1']);
    const [row] = await sql.unsafe(
      "SELECT extract(epoch FROM lease_until - now())::int AS secs FROM p2p.p2p_dispute_assignments WHERE dispute_id = 'd-first'",
    );
    expect(Number(row.secs)).toBeGreaterThan(290);
    expect(Number(row.secs)).toBeLessThanOrEqual(300);
  });

  it('ten agents claiming one free case at once: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim('d-race', `a${i}`, 300)));
    const winners = results.filter((r) => r.length === 1);
    expect(winners).toHaveLength(1);
    const [row] = await sql.unsafe("SELECT agent_id FROM p2p.p2p_dispute_assignments WHERE dispute_id = 'd-race'");
    expect(row.agent_id).toBe(winners[0][0].agent_id);
  });

  it('a held case refuses another agent (0 rows); the holder renews; an expired lease is taken', async () => {
    await claim('d-held', 'a1', 300);
    expect(await claim('d-held', 'a2', 300)).toHaveLength(0);
    expect((await claim('d-held', 'a1', 600)).map((r) => r.agent_id)).toEqual(['a1']);
    await sql.unsafe("UPDATE p2p.p2p_dispute_assignments SET lease_until = now() - interval '1 second' WHERE dispute_id = 'd-held'");
    expect((await claim('d-held', 'a2', 300)).map((r) => r.agent_id)).toEqual(['a2']);
  });
});
