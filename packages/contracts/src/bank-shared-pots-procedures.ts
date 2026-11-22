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
