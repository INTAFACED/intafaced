import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { MemoryAddressBookStore } from './book.js';
import type { WalletSessionSetting } from './session.js';

/**
 * D-portfolio-wallet-03 through the mounted router, signed out, as the wallet room calls it: a wallet opens a session by
 * signing, and the session is the only thing that says whose book a call reads or changes.
 */
const CHAIN_ID = 84532;
const ORIGIN = 'http://127.0.0.1:3210';
const A = privateKeyToAccount(`0x${'c3'.repeat(32)}`);
const B = privateKeyToAccount(`0x${'d4'.repeat(32)}`);
const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
const SECOND = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const SETTING: WalletSessionSetting = { secret: 'an-address-book-test-secret-of-length-40', ttlSeconds: 600, origins: [ORIGIN] };
const edge = createEdgeContext({ secret: 'an-address-book-test-edge-secret-length', serviceName: 'svc-protocol' });

function build(
  options: { setting?: WalletSessionSetting | null; maxContacts?: number; maxGroups?: number; wired?: boolean; now?: () => Date } = {},
) {
  const deps = {
    chain: { config: { chainId: CHAIN_ID } },
    registry: {},
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    ...(options.wired === false
      ? {}
      : {
          addressBook: {
            store: new MemoryAddressBookStore(),
            session: () => (options.setting === undefined ? SETTING : options.setting),
            maxContacts: () => ('maxContacts' in options ? options.maxContacts : 3),
            maxGroups: () => ('maxGroups' in options ? options.maxGroups : 2),
            ...(options.now ? { now: options.now } : {}),
          },
        }),
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(deps).createCaller(edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-address-book' }));
}
type Caller = ReturnType<typeof build>;

async function sessionFor(caller: Caller, account = A): Promise<string> {
  const { message, challenge } = await caller.walletSession.challenge({ address: account.address, origin: ORIGIN });
  const { session, address } = await caller.walletSession.open({ challenge, signature: await account.signMessage({ message }) });
  expect(address).toBe(account.address);
  return session;
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    const message = (err as Error).message;
    return message.split(':')[0]!;
  }
  throw new Error('expected a refusal');
}

describe('address book: ownership', () => {
  it('stores a contact server-side, keyed by the wallet, and a later session of the same wallet reads it back', async () => {
    const caller = build();
    const first = await sessionFor(caller);
    const added = await caller.addressBook.addContact({ session: first, label: '  TEST friend ', address: FRIEND.toLowerCase() });
    expect(added).toMatchObject({ label: 'TEST friend', address: FRIEND });
    const second = await sessionFor(caller);
    expect(second).not.toBe(first);
    const book = await caller.addressBook.list({ session: second });
    expect(book.owner).toBe(A.address);
    expect(book.contacts.map((c) => [c.label, c.address])).toEqual([['TEST friend', FRIEND]]);
  });

  it('a session for wallet A cannot read, change or even find wallet B’s book', async () => {
    const caller = build();
    const a = await sessionFor(caller, A);
    const b = await sessionFor(caller, B);
    const contact = await caller.addressBook.addContact({ session: b, label: 'B friend', address: FRIEND });
    const group = await caller.addressBook.createGroup({ session: b, name: 'B group', members: [B.address, FRIEND] });

    expect((await caller.addressBook.list({ session: a })).contacts).toEqual([]);
    expect((await caller.addressBook.list({ session: a })).groups).toEqual([]);
    expect(await code(caller.addressBook.group({ session: a, id: group.id }))).toBe('protocol.group_not_found');
    expect(await code(caller.addressBook.removeContact({ session: a, id: contact.id }))).toBe('protocol.contact_not_found');
    expect(await code(caller.addressBook.removeGroup({ session: a, id: group.id }))).toBe('protocol.group_not_found');
    // A cannot put B's own address into a group of A's either: it is not A's contact.
    expect(await code(caller.addressBook.createGroup({ session: a, name: 'A group', members: [B.address] }))).toBe(
      'protocol.group_member_unknown',
    );

    const still = await caller.addressBook.list({ session: b });
    expect(still.contacts.map((c) => c.id)).toEqual([contact.id]);
    expect(still.groups.map((g) => g.id)).toEqual([group.id]);
  });

  it('refuses every book call without a valid session: blank, forged, expired or from another wallet session secret', async () => {
    let now = new Date('2026-10-29T05:00:00Z');
    const caller = build({ now: () => now });
    const session = await sessionFor(caller);
    expect(await code(caller.addressBook.list({ session: 'v1.e30.AAAA' }))).toBe('protocol.wallet_session_invalid');
    const other = build({ setting: { ...SETTING, secret: 'a-different-address-book-test-secret-40' } });
    expect(await code(other.addressBook.list({ session }))).toBe('protocol.wallet_session_invalid');
    now = new Date(now.getTime() + 600_000);
    expect(await code(caller.addressBook.addContact({ session, label: 'x', address: FRIEND }))).toBe('protocol.wallet_session_invalid');
  });

  it('a book that is not wired, or whose session settings are blank, refuses wallet_session_unset', async () => {
    for (const caller of [build({ wired: false }), build({ setting: null })]) {
      expect(await code(caller.walletSession.challenge({ address: A.address, origin: ORIGIN }))).toBe('protocol.wallet_session_unset');
      expect(await code(caller.addressBook.list({ session: 'v1.a.b' }))).toBe('protocol.wallet_session_unset');
    }
  });
});

describe('address book: contacts', () => {
  it('refuses a bad address, a bad label, the wallet itself and a duplicate address', async () => {
    const caller = build();
    const session = await sessionFor(caller);
    const add = (label: string, address: string) => code(caller.addressBook.addContact({ session, label, address }));
    expect(await add('TEST', '0x1234')).toBe('protocol.contact_address_invalid');
    expect(await add('TEST', 'friend.test')).toBe('protocol.contact_address_invalid');
    // One wrong letter of case breaks the checksum: a mixed-case address must check out.
    expect(await add('TEST', FRIEND.replace('E7', 'e7'))).toBe('protocol.contact_address_invalid');
    expect(await add('   ', FRIEND)).toBe('protocol.contact_label_invalid');
    expect(await add('x'.repeat(65), FRIEND)).toBe('protocol.contact_label_invalid');
    expect(await add(`TEST${String.fromCodePoint(0x202e)}dneirf`, FRIEND)).toBe('protocol.contact_label_invalid');
    expect(await add('Me', A.address)).toBe('protocol.contact_self');
    await caller.addressBook.addContact({ session, label: 'x'.repeat(64), address: FRIEND });
    expect(await add('Again', FRIEND.toLowerCase())).toBe('protocol.contact_duplicate');
  });

  it('refuses past the owner’s maximum, and refuses when the maximum is blank', async () => {
    const caller = build({ maxContacts: 1 });
    const session = await sessionFor(caller);
    await caller.addressBook.addContact({ session, label: 'one', address: FRIEND });
    expect(await code(caller.addressBook.addContact({ session, label: 'two', address: SECOND }))).toBe('protocol.address_book_full');
    const unset = build({ maxContacts: undefined });
    const s2 = await sessionFor(unset);
    expect(await code(unset.addressBook.addContact({ session: s2, label: 'one', address: FRIEND }))).toBe(
      'protocol.address_book_max_contacts_unset',
    );
  });

  it('removing a contact frees its place and takes it out of the wallet’s groups', async () => {
    const caller = build({ maxContacts: 1 });
    const session = await sessionFor(caller);
    const friend = await caller.addressBook.addContact({ session, label: 'one', address: FRIEND });
    const group = await caller.addressBook.createGroup({ session, name: 'G', members: [A.address, FRIEND] });
    await caller.addressBook.removeContact({ session, id: friend.id });
    expect(await code(caller.addressBook.removeContact({ session, id: friend.id }))).toBe('protocol.contact_not_found');
    expect((await caller.addressBook.group({ session, id: group.id })).members.map((m) => m.address)).toEqual([A.address]);
    await caller.addressBook.addContact({ session, label: 'two', address: SECOND });
  });
});

describe('address book: wallet groups', () => {
  it('groups this wallet and a contact, with labels, and reads the group back by id', async () => {
    const caller = build();
    const session = await sessionFor(caller);
    const friend = await caller.addressBook.addContact({ session, label: 'TEST friend', address: FRIEND });
    const group = await caller.addressBook.createGroup({
      session,
      name: 'TEST group',
      members: [FRIEND.toLowerCase(), A.address, A.address],
    });
    expect(group.members).toEqual([
      { address: A.address, self: true, contactId: null, label: null },
      { address: FRIEND, self: false, contactId: friend.id, label: 'TEST friend' },
    ]);
    expect(await caller.addressBook.group({ session, id: group.id })).toEqual(group);
    expect((await caller.addressBook.list({ session })).groups).toEqual([group]);
    await caller.addressBook.removeGroup({ session, id: group.id });
    expect(await code(caller.addressBook.group({ session, id: group.id }))).toBe('protocol.group_not_found');
  });

  it('refuses a bad name, no members, a stranger, a duplicate name, past the maximum and a blank maximum', async () => {
    const caller = build({ maxGroups: 1 });
    const session = await sessionFor(caller);
    const create = (name: string, members: string[]) => code(caller.addressBook.createGroup({ session, name, members }));
    expect(await create('', [A.address])).toBe('protocol.group_name_invalid');
    expect(await create('G', [])).toBe('protocol.group_members_empty');
    expect(await create('G', ['0x12'])).toBe('protocol.contact_address_invalid');
    expect(await create('G', [SECOND])).toBe('protocol.group_member_unknown');
    await caller.addressBook.createGroup({ session, name: 'Group', members: [A.address] });
    expect(await create('GROUP', [A.address])).toBe('protocol.group_name_duplicate');
    expect(await create('Other', [A.address])).toBe('protocol.wallet_groups_full');
    const unset = build({ maxGroups: undefined });
    const s2 = await sessionFor(unset);
    expect(await code(unset.addressBook.createGroup({ session: s2, name: 'G', members: [A.address] }))).toBe(
      'protocol.wallet_groups_max_unset',
    );
  });
});
