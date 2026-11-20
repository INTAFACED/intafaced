import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuantError } from '../errors.js';
import type { QuotaGate } from '../quota/quota.js';
import { createPostgresTeamRepository } from './postgres-repository.js';

// AL-team-01 (J-algo-dev-08): collaborators, the edit lock, support grants and support reads on Postgres.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qteam_${process.pid}_${Date.now().toString(36)}`;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const databaseUrl = process.env.TEST_DATABASE_URL_QUANT?.trim() || process.env.TEST_DATABASE_URL?.trim();
const ready = await postgresAvailable(databaseUrl);

/** A gate that allows one collaborator per strategy and records what each check counted. */
function oneCollaborator(seen: bigint[]): QuotaGate {
  return {
    async lock() {},
    async check(_db, _account, needs) {
      for (const need of needs) {
        seen.push(need.used);
        if (need.used + need.adding > 1n) throw new QuantError('quant.quota_exceeded', `${need.resource}: ${need.used} used of 1 allowed`);
      }
    },
  };
}

describe.skipIf(!ready)('strategy team store on Postgres (AL-team-01)', () => {
  const sql = postgres(databaseUrl!, { max: 6, onnotice: () => undefined });
  const seen: bigint[] = [];
  const repo = createPostgresTeamRepository(sql, oneCollaborator(seen), SCHEMA);

  beforeAll(async () => {
    const lock: Sql = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
    await lock`SELECT pg_advisory_lock(hashtext('svc-quant.AL-team-01.migrate'))`;
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
      // The strategies table as 0000_quant_strategies.sql makes it, so the team tables' references hold.
      await sql.unsafe(
        `CREATE TABLE "${SCHEMA}"."strategies" (id text PRIMARY KEY, account_id uuid NOT NULL, client_strategy_id text NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL)`,
      );
      await sql.unsafe(readFileSync(join(SERVICE, 'drizzle/20261115120000_quant_team.sql'), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`));
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}"."strategies" (id, account_id, client_strategy_id, created_at) VALUES ('s1', $1, 'c1', now()), ('s2', $1, 'c2', now())`,
        [OWNER],
      );
    } finally {
      await lock`SELECT pg_advisory_unlock(hashtext('svc-quant.AL-team-01.migrate'))`;
      await lock.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('adds within the plan, changes a permission without counting, and refuses past the limit', async () => {
    const at = new Date();
    await repo.upsert({ strategyId: 's1', ownerId: OWNER, memberId: MATE, role: 'view', liveControl: false, at });
    const changed = await repo.upsert({ strategyId: 's1', ownerId: OWNER, memberId: MATE, role: 'edit', liveControl: true, at });
    expect(changed).toMatchObject({ role: 'edit', liveControl: true });
    await expect(repo.upsert({ strategyId: 's1', ownerId: OWNER, memberId: OTHER, role: 'view', liveControl: false, at })).rejects.toThrow(
      /^quant\.quota_exceeded — collaborators: 1 used/,
    );
    expect(seen).toEqual([0n, 1n]);
    expect((await repo.collaborators('s1')).map((row) => row.memberId)).toEqual([MATE]);
    expect((await repo.sharedWith(MATE)).map((row) => row.strategyId)).toEqual(['s1']);
    expect(await repo.mostCollaborators(OWNER)).toBe(1n);
    // Not the owner's strategy: not found, nothing stored.
    await expect(repo.upsert({ strategyId: 's1', ownerId: OTHER, memberId: MATE, role: 'view', liveControl: false, at })).rejects.toThrow(
      /^quant\.studio_not_found/,
    );
  });

  it('gives the lock to one of two people taking it at once, and to the other once it lapses', async () => {
    const at = new Date();
    const [a, b] = await Promise.all([
      repo.takeLock({ strategyId: 's2', holderId: OWNER, at, ttlMs: 20_000 }),
      repo.takeLock({ strategyId: 's2', holderId: MATE, at, ttlMs: 20_000 }),
    ]);
    expect([a.taken, b.taken].filter(Boolean)).toHaveLength(1);
    const winner = a.taken ? OWNER : MATE;
    const loser = a.taken ? MATE : OWNER;
    expect((await repo.takeLock({ strategyId: 's2', holderId: winner, at, ttlMs: 20_000 })).taken).toBe(true);
    const lapsed = new Date(at.getTime() + 20_000);
    const took = await repo.takeLock({ strategyId: 's2', holderId: loser, at: lapsed, ttlMs: 20_000 });
    expect(took).toMatchObject({ taken: true, lock: { holderId: loser } });
  });

  it('removing a teammate drops their lock', async () => {
    const at = new Date();
    await repo.releaseLock({ strategyId: 's1', holderId: OWNER });
    expect((await repo.takeLock({ strategyId: 's1', holderId: MATE, at, ttlMs: 60_000 })).taken).toBe(true);
    await repo.remove({ strategyId: 's1', memberId: MATE });
    expect(await repo.membership({ strategyId: 's1', memberId: MATE })).toBeNull();
    expect(await repo.lock('s1')).toBeNull();
  });

  it('stores one grant per key, reads under it only while it lasts, and never rewrites a grant or a read', async () => {
    const at = new Date();
    const [one, two] = await Promise.all([
      repo.createGrant({ strategyId: 's1', ownerId: OWNER, key: 'quant.grant:s1:0', at, seconds: 60 }),
      repo.createGrant({ strategyId: 's1', ownerId: OWNER, key: 'quant.grant:s1:0', at, seconds: 60 }),
    ]);
    expect(one.id).toBe(two.id);
    expect((await repo.recordRead({ strategyId: 's1', reader: 'support-1', at }))?.id).toBe(one.id);
    expect(await repo.recordRead({ strategyId: 's1', reader: 'support-1', at: new Date(at.getTime() + 61_000) })).toBeNull();
    expect((await repo.reads('s1')).map((row) => row.granted)).toEqual([true, false]);
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."support_grants" SET expires_at = now() + interval '1 day'`)).rejects.toThrow(
      /quant\.support_audit_immutable/,
    );
    await expect(sql.unsafe(`DELETE FROM "${SCHEMA}"."support_reads"`)).rejects.toThrow(/quant\.support_audit_immutable/);
  });
});
