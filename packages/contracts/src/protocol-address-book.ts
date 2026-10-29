import { z } from 'zod';

/**
 * Wire types for the wallet address book and wallet groups (D-portfolio-wallet-03), version 1: svc-protocol's
 * `walletSession.*` and `addressBook.*`. Public on the Protocol plane (the visitor may be signed out), so what proves the
 * caller owns a book is a signature from the wallet itself: `walletSession.challenge` writes an EIP-4361 message,
 * `walletSession.open` checks the wallet signed it and returns a short-lived session token, and every `addressBook.*`
 * call carries that token. The service reads the owning address from the token it issued, never from an address the
 * caller names. Every `addressBook.*` call is a POST (a tRPC mutation), reads included, so the token travels in a body and
 * never in a URL that an access log keeps.
 */
export const PROTOCOL_ADDRESS_BOOK_CONTRACT_VERSION = 1 as const;

export const PROTOCOL_WALLET_SESSION_REFUSALS = [
  /** The session secret, its lifetime or the origins wallet messages are written for are blank (owner settings). */
  'protocol.wallet_session_unset',
  /** The page asked for a message for an origin the owner has not listed. */
  'protocol.wallet_session_origin_unlisted',
  /** The challenge was not written by this service, is for another chain, or has expired. */
  'protocol.wallet_challenge_invalid',
  /** The signature does not recover to the address the challenge was written for. */
  'protocol.wallet_signature_not_owner',
  /** The session token is missing, altered, for another chain or expired: open a new session. */
  'protocol.wallet_session_invalid',
] as const;
export type ProtocolWalletSessionRefusal = (typeof PROTOCOL_WALLET_SESSION_REFUSALS)[number];

export const PROTOCOL_ADDRESS_BOOK_REFUSALS = [
  /** The owner has not published how many contacts one wallet may keep. */
  'protocol.address_book_max_contacts_unset',
  /** The owner has not published how many groups one wallet may keep. */
  'protocol.wallet_groups_max_unset',
  'protocol.address_book_full',
  'protocol.wallet_groups_full',
  'protocol.contact_address_invalid',
  'protocol.contact_label_invalid',
  'protocol.contact_duplicate',
  'protocol.contact_self',
  'protocol.contact_not_found',
  'protocol.group_name_invalid',
  'protocol.group_name_duplicate',
  'protocol.group_members_empty',
  'protocol.group_member_unknown',
  'protocol.group_not_found',
] as const;
export type ProtocolAddressBookRefusal = (typeof PROTOCOL_ADDRESS_BOOK_REFUSALS)[number];

/** Engineering bounds on the wire, not owner values: a label or a group name a person can read in one line. */
export const ADDRESS_BOOK_LABEL_MAX = 64;
export const WALLET_GROUP_NAME_MAX = 64;
/** The most addresses one create call may name; the owner's contact maximum still bounds it first. */
export const WALLET_GROUP_MEMBERS_MAX = 256;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/**
 * Text of 1 to `max` characters counted as code points, the way the service and the database CHECK (`char_length`)
 * count them. zod's `.max` counts UTF-16 units, so an emoji label the service stored would fail its own read.
 */
const codePoints = (max: number) =>
  z
    .string()
    .min(1)
    .refine((text) => [...text].length <= max, { message: `at most ${max} characters` });
const id = z.string().uuid();
const isoTime = z.string().datetime();
const session = z.string().min(1).max(2048);
// A 65-byte signature, or its 64-byte compact form (EIP-2098).
const signature = z.string().regex(/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/);

// ── walletSession ────────────────────────────────────────────────────────────────────────────────────────────────

export const protocolWalletSessionChallengeInputSchema = z.object({
  address,
  /** The page's own origin (`location.origin`). The message is written for it only when the owner lists it. */
  origin: z.string().url().max(256),
});
export const protocolWalletSessionChallengeOutputSchema = z.object({
  /** The exact EIP-4361 message the wallet signs. It grants no permission and moves no funds. */
  message: z.string().min(1),
  /** Opaque, sealed by the service: hand it back with the signature. */
  challenge: z.string().min(1).max(2048),
  expiresAt: isoTime,
});
export type ProtocolWalletSessionChallenge = z.infer<typeof protocolWalletSessionChallengeOutputSchema>;

export const protocolWalletSessionOpenInputSchema = z.object({ challenge: z.string().min(1).max(2048), signature });
export const protocolWalletSessionOpenOutputSchema = z.object({
  /** Bearer for `addressBook.*`: keep it in memory only. */
  session,
  /** The checksummed address the session proves. */
  address,
  expiresAt: isoTime,
});
export type ProtocolWalletSession = z.infer<typeof protocolWalletSessionOpenOutputSchema>;

// ── addressBook ──────────────────────────────────────────────────────────────────────────────────────────────────

export const protocolContactSchema = z.object({
  id,
  /** Checksummed. */
  address,
  label: codePoints(ADDRESS_BOOK_LABEL_MAX),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type ProtocolContact = z.infer<typeof protocolContactSchema>;

export const protocolWalletGroupMemberSchema = z.object({
  /** Checksummed. */
  address,
  /** True for the wallet that owns the book ("This wallet"). */
  self: z.boolean(),
  /** The contact this member is, with its label; null for the owning wallet. */
  contactId: id.nullable(),
  label: z.string().nullable(),
});
export const protocolWalletGroupSchema = z.object({
  id,
  name: codePoints(WALLET_GROUP_NAME_MAX),
  members: z.array(protocolWalletGroupMemberSchema),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type ProtocolWalletGroup = z.infer<typeof protocolWalletGroupSchema>;

const sessionOnly = z.object({ session });

export const protocolAddressBookListInputSchema = sessionOnly;
export const protocolAddressBookListOutputSchema = z.object({
  /** The address the session proves: whose book this is. */
  owner: address,
  contacts: z.array(protocolContactSchema),
  groups: z.array(protocolWalletGroupSchema),
});
export type ProtocolAddressBook = z.infer<typeof protocolAddressBookListOutputSchema>;

export const protocolAddressBookAddContactInputSchema = z.object({
  session,
  // Loose on the wire so the service answers a wrong shape with its own typed code.
  label: z.string().max(1024),
  address: z.string().max(256),
});
export const protocolAddressBookRemoveContactInputSchema = z.object({ session, id });
export const protocolAddressBookRemovedOutputSchema = z.object({ id, removed: z.literal(true) });

export const protocolAddressBookCreateGroupInputSchema = z.object({
  session,
  name: z.string().max(1024),
  /** Checksummed or lower-case: the owning wallet's own address and addresses of its contacts only. */
  members: z.array(z.string().max(256)).max(WALLET_GROUP_MEMBERS_MAX),
});
export const protocolAddressBookGroupInputSchema = z.object({ session, id });
export const protocolAddressBookRemoveGroupInputSchema = protocolAddressBookGroupInputSchema;
