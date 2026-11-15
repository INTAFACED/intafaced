import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresLibraryRepository } from './postgres-repository.js';

// AL-library-01 and AL-library-02 (J-algo-dev-09): listings, access rows, clone lineage and reviews on Postgres.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qlib_${process.pid}_${Date.now().toString(36)}`;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const databaseUrl = process.env.TEST_DATABASE_URL_QUANT?.trim() || process.env.TEST_DATABASE_URL?.trim();
const ready = await postgresAvailable(databaseUrl);

describe.skipIf(!ready)('strategy library store on Postgres (AL-library-01, AL-library-02)', () => {
  const sql = postgres(databaseUrl!, { max: 4, onnotice: () => undefined });
  const repo = createPostgresLibraryRepository(sql, SCHEMA);
  const listing = (strategyId: string, visibility: 'open' | 'protected' | 'invite', tags: ('trend' | 'swing')[]) => ({
    key: `quant.listing:${strategyId}:v1`,
    ownerId: OWNER,
    strategyId,
    strategyVersion: 1,
    runId: `run-${strategyId}`,
    title: `TEST ${strategyId}`,
    description: 'TEST description',
    tags,
    visibility,
    licence: 'TEST licence',
    checklistVersion: 'TEST v1',
    at: new Date(),
  });

  beforeAll(async () => {
    const lock: Sql = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
    await lock`SELECT pg_advisory_lock(hashtext('svc-quant.AL-library.migrate'))`;
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
      // The strategies table as 0000_quant_strategies.sql makes it, so the library tables' references hold.
      await sql.unsafe(
        `CREATE TABLE "${SCHEMA}"."strategies" (id text PRIMARY KEY, account_id uuid NOT NULL, client_strategy_id text NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL)`,
      );
      await sql.unsafe(
        readFileSync(join(SERVICE, 'drizzle/20261115140000_quant_library.sql'), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`),
      );
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}"."strategies" (id, account_id, client_strategy_id, created_at)
         VALUES ('s1', $1, 'c1', now()), ('s2', $1, 'c2', now()), ('s3', $1, 'c3', now()), ('copy', $2, 'c4', now())`,
        [OWNER, READER],
      );
    } finally {
      await lock`SELECT pg_advisory_unlock(hashtext('svc-quant.AL-library.migrate'))`;
      await lock.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('stores one listing per key, browses open and protected ones in registration order by tag, and refuses rewrites', async () => {
    const a = await repo.publish(listing('s1', 'open', ['trend']));
    expect((await repo.publish(listing('s1', 'open', ['trend']))).id).toBe(a.id);
    const b = await repo.publish(listing('s2', 'invite', ['trend']));
    const c = await repo.publish(listing('s3', 'protected', ['trend', 'swing']));
    expect((await repo.browse({ tag: null, afterSeq: 0, limit: 10 })).map((row) => row.id)).toEqual([a.id, c.id]);
    expect((await repo.browse({ tag: 'swing', afterSeq: 0, limit: 10 })).map((row) => row.id)).toEqual([c.id]);
    expect((await repo.browse({ tag: null, afterSeq: a.seq, limit: 10 })).map((row) => row.id)).toEqual([c.id]);
    expect((await repo.listingsOf(OWNER)).map((row) => row.id)).toEqual([a.id, b.id, c.id]);
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."library_listings" SET title = 'x' WHERE id = $1`, [a.id])).rejects.toThrow(
      /quant\.library_immutable/,
    );
  });

  it('keeps access rows insert-only and idempotent per seq, and one clone and one review per person', async () => {
    const [invite] = (await repo.listingsOf(OWNER)).filter((row) => row.visibility === 'invite');
    const at = new Date();
    await repo.addAccess({ listingId: invite!.id, userId: READER, action: 'request', seq: 0, actor: READER, at });
    await repo.addAccess({ listingId: invite!.id, userId: READER, action: 'request', seq: 0, actor: READER, at });
    await repo.addAccess({ listingId: invite!.id, userId: READER, action: 'grant', seq: 1, actor: OWNER, at });
    expect((await repo.access(invite!.id)).map((row) => row.action)).toEqual(['request', 'grant']);
    await expect(sql.unsafe(`DELETE FROM "${SCHEMA}"."library_access"`)).rejects.toThrow(/quant\.library_immutable/);

    await repo.recordClone({ strategyId: 'copy', accountId: READER, listingId: invite!.id, sourceVersion: 1, at });
    await repo.recordClone({ strategyId: 'copy', accountId: READER, listingId: invite!.id, sourceVersion: 1, at });
    expect(await repo.cloneOf({ listingId: invite!.id, accountId: READER })).toMatchObject({ strategyId: 'copy', sourceVersion: 1 });
    expect(await repo.lineage('copy')).toMatchObject({ listingId: invite!.id });

    await repo.addReview({ listingId: invite!.id, reviewerId: READER, text: 'TEST first', at });
    await repo.addReview({ listingId: invite!.id, reviewerId: READER, text: 'TEST second', at });
    expect((await repo.reviews(invite!.id)).map((row) => row.text)).toEqual(['TEST first']);
  });
});
