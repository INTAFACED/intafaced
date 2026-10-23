import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { memoryWithdrawDestinations, UserWithdrawDestinationStore, type UserWithdrawDestinations } from '../withdraw-destination.js';
import { memoryWalletProofs, sqlWalletProofs, startWalletProof, verifyWalletProof, type WalletProofStore } from './wallet-ownership.js';

/**
 * W-withdraw-17 on both proof stores: the in-memory one tests use and `bank.wallet_ownership_proofs` (migration 0055),
 * so a test double can never be more forgiving than the real table.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!parsed.pathname.replace(/^\//, '').endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

if (!process.env.TEST_DATABASE_URL?.trim()) {
  throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
}

// Well-known public development key (the first account of common local EVM chains). Holds nothing; TEST only.
const ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
// That key's `personal_sign` of each message below is made in the test with the same EIP-191 steps a wallet takes.
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let db!: TestDatabase;
let users = 0;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: dedicatedTestUrl(process.env.TEST_DATABASE_URL!.trim()), migrations });
}, 120_000);
afterAll(() => db?.drop());

const fresh = () => `00000000-0000-4000-8000-${String(++users).padStart(12, '0')}`;

function sign(message: string): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const rec = secp256k1.sign(keccak_256(joined), Buffer.from(KEY, 'hex'), { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out.set(rec.subarray(1), 0);
  out[64] = rec[0]! + 27;
  return `0x${Buffer.from(out).toString('hex')}`;
}

const stores: Array<[string, () => { destinations: UserWithdrawDestinations; proofs: WalletProofStore }]> = [
  ['memory store', () => ({ destinations: memoryWithdrawDestinations({ addressBookCap: () => '5' }), proofs: memoryWalletProofs() })],
  [
    'postgres store',
    () => ({ destinations: new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => '5' }), proofs: sqlWalletProofs(db.sql) }),
  ],
];

describe.each(stores)('wallet ownership proofs: %s', (_name, make) => {
  const rig = () => {
    const { destinations, proofs } = make();
    return { destinations, proofs, deps: { destinations, proofs, windowRaw: () => '30', validityRaw: () => '180' } };
  };

  it('stores the offer pending, verifies it once, and reads the latest proof per entry', async () => {
    const r = rig();
    const user = fresh();
    const entry = await r.destinations.save({
      userId: user,
      assetId: 'USDT',
      network: 'erc20',
      ref: ADDRESS.toUpperCase().replace('0X', '0x'),
      label: 'TEST',
    });
    const first = await startWalletProof(r.deps, { userId: user, destinationId: entry.destinationId });
    const second = await startWalletProof(r.deps, { userId: user, destinationId: entry.destinationId });
    expect(second.message).toContain(`Address: ${ADDRESS}`);
    expect((await r.proofs.latest(user)).get(entry.destinationId)?.id).toBe(second.proofId);

    const done = await verifyWalletProof(r.deps, { userId: user, proofId: second.proofId, signature: sign(second.message) });
    expect(done.state).toBe('verified');
    const stored = (await r.proofs.latest(user)).get(entry.destinationId)!;
    expect(stored).toMatchObject({ id: second.proofId, status: 'verified', address: ADDRESS });
    expect(stored.validUntil!.getTime() - stored.verifiedAt!.getTime()).toBe(180 * 86_400_000);
    // A second mark of the same proof finds nothing pending.
    expect(
      await r.proofs.markVerified(user, second.proofId, { signature: '0x', verifiedAt: new Date(), validUntil: new Date() }),
    ).toBeNull();
    // The superseded offer is still there, untouched.
    expect((await r.proofs.get(user, first.proofId))?.status).toBe('pending');
  });

  it("never answers another customer's proof, or an id that is not one", async () => {
    const r = rig();
    const user = fresh();
    const entry = await r.destinations.save({ userId: user, assetId: 'USDT', network: 'erc20', ref: ADDRESS, label: 'TEST' });
    const started = await startWalletProof(r.deps, { userId: user, destinationId: entry.destinationId });
    const other = fresh();
    expect(await r.proofs.get(other, started.proofId)).toBeNull();
    expect(await r.proofs.get(user, 'not-a-uuid')).toBeNull();
    expect((await r.proofs.latest(other)).size).toBe(0);
    expect(
      await r.proofs.markVerified(other, started.proofId, { signature: '0x', verifiedAt: new Date(), validUntil: new Date() }),
    ).toBeNull();
  });
});

describe('bank.wallet_ownership_proofs constraints', () => {
  it('refuses a verified row without its signature, and an offer that ends before it starts', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    await expect(
      db.sql`INSERT INTO bank.wallet_ownership_proofs (id, user_id, destination_id, address, message, status, expires_at, verified_at, valid_until)
             VALUES (${id}::uuid, 'u', ${id}::uuid, 'a', 'm', 'verified', now() + interval '1 minute', now(), now())`,
    ).rejects.toThrow(/wallet_ownership_proofs_verified_ck/);
    await expect(
      db.sql`INSERT INTO bank.wallet_ownership_proofs (id, user_id, destination_id, address, message, expires_at)
             VALUES (${id}::uuid, 'u', ${id}::uuid, 'a', 'm', now() - interval '1 minute')`,
    ).rejects.toThrow(/wallet_ownership_proofs_window_ck/);
  });
});
