import type { Sql } from 'postgres';
import { BankError } from '../errors.js';
import {
  BusinessDirectoryError,
  BusinessLookupLimiter,
  normaliseEmailQuery,
  normaliseHandleQuery,
  type BusinessDirectoryPort,
} from '../business/business-directory.js';
import { assertSharedPotsListLimit } from '../owner-list-limit.js';
import type { SpaceRecord, SpaceService } from './space-service.js';

/**
 * SHARED POTS (BK-acct-09, J-bank-07 #6).
 *
 * The owner of a named pot invites another person, by handle or email, to see it (`viewer`) or to add money to it
 * (`contributor`). The invite lasts the owner-set `BANK_SHARED_POT_INVITE_MINUTES` from when it was made, on the
 * database clock; accepting it later refuses `bank.invite_expired`. A pot is shared with at most the owner-set
 * `BANK_SHARED_POT_PEOPLE_CAP` people, invites still open included (`bank.shared_pot_full`). Either value blank refuses
 * `bank.joint_unset`: nothing is shared until the owner decides (the slice's decision note).
 *
 * Membership decides who may read the pot and who may call a move; it is never a balance. The pot's money stays the
 * owner's ledger account, a contributor adds to it with the same transfer as anyone paying into a space, and only the
 * owner takes money out. A viewer moving money into the pot, or any member taking money out, refuses
 * `bank.space_forbidden` (`assertMayAddTo` and `assertMayTakeOut`, called by the transfer doors). Who did what is a row in the pot's activity log, named by handle.
 */

export const BANK_SHARED_POT_INVITE_MINUTES_ENV = 'BANK_SHARED_POT_INVITE_MINUTES';
export const BANK_SHARED_POT_PEOPLE_CAP_ENV = 'BANK_SHARED_POT_PEOPLE_CAP';

export const SHARED_POT_ROLES = ['contributor', 'viewer'] as const;
export type SharedPotRole = (typeof SHARED_POT_ROLES)[number];

export interface SharedPotTerms {
  /** Minutes an invite stays open. Null: the owner has not set it. */
  inviteMinutes: number | null;
  /** People one pot may be shared with, open invites included. Null: the owner has not set it. */
  peopleCap: number | null;
}

/** A whole number of minutes from 1 to 43200 (30 days), or null. */
function parseInviteMinutes(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9][0-9]{0,4}$/.test(trimmed)) return null;
  const minutes = Number.parseInt(trimmed, 10);
  return minutes <= 43_200 ? minutes : null;
}

/** A whole number of people from 1 to 50, or null. */
function parsePeopleCap(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9][0-9]?$/.test(trimmed)) return null;
  const cap = Number.parseInt(trimmed, 10);
  return cap <= 50 ? cap : null;
}

export interface SharedPotOptions {
  /** `BANK_SHARED_POT_INVITE_MINUTES`, read on each call. */
  readonly inviteMinutes: () => string | undefined;
  /** `BANK_SHARED_POT_PEOPLE_CAP`, read on each call. */
  readonly peopleCap: () => string | undefined;
}

export interface SharedPotPerson {
  userId: string;
  /** The person's public handle; null when the directory no longer knows them. */
  handle: string | null;
}

export interface SharedPotMember extends SharedPotPerson {
  role: SharedPotRole;
  joinedAt: Date;
}

export interface SharedPotInvite {
  inviteId: string;
  spaceId: string;
  role: SharedPotRole;
  createdAt: Date;
  expiresAt: Date;
  /** Past its lifetime and never answered. Accepting it refuses `bank.invite_expired`. */
  expired: boolean;
}

export interface SharedPotActivityEntry {
  id: string;
  kind: 'invited' | 'cancelled' | 'joined' | 'declined' | 'left' | 'removed';
  actor: SharedPotPerson;
  subject: SharedPotPerson | null;
  role: SharedPotRole | null;
  at: Date;
}

