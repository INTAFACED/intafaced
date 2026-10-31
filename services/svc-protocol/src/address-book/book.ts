import { randomUUID } from 'node:crypto';
import { ADDRESS_BOOK_LABEL_MAX, WALLET_GROUP_NAME_MAX } from '@intafaced/contracts';
import { getAddress as toChecksum, isAddress, type Address } from 'viem';

/**
 * THE WALLET ADDRESS BOOK AND WALLET GROUPS (D-portfolio-wallet-03).
 *
 * One book per wallet address: contacts (an address and a label) and groups (a name and a set of wallets, each the
 * owning wallet itself or one of its contacts). A book is read and changed only with a wallet session (`session.ts`),
 * and every function here takes the owner from that session. No balance, no money and no key: a label is a note the
 * person keeps for themselves.
 *
 * Validation lives here; the limits that must hold under concurrent writes (the owner's maximum, a duplicate address or
 * group name, a member that must be a contact) are checked by the store inside one transaction per owner.
 */

export const ADDRESS_BOOK_MAX_CONTACTS_UNSET = 'protocol.address_book_max_contacts_unset' as const;
export const WALLET_GROUPS_MAX_UNSET = 'protocol.wallet_groups_max_unset' as const;

export type AddressBookRefusalCode =
  | typeof ADDRESS_BOOK_MAX_CONTACTS_UNSET
  | typeof WALLET_GROUPS_MAX_UNSET
  | 'protocol.address_book_full'
  | 'protocol.wallet_groups_full'
  | 'protocol.contact_address_invalid'
  | 'protocol.contact_label_invalid'
  | 'protocol.contact_duplicate'
  | 'protocol.contact_self'
  | 'protocol.contact_not_found'
  | 'protocol.group_name_invalid'
  | 'protocol.group_name_duplicate'
  | 'protocol.group_members_empty'
  | 'protocol.group_member_unknown'
  | 'protocol.group_not_found';

export class AddressBookRefusedError extends Error {
  constructor(
    readonly code: AddressBookRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'AddressBookRefusedError';
  }
}

