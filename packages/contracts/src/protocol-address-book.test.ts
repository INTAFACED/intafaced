import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ADDRESS_BOOK_REFUSALS,
  PROTOCOL_WALLET_SESSION_REFUSALS,
  protocolAddressBookAddContactInputSchema,
  protocolAddressBookCreateGroupInputSchema,
  protocolAddressBookListOutputSchema,
  protocolWalletSessionChallengeInputSchema,
  protocolWalletSessionOpenInputSchema,
  WALLET_GROUP_MEMBERS_MAX,
} from './protocol-address-book.js';

const owner = '0x52908400098527886E0F7030069857D2E4169EE7';
const now = '2026-10-29T12:00:00.000Z';
const uuid = '00000000-0000-4000-8000-000000000001';

describe('address book wire (v1)', () => {
  it('every call that reads or writes a book needs a session token', () => {
    expect(protocolAddressBookAddContactInputSchema.safeParse({ label: 'TEST', address: owner }).success).toBe(false);
    expect(protocolAddressBookAddContactInputSchema.safeParse({ session: '', label: 'TEST', address: owner }).success).toBe(false);
    expect(protocolAddressBookAddContactInputSchema.safeParse({ session: 'v1.a.b', label: 'TEST', address: owner }).success).toBe(true);
  });

  it('a challenge names an address and a URL origin; an open names a 65- or 64-byte signature', () => {
    expect(protocolWalletSessionChallengeInputSchema.safeParse({ address: owner, origin: 'http://127.0.0.1:3210' }).success).toBe(true);
    expect(protocolWalletSessionChallengeInputSchema.safeParse({ address: '0x12', origin: 'http://127.0.0.1:3210' }).success).toBe(false);
    expect(protocolWalletSessionChallengeInputSchema.safeParse({ address: owner, origin: 'not a url' }).success).toBe(false);
    expect(protocolWalletSessionOpenInputSchema.safeParse({ challenge: 'c', signature: `0x${'ab'.repeat(65)}` }).success).toBe(true);
    expect(protocolWalletSessionOpenInputSchema.safeParse({ challenge: 'c', signature: `0x${'ab'.repeat(64)}` }).success).toBe(true);
    expect(protocolWalletSessionOpenInputSchema.safeParse({ challenge: 'c', signature: '0xab' }).success).toBe(false);
  });

  it('bounds how many members one group call may name', () => {
    const members = Array.from({ length: WALLET_GROUP_MEMBERS_MAX + 1 }, () => owner);
    expect(protocolAddressBookCreateGroupInputSchema.safeParse({ session: 's', name: 'TEST', members }).success).toBe(false);
  });

  it('reads a book back with its owner, contacts and groups', () => {
    const contact = { id: uuid, address: owner, label: 'TEST friend', createdAt: now, updatedAt: now };
    const group = {
      id: uuid,
      name: 'TEST group',
      members: [{ address: owner, self: false, contactId: uuid, label: 'TEST friend' }],
      createdAt: now,
      updatedAt: now,
    };
    expect(protocolAddressBookListOutputSchema.parse({ owner, contacts: [contact], groups: [group] }).groups[0]!.name).toBe('TEST group');
  });

  it('counts a label in characters, as the service and the database do, not in UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f600).repeat(40);
    const contact = { id: uuid, address: owner, label: emoji, createdAt: now, updatedAt: now };
    expect(protocolAddressBookListOutputSchema.safeParse({ owner, contacts: [contact], groups: [] }).success).toBe(true);
    const long = { ...contact, label: 'x'.repeat(65) };
    expect(protocolAddressBookListOutputSchema.safeParse({ owner, contacts: [long], groups: [] }).success).toBe(false);
  });

  it('names every refusal in its own area, one way', () => {
    const all = [...PROTOCOL_WALLET_SESSION_REFUSALS, ...PROTOCOL_ADDRESS_BOOK_REFUSALS];
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) expect(code).toMatch(/^protocol\.[a-z_]+$/);
  });
});
