import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { memoryWithdrawDestinations, UserWithdrawDestinationStore, type UserWithdrawDestinations } from './withdraw-destination.js';
import { maskRef } from './ramps/customer-ramps.js';

/**
 * W-withdraw-08: the withdrawal address book. The same rules run against the in-memory store and the Postgres store,
 * so a test double can never be more forgiving than the real table.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const upFiles = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = upFiles.map((f) => readFileSync(join(drizzle, f), 'utf8'));

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!parsed.pathname.replace(/^\//, '').endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

if (!process.env.TEST_DATABASE_URL?.trim()) {
  throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';
const ADDR_C = '0x3333333333333333333333333333333333333333';
const IBAN = 'DE89370400440532013000';

let db!: TestDatabase;
let cap: string | undefined = '3';
let users = 0;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: dedicatedTestUrl(process.env.TEST_DATABASE_URL!.trim()), migrations });
}, 120_000);
afterAll(() => db?.drop());

/** A fresh customer id per test, so the Postgres cases never see each other's rows. */
const fresh = () => `00000000-0000-4000-8000-${String(++users).padStart(12, '0')}`;

const stores: Array<[string, () => UserWithdrawDestinations]> = [
  ['memory store', () => memoryWithdrawDestinations({ addressBookCap: () => cap })],
  ['postgres store', () => new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => cap })],
];