export interface ContactRecord {
  readonly id: string;
  readonly owner: Address;
  readonly address: Address;
  readonly label: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GroupMemberRecord {
  readonly address: Address;
  readonly self: boolean;
  readonly contactId: string | null;
  readonly label: string | null;
}

export interface GroupRecord {
  readonly id: string;
  readonly owner: Address;
  readonly name: string;
  readonly members: readonly GroupMemberRecord[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AddContactOutcome = { kind: 'added'; contact: ContactRecord } | { kind: 'full' } | { kind: 'duplicate' };
export type CreateGroupOutcome =
  { kind: 'created'; group: GroupRecord } | { kind: 'full' } | { kind: 'duplicate' } | { kind: 'unknown_member'; address: Address };

/** Every method is scoped to `owner`: a row of another owner is never read, changed or reported as existing. */
export interface AddressBookStore {
  contacts(owner: Address): Promise<ContactRecord[]>;
  groups(owner: Address): Promise<GroupRecord[]>;
  group(owner: Address, id: string): Promise<GroupRecord | null>;
  /** Atomic per owner: refuses `full` at `max` contacts and `duplicate` for an address already in the book. */
  addContact(owner: Address, contact: { address: Address; label: string }, max: number): Promise<AddContactOutcome>;
  /** Also takes the address out of the owner's groups. False when the owner has no contact with this id. */
  removeContact(owner: Address, id: string): Promise<boolean>;
  /** Atomic per owner: refuses `full`, a duplicate name (any case) and a member that is neither the owner nor a contact. */
  createGroup(owner: Address, group: { name: string; members: readonly Address[] }, max: number): Promise<CreateGroupOutcome>;
  removeGroup(owner: Address, id: string): Promise<boolean>;
}

/** Control and invisible formatting characters (bidi overrides, zero-width joiners) make a label lie about itself. */
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

function cleanText(raw: string, max: number): string | null {
  const text = raw.normalize('NFC').trim();
  if (text.length === 0 || [...text].length > max || HIDDEN.test(text)) return null;
  return text;
}

export function contactLabel(raw: string): string {
  const label = cleanText(raw, ADDRESS_BOOK_LABEL_MAX);
  if (label === null)
    throw new AddressBookRefusedError(
      'protocol.contact_label_invalid',
      `A label is 1 to ${ADDRESS_BOOK_LABEL_MAX} characters with no hidden characters.`,
    );
  return label;
}

export function groupName(raw: string): string {
  const name = cleanText(raw, WALLET_GROUP_NAME_MAX);
  if (name === null)
    throw new AddressBookRefusedError(
      'protocol.group_name_invalid',
      `A group name is 1 to ${WALLET_GROUP_NAME_MAX} characters with no hidden characters.`,
    );
  return name;
}

/** A 20-byte hex address. A mixed-case address must carry a valid checksum: one wrong letter is a different wallet. */
export function walletAddress(raw: string): Address {
  const text = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text) || !isAddress(text, { strict: true }))
    throw new AddressBookRefusedError('protocol.contact_address_invalid', 'This is not a wallet address (0x and 40 hex characters).');
  return toChecksum(text);
}

function requireMax(value: number | undefined, code: typeof ADDRESS_BOOK_MAX_CONTACTS_UNSET | typeof WALLET_GROUPS_MAX_UNSET): number {
  if (value === undefined || !Number.isInteger(value) || value < 1)
    throw new AddressBookRefusedError(
      code,
      code === ADDRESS_BOOK_MAX_CONTACTS_UNSET
        ? 'The owner has not published how many contacts one wallet may keep.'
        : 'The owner has not published how many groups one wallet may keep.',
    );
  return value;
}

export async function addContact(
  store: AddressBookStore,
  owner: Address,
  input: { label: string; address: string },
  maxContacts: number | undefined,
): Promise<ContactRecord> {
  const max = requireMax(maxContacts, ADDRESS_BOOK_MAX_CONTACTS_UNSET);
  const label = contactLabel(input.label);
  const address = walletAddress(input.address);
  if (address === toChecksum(owner))
    throw new AddressBookRefusedError('protocol.contact_self', 'This is your own wallet. It is already in every group as This wallet.');
  const outcome = await store.addContact(owner, { address, label }, max);
  if (outcome.kind === 'full')
    throw new AddressBookRefusedError('protocol.address_book_full', `Your address book holds its maximum of ${max} contacts.`);
  if (outcome.kind === 'duplicate')
    throw new AddressBookRefusedError('protocol.contact_duplicate', 'This address is already in your address book.');
  return outcome.contact;
}

export async function removeContact(store: AddressBookStore, owner: Address, id: string): Promise<void> {
  if (!(await store.removeContact(owner, id)))
    throw new AddressBookRefusedError('protocol.contact_not_found', 'There is no such contact in your address book.');
}

export async function createGroup(
  store: AddressBookStore,
  owner: Address,
  input: { name: string; members: readonly string[] },
  maxGroups: number | undefined,
): Promise<GroupRecord> {
  const max = requireMax(maxGroups, WALLET_GROUPS_MAX_UNSET);
  const name = groupName(input.name);
  const members = [...new Set(input.members.map(walletAddress))];
  if (members.length === 0) throw new AddressBookRefusedError('protocol.group_members_empty', 'Choose at least one wallet for the group.');
  const outcome = await store.createGroup(owner, { name, members }, max);
  if (outcome.kind === 'full') throw new AddressBookRefusedError('protocol.wallet_groups_full', `You have the maximum of ${max} groups.`);
  if (outcome.kind === 'duplicate')
    throw new AddressBookRefusedError('protocol.group_name_duplicate', 'You already have a group with this name.');
  if (outcome.kind === 'unknown_member')
    throw new AddressBookRefusedError(
      'protocol.group_member_unknown',
      `${outcome.address} is not this wallet or one of its contacts. Add it to the address book first.`,
    );
  return outcome.group;
}

export async function readGroup(store: AddressBookStore, owner: Address, id: string): Promise<GroupRecord> {
  const group = await store.group(owner, id);
  if (!group) throw new AddressBookRefusedError('protocol.group_not_found', 'There is no such group in your address book.');
  return group;
}

export async function removeGroup(store: AddressBookStore, owner: Address, id: string): Promise<void> {
  if (!(await store.removeGroup(owner, id)))
    throw new AddressBookRefusedError('protocol.group_not_found', 'There is no such group in your address book.');
}

/** Resolves stored member addresses against the owner's contacts, in a stable order: the owner first, then by label. */
export function resolveMembers(owner: Address, addresses: readonly Address[], contacts: readonly ContactRecord[]): GroupMemberRecord[] {
  const byAddress = new Map(contacts.map((c) => [c.address, c]));
  return addresses
    .map((address): GroupMemberRecord => {
      if (address === owner) return { address, self: true, contactId: null, label: null };
      const contact = byAddress.get(address);
      return { address, self: false, contactId: contact?.id ?? null, label: contact?.label ?? null };
    })
    .sort((a, b) => Number(b.self) - Number(a.self) || (a.label ?? '').localeCompare(b.label ?? '') || a.address.localeCompare(b.address));
}

/** In-memory store for tests, with the same per-owner rules as the Postgres one. */
export class MemoryAddressBookStore implements AddressBookStore {
  private readonly contactRows: ContactRecord[] = [];
  private readonly groupRows: Array<{ id: string; owner: Address; name: string; members: Address[]; createdAt: Date; updatedAt: Date }> =
    [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async contacts(owner: Address) {
    return this.contactRows
      .filter((c) => c.owner === owner)
      .sort((a, b) => a.label.localeCompare(b.label) || a.address.localeCompare(b.address));
  }
  async groups(owner: Address) {
    const contacts = await this.contacts(owner);
    return this.groupRows
      .filter((g) => g.owner === owner)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ ...g, members: resolveMembers(owner, g.members, contacts) }));
  }
  async group(owner: Address, id: string) {
    return (await this.groups(owner)).find((g) => g.id === id) ?? null;
  }
  async addContact(owner: Address, contact: { address: Address; label: string }, max: number): Promise<AddContactOutcome> {
    const mine = this.contactRows.filter((c) => c.owner === owner);
    if (mine.some((c) => c.address === contact.address)) return { kind: 'duplicate' };
    if (mine.length >= max) return { kind: 'full' };
    const at = this.now();
    const row: ContactRecord = { id: randomUUID(), owner, ...contact, createdAt: at, updatedAt: at };
    this.contactRows.push(row);
    return { kind: 'added', contact: row };
  }
  async removeContact(owner: Address, id: string) {
    const index = this.contactRows.findIndex((c) => c.owner === owner && c.id === id);
    if (index < 0) return false;
    const [removed] = this.contactRows.splice(index, 1);
    for (const g of this.groupRows.filter((row) => row.owner === owner)) {
      if (g.members.includes(removed!.address)) {
        g.members = g.members.filter((m) => m !== removed!.address);
        g.updatedAt = this.now();
      }
    }
    return true;
  }
  async createGroup(owner: Address, group: { name: string; members: readonly Address[] }, max: number): Promise<CreateGroupOutcome> {
    const mine = this.groupRows.filter((g) => g.owner === owner);
    if (mine.some((g) => g.name.toLowerCase() === group.name.toLowerCase())) return { kind: 'duplicate' };
    if (mine.length >= max) return { kind: 'full' };
    const known = new Set([owner, ...this.contactRows.filter((c) => c.owner === owner).map((c) => c.address)]);
    const unknown = group.members.find((m) => !known.has(m));
    if (unknown) return { kind: 'unknown_member', address: unknown };
    const at = this.now();
    const row = { id: randomUUID(), owner, name: group.name, members: [...group.members], createdAt: at, updatedAt: at };
    this.groupRows.push(row);
    return { kind: 'created', group: { ...row, members: resolveMembers(owner, row.members, await this.contacts(owner)) } };
  }
  async removeGroup(owner: Address, id: string) {
    const index = this.groupRows.findIndex((g) => g.owner === owner && g.id === id);
    if (index < 0) return false;
    this.groupRows.splice(index, 1);
    return true;
  }
}
