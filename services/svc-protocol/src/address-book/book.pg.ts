import type { Sql, TransactionSql } from 'postgres';
import { getAddress as toChecksum, type Address } from 'viem';
import {
  resolveMembers,
  type AddContactOutcome,
  type AddressBookStore,
  type ContactRecord,
  type CreateGroupOutcome,
  type GroupRecord,
} from './book.js';

/**
 * Postgres `AddressBookStore` over `protocol.wallet_contacts`, `wallet_groups` and `wallet_group_members`
 * (20261029050900). Every statement names the owner. Each write takes a transaction-scoped advisory lock on its owner,
 * so two concurrent adds cannot both pass the maximum, and a group's members are checked against contacts that cannot
 * be removed until the group is written.
 */
type ContactRow = {
  id: string;
  owner_address: string;
  address: string;
  label: string;
  created_at: Date | string;
  updated_at: Date | string;
};
type GroupRow = { id: string; owner_address: string; name: string; created_at: Date | string; updated_at: Date | string };
type MemberRow = { group_id: string; address: string };

// The service's client is shared with drizzle, which reads timestamps back as text.
const at = (value: Date | string) => new Date(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toContact(r: ContactRow): ContactRecord {
  return {
    id: r.id,
    owner: toChecksum(r.owner_address),
    address: toChecksum(r.address),
    label: r.label,
    createdAt: at(r.created_at),
    updatedAt: at(r.updated_at),
  };
}

async function lockOwner(tx: TransactionSql, owner: Address) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`protocol.wallet-book:${owner}`}, 0))`;
}

export class PostgresAddressBookStore implements AddressBookStore {
  constructor(private readonly sql: Sql) {}

  async contacts(owner: Address): Promise<ContactRecord[]> {
    const rows = await this.sql<ContactRow[]>`
      SELECT id, owner_address, address, label, created_at, updated_at FROM protocol.wallet_contacts
      WHERE owner_address = ${toChecksum(owner)} ORDER BY label, address`;
    return rows.map(toContact);
  }

  private async readGroups(owner: Address, id?: string): Promise<GroupRecord[]> {
    const who = toChecksum(owner);
    const groups = id
      ? await this.sql<GroupRow[]>`
          SELECT id, owner_address, name, created_at, updated_at FROM protocol.wallet_groups
          WHERE owner_address = ${who} AND id = ${id}`
      : await this.sql<GroupRow[]>`
          SELECT id, owner_address, name, created_at, updated_at FROM protocol.wallet_groups
          WHERE owner_address = ${who} ORDER BY name, id`;
    if (groups.length === 0) return [];
    const ids = groups.map((g) => g.id);
    const members = await this.sql<MemberRow[]>`
      SELECT m.group_id, m.address FROM protocol.wallet_group_members m
      JOIN protocol.wallet_groups g ON g.id = m.group_id
      WHERE g.owner_address = ${who} AND m.group_id = ANY(${ids}::uuid[])`;
    const contacts = await this.contacts(who);
    return groups.map((g) => ({
      id: g.id,
      owner: toChecksum(g.owner_address),
      name: g.name,
      members: resolveMembers(
        who,
        members.filter((m) => m.group_id === g.id).map((m) => toChecksum(m.address)),
        contacts,
      ),
      createdAt: at(g.created_at),
      updatedAt: at(g.updated_at),
    }));
  }

  groups(owner: Address): Promise<GroupRecord[]> {
    return this.readGroups(owner);
  }

  async group(owner: Address, id: string): Promise<GroupRecord | null> {
    if (!UUID.test(id)) return null;
    return (await this.readGroups(owner, id))[0] ?? null;
  }

  async addContact(owner: Address, contact: { address: Address; label: string }, max: number): Promise<AddContactOutcome> {
    const who = toChecksum(owner);
    return this.sql.begin(async (tx) => {
      await lockOwner(tx, who);
      const [found] = await tx<Array<{ total: number; same: number }>>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE address = ${contact.address})::int AS same
        FROM protocol.wallet_contacts WHERE owner_address = ${who}`;
      if ((found?.same ?? 0) > 0) return { kind: 'duplicate' } as const;
      if ((found?.total ?? 0) >= max) return { kind: 'full' } as const;
      const [row] = await tx<ContactRow[]>`
        INSERT INTO protocol.wallet_contacts (owner_address, address, label)
        VALUES (${who}, ${contact.address}, ${contact.label})
        RETURNING id, owner_address, address, label, created_at, updated_at`;
      if (!row) throw new Error('protocol.wallet_contacts insert returned no row');
      return { kind: 'added', contact: toContact(row) } as const;
    });
  }

  async removeContact(owner: Address, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const who = toChecksum(owner);
    return this.sql.begin(async (tx) => {
      await lockOwner(tx, who);
      const [removed] = await tx<Array<{ address: string }>>`
        DELETE FROM protocol.wallet_contacts WHERE owner_address = ${who} AND id = ${id} RETURNING address`;
      if (!removed) return false;
      const touched = await tx<Array<{ group_id: string }>>`
        DELETE FROM protocol.wallet_group_members m USING protocol.wallet_groups g
        WHERE g.id = m.group_id AND g.owner_address = ${who} AND m.address = ${removed.address}
        RETURNING m.group_id`;
      if (touched.length > 0) {
        const ids = touched.map((t) => t.group_id);
        await tx`UPDATE protocol.wallet_groups SET updated_at = now() WHERE owner_address = ${who} AND id = ANY(${ids}::uuid[])`;
      }
      return true;
    });
  }

  async createGroup(owner: Address, group: { name: string; members: readonly Address[] }, max: number): Promise<CreateGroupOutcome> {
    const who = toChecksum(owner);
    const created = await this.sql.begin(async (tx) => {
      await lockOwner(tx, who);
      const [found] = await tx<Array<{ total: number; same: number }>>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE lower(name) = lower(${group.name}))::int AS same
        FROM protocol.wallet_groups WHERE owner_address = ${who}`;
      if ((found?.same ?? 0) > 0) return { kind: 'duplicate' } as const;
      if ((found?.total ?? 0) >= max) return { kind: 'full' } as const;
      const contactAddresses = new Set(
        (await tx<Array<{ address: string }>>`SELECT address FROM protocol.wallet_contacts WHERE owner_address = ${who}`).map((r) =>
          toChecksum(r.address),
        ),
      );
      const unknown = group.members.find((m) => m !== who && !contactAddresses.has(m));
      if (unknown) return { kind: 'unknown_member', address: unknown } as const;
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO protocol.wallet_groups (owner_address, name) VALUES (${who}, ${group.name}) RETURNING id`;
      if (!row) throw new Error('protocol.wallet_groups insert returned no row');
      // One statement for every member, so the owner's lock is held for one round trip.
      await tx`
        INSERT INTO protocol.wallet_group_members (group_id, address)
        SELECT ${row.id}::uuid, member FROM unnest(${[...group.members]}::text[]) AS member`;
      return { kind: 'created', id: row.id } as const;
    });
    if (created.kind !== 'created') return created;
    const stored = await this.group(who, created.id);
    if (!stored) throw new Error('protocol.wallet_groups row vanished after insert');
    return { kind: 'created', group: stored };
  }

  async removeGroup(owner: Address, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.sql`DELETE FROM protocol.wallet_groups WHERE owner_address = ${toChecksum(owner)} AND id = ${id} RETURNING id`;
    return rows.length > 0;
  }
}
