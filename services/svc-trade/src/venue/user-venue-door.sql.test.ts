import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { SqlPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';

/**
 * The door on the store it runs on in a real stack (Postgres jsonb, which does not keep key order): a second prepare
 * of a key returns the stored action, a re-prepare after a not-definite submit returns it too, and a definite outcome
 * is never replaced by a later not-definite one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The user-venue door Postgres test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111d1';
const principal = { sub: USER, userId: USER, sid: 's-sql', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue door sql')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

describe('UserVenueDoor on SqlPreparedActionStore (Postgres) against the TEST simulator', () => {
  let db: TestDatabase | undefined;
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('200000'), 'deposit:test:sql');
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((r) => {
      server?.closeAllConnections();
      server ? server.close(() => r()) : r();
    });
    await db?.drop();
  }, 30_000);

  /** The next submit answers `definite: false` after the venue has answered (the answer was lost on the way back). */
  let loseNextAnswer = false;

  function door() {
    const store = new SqlPreparedActionStore(db!.sql);
    const d = new UserVenueDoor({
      connect: async () => {
        const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
        const submit = venue.submit.bind(venue);
        return Object.assign(venue, {
          submit: async (...args: Parameters<typeof submit>) => {
            const outcome = await submit(...args);
            if (!loseNextAnswer) return outcome;
            loseNextAnswer = false;
            return { definite: false as const, reason: 'timeout' as const };
          },
        });
      },
      appEnv: 'test',
      store,
      stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
      builder: null,
      now: () => new Date(),
    });
    return { d, store };
  }

  it('a second prepare of the same key returns the stored action (jsonb key order does not matter)', async () => {
    const { d } = door();
    const intent = { kind: 'update_leverage' as const, symbol: 'BTC-PERP', leverageBps: 30_000, marginMode: 'isolated' as const };
    const actionKey = `leverage:${USER}:sql:1`;
    const first = await d.prepare(principal, { owner, signer, intent, actionKey });
    expect(first.reused).toBe(false);
    const second = await d.prepare(principal, { owner, signer, intent, actionKey });
    expect(second).toMatchObject({ reused: true, signed: false, lastOutcome: null });
    expect(second.prepared.digest).toBe(first.prepared.digest);
    expect(second.prepared.nonce).toBe(first.prepared.nonce);
  });

  it('re-prepare after a not-definite submit returns the stored, signed action; a later lost answer never replaces the definite one', async () => {
    const { d, store } = door();
    // A withdrawal (the step-up approves here) reads back by its nonce.
    const withdraw = {
      kind: 'withdraw' as const,
      asset: 'USDC',
      amount: a('3.25'),
      destination: owner,
      withdrawalKey: `withdraw:${USER}:sql:1`,
    };
    const p = await d.prepare(principal, { owner, signer, intent: withdraw, stepUpApprovalId: 'appr-sql' });
    sim.switches.loseAnswers = 1;
    const lost = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(lost.outcome).toEqual({ definite: false, reason: 'timeout' });
    expect(lost.readBack).toEqual({ nonce: p.prepared.nonce });

    const again = await d.prepare(principal, { owner, signer, intent: withdraw, stepUpApprovalId: 'appr-sql' });
    expect(again).toMatchObject({ reused: true, signed: true, lastOutcome: { definite: false, reason: 'timeout' } });
    expect(again.prepared.digest).toBe(p.prepared.digest);

    const landed = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(landed.outcome).toMatchObject({ definite: true, accepted: true });

    loseNextAnswer = true;
    const later = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(loseNextAnswer).toBe(false);
    expect(later.outcome).toEqual(landed.outcome);
    expect((await store.find(USER, p.actionKey))?.lastOutcome).toEqual(landed.outcome);
  });

  it('bad signature bytes are refused and never stored: the key still completes with a good signature', async () => {
    const { d, store } = door();
    const intent = { kind: 'update_leverage' as const, symbol: 'BTC-PERP', leverageBps: 20_000, marginMode: 'isolated' as const };
    const p = await d.prepare(principal, { owner, signer, intent, actionKey: `leverage:${USER}:sql:2` });
    await expect(
      d.submit(principal, p.actionKey, { digest: p.prepared.digest, signature: '0xdead', signedBy: owner }),
    ).rejects.toMatchObject({
      refusal: { code: 'signature_mismatch' },
    });
    expect((await store.find(USER, p.actionKey))?.signature).toBeNull();
    const ok = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(ok.outcome).toMatchObject({ definite: true, accepted: true });
  });
});