export interface SharedPotsOverview {
  terms: SharedPotTerms;
  /** The caller's own live pots shared with anyone or with an invite out, each with its people and open invites. */
  owned: Array<{
    space: SpaceRecord;
    members: SharedPotMember[];
    invites: Array<SharedPotInvite & { invitee: SharedPotPerson }>;
  }>;
  /** Live pots of other people that the caller is a member of. */
  shared: Array<{ space: SpaceRecord; owner: SharedPotPerson; role: SharedPotRole; members: SharedPotMember[] }>;
  /** Invites to the caller never answered, open or expired, for pots still live. */
  invites: Array<SharedPotInvite & { pot: { name: string; assetId: string }; owner: SharedPotPerson }>;
}

interface InviteRow {
  id: string;
  space_id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  role: SharedPotRole;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  declined_at: Date | null;
  cancelled_at: Date | null;
  expired: boolean;
}

interface MemberRow {
  space_id: string;
  user_id: string;
  role: SharedPotRole;
  joined_at: Date;
}

interface ActivityRow {
  id: string;
  kind: SharedPotActivityEntry['kind'];
  actor_user_id: string;
  subject_user_id: string | null;
  role: SharedPotRole | null;
  at: Date;
}

const toInvite = (row: InviteRow): SharedPotInvite => ({
  inviteId: row.id,
  spaceId: row.space_id,
  role: row.role,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  expired: row.expired,
});

export class SharedPotService {
  constructor(
    private readonly sql: Sql,
    private readonly spaces: SpaceService,
    private readonly directory: BusinessDirectoryPort,
    private readonly options: SharedPotOptions,
    private readonly lookups: BusinessLookupLimiter = new BusinessLookupLimiter(),
  ) {}

  /** The owner's two values as they read now; a blank or malformed one is null, never a default. */
  terms(): SharedPotTerms {
    return { inviteMinutes: parseInviteMinutes(this.options.inviteMinutes()), peopleCap: parsePeopleCap(this.options.peopleCap()) };
  }

  private requireTerms(): { inviteMinutes: number; peopleCap: number } {
    const { inviteMinutes, peopleCap } = this.terms();
    if (inviteMinutes === null || peopleCap === null) {
      throw new BankError(
        'The bank has not decided how long an invite lasts or how many people can share a pot, so pots are not shared',
        'bank.joint_unset',
      );
    }
    return { inviteMinutes, peopleCap };
  }

