import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { formatAmount } from '@intafaced/ledger-client';
import { SHARED_POT_ROLES, type SharedPotInvite, type SharedPotMember, type SharedPotPerson } from './shared-pots.js';

/**
 * `bank.sharedPots.*` (BK-acct-09, J-bank-07 #6): a named pot its owner shares with other people, each a viewer or a
 * contributor, by an invite that lasts the owner-set time. Reading is `bank:read`; inviting and answering are
 * `bank:write`. Membership moves no value: a contributor adds money with `transfers.create` into the pot, and a viewer
 * doing so refuses `bank.space_forbidden`. Blank owner values refuse `bank.joint_unset`.
 */

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const role = z.enum(SHARED_POT_ROLES);
const person = z.object({ userId: z.string(), handle: z.string().nullable() });
const member = person.extend({ role, joinedAt: z.string() });
const invite = z.object({
  inviteId: z.string(),
  spaceId: z.string(),
  role,
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
});
const pot = z.object({ id: z.string(), name: z.string(), assetId: z.string() });

const personOut = (p: SharedPotPerson) => ({ userId: p.userId, handle: p.handle });
const memberOut = (m: SharedPotMember) => ({ ...personOut(m), role: m.role, joinedAt: m.joinedAt.toISOString() });
const inviteOut = (i: SharedPotInvite) => ({
  inviteId: i.inviteId,
  spaceId: i.spaceId,
  role: i.role,
  createdAt: i.createdAt.toISOString(),
  expiresAt: i.expiresAt.toISOString(),
  expired: i.expired,
});

export function createSharedPotsRouter(bank: BankServices, guard: Guard) {
  return router({
    /**
     * The bank's two values (null when not set), the caller's own pots they share with their people and open invites,
     * the pots shared with them with the balance from the ledger, and invites to them not yet answered.
     */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
      .output(
        z.object({
          terms: z.object({ inviteMinutes: z.number().int().nullable(), peopleCap: z.number().int().nullable() }),
          owned: z.array(z.object({ pot, members: z.array(member), invites: z.array(invite.extend({ invitee: person })) })),
          shared: z.array(
            z.object({
              pot: pot.extend({ balance: z.string() }),
              owner: person,
              role,
              members: z.array(member),
            }),
          ),
          invites: z.array(invite.extend({ pot: pot.omit({ id: true }), owner: person })),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const view = await bank.sharedPots.overview(ctx.principal.userId, input.limit);
          const shared = [];
          for (const row of view.shared) {
            shared.push({
              pot: {
                id: row.space.id,
                name: row.space.name,
                assetId: row.space.assetId,
                // The ledger's answer for the owner's pot account, read now; never stored.
                balance: formatAmount(await bank.spaces.balanceOf(row.space)),
              },
              owner: personOut(row.owner),
              role: row.role,
              members: row.members.map(memberOut),
            });
          }
          return {
            terms: view.terms,
            owned: view.owned.map((row) => ({
              pot: { id: row.space.id, name: row.space.name, assetId: row.space.assetId },
              members: row.members.map(memberOut),
              invites: row.invites.map((i) => ({ ...inviteOut(i), invitee: personOut(i.invitee) })),
            })),
            shared,
            invites: view.invites.map((i) => ({ ...inviteOut(i), pot: i.pot, owner: personOut(i.owner) })),
          };
        }),
      ),

    /** Invite one active person, by handle or email, to see or add to one of the caller's live pots. Moves no value. */
    invite: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          inviteId: z.string().guid(),
          spaceId: z.string().guid(),
          handle: z.string().max(64).optional(),
          email: z.string().max(320).optional(),
          role,
        }),
      )
      .output(invite.extend({ invitee: person }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const made = await bank.sharedPots.invite({ ...input, ownerUserId: ctx.principal.userId });
          return { ...inviteOut(made), invitee: personOut(made.invitee) };
        }),
      ),

    /** Accept an invite to the caller; past its lifetime refuses `bank.invite_expired`. Moves no value. */
    accept: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ inviteId: z.string().guid() }))
      .output(z.object({ spaceId: z.string(), role }))
      .mutation(async ({ ctx, input }) => guard(() => bank.sharedPots.accept(input.inviteId, ctx.principal.userId))),

    /** Decline an invite to the caller. Moves no value. */
    decline: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ inviteId: z.string().guid() }))
      .output(z.object({ declined: z.literal(true) }))
      .mutation(async ({ ctx, input }) => guard(() => bank.sharedPots.decline(input.inviteId, ctx.principal.userId))),

    /** Stop sharing a pot the caller is a member of. The pot and its money stay the owner's. */
    leave: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid() }))
      .output(z.object({ left: z.literal(true) }))
      .mutation(async ({ ctx, input }) => guard(() => bank.sharedPots.leave(input.spaceId, ctx.principal.userId))),

    /** The owner stops sharing one of their pots with one member. Moves no value. */
    remove: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().guid(), userId: z.string().min(1).max(64) }))
      .output(z.object({ removed: z.literal(true) }))
      .mutation(async ({ ctx, input }) => guard(() => bank.sharedPots.remove(input.spaceId, ctx.principal.userId, input.userId))),

    /** The pot's log, newest first, each entry naming who acted by handle: for the owner and the pot's members. */
    activity: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          spaceId: z.string().guid(),
          limit: z.number().int().min(1).max(200).optional(),
          before: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            kind: z.enum(['invited', 'joined', 'declined', 'left', 'removed']),
            actor: person,
            subject: person.nullable(),
            role: role.nullable(),
            at: z.string(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () =>
          (await bank.sharedPots.activity(input.spaceId, ctx.principal.userId, input.limit, input.before)).map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            actor: personOut(entry.actor),
            subject: entry.subject ? personOut(entry.subject) : null,
            role: entry.role,
            at: entry.at.toISOString(),
          })),
        ),
      ),
  });
}