describe.each(stores)('address book: %s', (_name, make) => {
  const save = (store: UserWithdrawDestinations, userId: string, over: Partial<Parameters<UserWithdrawDestinations['save']>[0]> = {}) =>
    store.save({ userId, assetId: 'usdt', network: 'ERC20', ref: ADDR_A, label: 'Cold wallet', ...over });

  it('saves an entry with its asset, network and tag, and lists it with its state', async () => {
    const store = make();
    const u = fresh();
    const saved = await save(store, u, { tag: '12345' });
    expect(saved).toMatchObject({ assetId: 'USDT', network: 'erc20', tag: '12345', origin: 'customer', state: 'active', kind: 'crypto' });
    expect(await store.list(u)).toHaveLength(1);
    expect(await store.list(fresh())).toEqual([]);
  });

  it('saves the same (asset, network, address, tag) once, whatever the address case, without moving it', async () => {
    const store = make();
    const u = fresh();
    const first = await save(store, u);
    const again = await save(store, u, { ref: ADDR_A.toUpperCase().replace('0X', '0x'), label: 'Another name' });
    expect(again.destinationId).toBe(first.destinationId);
    expect(again.label).toBe('Cold wallet');
    expect(again.updatedAt).toEqual(first.updatedAt);
    // A different memo, network or asset is a different entry.
    const other = await save(store, u, { tag: '99', label: 'With memo' });
    expect(other.destinationId).not.toBe(first.destinationId);
    expect(await store.list(u)).toHaveLength(2);
  });

  it('refuses a label another saved address already has, whatever its case, and one customer cannot block another', async () => {
    const store = make();
    const u = fresh();
    await save(store, u);
    await expect(save(store, u, { ref: ADDR_B, label: 'cold WALLET' })).rejects.toMatchObject({ code: 'bank.destination_label_taken' });
    expect(await store.list(u)).toHaveLength(1);
    await expect(save(store, fresh(), { ref: ADDR_B, label: 'cold wallet' })).resolves.toBeDefined();
  });

  it('refuses a blank cap, and a full book, before and after the cap is set', async () => {
    const store = make();
    const u = fresh();
    cap = undefined;
    await expect(save(store, u)).rejects.toMatchObject({ code: 'bank.address_book_cap_unset' });
    cap = ' ';
    await expect(save(store, u)).rejects.toMatchObject({ code: 'bank.address_book_cap_unset' });
    cap = '0';
    await expect(save(store, u)).rejects.toMatchObject({ code: 'bank.address_book_cap_unset' });
    cap = '2';
    await save(store, u, { ref: ADDR_A, label: 'One' });
    await save(store, u, { ref: ADDR_B, label: 'Two' });
    await expect(save(store, u, { ref: ADDR_C, label: 'Three' })).rejects.toMatchObject({ code: 'bank.address_book_full' });
    // A repeat of a saved entry is not a new one, so it still answers when the book is full.
    await expect(save(store, u, { ref: ADDR_A, label: 'One' })).resolves.toBeDefined();
    cap = '3';
  });

  it('refuses a malformed address, network, asset, tag or label, and saves nothing', async () => {
    const store = make();
    const u = fresh();
    for (const bad of [
      { ref: 'not-an-address' },
      { ref: IBAN },
      { network: 'x' },
      { network: 'bad net!' },
      { assetId: '' },
      { tag: ' padded ' },
      { label: ' ' },
    ]) {
      await expect(save(store, u, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bank.ramp_invalid_destination' });
    }
    expect(await store.list(u)).toEqual([]);
  });

  it('renames without restarting the cooling clock, refuses a taken label and another customer’s entry', async () => {
    const store = make();
    const u = fresh();
    const one = await save(store, u, { label: 'One' });
    await save(store, u, { ref: ADDR_B, label: 'Two' });
    const renamed = await store.rename({ userId: u, destinationId: one.destinationId, label: 'Renamed' });
    expect(renamed.label).toBe('Renamed');
    expect(renamed.updatedAt).toEqual(one.updatedAt);
    await expect(store.rename({ userId: u, destinationId: one.destinationId, label: 'TWO' })).rejects.toMatchObject({
      code: 'bank.destination_label_taken',
    });
    await expect(store.rename({ userId: fresh(), destinationId: one.destinationId, label: 'Mine now' })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
    expect((await store.list(u)).find((d) => d.destinationId === one.destinationId)?.label).toBe('Renamed');
  });

  it('removes once per idempotency key, only the caller’s own entry, and the slot is free again', async () => {
    const store = make();
    const u = fresh();
    const one = await save(store, u, { label: 'One' });
    await expect(
      store.remove({ userId: fresh(), destinationId: one.destinationId, idempotencyKey: 'rm-other-0001' }),
    ).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
    await store.remove({ userId: u, destinationId: one.destinationId, idempotencyKey: 'rm-key-0001' });
    await expect(store.remove({ userId: u, destinationId: one.destinationId, idempotencyKey: 'rm-key-0001' })).resolves.toMatchObject({
      removed: true,
    });
    await expect(store.remove({ userId: u, destinationId: one.destinationId, idempotencyKey: 'rm-key-0002' })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
    await expect(save(store, u, { label: 'One' })).resolves.toBeDefined();
  });

  it('keeps the legacy slot working: one per kind, and withdrawals still find it', async () => {
    const store = make();
    const u = fresh();
    await store.persist({ userId: u, kind: 'crypto', ref: ADDR_A });
    const second = await store.persist({ userId: u, kind: 'crypto', ref: ADDR_B });
    expect(await store.list(u)).toHaveLength(1);
    expect((await store.require({ userId: u, kind: 'crypto' })).ref).toBe(second.ref);
    await store.persist({ userId: u, kind: 'bank', ref: IBAN });
    expect((await store.require({ userId: u, kind: 'bank' })).ref).toBe(IBAN);
    // A saved book entry never replaces the legacy slot.
    await save(store, u, { ref: ADDR_C, label: 'Book' });
    expect((await store.require({ userId: u, kind: 'crypto' })).ref).toBe(ADDR_B);
  });

  it('uses the only saved address for a withdrawal, and refuses to pick between several', async () => {
    const store = make();
    const u = fresh();
    await expect(store.require({ userId: u, kind: 'crypto' })).rejects.toMatchObject({ code: 'bank.withdraw_destination_missing' });
    const only = await save(store, u, { label: 'Only' });
    expect((await store.require({ userId: u, kind: 'crypto' })).destinationId).toBe(only.destinationId);
    await save(store, u, { ref: ADDR_B, label: 'Second' });
    await expect(store.require({ userId: u, kind: 'crypto' })).rejects.toMatchObject({ code: 'bank.withdraw_destination_ambiguous' });
  });

  it('stops a legacy label from taking a saved address’s name', async () => {
    const store = make();
    const u = fresh();
    await save(store, u, { label: 'Shared name' });
    await expect(store.persist({ userId: u, kind: 'bank', ref: IBAN, label: 'shared NAME' })).rejects.toMatchObject({
      code: 'bank.destination_label_taken',
    });
  });
});

describe('address book: postgres only', () => {
  it('lets two racing saves pass the cap only once', async () => {
    const store = new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => '1' });
    const u = fresh();
    const results = await Promise.allSettled([
      store.save({ userId: u, assetId: 'USDT', network: 'erc20', ref: ADDR_A, label: 'A' }),
      store.save({ userId: u, assetId: 'USDT', network: 'erc20', ref: ADDR_B, label: 'B' }),
      store.save({ userId: u, assetId: 'USDT', network: 'erc20', ref: ADDR_C, label: 'C' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual([
      'bank.address_book_full',
      'bank.address_book_full',
    ]);
    expect(await store.list(u)).toHaveLength(1);
  });

  it('the down migration refuses while a saved entry exists, and restores one slot per kind once it is gone', async () => {
    const store = new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => '5' });
    const u = fresh();
    const saved = await store.save({ userId: u, assetId: 'USDT', network: 'erc20', ref: ADDR_A, label: 'Down test' });
    const down = readFileSync(join(drizzle, '0043_withdraw_address_book.down.sql'), 'utf8');
    const up = readFileSync(join(drizzle, '0043_withdraw_address_book.sql'), 'utf8');
    await expect(db.sql.begin((tx) => tx.unsafe(down))).rejects.toThrow(/saved entries/);
    // The other cases in this file left saved entries of their own; clear them all, as an operator would have to.
    await db.sql`DELETE FROM bank.user_withdraw_destinations WHERE origin <> 'legacy'`;
    void saved;
    await store.persist({ userId: u, kind: 'crypto', ref: ADDR_B });
    await db.sql.begin((tx) => tx.unsafe(down));
    const rows = await db.sql<
      Array<{ kind: string; ref: string }>
    >`SELECT kind, ref FROM bank.user_withdraw_destinations WHERE user_id = ${u}`;
    expect(rows).toEqual([{ kind: 'crypto', ref: ADDR_B }]);
    // Two old rows of one customer with the same label: the up migration keeps both, renaming the later one.
    const twin = fresh();
    await db.sql`INSERT INTO bank.user_withdraw_destinations (user_id, kind, ref, label) VALUES (${twin}, 'crypto', ${ADDR_A}, 'Same'), (${twin}, 'bank', ${IBAN}, 'same')`;
    // Back up again so the rest of the suite sees the book, and the legacy row is still the legacy slot.
    await db.sql.begin((tx) => tx.unsafe(up));
    const labels = await db.sql<
      Array<{ kind: string; label: string }>
    >`SELECT kind, label FROM bank.user_withdraw_destinations WHERE user_id = ${twin} ORDER BY kind`;
    expect(labels).toEqual([
      { kind: 'bank', label: 'same' },
      { kind: 'crypto', label: 'Same (2)' },
    ]);
    const after = new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => '5' });
    expect((await after.require({ userId: u, kind: 'crypto' })).origin).toBe('legacy');
  });
});

describe('masking', () => {
  it('shows the start and end of an address and hides the middle', () => {
    expect(maskRef(ADDR_A)).toBe('0x1111…1111');
    expect(maskRef(IBAN)).toBe('DE8937…3000');
    expect(maskRef('short')).toBe('sh…');
  });
});

void BOB;