  /**
   * Invite one active person, by handle or email, to one of the owner's live named pots. Asking again with the same
   * invite id returns that invite. An unknown, frozen or closed person is one answer (`bank.invitee_not_found`).
   */
  async invite(input: {
    inviteId: string;
    ownerUserId: string;
    spaceId: string;
    handle?: string;
    email?: string;
    role: SharedPotRole;
  }): Promise<SharedPotInvite & { invitee: SharedPotPerson }> {
    const { inviteMinutes, peopleCap } = this.requireTerms();
    const replay = await this.inviteById(input.inviteId);
    if (replay) return this.replayInvite(replay, input);

    // The caller's own live pot first: the directory is asked nothing for a pot that is not theirs to share.
    await this.spaces.underRowLock((tx) => this.spaces.ownPotForUpdate(tx, input.spaceId, input.ownerUserId));
    const invitee = await this.findInvitee(input.ownerUserId, input.handle, input.email);
    if (invitee.userId === input.ownerUserId) {
      throw new BankError('You own this pot; invite someone else', 'bank.shared_pot_invalid');
    }
    const created = await this.spaces.underRowLock(async (tx) => {
      // The pot's row lock orders invites, accepts, removals and archiving of this pot.
      await this.spaces.ownPotForUpdate(tx, input.spaceId, input.ownerUserId);
      const inserted = await tx<InviteRow[]>`
        INSERT INTO bank.shared_pot_invites (id, space_id, inviter_user_id, invitee_user_id, role, expires_at)
        SELECT ${input.inviteId}::uuid, ${input.spaceId}::uuid, ${input.ownerUserId}, ${invitee.userId}, ${input.role},
               now() + make_interval(mins => ${inviteMinutes}::int)
        ON CONFLICT (id) DO NOTHING
        RETURNING id, space_id, inviter_user_id, invitee_user_id, role, created_at, expires_at, accepted_at, declined_at,
                  cancelled_at, false AS expired
      `;
      if (!inserted[0]) return null;
      const [taken] = await tx<Array<{ member: boolean; open_invite: boolean; people: number }>>`
        SELECT EXISTS (SELECT 1 FROM bank.shared_pot_members WHERE space_id = ${input.spaceId}::uuid AND user_id = ${invitee.userId}) AS member,
               EXISTS (SELECT 1 FROM bank.shared_pot_invites
                        WHERE space_id = ${input.spaceId}::uuid AND invitee_user_id = ${invitee.userId}
                          AND id <> ${input.inviteId}::uuid AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL
                          AND expires_at > now()) AS open_invite,
               ((SELECT count(*) FROM bank.shared_pot_members WHERE space_id = ${input.spaceId}::uuid)
                + (SELECT count(*) FROM bank.shared_pot_invites
                    WHERE space_id = ${input.spaceId}::uuid AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL
                      AND expires_at > now()))::int AS people
      `;
      // A refusal below rolls the insert back with it.
      if (taken!.member) throw new BankError('This person already shares this pot', 'bank.shared_pot_invalid');
      if (taken!.open_invite) {
        throw new BankError('This person already has an open invite to this pot', 'bank.shared_pot_invalid');
      }
      if (taken!.people > peopleCap) {
        throw new BankError(
          `This pot is shared with as many people as the bank allows (${peopleCap}), open invites included`,
          'bank.shared_pot_full',
        );
      }
      await tx`
        INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, subject_user_id, kind, role)
        VALUES (${input.spaceId}::uuid, ${input.ownerUserId}, ${invitee.userId}, 'invited', ${input.role})
      `;
      return inserted[0];
    });
    // Another call with this id won the insert: answer as a replay of it.
    if (!created) return this.replayInvite((await this.inviteById(input.inviteId))!, input);
    return { ...toInvite(created), invitee: { userId: invitee.userId, handle: invitee.handle } };
  }

  private async replayInvite(
    row: InviteRow,
    input: { ownerUserId: string; spaceId: string; role: SharedPotRole },
  ): Promise<SharedPotInvite & { invitee: SharedPotPerson }> {
    if (row.inviter_user_id !== input.ownerUserId || row.space_id !== input.spaceId || row.role !== input.role) {
      throw new BankError('This invite id was used for a different invite', 'bank.shared_pot_invalid');
    }
    const [invitee] = await this.people([row.invitee_user_id]);
    return { ...toInvite(row), invitee: invitee! };
  }

  private async findInvitee(callerId: string, handleRaw = '', emailRaw = ''): Promise<{ userId: string; handle: string }> {
    if ((handleRaw.trim() === '') === (emailRaw.trim() === '')) {
      throw new BankError('Name the person by handle or by email, not both', 'bank.shared_pot_invalid');
    }
    if (!this.lookups.tryTake(callerId)) {
      throw new BankError('Too many lookups. Try again in a minute', 'bank.business_directory_rate_limited');
    }
    const notFound = () => new BankError('No active account has this handle or email', 'bank.invitee_not_found');
    const handle = handleRaw.trim() === '' ? null : normaliseHandleQuery(handleRaw);
    const email = emailRaw.trim() === '' ? null : normaliseEmailQuery(emailRaw);
    if (handle === null && email === null) throw notFound();
    let hit: { userId: string; handle: string } | null;
    try {
      hit = await this.directory.findActive(handle !== null ? { handle } : { email: email! });
    } catch (err) {
      directoryError(err);
    }
    if (!hit) throw notFound();
    return hit;
  }

