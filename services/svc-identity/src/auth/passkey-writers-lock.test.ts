import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { checkMayAddFactor, type FactorActor } from './factor-gate.js';
import { enrollPasskey, toRegistrationResponseJSON, type PasskeyCeremony, type StoredPasskey } from './enroll-passkey.js';
import { toAuthenticationResponseJSON, verifyPasskey, type VerifyPasskeyCeremony } from './verify-passkey.js';
import { unenrollPasskey } from './unenroll-passkey.js';
import type { ChallengeStorePort } from './webauthn.js';

/**
 * Concurrency proof for the three standalone passkey writers (#4618) against
 * real Postgres: enroll-passkey.ts, verify-passkey.ts and unenroll-passkey.ts
 * read-modify-write `users.webauthn_creds`. Without `SELECT … FOR UPDATE` in
 * one transaction a race loses an update or brings a removed passkey back.
 *
 * Each race is forced open (a gate in the ceremony, or a delay after the
 * read), so these fail on the unlocked code every time, not just sometimes.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Resolves for everyone once `n` callers have arrived. */
function barrier(n: number) {
  let arrived = 0;
  const gate = deferred();
  return async () => {
    arrived += 1;
    if (arrived >= n) gate.release();
    await gate.promise;
  };
}

const mfaActor: FactorActor = { mfa: true, privileged: false };
const passwordOnly: FactorActor = { mfa: false, privileged: false };

const rp = { rpId: 'intafaced.com', rpName: 'INTAFACED', origin: 'https://app.intafaced.com' };

function cred(credentialId: string, counter = 0): StoredPasskey {
  return { credentialId, publicKey: 'AQID', counter, transports: ['internal'], createdAt: '2026-10-13T00:00:00.000Z' };
}

function clientData(challenge: string, type: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin: rp.origin }), 'utf8').toString('base64url');
}

function holdingChallenges(userId: string): ChallengeStorePort {
  return {
    async put() {},
    async take(challenge, kind) {
      return { challenge, userId, kind, expiresAt: Date.now() + 60_000 };
    },
  };
}

function registration(id: string) {
  return toRegistrationResponseJSON({
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: clientData('c', 'webauthn.create'), attestationObject: 'a' },
  });
}

function assertion(id: string) {
  return toAuthenticationResponseJSON({
    id,
    rawId: id,
    type: 'public-key',
    response: { clientDataJSON: clientData('c', 'webauthn.get'), authenticatorData: 'a', signature: 's' },
  });
}

/** Registration ceremony that stores whatever id the response carries, after `before()`. */
function enrollCeremony(before: () => Promise<void>): PasskeyCeremony {
  return {
    generate: async () => {
      throw new Error('generate must not be called');
    },
    verify: (async ({ response }: { response: { id: string } }) => {
      await before();
      return {
        verified: true,
        registrationInfo: { credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } },
      };
    }) as unknown as PasskeyCeremony['verify'],
  };
}

