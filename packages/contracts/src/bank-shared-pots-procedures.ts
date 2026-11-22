import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { card, invite, member, person, pot, role, SHARED_POT_ACTIVITY_KINDS } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `sharedPots.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * The bank's two values (null when not set), the caller's own pots they share with their people and open invites,
 * the pots shared with them with the balance from the ledger, and invites to them not yet answered.
 */
export const BANK_SHARED_POTS_LIST = defineProcedure({
  ...base,
  name: 'bank.sharedPots.list',
  kind: 'query',
  path: 'sharedPots.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({
    terms: z.object({ inviteMinutes: z.number().int().nullable(), peopleCap: z.number().int().nullable() }),
    owned: z.array(
      z.object({ pot, card: card.nullable(), members: z.array(member), invites: z.array(invite.extend({ invitee: person })) }),
    ),
    shared: z.array(
      z.object({
        pot: pot.extend({ balance: z.string() }),
        card: card.nullable(),
        owner: person,
        role,
        members: z.array(member),
      }),
    ),
    invites: z.array(invite.extend({ pot: pot.omit({ id: true }), owner: person })),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The pot's log, newest first, each entry naming who acted by handle: for the owner and the pot's members. */
export const BANK_SHARED_POTS_ACTIVITY = defineProcedure({
  ...base,
  name: 'bank.sharedPots.activity',
  kind: 'query',
  path: 'sharedPots.activity',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    spaceId: z.string().guid(),
    limit: z.number().int().min(1).max(200).optional(),
    // At most 18 digits: always inside a bigint, so the cursor never fails in the database.
    before: z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/)
      .optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(SHARED_POT_ACTIVITY_KINDS),
      actor: person,
      subject: person.nullable(),
      role: role.nullable(),
      card: z.object({ cardId: z.string(), panTail: z.string() }).nullable(),
      at: z.string(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Invite one active person, by handle or email, to see or add to one of the caller's live pots. Moves no value. */
export const BANK_SHARED_POTS_INVITE = defineProcedure({
  ...base,
  name: 'bank.sharedPots.invite',
  kind: 'mutation',
  path: 'sharedPots.invite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    inviteId: z.string().guid(),
    spaceId: z.string().guid(),
    handle: z.string().max(64).optional(),
    email: z.string().max(320).optional(),
    role,
  }),
  output: invite.extend({ invitee: person }),
  samples: [
    {
      verdict: 'accept',
      input: { inviteId: '11111111-1111-4111-8111-111111111111', spaceId: '11111111-1111-4111-8111-111111111111', role: 'contributor' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A holder of the pot (its owner or a contributor) freezes its linked card, for example when it is lost. Freezing
 * protects and never prompts; a viewer refuses `bank.space_forbidden`. The pot's log names who froze it, written
 * with the card's row. Only the owner unfreezes, through `cards.setStatus` and its step-up.
 */
export const BANK_SHARED_POTS_FREEZE_CARD = defineProcedure({
  ...base,
  name: 'bank.sharedPots.freezeCard',
  kind: 'mutation',
  path: 'sharedPots.freezeCard',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: card,
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Accept an invite to the caller; past its lifetime refuses `bank.invite_expired`. Moves no value. */
export const BANK_SHARED_POTS_ACCEPT = defineProcedure({
  ...base,
  name: 'bank.sharedPots.accept',
  kind: 'mutation',
  path: 'sharedPots.accept',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ inviteId: z.string().guid() }),
  output: z.object({ spaceId: z.string(), role }),
  samples: [
    { verdict: 'accept', input: { inviteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Decline an invite to the caller. Moves no value. */
export const BANK_SHARED_POTS_DECLINE = defineProcedure({
  ...base,
  name: 'bank.sharedPots.decline',
  kind: 'mutation',
  path: 'sharedPots.decline',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ inviteId: z.string().guid() }),
  output: z.object({ declined: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { inviteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Stop sharing a pot the caller is a member of. The pot and its money stay the owner's. */
export const BANK_SHARED_POTS_LEAVE = defineProcedure({
  ...base,
  name: 'bank.sharedPots.leave',
  kind: 'mutation',
  path: 'sharedPots.leave',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: z.object({ left: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner stops sharing one of their pots with one member. Moves no value. */
export const BANK_SHARED_POTS_REMOVE = defineProcedure({
  ...base,
  name: 'bank.sharedPots.remove',
  kind: 'mutation',
  path: 'sharedPots.remove',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid(), userId: z.string().min(1).max(64) }),
  output: z.object({ removed: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111', userId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner withdraws an invite not yet answered, so it no longer holds a place. Moves no value. */
export const BANK_SHARED_POTS_CANCEL_INVITE = defineProcedure({
  ...base,
  name: 'bank.sharedPots.cancelInvite',
  kind: 'mutation',
  path: 'sharedPots.cancelInvite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ inviteId: z.string().guid() }),
  output: z.object({ cancelled: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { inviteId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner unlinks the pot's card. The card itself is untouched. */
export const BANK_SHARED_POTS_UNLINK_CARD = defineProcedure({
  ...base,
  name: 'bank.sharedPots.unlinkCard',
  kind: 'mutation',
  path: 'sharedPots.unlinkCard',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid() }),
  output: z.object({ unlinked: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner links one of their own cards to one of their pots, so the pot's holders can freeze it. Moves no money. */
export const BANK_SHARED_POTS_LINK_CARD = defineProcedure({
  ...base,
  name: 'bank.sharedPots.linkCard',
  kind: 'mutation',
  path: 'sharedPots.linkCard',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid(), cardId: z.string().guid() }),
  output: card,
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111', cardId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