  /**
   * The invitee accepts: they join the pot with the invite's role. Accepting again returns the same membership. Past
   * its lifetime refuses `bank.invite_expired`; a pot already shared with the cap refuses `bank.shared_pot_full`.
   */
  async accept(inviteId: string, userId: string): Promise<{ spaceId: string; role: SharedPotRole }> {
    const { peopleCap } = this.requireTerms();
    return this.spaces.underRowLock(async (tx) => {
      const invite = await this.ownInviteForUpdate(tx, inviteId, userId);
      if (invite.accepted_at) {
        // Accepting again answers with the membership this invite made, while it lasts. Once the person has left or been
        // removed, the used invite opens nothing: the owner sends a new one.
        if ((await this.roleOf(invite.space_id, userId, tx)) !== null) return { spaceId: invite.space_id, role: invite.role };
        throw new BankError(
          'This invite was used, and you no longer share this pot. Ask the owner for a new invite',
          'bank.invite_not_found',
        );
      }
      if (invite.declined_at) throw new BankError('You declined this invite', 'bank.invite_not_found');
      if (invite.cancelled_at) throw new BankError('The owner cancelled this invite', 'bank.invite_not_found');
      // Same lock order as `invite`: the pot's row, then its rows here.
      await tx`SELECT id FROM bank.spaces WHERE id = ${invite.space_id}::uuid FOR UPDATE`;
      const pot = await this.spaces.get(invite.space_id, tx);
      if (pot.archivedAt) throw new BankError(`Space "${pot.name}" is archived`, 'bank.space_archived');
      if (invite.expired) {
        throw new BankError(
          `This invite ended at ${invite.expires_at.toISOString()}. Ask the pot's owner for a new one`,
          'bank.invite_expired',
        );
      }
      const [held] = await tx<Array<{ people: number }>>`
        SELECT count(*)::int AS people FROM bank.shared_pot_members WHERE space_id = ${invite.space_id}::uuid
      `;
      if (held!.people >= peopleCap) {
        throw new BankError(`This pot is shared with as many people as the bank allows (${peopleCap})`, 'bank.shared_pot_full');
      }
      await tx`UPDATE bank.shared_pot_invites SET accepted_at = now() WHERE id = ${inviteId}::uuid`;
      await tx`
        INSERT INTO bank.shared_pot_members (space_id, user_id, role, invite_id)
        VALUES (${invite.space_id}::uuid, ${userId}, ${invite.role}, ${inviteId}::uuid)
      `;
      await tx`
        INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, kind, role)
        VALUES (${invite.space_id}::uuid, ${userId}, 'joined', ${invite.role})
      `;
      return { spaceId: invite.space_id, role: invite.role };
    });
  }

  /** The invitee says no. Declining again changes nothing; an accepted invite is left by leaving the pot. */
  async decline(inviteId: string, userId: string): Promise<{ declined: true }> {
    return this.spaces.underRowLock(async (tx) => {
      const invite = await this.ownInviteForUpdate(tx, inviteId, userId);
      if (invite.declined_at) return { declined: true as const };
      if (invite.accepted_at) throw new BankError('You accepted this invite; leave the pot instead', 'bank.shared_pot_invalid');
      if (invite.cancelled_at) throw new BankError('The owner cancelled this invite', 'bank.invite_not_found');
      await tx`UPDATE bank.shared_pot_invites SET declined_at = now() WHERE id = ${inviteId}::uuid`;
      await tx`
        INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, kind, role)
        VALUES (${invite.space_id}::uuid, ${userId}, 'declined', ${invite.role})
      `;
      return { declined: true as const };
    });
  }

  private async ownInviteForUpdate(tx: Sql, inviteId: string, userId: string): Promise<InviteRow> {
    const [row] = await tx<InviteRow[]>`
      SELECT id, space_id, inviter_user_id, invitee_user_id, role, created_at, expires_at, accepted_at, declined_at,
             cancelled_at, expires_at <= now() AS expired
        FROM bank.shared_pot_invites
       WHERE id = ${inviteId}::uuid AND invitee_user_id = ${userId}
       FOR UPDATE
    `;
    if (!row) throw new BankError('No invite of yours has this id', 'bank.invite_not_found');
    return row;
  }

