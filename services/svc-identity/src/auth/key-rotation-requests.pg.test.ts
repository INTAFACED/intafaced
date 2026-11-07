/**
 * A key's own rotation request against Postgres (DV-keys-04, J-developer-07 #3): one waiting request per key, the
 * requesting key can never approve it, no other key can either, and another account's request reads as none.
 * The person's approval (one rotation, the request spent in the same transaction) is walked by the journey.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';
import { approveByKey, approveByPerson, requestRotation, waitingRotation, RotationRequestError } from './key-rotation-requests.js';
import type { DeveloperKeysDeps } from './developer-keys.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const db: TestDb = await createTestDb({
  service: 'identity',
  url: identityTestUrl(),
  migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
});
afterAll(async () => {
  await db.drop();
});
const bus = new MemoryEventBus('svc-identity');
const auth = new AuthService(
  db.sql,
  bus,
  new RankService(db.sql, bus),
  {
    secret: 'an-identity-key-rotation-request-test-secret-long',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
  },
  undefined,
  randomBytes(32).toString('base64'),
  undefined,
  undefined,
  25,
);
auth.useLogger({ warn: () => undefined });

let n = 0;
async function holder(keys = 1): Promise<{ userId: string; keys: string[] }> {
  n += 1;
  const handle = `krr${process.pid}${n}`;
  const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  const ids: string[] = [];
  for (let i = 0; i < keys; i += 1) {
    const [row] = await db.sql<Array<{ id: string }>>`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes)
      VALUES (${session.userId}, ${`TEST bot ${i}`}, ${randomBytes(32).toString('hex')}, ${`k${n}x${i}`}, ${['trade:read', 'trade:write']})
      RETURNING id`;
    ids.push(row!.id);
  }
  return { userId: session.userId, keys: ids };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    if (err instanceof RotationRequestError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe("a key's own rotation request", () => {
  it('waits once per key: a second ask answers with the waiting request', async () => {
    const { userId, keys } = await holder();
    const first = await requestRotation(db.sql, { userId, keyId: keys[0]!, overlapSeconds: 0 });
    const again = await requestRotation(db.sql, { userId, keyId: keys[0]!, overlapSeconds: 30 });
    expect(again.requestId).toBe(first.requestId);
    expect(again.overlapSeconds).toBe(0);
    expect(await waitingRotation(db.sql, userId, keys[0]!)).toEqual(first);
    const [{ count }] = await db.sql<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM api_key_rotation_requests WHERE key_id = ${keys[0]!}`;
    expect(count).toBe(1);
  });

  it('refuses the requesting key by name, any other key because only a person approves, and changes nothing', async () => {
    const { userId, keys } = await holder(2);
    const { requestId } = await requestRotation(db.sql, { userId, keyId: keys[0]!, overlapSeconds: 0 });
    expect(await refusal(approveByKey(db.sql, { userId, keyId: keys[0]!, requestId }))).toBe('identity.rotation_self_approval');
    expect(await refusal(approveByKey(db.sql, { userId, keyId: keys[1]!, requestId }))).toBe('identity.rotation_approver_not_person');
    expect((await waitingRotation(db.sql, userId, keys[0]!))?.requestId).toBe(requestId);
    const [{ count }] = await db.sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM api_keys WHERE user_id = ${userId}`;
    expect(count).toBe(2);
  });

  it("another account's request, or a made-up id, reads as none", async () => {
    const owner = await holder();
    const other = await holder();
    const { requestId } = await requestRotation(db.sql, { userId: owner.userId, keyId: owner.keys[0]!, overlapSeconds: 0 });
    expect(await refusal(approveByKey(db.sql, { userId: other.userId, keyId: other.keys[0]!, requestId }))).toBe(
      'identity.rotation_request_not_found',
    );
    expect(await refusal(approveByKey(db.sql, { userId: owner.userId, keyId: owner.keys[0]!, requestId: randomUUID() }))).toBe(
      'identity.rotation_request_not_found',
    );
    expect(await waitingRotation(db.sql, other.userId, owner.keys[0]!)).toBeNull();
    expect(await refusal(requestRotation(db.sql, { userId: other.userId, keyId: owner.keys[0]!, overlapSeconds: 0 }))).toBe(
      'identity.key_not_found',
    );
  });

  it('a revoked key cannot ask', async () => {
    const { userId, keys } = await holder();
    await db.sql`UPDATE api_keys SET revoked = true, revoked_at = now() WHERE id = ${keys[0]!}`;
    expect(await refusal(requestRotation(db.sql, { userId, keyId: keys[0]!, overlapSeconds: 0 }))).toBe('identity.key_not_live');
  });

  it('a key or a sub-account cannot approve through the person door, before anything is read', async () => {
    const { userId, keys } = await holder();
    const { requestId } = await requestRotation(db.sql, { userId, keyId: keys[0]!, overlapSeconds: 0 });
    const deps = { sql: db.sql } as unknown as DeveloperKeysDeps;
    for (const caller of [
      { userId, sid: 's', kid: keys[0]!, scopes: ['identity:write'] },
      { userId, sid: 's', sub_account: randomUUID(), scopes: ['identity:write'] },
    ]) {
      expect(await refusal(approveByPerson(deps, caller, { requestId }))).toBe('identity.rotation_approver_not_person');
    }
    expect((await waitingRotation(db.sql, userId, keys[0]!))?.requestId).toBe(requestId);
  });
});
