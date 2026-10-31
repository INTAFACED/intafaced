import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresAddressBookStore } from './book.pg.js';

/**
 * `protocol.wallet_contacts`, `wallet_groups` and `wallet_group_members` (20261029050900) on a real test database. Deletes
 * only this file's owners' rows.
 */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '20261029050900_wallet_contacts.sql');
const available = URL ? await postgresAvailable(URL) : false;
// The service's own client: drizzle shares it and reads timestamps back as text, which the store must handle.
const db = URL && available ? createDb({ url: URL, schema: 'protocol', max: 4 }, {}) : null;
const sql: Sql | null = db?.sql ?? null;
const A = privateKeyToAccount(`0x${'e5'.repeat(32)}`).address;
const B = privateKeyToAccount(`0x${'f6'.repeat(32)}`).address;
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7' as const;
const SECOND = '0x8ba1f109551bD432803012645Ac136ddd64DBA72' as const;

if (!sql) {
  describe.skip('address book store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('address book store (Postgres)', () => {
    const cleanup = async () => {
      await sql!`DELETE FROM protocol.wallet_groups WHERE owner_address IN (${A}, ${B})`;
      await sql!`DELETE FROM protocol.wallet_contacts WHERE owner_address IN (${A}, ${B})`;
    };
    beforeAll(async () => {
      await assertTestDatabase(sql!, 'svc-protocol book.pg.test');
      await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
      await sql!.unsafe(readFileSync(migration, 'utf8'));
      await cleanup();
    });
    afterAll(async () => {
      await cleanup();
      await db!.close();
    });

    it('keeps contacts per owner, refuses a duplicate address and holds the maximum under concurrent adds', async () => {
      const store = new PostgresAddressBookStore(sql!);
      const added = await store.addContact(A, { address: FRIEND, label: 'TEST friend' }, 2);
      expect(added.kind).toBe('added');
      if (added.kind !== 'added') return;
      expect(added.contact.createdAt).toBeInstanceOf(Date);
      expect(Number.isNaN(added.contact.createdAt.getTime())).toBe(false);
      expect(await store.addContact(A, { address: FRIEND, label: 'again' }, 2)).toEqual({ kind: 'duplicate' });
      // B's book is its own: the same address is not a duplicate there.
      expect((await store.addContact(B, { address: FRIEND, label: 'B friend' }, 2)).kind).toBe('added');
      expect((await store.contacts(A)).map((c) => c.label)).toEqual(['TEST friend']);

      // Five concurrent adds against a maximum of 2 with one already stored: exactly one gets in.
      const racers = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          store.addContact(A, { address: `0x${String(i + 1).padStart(40, '0')}` as `0x${string}`, label: `racer ${i}` }, 2),
        ),
      );
      expect(racers.filter((r) => r.kind === 'added')).toHaveLength(1);
      expect(racers.filter((r) => r.kind === 'full')).toHaveLength(4);
      expect(await store.contacts(A)).toHaveLength(2);
    });

    it('creates a group of the owner and its contacts only, reads it by owner, and drops a removed contact from it', async () => {
      const store = new PostgresAddressBookStore(sql!);
      await cleanup();
      const friend = await store.addContact(A, { address: FRIEND, label: 'TEST friend' }, 10);
      if (friend.kind !== 'added') throw new Error('not added');
      expect(await store.createGroup(A, { name: 'G', members: [A, SECOND] }, 5)).toEqual({ kind: 'unknown_member', address: SECOND });
      const created = await store.createGroup(A, { name: 'TEST group', members: [A, FRIEND] }, 5);
      if (created.kind !== 'created') throw new Error('not created');
      expect(created.group.members).toEqual([
        { address: A, self: true, contactId: null, label: null },
        { address: FRIEND, self: false, contactId: friend.contact.id, label: 'TEST friend' },
      ]);
      expect(await store.createGroup(A, { name: 'test GROUP', members: [A] }, 5)).toEqual({ kind: 'duplicate' });
      expect(await store.createGroup(A, { name: 'Second', members: [A] }, 1)).toEqual({ kind: 'full' });
      expect(await store.group(B, created.group.id)).toBeNull();
      expect(await store.group(A, 'not-a-uuid')).toBeNull();
      expect(await store.removeContact(B, friend.contact.id)).toBe(false);
      expect(await store.removeGroup(B, created.group.id)).toBe(false);

      expect(await store.removeContact(A, friend.contact.id)).toBe(true);
      expect((await store.group(A, created.group.id))?.members.map((m) => m.address)).toEqual([A]);
      expect(await store.removeGroup(A, created.group.id)).toBe(true);
      expect(await sql!`SELECT 1 FROM protocol.wallet_group_members WHERE group_id = ${created.group.id}`).toHaveLength(0);
    });
  });
}
