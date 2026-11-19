import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createServiceSigner, createServiceVerifier, type Keyring } from '@intafaced/contracts';
import {
  classifyPostOutcome,
  createHttpLedgerClient,
  ledgerPostWire,
  recipes,
  parseAmount,
  type LedgerError,
} from '@intafaced/ledger-client';
import { LEDGER_POST_RECIPE, createHttpRecipePoster } from '@intafaced/ledger-client/post-recipe';
import { registerS2sHttp } from './s2s-http.js';
import { LedgerService } from './service.js';
import { truncateBook } from './db/journal-guards.testkit.js';

/**
 * `/trpc/postRecipe` on the real engine: Postgres, the real `LedgerService` (custody layer off, as at launch; conflict
 * mode `refuse`, as in staging and production), a real HTTP port, and the shared HTTP recipe client signing with an S2S
 * v3 key. At each step: if it crashes exactly here, whose funds are stranded? None, because every retry is the same key.
 *
 * H8a PG-hard: never skips. CI uses TEST_DATABASE_URL; local without it starts Testcontainers postgres:16-alpine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_post_recipe_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    throw new Error(`H8a: postRecipe is PG-hard (no skip-green). Testcontainers could not start: ${String(err)}`);
  }
}

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WALLET = '0x00000000000000000000000000000000000000aa';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CHECKER = '22222222-2222-4222-8222-222222222222';
const PURCHASE = {
  course: 'perps-101',
  userId: USER,
  n: '1',
  assetId: 'USDC',
  amount: '2.5',
  to: { kind: 'treasury-wallet' as const, walletId: WALLET },
  paymentId: `0x${'ab'.repeat(32)}`,
};
const KEY = `academy:purchase:perps-101:${USER}:1`;

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

describe('postRecipe on the real ledger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let ledger: LedgerService;
  let app: FastifyInstance;
  let baseUrl: string;
  const key = pair();
  const keyring: Keyring = [{ kid: 'svc-academy.a', svc: 'svc-academy', use: 's2s', x: key.x }];
  const signer = createServiceSigner({ service: 'svc-academy', kid: 'svc-academy.a', privateKey: key.privateKey, keyring });
  const sign = (payload: string, request: { method: 'POST'; url: URL; contentType: 'application/json' }) =>
    signer.headers({
      audience: 'svc-ledger',
      method: request.method,
      url: request.url,
      body: payload,
      context: { contentType: request.contentType },
    });
  const poster = (options: { fetch?: typeof fetch } = {}) =>
    createHttpRecipePoster({ baseUrl, sign, timeoutMs: 10_000, retries: 2, deadlineMs: 25_000, retryBaseDelayMs: 1, ...options });
  const rows = async () => (await db!.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ledger_tx WHERE idempotency_key = ${KEY}`)[0]!.n;
  const revenue = async () =>
    (await ledger.balance({ ownerType: 'house', ownerId: 'fees:academy', assetId: 'USDC', kind: 'available' })).amount;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDb({
      service: 'ledgerpostrecipe',
      url: admin.url,
      migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema)),
    });
  }, 120_000);

  beforeEach(async () => {
    await truncateBook(
      db!.sql,
      'ledger_freeze_outbox, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE',
    );
    await db!.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
    await db!.sql`UPDATE posting_freeze SET frozen = false, reason = NULL, actor = NULL WHERE id = true`;
    ledger = new LedgerService(db!.sql, new MemoryEventBus('post-recipe'), { idempotencyConflict: 'refuse' });
    app = Fastify({ logger: false });
    registerS2sHttp(app, ledger, 'ledger-shared-internal-secret-32chars!', {
      bodyBind: 'require',
      s2s: { verifier: createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }), mode: 'keypair' },
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('books the purchase once, with custody off, under the business key; the receipt is the booked entries', async () => {
    const tx = await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    expect(tx.idempotencyKey).toBe(KEY);
    expect(tx.module).toBe('academy');
    expect(tx.entries.map((e) => [e.direction, e.amount])).toEqual([
      ['debit', parseAmount('2.5')],
      ['credit', parseAmount('2.5')],
    ]);
    expect(await rows()).toBe('1');
    const stored = await ledger.getTxByKey(KEY);
    expect(stored?.id).toBe(tx.id);
  });

  it('crash after the ledger committed but before the caller heard: the retry is the same key and books nothing twice', async () => {
    // The first attempt commits and its answer is lost on the way back; the client retries the same bytes.
    let calls = 0;
    const losing: typeof fetch = async (input, init) => {
      calls += 1;
      const res = await fetch(input, init);
      if (calls === 1) throw new TypeError('fetch failed: answer lost after commit');
      return res;
    };
    const tx = await poster({ fetch: losing }).postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    expect(calls).toBe(2);
    expect(await rows()).toBe('1');
    expect((await ledger.getTxByKey(KEY))?.id).toBe(tx.id);
    // And the caller asking again later (a restart) still gets the same transaction.
    expect((await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE })).id).toBe(tx.id);
    expect(await rows()).toBe('1');
    expect(await revenue()).toBe(parseAmount('2.5'));
  });

  it('postRecipe and post land on the same key: one booking whichever door the retry takes', async () => {
    const tx = await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    const viaPost = await createHttpLedgerClient({ baseUrl, sign, retries: 0 }).post(
      recipes.academyPurchase({ ...PURCHASE, n: 1n, amount: parseAmount('2.5') }),
    );
    expect(viaPost.id).toBe(tx.id);
    expect(viaPost.entries.map((e) => [e.accountId, e.direction, e.amount])).toEqual(
      tx.entries.map((e) => [e.accountId, e.direction, e.amount]),
    );
    expect(ledgerPostWire(recipes.academyPurchase({ ...PURCHASE, n: 1n, amount: parseAmount('2.5') })).idempotencyKey).toBe(KEY);
    expect(await rows()).toBe('1');
  });

  it('the same key with a different body is refused (409 idempotency_conflict); the first booking stands', async () => {
    const tx = await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    const err = await poster()
      .postRecipe({ recipe: 'academyPurchase', input: { ...PURCHASE, amount: '3' } })
      .catch((e: unknown) => e);
    expect((err as LedgerError).code).toBe('ledger.idempotency_conflict');
    // Never read as a refusal: the key is taken, the caller must not record that nothing moved.
    expect(classifyPostOutcome(err)).toBe('unknown');
    expect(await rows()).toBe('1');
    expect((await ledger.getTxByKey(KEY))?.id).toBe(tx.id);
    expect(await revenue()).toBe(parseAmount('2.5'));
  });

  it('frozen: refused (412 ledger.frozen, a definite refusal), nothing booked; after the thaw the same call books once', async () => {
    await ledger.freeze('postRecipe freeze test', OPERATOR);
    const err = await poster()
      .postRecipe({ recipe: 'academyPurchase', input: PURCHASE })
      .catch((e: unknown) => e);
    expect((err as LedgerError).code).toBe('ledger.frozen');
    expect(classifyPostOutcome(err)).toBe('refused');
    expect(await rows()).toBe('0');

    await ledger.unfreeze(OPERATOR, CHECKER);
    const tx = await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    expect(tx.idempotencyKey).toBe(KEY);
    expect(await rows()).toBe('1');
  });

  it('frozen after it booked: the retry of a committed post still answers the original transaction', async () => {
    const tx = await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    await ledger.freeze('postRecipe freeze after commit', OPERATOR);
    expect((await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE })).id).toBe(tx.id);
    expect(await rows()).toBe('1');
  });

  it('the refund reverses the purchase on the book, and cannot be booked twice', async () => {
    await poster().postRecipe({ recipe: 'academyPurchase', input: PURCHASE });
    const { to, ...rest } = PURCHASE;
    const refund = { recipe: 'academyPurchaseRefund' as const, input: { ...rest, from: to, paymentId: `0x${'cd'.repeat(32)}` } };
    const tx = await poster().postRecipe(refund);
    expect(tx.idempotencyKey).toBe(`academy:refund:perps-101:${USER}:1`);
    expect((await poster().postRecipe(refund)).id).toBe(tx.id);
    expect(await revenue()).toBe(0n);
  });

  it('a body the door refuses never reaches the book, sent raw over the port', async () => {
    const payload = JSON.stringify({ recipe: 'academyPurchase', input: { ...PURCHASE, amount: 2.5 } });
    const url = new URL(`${baseUrl}${LEDGER_POST_RECIPE.path}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sign(payload, { method: 'POST', url, contentType: 'application/json' }) },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('ledger.recipe_input_invalid');
    expect(await rows()).toBe('0');
  });
});