  /**
   * The owner withdraws an invite not yet answered, open or expired, so it no longer holds a place. Cancelling again
   * changes nothing; an answered invite refuses `bank.shared_pot_invalid`.
   */
  async cancelInvite(inviteId: string, ownerUserId: string): Promise<{ cancelled: true }> {
    return this.spaces.underRowLock(async (tx) => {
      const [row] = await tx<InviteRow[]>`
        SELECT id, space_id, inviter_user_id, invitee_user_id, role, created_at, expires_at, accepted_at, declined_at,
               cancelled_at, expires_at <= now() AS expired
          FROM bank.shared_pot_invites WHERE id = ${inviteId}::uuid
      `;
      if (!row) throw new BankError('No invite has this id', 'bank.invite_not_found');
      // The pot's row lock, as for every change to who shares it; another owner's pot is not found.
      await this.spaces.ownPotForUpdate(tx, row.space_id, ownerUserId);
      const [invite] = await tx<InviteRow[]>`
        SELECT id, space_id, inviter_user_id, invitee_user_id, role, created_at, expires_at, accepted_at, declined_at,
               cancelled_at, expires_at <= now() AS expired
          FROM bank.shared_pot_invites WHERE id = ${inviteId}::uuid FOR UPDATE
      `;
      if (invite!.cancelled_at) return { cancelled: true as const };
      if (invite!.accepted_at || invite!.declined_at) {
        throw new BankError('This invite was already answered', 'bank.shared_pot_invalid');
      }
      await tx`UPDATE bank.shared_pot_invites SET cancelled_at = now() WHERE id = ${inviteId}::uuid`;
      await tx`
        INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, subject_user_id, kind, role)
        VALUES (${row.space_id}::uuid, ${ownerUserId}, ${row.invitee_user_id}, 'cancelled', ${row.role})
      `;
      return { cancelled: true as const };
    });
  }

  /** A member stops sharing the pot. Not a member changes nothing. */
  async leave(spaceId: string, userId: string): Promise<{ left: true }> {
    return this.spaces.underRowLock(async (tx) => {
      await tx`SELECT id FROM bank.spaces WHERE id = ${spaceId}::uuid FOR UPDATE`;
      const gone = await tx`DELETE FROM bank.shared_pot_members WHERE space_id = ${spaceId}::uuid AND user_id = ${userId} RETURNING role`;
      if (gone.length) {
        await tx`
          INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, kind, role)
          VALUES (${spaceId}::uuid, ${userId}, 'left', ${gone[0]!.role as string})
        `;
      }
      return { left: true as const };
    });
  }

  /** The owner stops sharing the pot with one member. Not a member changes nothing. */
  async remove(spaceId: string, ownerUserId: string, memberUserId: string): Promise<{ removed: true }> {
    return this.spaces.underRowLock(async (tx) => {
      await this.spaces.ownPotForUpdate(tx, spaceId, ownerUserId);
      const gone =
        await tx`DELETE FROM bank.shared_pot_members WHERE space_id = ${spaceId}::uuid AND user_id = ${memberUserId} RETURNING role`;
      if (gone.length) {
        await tx`
          INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, subject_user_id, kind, role)
          VALUES (${spaceId}::uuid, ${ownerUserId}, ${memberUserId}, 'removed', ${gone[0]!.role as string})
        `;
      }
      return { removed: true as const };
    });
  }

  /** The caller's role in someone else's pot, or null when they are not a member. */
  async roleOf(spaceId: string, userId: string, db: Sql = this.sql): Promise<SharedPotRole | null> {
    const [row] = await db<Array<{ role: SharedPotRole }>>`
      SELECT role FROM bank.shared_pot_members WHERE space_id = ${spaceId}::uuid AND user_id = ${userId}
    `;
    return row?.role ?? null;
  }

