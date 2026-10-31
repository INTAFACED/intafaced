import {
  protocolAddressBookAddContactInputSchema,
  protocolAddressBookCreateGroupInputSchema,
  protocolAddressBookGroupInputSchema,
  protocolAddressBookListInputSchema,
  protocolAddressBookListOutputSchema,
  protocolAddressBookRemoveContactInputSchema,
  protocolAddressBookRemovedOutputSchema,
  protocolAddressBookRemoveGroupInputSchema,
  protocolContactSchema,
  protocolWalletGroupSchema,
  protocolWalletSessionChallengeInputSchema,
  protocolWalletSessionChallengeOutputSchema,
  protocolWalletSessionOpenInputSchema,
  protocolWalletSessionOpenOutputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
} from '@intafaced/contracts';
import {
  ADDRESS_BOOK_MAX_CONTACTS_UNSET,
  AddressBookRefusedError,
  WALLET_GROUPS_MAX_UNSET,
  addContact,
  createGroup,
  readGroup,
  removeContact,
  removeGroup,
  type AddressBookStore,
  type ContactRecord,
  type GroupRecord,
} from './book.js';
import {
  WALLET_SESSION_UNSET,
  WALLET_SESSION_ORIGIN_UNLISTED,
  WALLET_SIGNATURE_NOT_OWNER,
  WalletSessionRefusedError,
  issueWalletChallenge,
  openWalletSession,
  walletSessionOwner,
  type WalletSessionSetting,
} from './session.js';

/**
 * `walletSession.*` and `addressBook.*` (D-portfolio-wallet-03). Public like the rest of this plane (no INTAFACED login,
 * the jurisdiction matrix still runs), because the proof of ownership is the wallet's own signature: every
 * `addressBook.*` procedure first turns the session token into the owning address and passes only that address on.
 *
 * Every procedure is a mutation, reads included, so the session token travels in a POST body and never in a GET URL
 * that access logs keep.
 */
export interface AddressBookDeps {
  /** Read per call: the chain the service is configured for. */
  chainId: () => number;
  store: AddressBookStore;
  /** Null while the secret, the lifetime or the origins are blank (`protocol.wallet_session_unset`). */
  session: () => WalletSessionSetting | null;
  /** `PROTOCOL_ADDRESS_BOOK_MAX_CONTACTS`; undefined refuses `protocol.address_book_max_contacts_unset`. */
  maxContacts: () => number | undefined;
  /** `PROTOCOL_WALLET_GROUPS_MAX`; undefined refuses `protocol.wallet_groups_max_unset`. */
  maxGroups: () => number | undefined;
  now?: () => Date;
}

/** The refusal's code leads the message, as the launch refusals do, so the page can read it. */
export function addressBookTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof WalletSessionRefusedError) {
    const code =
      err.code === WALLET_SESSION_UNSET
        ? 'PRECONDITION_FAILED'
        : err.code === WALLET_SESSION_ORIGIN_UNLISTED
          ? 'BAD_REQUEST'
          : err.code === WALLET_SIGNATURE_NOT_OWNER
            ? 'FORBIDDEN'
            : 'UNAUTHORIZED';
    return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
  }
  if (err instanceof AddressBookRefusedError) {
    const code =
      err.code === ADDRESS_BOOK_MAX_CONTACTS_UNSET || err.code === WALLET_GROUPS_MAX_UNSET
        ? 'PRECONDITION_FAILED'
        : err.code === 'protocol.contact_not_found' || err.code === 'protocol.group_not_found'
          ? 'NOT_FOUND'
          : err.code === 'protocol.address_book_full' ||
              err.code === 'protocol.wallet_groups_full' ||
              err.code === 'protocol.contact_duplicate' ||
              err.code === 'protocol.group_name_duplicate'
            ? 'CONFLICT'
            : 'BAD_REQUEST';
    return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

const contactOut = (c: ContactRecord) => ({
  id: c.id,
  address: c.address,
  label: c.label,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});
const groupOut = (g: GroupRecord) => ({
  id: g.id,
  name: g.name,
  members: g.members.map((m) => ({ address: m.address, self: m.self, contactId: m.contactId, label: m.label })),
  createdAt: g.createdAt.toISOString(),
  updatedAt: g.updatedAt.toISOString(),
});

export function createWalletSessionRouter(deps: AddressBookDeps) {
  const now = deps.now ?? (() => new Date());
  return router({
    challenge: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolWalletSessionChallengeInputSchema)
      .output(protocolWalletSessionChallengeOutputSchema)
      .mutation(({ input }) => {
        try {
          const issued = issueWalletChallenge(deps.session(), deps.chainId(), input, now());
          return { message: issued.message, challenge: issued.challenge, expiresAt: issued.expiresAt.toISOString() };
        } catch (err) {
          throw addressBookTrpcError(err);
        }
      }),
    open: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolWalletSessionOpenInputSchema)
      .output(protocolWalletSessionOpenOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const opened = await openWalletSession(deps.session(), deps.chainId(), input, now());
          return { session: opened.session, address: opened.address, expiresAt: opened.expiresAt.toISOString() };
        } catch (err) {
          throw addressBookTrpcError(err);
        }
      }),
  });
}

export function createAddressBookRouter(deps: AddressBookDeps) {
  const now = deps.now ?? (() => new Date());
  /** The only way a procedure below learns whose book it is. */
  const owner = (session: string) => walletSessionOwner(deps.session(), deps.chainId(), session, now());
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw addressBookTrpcError(err);
    }
  };
  return router({
    list: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressBookListInputSchema)
      .output(protocolAddressBookListOutputSchema)
      .mutation(({ input }) =>
        guarded(async () => {
          const who = owner(input.session);
          const [contacts, groups] = await Promise.all([deps.store.contacts(who), deps.store.groups(who)]);
          return { owner: who, contacts: contacts.map(contactOut), groups: groups.map(groupOut) };
        }),
      ),
    addContact: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressBookAddContactInputSchema)
      .output(protocolContactSchema)
      .mutation(({ input }) =>
        guarded(async () => contactOut(await addContact(deps.store, owner(input.session), input, deps.maxContacts()))),
      ),
    removeContact: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressBookRemoveContactInputSchema)
      .output(protocolAddressBookRemovedOutputSchema)
      .mutation(({ input }) =>
        guarded(async () => {
          await removeContact(deps.store, owner(input.session), input.id);
          return { id: input.id, removed: true as const };
        }),
      ),
    createGroup: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressBookCreateGroupInputSchema)
      .output(protocolWalletGroupSchema)
      .mutation(({ input }) => guarded(async () => groupOut(await createGroup(deps.store, owner(input.session), input, deps.maxGroups())))),
    group: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressBookGroupInputSchema)
      .output(protocolWalletGroupSchema)
      .mutation(({ input }) => guarded(async () => groupOut(await readGroup(deps.store, owner(input.session), input.id)))),
    removeGroup: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressBookRemoveGroupInputSchema)
      .output(protocolAddressBookRemovedOutputSchema)
      .mutation(({ input }) =>
        guarded(async () => {
          await removeGroup(deps.store, owner(input.session), input.id);
          return { id: input.id, removed: true as const };
        }),
      ),
  });
}

/** An address book that is not wired refuses `protocol.wallet_session_unset` before it reaches a store. */
export const unwiredAddressBookStore: AddressBookStore = {
  contacts: async () => [],
  groups: async () => [],
  group: async () => null,
  addContact: async () => {
    throw new Error('address book store is not wired');
  },
  removeContact: async () => false,
  createGroup: async () => {
    throw new Error('address book store is not wired');
  },
  removeGroup: async () => false,
};