/** Authentication ceremony that reports `newCounter` for the asserted credential, after `before()`. */
function verifyCeremony(before: () => Promise<void>, newCounter: (id: string) => number): VerifyPasskeyCeremony {
  return {
    generate: async () => {
      throw new Error('generate must not be called');
    },
    verify: (async ({ response }: { response: { id: string } }) => {
      await before();
      return { verified: true, authenticationInfo: { newCounter: newCounter(response.id), credentialID: response.id } };
    }) as unknown as VerifyPasskeyCeremony['verify'],
  };
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('passkey writers row lock (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  afterAll(async () => {
    await db.drop();
  });

  let n = 0;
  async function makeUser(creds: StoredPasskey[]): Promise<string> {
    const handle = `lock${process.pid}x${++n}`;
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO users (handle, email, password_hash, webauthn_creds)
      VALUES (${handle}, ${`${handle}@example.com`}, 'x', ${db.sql.json(creds as never)})
      RETURNING id
    `;
    return rows[0]!.id;
  }
  async function credsOf(userId: string): Promise<StoredPasskey[]> {
    const rows = await db.sql<Array<{ webauthn_creds: StoredPasskey[] }>>`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
    return rows[0]!.webauthn_creds;
  }

  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('passkey writers take the user row lock (#4618)', () => {
    it('two parallel enrolments both land (no lost update)', async () => {
      const userId = await makeUser([]);
      const ceremony = enrollCeremony(barrier(2)); // both read the list, then both write
      const challenges = holdingChallenges(userId);
      await Promise.all([
        enrollPasskey(db.sql, userId, rp, registration('cred-a'), challenges, mfaActor, ceremony),
        enrollPasskey(db.sql, userId, rp, registration('cred-b'), challenges, mfaActor, ceremony),
      ]);
      const ids = (await credsOf(userId)).map((c) => c.credentialId).sort();
      expect(ids).toEqual(['cred-a', 'cred-b']);
    });

    it('an enrolment racing an unenrol cannot bring the removed passkey back', async () => {
      const userId = await makeUser([cred('old')]);
      const gate = deferred();
      const enrolling = enrollPasskey(
        db.sql,
        userId,
        rp,
        registration('new'),
        holdingChallenges(userId),
        mfaActor,
        enrollCeremony(() => gate.promise),
      );
      await sleep(50); // the enrolment has read ['old'] and is parked in its ceremony
      await unenrollPasskey(db.sql, userId, 'old');
      gate.release();
      await enrolling;
      expect((await credsOf(userId)).map((c) => c.credentialId)).toEqual(['new']);
    });

    it('two parallel password-only first-factor enrolments leave exactly one passkey (gate runs under the lock)', async () => {
      const userId = await makeUser([]);
      // Both callers pass the router's unlocked "has a factor?" check on the empty
      // account, then meet at the barrier before either takes the row lock.
      const ceremony = enrollCeremony(barrier(2));
      const challenges = holdingChallenges(userId);
      const outcomes = await Promise.allSettled([
        enrollPasskey(db.sql, userId, rp, registration('cred-a'), challenges, passwordOnly, ceremony),
        enrollPasskey(db.sql, userId, rp, registration('cred-b'), challenges, passwordOnly, ceremony),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toMatchObject({ code: 'auth.mfa_required' });
      expect(await credsOf(userId)).toHaveLength(1);
    });

    it('two parallel assertions on different passkeys both advance their counters', async () => {
      const userId = await makeUser([cred('k1'), cred('k2')]);
      const ceremony = verifyCeremony(
        () => sleep(120),
        (id) => (id === 'k1' ? 5 : 7),
      );
      const challenges = holdingChallenges(userId);
      await Promise.all([
        verifyPasskey(db.sql, userId, rp, assertion('k1'), challenges, ceremony),
        verifyPasskey(db.sql, userId, rp, assertion('k2'), challenges, ceremony),
      ]);
      const stored = await credsOf(userId);
      expect(stored.find((c) => c.credentialId === 'k1')?.counter).toBe(5);
      expect(stored.find((c) => c.credentialId === 'k2')?.counter).toBe(7);
    });

    it('an assertion racing an unenrol cannot bring the removed passkey back', async () => {
      const userId = await makeUser([cred('k1'), cred('k2')]);
      const gate = deferred();
      const verifying = verifyPasskey(
        db.sql,
        userId,
        rp,
        assertion('k1'),
        holdingChallenges(userId),
        verifyCeremony(
          () => gate.promise,
          () => 9,
        ),
      );
      await sleep(50); // the assertion has read both passkeys and is parked in its ceremony
      const unenrolling = unenrollPasskey(db.sql, userId, 'k2');
      // Unlocked code finishes the unenrol inside this window; locked code makes it wait.
      await Promise.race([unenrolling.catch(() => undefined), sleep(300)]);
      gate.release();
      await Promise.all([verifying, unenrolling]);
      const stored = await credsOf(userId);
      expect(stored.map((c) => c.credentialId)).toEqual(['k1']);
      expect(stored[0]!.counter).toBe(9);
    });

    it('two parallel unenrols of different passkeys both stick', async () => {
      const userId = await makeUser([cred('k1'), cred('k2'), cred('k3')]);
      // Hold every plain (non-transaction) statement open for a moment after it
      // returns, so unlocked code has read the list before either side writes.
      const slow = new Proxy(db.sql, {
        apply: async (target, thisArg, args) => {
          const result = await Reflect.apply(target, thisArg, args as never);
          await sleep(150);
          return result;
        },
      });
      await Promise.all([unenrollPasskey(slow, userId, 'k1'), unenrollPasskey(slow, userId, 'k2')]);
      expect((await credsOf(userId)).map((c) => c.credentialId)).toEqual(['k3']);
    });
  });
}