  /**
   * Before a transfer out of a space that is not the caller's: a member of that shared pot is refused by name
   * (`bank.space_forbidden`), as only its owner takes money out. Anyone else is left to the ownership check.
   */
  async assertMayTakeOut(callerUserId: string, from: Pick<SpaceRecord, 'id' | 'userId'>): Promise<void> {
    if (from.userId !== callerUserId && (await this.roleOf(from.id, callerUserId)) !== null) {
      throw new BankError('Only the owner of a shared pot can take money out of it', 'bank.space_forbidden');
    }
  }

  /** Before money goes into someone else's live space: a viewer of that shared pot adds none (`bank.space_forbidden`). */
  async assertMayAddTo(callerUserId: string, toSpaceId: string): Promise<void> {
    if ((await this.roleOf(toSpaceId, callerUserId)) === 'viewer') {
      throw new BankError('A viewer of a shared pot can see it but cannot move money into it', 'bank.space_forbidden');
    }
  }

  /** What the caller shares, what is shared with them and the invites they have not answered, each list one page long. */
  async overview(userId: string, limit: number | undefined): Promise<SharedPotsOverview> {
    const page = assertSharedPotsListLimit(limit);
    const ownedRows = await this.sql<Array<{ id: string }>>`
      SELECT s.id FROM bank.spaces s
       WHERE s.user_id = ${userId} AND s.kind = 'named' AND s.archived_at IS NULL
         AND (EXISTS (SELECT 1 FROM bank.shared_pot_members m WHERE m.space_id = s.id)
              OR EXISTS (SELECT 1 FROM bank.shared_pot_invites i
                          WHERE i.space_id = s.id AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.cancelled_at IS NULL))
       ORDER BY s.created_at, s.id
       LIMIT ${page}
    `;
    const sharedRows = await this.sql<MemberRow[]>`
      SELECT m.space_id, m.user_id, m.role, m.joined_at
        FROM bank.shared_pot_members m JOIN bank.spaces s ON s.id = m.space_id
       WHERE m.user_id = ${userId} AND s.archived_at IS NULL
       ORDER BY m.joined_at, m.space_id
       LIMIT ${page}
    `;
    const inviteRows = await this.sql<InviteRow[]>`
      SELECT i.id, i.space_id, i.inviter_user_id, i.invitee_user_id, i.role, i.created_at, i.expires_at, i.accepted_at,
             i.declined_at, i.cancelled_at, i.expires_at <= now() AS expired
        FROM bank.shared_pot_invites i JOIN bank.spaces s ON s.id = i.space_id
       WHERE i.invitee_user_id = ${userId} AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.cancelled_at IS NULL AND s.archived_at IS NULL
       ORDER BY i.created_at DESC, i.id
       LIMIT ${page}
    `;
    const potIds = [...ownedRows.map((r) => r.id), ...sharedRows.map((r) => r.space_id)];
    const members = potIds.length
      ? await this.sql<MemberRow[]>`
          SELECT space_id, user_id, role, joined_at FROM bank.shared_pot_members
           WHERE space_id = ANY(${potIds}::uuid[]) ORDER BY joined_at, user_id
        `
      : [];
    const ownedIds = ownedRows.map((r) => r.id);
    const openOut = ownedIds.length
      ? await this.sql<InviteRow[]>`
          SELECT id, space_id, inviter_user_id, invitee_user_id, role, created_at, expires_at, accepted_at, declined_at,
                 cancelled_at, expired
            FROM (SELECT *, expires_at <= now() AS expired,
                         row_number() OVER (PARTITION BY space_id ORDER BY created_at DESC, id) AS n
                    FROM bank.shared_pot_invites
                   WHERE space_id = ANY(${ownedIds}::uuid[]) AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL) open
           -- One page per pot, newest first, so one busy pot never hides another's invites.
           WHERE n <= ${page}
           ORDER BY created_at DESC, id
        `
      : [];
    const ids = [...new Set([...potIds, ...inviteRows.map((r) => r.space_id)])];
    const pots = new Map<string, SpaceRecord>((await Promise.all(ids.map((id) => this.spaces.get(id)))).map((pot) => [pot.id, pot]));
    const names = await this.names([
      ...members.map((m) => m.user_id),
      ...openOut.map((i) => i.invitee_user_id),
      ...inviteRows.map((i) => i.inviter_user_id),
      ...sharedRows.map((r) => pots.get(r.space_id)!.userId),
    ]);
    const person = (id: string): SharedPotPerson => ({ userId: id, handle: names.get(id) ?? null });
    const membersOf = (spaceId: string): SharedPotMember[] =>
      members.filter((m) => m.space_id === spaceId).map((m) => ({ ...person(m.user_id), role: m.role, joinedAt: m.joined_at }));
    return {
      terms: this.terms(),
      owned: ownedIds.map((id) => ({
        space: pots.get(id)!,
        members: membersOf(id),
        invites: openOut.filter((i) => i.space_id === id).map((i) => ({ ...toInvite(i), invitee: person(i.invitee_user_id) })),
      })),
      shared: sharedRows.map((r) => {
        const space = pots.get(r.space_id)!;
        return { space, owner: person(space.userId), role: r.role, members: membersOf(r.space_id) };
      }),
      invites: inviteRows.map((i) => {
        const pot = pots.get(i.space_id)!;
        return { ...toInvite(i), pot: { name: pot.name, assetId: pot.assetId }, owner: person(i.inviter_user_id) };
      }),
    };
  }

  /** The pot's log, newest first, for its owner and its members. Anyone else is told the pot is not found. */
  async activity(spaceId: string, userId: string, limit: number | undefined, before?: string): Promise<SharedPotActivityEntry[]> {
    const page = assertSharedPotsListLimit(limit);
    const pot = await this.spaces.find(spaceId);
    if (!pot || (pot.userId !== userId && (await this.roleOf(spaceId, userId)) === null)) {
      throw new BankError(`Space ${spaceId} not found`, 'bank.space_not_found');
    }
    const rows = await this.sql<ActivityRow[]>`
      SELECT id::text, kind, actor_user_id, subject_user_id, role, at
        FROM bank.shared_pot_activity
       WHERE space_id = ${spaceId}::uuid ${before === undefined ? this.sql`` : this.sql`AND id < ${before}::bigint`}
       ORDER BY id DESC
       LIMIT ${page}
    `;
    const names = await this.names(rows.flatMap((r) => (r.subject_user_id ? [r.actor_user_id, r.subject_user_id] : [r.actor_user_id])));
    const person = (id: string): SharedPotPerson => ({ userId: id, handle: names.get(id) ?? null });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      actor: person(r.actor_user_id),
      subject: r.subject_user_id ? person(r.subject_user_id) : null,
      role: r.role,
      at: r.at,
    }));
  }

  private async inviteById(inviteId: string): Promise<InviteRow | null> {
    const [row] = await this.sql<InviteRow[]>`
      SELECT id, space_id, inviter_user_id, invitee_user_id, role, created_at, expires_at, accepted_at, declined_at,
             cancelled_at, expires_at <= now() AS expired
        FROM bank.shared_pot_invites WHERE id = ${inviteId}::uuid
    `;
    return row ?? null;
  }

  private async people(ids: string[]): Promise<SharedPotPerson[]> {
    const names = await this.names(ids);
    return ids.map((id) => ({ userId: id, handle: names.get(id) ?? null }));
  }

  private async names(ids: string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    try {
      return await this.directory.handlesOf(unique);
    } catch (err) {
      directoryError(err);
    }
  }
}

function directoryError(err: unknown): never {
  if (err instanceof BusinessDirectoryError && err.reason === 'unset') {
    throw new BankError('svc-bank cannot read handles, so shared pots cannot name anyone', 'bank.business_directory_unset');
  }
  throw new BankError('svc-identity did not answer for handles; try again', 'bank.business_directory_unavailable');
}
