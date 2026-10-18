import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AcademyError } from './errors.js';
import { isPaperOpsEnabled, paperOpsDisabledMessage, paperOpsStatus, type PaperOpsStatus } from './paper/ops-gate.js';
import { assertPaperNeverReadableAsRealMoney } from './paper/real-money-ban.js';
import { assertCallerCannotLiePaperFlag, type PaperMarketFlagPort } from './paper/market-flag-verify.js';
import { recordPaperCertItemProgress, type PaperCertProgressView } from './paper/cert-progress-hook.js';
import { isDrillComplete, type DrillRun, type PaperMarketRef } from './paper/workbook-loop.js';
import { emptyScene, parseScene } from './spatial/scene.js';
import { decideHostSceneWrite, sceneFingerprint } from './spatial/edit-policy.js';
import {
  assertFreezeReason,
  badgeOf,
  AmbassadorProgrammeError,
  type AmbassadorBadge,
  type AmbassadorRecord,
  type AmbassadorStatus,
} from './ambassadors/programme.js';
import { assertAmbassadorsListLimit } from './ambassadors/list-limit.js';
import {
  assertMyCertsListLimit,
  assertMyResidenciesListLimit,
  assertOpenResidenciesListLimit,
  assertRoomsListLimit,
  assertSeasonStandingsSqlLimit,
  assertSeasonsSqlListLimit,
  assertSessionsListLimit,
} from './sql-list-limit.js';
import {
  assertCohortSlug,
  assertStatement,
  ResidencyError,
  type ResidencyApplication,
  type ResidencyStatus,
} from './ambassadors/residency.js';
import { assertCertCatalog, certificateForPath, listCertCatalog } from './certs/catalog.js';
import { ASSESSMENT_CATALOG, type AssessmentDefinition, type AssessmentPublic } from './assessment/catalog.js';
import { AssessmentRepository, type AttemptRow } from './assessment/repository.js';
import { randomPublicId, isPublicId } from './certs/public-id.js';
import { normaliseHolderName } from './certs/holder-name.js';
import { PROGRAMME_SLUGS } from './curriculum/programmes.js';
import {
  alreadyGrantedAfterInsert,
  CertError,
  certIdempotencyKey,
  decideGrant,
  decideItemComplete,
  progressReport,
  type CertDefinition,
  type CertGrantRecord,
  type EnrollmentRecord,
  type ItemCompletionRecord,
  type ProgressReport,
} from './certs/progress.js';
import {
  certXpPlaneStatus,
  NullCertXpPublisher,
  type CertXpEmitResult,
  type CertXpPlaneStatus,
  type CertXpPublisher,
} from './certs/xp-publish.js';
import {
  assertNoCertPerkMoneyAttachment,
  certPerkPlaneStatus,
  resolveCertPerkOutcome,
  type CertPerkOutcome,
  type CertPerkPlaneStatus,
} from './certs/perk-plane.js';
import { hasCurriculumSlug } from './curriculum/catalog.js';
import { type ProgrammeDefinition } from './curriculum/programmes.js';
import type { VideoSpineEntry } from './video/catalog.js';
import { AcademyCustomerStore } from './learning/customer-store.js';
import {
  assertMayWriteScore,
  assertScore,
  assertSeasonSlug,
  rankStandings,
  TournamentError,
  type RankedStanding,
  type SeasonRecord,
  type SeasonStatus,
  type StandingRecord,
} from './tournaments/ladder.js';
import { assertScoreWindowOpen } from './tournaments/season-calendar.js';
import { freezeSeasonWithSnapshot, transitionSeason } from './tournaments/season-lifecycle.js';
import { assertNoPrizeAttachment } from './tournaments/prize-refuse.js';
import { validateBulkScoreWrite, type ScorePatch } from './tournaments/bulk-score.js';
import type { FreezeStandingsSnapshot } from './tournaments/season-lifecycle.js';
import { decideSeat, inviteIsLive, needsStakeCheck, type RoomAccessKind } from './access/room-access.js';
import { assertPublishedMaxRoomCapacity } from './access/max-room-capacity.js';
import { mayHost, type HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import { isConstructed, type StreamCredential, type StreamProvider } from './stream/provider.js';
import { withAcademySpan } from './tracing.js';

/**
 * ACADEMY LOBBIES (§8.3, §XIII "live session lobbies, capacity tiers").
 *
 * Rooms with capacity tiers, sessions inside them, and who is sitting in one
 * right now. §8.3 names the tiers and this service implements exactly those
 * three — `free`, `staked`, `invite` — in access/room-access.ts, which holds
 * the whole admission rule as one pure function.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * Curriculum READ is a separate pure module (`curriculum/catalog.ts`) wired on
 * the router — not on this class. Progress, certifications and ambassador pay
 * remain absent on purpose:
 *
 *   · FULL DERIV//DESK library (20 playbooks + 3 workbooks) is residual —
 *     proprietary content is not in this monorepo; the thin spine is platform-
 *     native so the list + content path is real rather than empty.
 *   · CERTIFICATIONS track progress, publish XP (`certs/xp-publish.ts`), then
 *     surface real identity perks or refuse invent perk money (`certs/perk-plane.ts`).
 *     svc-identity remains the only writer to `rank_state` / perk SoT (§4.1) —
 *     academy never maps cert → perk and never invents perk money.
 *   · AMBASSADOR PAY and lobby subscriptions MOVE VALUE. They need ledger
 *     recipes that do not exist, and a half-built pay path is worse than an
 *     absent one.
 *
 * NO VALUE MOVES HERE. `academy` is `custodial: false`, this process holds no
 * ledger client and no LEDGER_URL, and the only money-shaped number it touches
 * is a room's stake THRESHOLD — compared against svc-token's answer, never
 * stored. It is an `Amount` (scaled bigint) in memory and a decimal string on
 * the wire, like every other amount in the OS.
 */

export type RoomKind = 'general' | 'futures' | 'options' | 'meme_war_room' | 'forex' | 'defi_lab' | 'merchant_clinic';
export type SessionStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type AttendeeRole = 'host' | 'speaker' | 'attendee';

export interface RoomRecord {
  id: string;
  slug: string;
  name: string;
  kind: RoomKind;
  access: RoomAccessKind;
  minStake: Amount;
  capacity: number;
  hostId: string;
}

export interface SessionRecord {
  id: string;
  roomId: string;
  title: string;
  hostId: string;
  status: SessionStatus;
  startsAt: Date;
  endsAt: Date | null;
  streamProvider: string | null;
  streamRoom: string | null;
  scene: Record<string, unknown>;
  /**
   * Optimistic concurrency token for host scene writes.
   * Always present on read so clients can supply expectedFingerprint without re-hashing.
   */
  sceneFingerprint: string;
}

interface RoomRow {
  id: string;
  slug: string;
  name: string;
  kind: RoomKind;
  access: RoomAccessKind;
  min_stake: string;
  capacity: number;
  host_id: string;
}

interface SessionRow {
  id: string;
  room_id: string;
  title: string;
  host_id: string;
  status: SessionStatus;
  starts_at: Date;
  ends_at: Date | null;
  stream_provider: string | null;
  stream_room: string | null;
  scene: Record<string, unknown>;
}

const toRoom = (row: RoomRow): RoomRecord => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  kind: row.kind,
  access: row.access,
  minStake: parseAmount(row.min_stake),
  capacity: row.capacity,
  hostId: row.host_id,
});

const toSession = (row: SessionRow): SessionRecord => {
  // Unreadable DB default `{}` → empty v1 fingerprint (same SoT as updateScene).
  const parsed = parseScene(row.scene);
  const scene = parsed.ok ? parsed.scene : emptyScene();
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    hostId: row.host_id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    streamProvider: row.stream_provider,
    streamRoom: row.stream_room,
    scene: row.scene,
    sceneFingerprint: sceneFingerprint(scene),
  };
};

export interface AcademyServiceOptions {
  /**
   * Owner-published operational ceiling. Undefined = unpublished —
   * createRoom refuses `academy.room_capacity_unset`. Never invent 5000.
   */
  maxRoomCapacity?: number;
  /** Stage-1 tournament ladder kill-switch (`ACADEMY_TOURNAMENT_ENABLED`). */
  tournamentEnabled?: boolean;
  /** Stage-3 paper-trading ops kill-switch (`ACADEMY_PAPER_TRADING_ENABLED`). */
  paperTradingEnabled?: boolean;
  /**
   * Trade public-markets paper flag port. Undefined when TRADE_URL is unset —
   * paper drills then refuse `academy.paper_flag_unverified` rather than
   * trusting `paper: true` on the wire.
   */
  paperMarketFlagPort?: PaperMarketFlagPort;
  /** Test seam. Production uses the empty-prerequisite catalog. */
  programmeCatalog?: readonly ProgrammeDefinition[];
  /** Test seam. Production uses the spine, whose media fields are null until set. */
  videoSpine?: readonly VideoSpineEntry[];
  /** Test seam. Production is the owner catalog, which is foundations-v1 only. */
  certCatalog?: readonly CertDefinition[];
  /** Test seam. Production is empty: no owner-published scored assessment. */
  assessmentCatalog?: readonly AssessmentDefinition[];
}

export class AcademyService {
  private readonly customer: AcademyCustomerStore;
  private readonly assessments: AssessmentRepository;

  constructor(
    private readonly sql: Sql,
    private readonly stakes: StakeSource,
    private readonly hostRights: HostRightsSource,
    private readonly stream: StreamProvider,
    private readonly options: AcademyServiceOptions,
    /**
     * Stage-2 cert XP emit (TRK-academy.certs). Defaults to the null publisher
     * so every existing construction of this service keeps working and keeps
     * being honest: no bus, no award, and `grantCert` says which.
     */
    private readonly certXp: CertXpPublisher = new NullCertXpPublisher(),
  ) {
    this.customer = new AcademyCustomerStore(sql);
    const assessments = this.options.assessmentCatalog ?? ASSESSMENT_CATALOG;
    this.assessments = new AssessmentRepository(sql, assessments);
    if (this.options.certCatalog) {
      assertCertCatalog(this.options.certCatalog, {
        lesson: hasCurriculumSlug,
        assessment: (slug) => assessments.some((row) => row.slug === slug),
      });
    }
  }

  private certs(): readonly CertDefinition[] {
    return this.options.certCatalog ?? listCertCatalog();
  }

  private certDefinition(id: string): CertDefinition | null {
    return this.certs().find((row) => row.id === id) ?? null;
  }

  private refuseUnpublishedPath(pathSlug: string): void {
    const path = pathSlug.trim().toLowerCase();
    if ((PROGRAMME_SLUGS as readonly string[]).includes(path) && !certificateForPath(path, this.certs())) {
      throw new AcademyError(`academy.certificate_unpublished path=${path}`, 'academy.certificate_unpublished');
    }
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────

  /**
   * Open a room.
   *
   * The §4.1 host-rights check comes FIRST, before any validation of what the
   * room would look like. Someone who may not host does not need to be told
   * their capacity is too high — and checking the perk before writing anything
   * means an svc-identity outage costs a retry rather than a cleanup
   * (host-rights.ts on why it fails closed).
   */
  async createRoom(input: {
    hostId: string;
    slug: string;
    name: string;
    kind: RoomKind;
    access: RoomAccessKind;
    minStake?: Amount;
    capacity: number;
  }): Promise<RoomRecord> {
    await this.assertMayHost(input.hostId);

    const maxRoomCapacity = assertPublishedMaxRoomCapacity(this.options.maxRoomCapacity);
    if (input.capacity > maxRoomCapacity) {
      throw new AcademyError(`A lobby cannot seat more than ${maxRoomCapacity} — presence fans out over the gateway`, 'academy.room_full');
    }
    // The database asserts this too (`rooms_stake_gate_ck`). Asserting it here
    // as well means the caller gets a sentence rather than a constraint name.
    const minStake = input.access === 'staked' ? (input.minStake ?? 0n) : 0n;
    if (input.access === 'staked' && minStake <= 0n) {
      throw new AcademyError('A staked lobby needs a stake threshold above zero', 'academy.stake_required');
    }

    const rows = await this.sql<RoomRow[]>`
      INSERT INTO academy.rooms (slug, name, kind, access, min_stake, capacity, host_id)
      VALUES (${input.slug}, ${input.name}, ${input.kind}, ${input.access},
              ${formatAmount(minStake)}::numeric, ${input.capacity}, ${input.hostId})
      RETURNING id, slug, name, kind, access, min_stake, capacity, host_id
    `;
    return toRoom(rows[0]!);
  }

  async room(roomId: string): Promise<RoomRecord> {
    const rows = await this.sql<RoomRow[]>`
      SELECT id, slug, name, kind, access, min_stake, capacity, host_id FROM academy.rooms WHERE id = ${roomId}
    `;
    const row = rows[0];
    if (!row) throw new AcademyError(`Room ${roomId} not found`, 'academy.room_not_found');
    return toRoom(row);
  }

  async listRooms(filter: { kind?: RoomKind; limit?: number } = {}): Promise<RoomRecord[]> {
    const limit = assertRoomsListLimit(filter.limit);
    const rows = filter.kind
      ? await this.sql<RoomRow[]>`
          SELECT id, slug, name, kind, access, min_stake, capacity, host_id
            FROM academy.rooms WHERE kind = ${filter.kind} ORDER BY name ASC
            LIMIT ${limit}
        `
      : await this.sql<RoomRow[]>`
          SELECT id, slug, name, kind, access, min_stake, capacity, host_id FROM academy.rooms ORDER BY kind ASC, name ASC
          LIMIT ${limit}
        `;
    return rows.map(toRoom);
  }

  /** Invite someone into an `invite` room. The host's call, and only theirs. */
  async invite(input: { roomId: string; hostId: string; userId: string; expiresAt?: Date | null }): Promise<void> {
    const room = await this.room(input.roomId);
    this.assertHost(room.hostId, input.hostId, 'room');

    await this.sql`
      INSERT INTO academy.room_invites (room_id, user_id, invited_by, expires_at)
      VALUES (${input.roomId}, ${input.userId}, ${input.hostId}, ${input.expiresAt ?? null})
      ON CONFLICT (room_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async scheduleSession(input: { roomId: string; hostId: string; title: string; startsAt: Date }): Promise<SessionRecord> {
    const room = await this.room(input.roomId);
    this.assertHost(room.hostId, input.hostId, 'room');

    const rows = await this.sql<SessionRow[]>`
      INSERT INTO academy.sessions (room_id, title, host_id, starts_at)
      VALUES (${input.roomId}, ${input.title}, ${input.hostId}, ${input.startsAt})
      RETURNING *
    `;
    return toSession(rows[0]!);
  }

  async session(sessionId: string): Promise<SessionRecord> {
    const rows = await this.sql<SessionRow[]>`SELECT * FROM academy.sessions WHERE id = ${sessionId}`;
    const row = rows[0];
    if (!row) throw new AcademyError(`Session ${sessionId} not found`, 'academy.session_not_found');
    return toSession(row);
  }

  async listSessions(filter: { roomId?: string; status?: SessionStatus; limit?: number } = {}): Promise<SessionRecord[]> {
    const limit = assertSessionsListLimit(filter.limit);
    const rows = await this.sql<SessionRow[]>`
      SELECT * FROM academy.sessions
       WHERE (${filter.roomId ?? null}::uuid IS NULL OR room_id = ${filter.roomId ?? null})
         AND (${filter.status ?? null}::text IS NULL OR status::text = ${filter.status ?? null})
       ORDER BY starts_at ASC
       LIMIT ${limit}
    `;
    return rows.map(toSession);
  }

  /**
   * Open the doors.
   *
   * The stream room is opened here rather than at schedule time, so an SFU room
   * exists only while a session is actually running. When no provider is
   * configured the session still goes live as text, presence and the scene
   * canvas — `stream_room` stays null and `streamCredential` says why.
   */
  async startSession(input: { sessionId: string; hostId: string }): Promise<SessionRecord> {
    const session = await this.session(input.sessionId);
    this.assertHost(session.hostId, input.hostId, 'session');
    if (session.status !== 'scheduled') {
      throw new AcademyError(`A ${session.status} session cannot be started`, 'academy.session_not_live');
    }

    return withAcademySpan(
      'academy.session.start',
      { stage: 'session', operation: 'start', sessionId: session.id, roomId: session.roomId, streamProvider: this.stream.id },
      async () => {
        const streamRoom = isConstructed(this.stream) ? await this.stream.openRoom(session.id) : null;

        const rows = await this.sql<SessionRow[]>`
          UPDATE academy.sessions
             SET status = 'live', stream_provider = ${streamRoom ? this.stream.id : null},
                 stream_room = ${streamRoom}, updated_at = now()
           WHERE id = ${session.id} AND status = 'scheduled'
          RETURNING *
        `;
        const started = rows[0];
        if (!started) {
          // This call lost the conditional update, so it did not start the session.
          // Keep a same-name room only while its stored session is still live.
          const current = await this.session(session.id);
          if (streamRoom && (current.status !== 'live' || streamRoom !== current.streamRoom)) {
            await this.stream.closeRoom(streamRoom);
          }
          throw new AcademyError(`A ${current.status} session cannot be started`, 'academy.session_not_live');
        }
        return toSession(started);
      },
    );
  }

  /**
   * End it, and empty the room.
   *
   * Every live attendee is marked as having left in the same transaction that
   * ends the session. Leaving them open would make the next session in the same
   * room inherit an occupancy that nobody is actually occupying.
   */
  async endSession(input: { sessionId: string; hostId: string; now?: Date }): Promise<SessionRecord> {
    const now = input.now ?? new Date();
    const session = await this.session(input.sessionId);
    this.assertHost(session.hostId, input.hostId, 'session');

    await transaction(this.sql, async (tx) => {
      // Publish the terminal state before the external delete. A delayed start
      // that recreates the same-name room must see ended and compensate it.
      const ended = await tx<SessionRow[]>`
        UPDATE academy.sessions SET status = 'ended', ends_at = ${now}, updated_at = now()
         WHERE id = ${session.id} AND status IN ('scheduled', 'live')
        RETURNING *
      `;
      if (ended[0]) {
        await tx`
          UPDATE academy.session_attendees SET left_at = ${now} WHERE session_id = ${session.id} AND left_at IS NULL
        `;
      }
    });

    // Keep the stored room and original ended timestamp as the retry identity.
    // Failed or lost delete acknowledgements cannot reopen the session; an
    // authorized end retry re-drives cleanup without changing terminal state.
    const terminal = await this.session(session.id);
    if (terminal.streamRoom) await this.stream.closeRoom(terminal.streamRoom);
    return terminal;
  }

  /** Live attendees. A COUNT, never a maintained counter. */
  async occupancy(sessionId: string, tx: Sql = this.sql): Promise<number> {
    const rows = await tx<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count FROM academy.session_attendees WHERE session_id = ${sessionId} AND left_at IS NULL
    `;
    return Number(rows[0]?.count ?? '0');
  }

  /**
   * Take a seat.
   *
   * ── Why the seat is claimed under a lock ────────────────────────────────────
   *
   * Capacity is only a capacity if two people racing for the last seat cannot
   * both get it. The insert runs inside a transaction that locks the session
   * row first, so the occupancy count and the insert cannot interleave — which
   * is the whole reason `read committed` is correct here (see
   * packages/db/src/connection.ts on when it is, and when it is not).
   *
   * The GATE is evaluated before the lock is taken, deliberately: a stake
   * lookup is a network call, and holding the busiest row in a live lobby
   * across one would serialise every join behind svc-token's latency.
   */
  async join(input: { sessionId: string; userId: string; now?: Date }): Promise<{ role: AttendeeRole }> {
    const now = input.now ?? new Date();
    const session = await this.session(input.sessionId);
    if (session.status !== 'live') throw new AcademyError('That session is not live', 'academy.session_not_live');

    const room = await this.room(session.roomId);
    const isHost = room.hostId === input.userId || session.hostId === input.userId;

    // Only a staked room asks svc-token, so an outage there does not close the
    // free and invite lobbies too.
    const stake = needsStakeCheck(room, isHost) ? await this.stakes.stakeOf(input.userId) : 0n;

    const invited = room.access === 'invite' && !isHost ? inviteIsLive(await this.liveInvite(room.id, input.userId), now) : false;

    return withAcademySpan(
      'academy.session.join',
      { stage: 'lobby', operation: 'join', sessionId: session.id, roomId: room.id, userId: input.userId, capacity: room.capacity },
      async (span) => {
        const role: AttendeeRole = isHost ? 'host' : 'attendee';

        const decision = await transaction(
          this.sql,
          async (tx) => {
            const locked = await tx<Array<{ status: SessionRecord['status'] }>>`
              SELECT status FROM academy.sessions WHERE id = ${session.id} FOR UPDATE
            `;
            // The external gate may finish after end/cancel removed this seat.
            // Recheck under the existing lock before occupancy or attendee writes.
            if (locked[0]?.status !== 'live') {
              throw new AcademyError('That session is not live', 'academy.session_not_live');
            }
            const occupancy = await this.occupancy(session.id, tx);

            const seat = decideSeat(
              { access: room.access, minStake: room.minStake, capacity: room.capacity },
              { occupancy, stake, invited, isHost },
            );
            if (!seat.allowed) return { seat, occupancy };

            await tx`
              INSERT INTO academy.session_attendees (session_id, user_id, role, joined_at)
              VALUES (${session.id}, ${input.userId}, ${role}, ${now})
              ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, role = EXCLUDED.role
            `;

            if (room.access === 'invite' && !isHost) {
              await tx`
                UPDATE academy.room_invites SET used_at = COALESCE(used_at, ${now})
                 WHERE room_id = ${room.id} AND user_id = ${input.userId}
              `;
            }

            return { seat, occupancy };
          },
          { isolation: 'read committed' },
        );

        span.setAttribute('intafaced.occupancy', decision.occupancy);
        // A refusal is invisible from the outside — nobody files a ticket for a
        // room they could not get into. This attribute is the only place
        // "how many bounced off the stake gate" is a number.
        span.setAttribute('intafaced.decision', decision.seat.allowed ? 'allowed' : decision.seat.code);

        if (!decision.seat.allowed) throw new AcademyError(decision.seat.reason, decision.seat.code);
        return { role };
      },
    );
  }

  async leave(input: { sessionId: string; userId: string; now?: Date }): Promise<void> {
    const now = input.now ?? new Date();
    await this.sql`
      UPDATE academy.session_attendees SET left_at = ${now}
       WHERE session_id = ${input.sessionId} AND user_id = ${input.userId} AND left_at IS NULL
    `;
  }

  /**
   * A join credential for the stream.
   *
   * Separate from `join` on purpose. A seat is granted by this service; a
   * stream credential is granted by the SFU, and when there is no SFU the
   * lobby still runs. Folding the two together would make every text lobby fail
   * to admit anyone the moment streaming was unconfigured.
   *
   * Refuses anyone not actually seated: a credential is a key to a live room.
   */
  async streamCredential(input: { sessionId: string; userId: string }): Promise<StreamCredential> {
    const session = await this.session(input.sessionId);
    if (session.status !== 'live' || !session.streamRoom) {
      throw new AcademyError('That session is not carrying a stream', 'academy.stream_unavailable');
    }

    const rows = await this.sql<Array<{ role: AttendeeRole }>>`
      SELECT role FROM academy.session_attendees
       WHERE session_id = ${session.id} AND user_id = ${input.userId} AND left_at IS NULL
    `;
    const role = rows[0]?.role;
    if (!role) throw new AcademyError('Take a seat in the lobby first', 'academy.session_not_live');

    return this.stream.credential({ sessionId: session.id, streamRoom: session.streamRoom, userId: input.userId, role });
  }

  /**
   * The 2D spatial layer's state (§8.3).
   *
   * Kept serializable and kept whole: the host writes the scene, everyone else
   * reads it. Merging per-attendee edits would need a conflict model this does
   * not have, and half a merge is a room that renders differently for different
   * people.
   */
  async updateScene(input: {
    sessionId: string;
    hostId: string;
    scene: Record<string, unknown>;
    /** Optional optimistic concurrency token — must match server scene fingerprint. */
    expectedFingerprint?: string;
  }): Promise<SessionRecord & { sceneFingerprint: string }> {
    const session = await this.session(input.sessionId);
    this.assertHost(session.hostId, input.hostId, 'session');

    // DB default was historically `{}`, which is not Scene v1. Treat unreadable
    // current state as empty v1 so reconnect/edit policy still has a SoT.
    const currentParsed = parseScene(session.scene);
    const current = currentParsed.ok ? currentParsed.scene : emptyScene();

    const decision = decideHostSceneWrite({
      current,
      next: input.scene,
      ...(input.expectedFingerprint !== undefined ? { expectedFingerprint: input.expectedFingerprint } : {}),
    });
    if (!decision.ok) {
      if (decision.reason === 'conflict') {
        throw new AcademyError(decision.message, 'academy.scene_conflict');
      }
      if (decision.reason === 'presence_collision') {
        throw new AcademyError(decision.message, 'academy.scene_presence_collision');
      }
      throw new AcademyError(decision.message, 'academy.scene_invalid');
    }

    const rows = await this.sql<SessionRow[]>`
      UPDATE academy.sessions SET scene = ${this.sql.json(decision.scene as never)}, updated_at = now() WHERE id = ${session.id} RETURNING *
    `;
    return { ...toSession(rows[0]!), sceneFingerprint: decision.fingerprint };
  }

  // ── Tournament ladders Stage-1 (NO PRIZE MONEY) ────────────────────────────

  private assertTournamentEnabled(): void {
    if (this.options.tournamentEnabled === false) {
      throw new AcademyError('Tournament ladder is disabled', 'academy.tournament_disabled');
    }
  }

  /** Stage-3 — ops kill paper drills without touching live trade. */
  assertPaperTradingEnabled(): void {
    if (!isPaperOpsEnabled(this.options.paperTradingEnabled)) {
      throw new AcademyError(paperOpsDisabledMessage(), 'academy.paper_trading_disabled');
    }
  }

  /**
   * D26-P1-C4 — claimed `paper: true` must match trade's public listing.
   * Unset port (no TRADE_URL) refuses by name rather than trusting the caller.
   */
  async assertCallerPaperFlagVerified(market: PaperMarketRef | null): Promise<void> {
    await assertCallerCannotLiePaperFlag(this.options.paperMarketFlagPort, market);
  }

  /** Stage-3 — ops status snapshot (live trade always unaffected). */
  paperOpsStatus(): PaperOpsStatus {
    const status = paperOpsStatus(this.options.paperTradingEnabled);
    assertPaperNeverReadableAsRealMoney(status);
    return status;
  }

  /**
   * After a sealed paper drill: record cert *item* completion when the workbook
   * is bound to a catalog cert. Unbound → `progress: 'unbound'`. Never grantCert,
   * never invent XP, never perk-map, never ledger.
   */
  async recordPaperDrillCertProgress(input: { userId: string; run: DrillRun }): Promise<PaperCertProgressView> {
    this.assertPaperTradingEnabled();
    const certs = listCertCatalog();
    const drillComplete = isDrillComplete(input.run);
    let existing: ItemCompletionRecord | null = null;
    if (drillComplete) {
      const slug = input.run.workbookSlug.trim();
      const existingRows = await this.sql<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
        SELECT user_id, item_slug, completed_at FROM academy.cert_item_completions
         WHERE user_id = ${input.userId} AND item_slug = ${slug}
      `;
      existing = existingRows[0]
        ? {
            userId: existingRows[0].user_id,
            itemSlug: existingRows[0].item_slug,
            completedAt: existingRows[0].completed_at,
          }
        : null;
    }

    const pending: { record: ItemCompletionRecord | null } = { record: null };
    const view = recordPaperCertItemProgress({
      userId: input.userId,
      run: input.run,
      certs,
      existing,
      persist: (record) => {
        pending.record = record;
      },
    });
    if (view.progress === 'recorded' && pending.record) {
      const row = await this.markCurriculumComplete({
        userId: input.userId,
        itemSlug: view.itemSlug,
      });
      const recorded: PaperCertProgressView = {
        ...view,
        completedAt: row.completedAt,
      };
      assertPaperNeverReadableAsRealMoney(recorded);
      return recorded;
    }
    assertPaperNeverReadableAsRealMoney(view);
    return view;
  }

  private mapTournamentErr(err: unknown): never {
    if (err instanceof TournamentError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  private toSeason(row: {
    id: string;
    slug: string;
    title: string;
    status: SeasonStatus;
    rules_summary: string;
    starts_at: Date;
    ends_at: Date | null;
  }): SeasonRecord {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      rulesSummary: row.rules_summary,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }

  async createSeason(input: {
    slug: string;
    title: string;
    rulesSummary: string;
    startsAt: Date;
    endsAt?: Date | null;
  }): Promise<SeasonRecord> {
    this.assertTournamentEnabled();
    let slug: string;
    try {
      slug = assertSeasonSlug(input.slug);
    } catch (e) {
      this.mapTournamentErr(e);
    }
    const title = input.title.trim();
    const rules = input.rulesSummary.trim();
    if (title.length < 3 || title.length > 160) {
      throw new AcademyError('Season title 3–160 characters', 'academy.season_invalid');
    }
    if (rules.length < 8 || rules.length > 4000) {
      throw new AcademyError('Rules summary 8–4000 characters', 'academy.season_invalid');
    }
    // Refuse prize-shaped fields if a caller ever spreads invent payload into season shape.
    try {
      assertNoPrizeAttachment({
        slug,
        title,
        rulesSummary: rules,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        status: 'scheduled',
      });
    } catch (e) {
      this.mapTournamentErr(e);
    }
    const rows = await this.sql<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: SeasonStatus;
        rules_summary: string;
        starts_at: Date;
        ends_at: Date | null;
      }>
    >`
      INSERT INTO academy.tournament_seasons (slug, title, status, rules_summary, starts_at, ends_at)
      VALUES (${slug}, ${title}, 'scheduled', ${rules}, ${input.startsAt}, ${input.endsAt ?? null})
      RETURNING id, slug, title, status, rules_summary, starts_at, ends_at
    `;
    return this.toSeason(rows[0]!);
  }

  async season(seasonId: string): Promise<SeasonRecord> {
    this.assertTournamentEnabled();
    const rows = await this.sql<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: SeasonStatus;
        rules_summary: string;
        starts_at: Date;
        ends_at: Date | null;
      }>
    >`SELECT id, slug, title, status, rules_summary, starts_at, ends_at FROM academy.tournament_seasons WHERE id = ${seasonId}`;
    if (!rows[0]) throw new AcademyError(`Season ${seasonId} not found`, 'academy.season_not_found');
    return this.toSeason(rows[0]);
  }

  async listSeasons(filter: { status?: SeasonStatus; limit?: number } = {}): Promise<SeasonRecord[]> {
    this.assertTournamentEnabled();
    const limit = assertSeasonsSqlListLimit(filter.limit);
    const rows = filter.status
      ? await this.sql<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons WHERE status = ${filter.status}
            ORDER BY starts_at DESC
            LIMIT ${limit}
        `
      : await this.sql<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons ORDER BY starts_at DESC
            LIMIT ${limit}
        `;
    return rows.map((r) => this.toSeason(r));
  }

  async setSeasonStatus(input: { seasonId: string; status: SeasonStatus }): Promise<SeasonRecord> {
    this.assertTournamentEnabled();
    const current = await this.season(input.seasonId);
    // Pure lifecycle owns legal edges — raw SQL used to allow scheduled→frozen etc.
    try {
      assertNoPrizeAttachment(current);
      transitionSeason(current, input.status);
    } catch (e) {
      this.mapTournamentErr(e);
    }

    // live→frozen: snapshot + status flip MUST be one transaction.
    // Split writes left a crash hole: snapshot exists while status stays live
    // and scores still write. This freeze stores the standings computed now,
    // replacing that earlier row, and then marks the season frozen.
    if (current.status === 'live' && input.status === 'frozen') {
      return transaction(
        this.sql,
        async (tx) => {
          const locked = await tx<
            Array<{
              id: string;
              slug: string;
              title: string;
              status: SeasonStatus;
              rules_summary: string;
              starts_at: Date;
              ends_at: Date | null;
            }>
          >`
            SELECT id, slug, title, status, rules_summary, starts_at, ends_at
              FROM academy.tournament_seasons
             WHERE id = ${input.seasonId}
             FOR UPDATE
          `;
          if (!locked[0]) throw new AcademyError(`Season ${input.seasonId} not found`, 'academy.season_not_found');
          const lockedSeason = this.toSeason(locked[0]);
          try {
            assertNoPrizeAttachment(lockedSeason);
            transitionSeason(lockedSeason, 'frozen');
          } catch (e) {
            this.mapTournamentErr(e);
          }
          if (lockedSeason.status !== 'live') {
            throw new AcademyError(
              `Season ${input.seasonId} is ${lockedSeason.status} — cannot freeze (concurrent transition)`,
              'academy.season_invalid',
            );
          }

          const standingRows = await tx<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
            SELECT season_id, user_id, score, updated_at FROM academy.tournament_standings
             WHERE season_id = ${input.seasonId}
          `;
          let snapshot: FreezeStandingsSnapshot;
          try {
            const frozen = freezeSeasonWithSnapshot(
              lockedSeason,
              standingRows.map((r) => ({
                seasonId: r.season_id,
                userId: r.user_id,
                score: r.score,
                updatedAt: r.updated_at,
              })),
            );
            snapshot = frozen.snapshot;
          } catch (e) {
            this.mapTournamentErr(e);
          }
          const standingsJson = snapshot.standings.map((s) => ({
            rank: s.rank,
            userId: s.userId,
            score: s.score,
            updatedAt: s.updatedAt.toISOString(),
          }));
          await tx`
            INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings)
            VALUES (${input.seasonId}, ${snapshot.frozenAt}, ${tx.json(standingsJson as never)})
            ON CONFLICT (season_id) DO UPDATE
              SET frozen_at = EXCLUDED.frozen_at,
                  standings = EXCLUDED.standings
          `;
          const rows = await tx<
            Array<{
              id: string;
              slug: string;
              title: string;
              status: SeasonStatus;
              rules_summary: string;
              starts_at: Date;
              ends_at: Date | null;
            }>
          >`
            UPDATE academy.tournament_seasons
               SET status = 'frozen', updated_at = now()
             WHERE id = ${input.seasonId}
               AND status = 'live'
             RETURNING id, slug, title, status, rules_summary, starts_at, ends_at
          `;
          if (!rows[0]) {
            throw new AcademyError(`Season ${input.seasonId} left live during freeze (concurrent transition)`, 'academy.season_invalid');
          }
          return this.toSeason(rows[0]);
        },
        { isolation: 'read committed' },
      );
    }

    const rows = await this.sql<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: SeasonStatus;
        rules_summary: string;
        starts_at: Date;
        ends_at: Date | null;
      }>
    >`
      UPDATE academy.tournament_seasons
         SET status = ${input.status}, updated_at = now()
       WHERE id = ${input.seasonId}
         AND status = ${current.status}
       RETURNING id, slug, title, status, rules_summary, starts_at, ends_at
    `;
    const row = rows[0];
    if (!row) {
      throw new AcademyError(`Season ${input.seasonId} is no longer ${current.status}`, 'academy.season_invalid');
    }
    return this.toSeason(row);
  }

  /** Read durable freeze audit snapshot (null when season never frozen on this path). */
  async freezeSnapshot(seasonId: string): Promise<{
    seasonId: string;
    frozenAt: Date;
    standings: { rank: number; userId: string; score: number; updatedAt: string }[];
  } | null> {
    this.assertTournamentEnabled();
    await this.season(seasonId);
    const rows = await this.sql<Array<{ season_id: string; frozen_at: Date; standings: unknown }>>`
      SELECT season_id, frozen_at, standings FROM academy.tournament_freeze_snapshots
       WHERE season_id = ${seasonId}
    `;
    const r = rows[0];
    if (!r) return null;
    const standings = r.standings as { rank: number; userId: string; score: number; updatedAt: string }[];
    return {
      seasonId: r.season_id,
      frozenAt: r.frozen_at,
      standings: [...standings],
    };
  }

  async setStanding(input: { seasonId: string; userId: string; score: number; now?: Date }): Promise<StandingRecord> {
    this.assertTournamentEnabled();
    const season = await this.season(input.seasonId);
    const now = input.now ?? new Date();
    try {
      // Live status alone is not enough — calendar window must still be open.
      assertScoreWindowOpen(season, now);
      assertMayWriteScore(season.status);
      assertScore(input.score);
    } catch (e) {
      this.mapTournamentErr(e);
    }
    // The read above is not the write gate. Freeze holds this same row from the
    // snapshot read through the status flip, so the upsert waits, then refuses
    // unless the stored status is still live.
    return transaction(
      this.sql,
      async (tx) => {
        const locked = await tx<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons
           WHERE id = ${input.seasonId}
           FOR UPDATE
        `;
        if (!locked[0]) throw new AcademyError(`Season ${input.seasonId} not found`, 'academy.season_not_found');
        const lockedSeason = this.toSeason(locked[0]);
        try {
          assertScoreWindowOpen(lockedSeason, now);
          assertMayWriteScore(lockedSeason.status);
        } catch (e) {
          this.mapTournamentErr(e);
        }
        const rows = await tx<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
          INSERT INTO academy.tournament_standings (season_id, user_id, score, updated_at)
          VALUES (${input.seasonId}, ${input.userId}, ${input.score}, now())
          ON CONFLICT (season_id, user_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now()
          RETURNING season_id, user_id, score, updated_at
        `;
        const r = rows[0]!;
        return { seasonId: r.season_id, userId: r.user_id, score: r.score, updatedAt: r.updated_at };
      },
      { isolation: 'read committed' },
    );
  }

  /**
   * Operator bulk score write — Stage-2 L3 residual on the wire.
   * Pure `validateBulkScoreWrite` owns refuse rules (live-only, no empty, no
   * dup user, score bounds). Accepted patches upsert in ONE transaction under
   * a season-row lock so freeze cannot interleave a partial board, and a
   * mid-batch crash cannot leave half the patch set durable.
   * No prize fields, no invent scores.
   */
  async bulkSetStandings(input: {
    seasonId: string;
    patches: readonly ScorePatch[];
  }): Promise<
    { ok: true; accepted: number; standings: StandingRecord[] } | { ok: false; reason: string; message: string; badUserId?: string }
  > {
    this.assertTournamentEnabled();
    const season = await this.season(input.seasonId);
    const gate = validateBulkScoreWrite({
      seasonStatus: season.status,
      seasonId: input.seasonId,
      patches: input.patches,
      // Same calendar gate as setStanding — refuse bulk before any partial upserts.
      startsAt: season.startsAt,
      endsAt: season.endsAt,
    });
    if (gate.status === 'refuse') {
      return {
        ok: false,
        reason: gate.reason,
        message: gate.message,
        ...(gate.badUserId !== undefined ? { badUserId: gate.badUserId } : {}),
      };
    }

    const now = new Date();
    return transaction(
      this.sql,
      async (tx) => {
        // Total order vs freeze: lock season before re-check + multi-row upsert.
        const locked = await tx<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons
           WHERE id = ${input.seasonId}
           FOR UPDATE
        `;
        if (!locked[0]) throw new AcademyError(`Season ${input.seasonId} not found`, 'academy.season_not_found');
        const lockedSeason = this.toSeason(locked[0]);
        const reGate = validateBulkScoreWrite({
          seasonStatus: lockedSeason.status,
          seasonId: input.seasonId,
          patches: input.patches,
          startsAt: lockedSeason.startsAt,
          endsAt: lockedSeason.endsAt,
          now,
        });
        if (reGate.status === 'refuse') {
          return {
            ok: false as const,
            reason: reGate.reason,
            message: reGate.message,
            ...(reGate.badUserId !== undefined ? { badUserId: reGate.badUserId } : {}),
          };
        }

        const standings: StandingRecord[] = [];
        for (const p of reGate.patches) {
          const rows = await tx<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
            INSERT INTO academy.tournament_standings (season_id, user_id, score, updated_at)
            VALUES (${input.seasonId}, ${p.userId}, ${p.score}, now())
            ON CONFLICT (season_id, user_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now()
            RETURNING season_id, user_id, score, updated_at
          `;
          const r = rows[0]!;
          standings.push({ seasonId: r.season_id, userId: r.user_id, score: r.score, updatedAt: r.updated_at });
        }
        return { ok: true as const, accepted: standings.length, standings };
      },
      { isolation: 'read committed' },
    );
  }

  async standings(seasonId: string, filter: { limit?: number } = {}): Promise<RankedStanding[]> {
    this.assertTournamentEnabled();
    const limit = assertSeasonStandingsSqlLimit(filter.limit);
    await this.season(seasonId);
    const rows = await this.sql<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
      SELECT season_id, user_id, score, updated_at FROM academy.tournament_standings
       WHERE season_id = ${seasonId}
       ORDER BY score DESC, updated_at ASC
       LIMIT ${limit}
    `;
    return rankStandings(
      rows.map((r) => ({
        seasonId: r.season_id,
        userId: r.user_id,
        score: r.score,
        updatedAt: r.updated_at,
      })),
    );
  }

  // ── Ambassador programme (Stage-1 status only — NO PAY) ───────────────────

  private toAmbassador(row: {
    user_id: string;
    status: AmbassadorStatus;
    appointed_by: string;
    appointed_at: Date;
    frozen_at: Date | null;
    frozen_by: string | null;
    freeze_reason: string | null;
  }): AmbassadorRecord {
    return {
      userId: row.user_id,
      status: row.status,
      appointedBy: row.appointed_by,
      appointedAt: row.appointed_at,
      frozenAt: row.frozen_at,
      frozenBy: row.frozen_by,
      freezeReason: row.freeze_reason,
    };
  }

  private mapAmbassadorErr(err: unknown): never {
    if (err instanceof AmbassadorProgrammeError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  async ambassadorOf(userId: string): Promise<AmbassadorRecord | null> {
    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      SELECT user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
        FROM academy.ambassadors WHERE user_id = ${userId}
    `;
    return rows[0] ? this.toAmbassador(rows[0]) : null;
  }

  async ambassadorBadge(userId: string): Promise<AmbassadorBadge> {
    return badgeOf(userId, await this.ambassadorOf(userId));
  }

  async listAmbassadors(filter: { status?: AmbassadorStatus; limit?: number } = {}): Promise<AmbassadorRecord[]> {
    const limit = assertAmbassadorsListLimit(filter.limit);
    const rows = filter.status
      ? await this.sql<
          Array<{
            user_id: string;
            status: AmbassadorStatus;
            appointed_by: string;
            appointed_at: Date;
            frozen_at: Date | null;
            frozen_by: string | null;
            freeze_reason: string | null;
          }>
        >`
          SELECT user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
            FROM academy.ambassadors WHERE status = ${filter.status}
            ORDER BY appointed_at DESC
            LIMIT ${limit}
        `
      : await this.sql<
          Array<{
            user_id: string;
            status: AmbassadorStatus;
            appointed_by: string;
            appointed_at: Date;
            frozen_at: Date | null;
            frozen_by: string | null;
            freeze_reason: string | null;
          }>
        >`
          SELECT user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
            FROM academy.ambassadors ORDER BY status ASC, appointed_at DESC
            LIMIT ${limit}
        `;
    return rows.map((r) => this.toAmbassador(r));
  }

  /**
   * Operator appoint. New row only, or refuse.
   * Already-active is refused so double-click does not rewrite appointed_by silently.
   * Frozen is refused so freeze audit is not erased — use unfreezeAmbassador.
   */
  async appointAmbassador(input: { userId: string; operatorId: string }): Promise<AmbassadorRecord> {
    const existing = await this.ambassadorOf(input.userId);
    if (existing?.status === 'active') {
      throw new AcademyError(`User ${input.userId} is already an active ambassador`, 'academy.ambassador_already_active');
    }
    if (existing?.status === 'frozen') {
      throw new AcademyError(
        `Ambassador ${input.userId} is frozen — unfreeze to restore the badge (re-appoint would erase freeze audit)`,
        'academy.ambassador_already_frozen',
      );
    }

    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      INSERT INTO academy.ambassadors (user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason, updated_at)
      VALUES (${input.userId}, 'active', ${input.operatorId}, now(), NULL, NULL, NULL, now())
      ON CONFLICT (user_id) DO UPDATE SET
        status = 'active',
        appointed_by = EXCLUDED.appointed_by,
        appointed_at = now(),
        frozen_at = NULL,
        frozen_by = NULL,
        freeze_reason = NULL,
        updated_at = now()
      WHERE academy.ambassadors.status IS DISTINCT FROM 'frozen'
        AND academy.ambassadors.status IS DISTINCT FROM 'active'
      RETURNING user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
    `;
    if (!rows[0]) {
      // Concurrent freeze/active won the race — re-read and refuse honestly.
      const again = await this.ambassadorOf(input.userId);
      if (again?.status === 'frozen') {
        throw new AcademyError(
          `Ambassador ${input.userId} is frozen — unfreeze to restore the badge (re-appoint would erase freeze audit)`,
          'academy.ambassador_already_frozen',
        );
      }
      if (again?.status === 'active') {
        throw new AcademyError(`User ${input.userId} is already an active ambassador`, 'academy.ambassador_already_active');
      }
      throw new AcademyError(`Could not appoint ambassador ${input.userId}`, 'academy.ambassador_invalid');
    }
    return this.toAmbassador(rows[0]!);
  }

  async freezeAmbassador(input: { userId: string; operatorId: string; reason: string }): Promise<AmbassadorRecord> {
    let reason: string;
    try {
      reason = assertFreezeReason(input.reason);
    } catch (err) {
      this.mapAmbassadorErr(err);
    }

    const existing = await this.ambassadorOf(input.userId);
    if (!existing) {
      throw new AcademyError(`No ambassador programme row for ${input.userId}`, 'academy.ambassador_not_found');
    }
    if (existing.status === 'frozen') {
      throw new AcademyError(`Ambassador ${input.userId} is already frozen`, 'academy.ambassador_already_frozen');
    }

    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      UPDATE academy.ambassadors
         SET status = 'frozen',
             frozen_at = now(),
             frozen_by = ${input.operatorId},
             freeze_reason = ${reason},
             updated_at = now()
       WHERE user_id = ${input.userId}
         AND status = 'active'
       RETURNING user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
    `;
    if (rows.length === 0) {
      // Concurrent freeze won the race — do not overwrite freeze_reason/by.
      throw new AcademyError(`Ambassador ${input.userId} is already frozen`, 'academy.ambassador_already_frozen');
    }
    return this.toAmbassador(rows[0]!);
  }

  async unfreezeAmbassador(input: { userId: string; operatorId: string }): Promise<AmbassadorRecord> {
    const existing = await this.ambassadorOf(input.userId);
    if (!existing) {
      throw new AcademyError(`Ambassador ${input.userId} not found`, 'academy.ambassador_not_found');
    }
    if (existing.status !== 'frozen') {
      throw new AcademyError(`Ambassador ${input.userId} is not frozen`, 'academy.ambassador_invalid');
    }
    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      UPDATE academy.ambassadors
         SET status = 'active',
             frozen_at = NULL,
             frozen_by = NULL,
             freeze_reason = NULL,
             updated_at = now()
       WHERE user_id = ${input.userId} AND status = 'frozen'
       RETURNING user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
    `;
    if (!rows[0]) {
      throw new AcademyError(`Ambassador ${input.userId} not found`, 'academy.ambassador_not_found');
    }
    // operatorId is audit context for future event emission — required for admin write symmetry.
    void input.operatorId;
    return this.toAmbassador(rows[0]);
  }

  // ── Residency applications (Stage-1 durable — NO PAY) ─────────────────────
  //
  // Persistence is the whole point: MemoryResidencyDesk is for unit tests only.
  // Routes write here so an apply survives restart.

  private toResidency(row: {
    id: string;
    user_id: string;
    cohort_slug: string;
    statement: string;
    status: ResidencyStatus;
    applied_at: Date;
    decided_at: Date | null;
    decided_by: string | null;
    decision_note: string | null;
  }): ResidencyApplication {
    return {
      id: row.id,
      userId: row.user_id,
      cohortSlug: row.cohort_slug,
      statement: row.statement,
      status: row.status,
      appliedAt: row.applied_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      decisionNote: row.decision_note,
    };
  }

  private mapResidencyErr(err: unknown): never {
    if (err instanceof ResidencyError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  async applyResidency(input: { userId: string; cohortSlug: string; statement: string }): Promise<ResidencyApplication> {
    let cohortSlug: string;
    let statement: string;
    try {
      cohortSlug = assertCohortSlug(input.cohortSlug);
      statement = assertStatement(input.statement);
    } catch (err) {
      this.mapResidencyErr(err);
    }

    try {
      const rows = await this.sql<
        Array<{
          id: string;
          user_id: string;
          cohort_slug: string;
          statement: string;
          status: ResidencyStatus;
          applied_at: Date;
          decided_at: Date | null;
          decided_by: string | null;
          decision_note: string | null;
        }>
      >`
        INSERT INTO academy.residency_applications
          (user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note, updated_at)
        VALUES
          (${input.userId}, ${cohortSlug}, ${statement}, 'applied', now(), NULL, NULL, NULL, now())
        RETURNING id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
      `;
      return this.toResidency(rows[0]!);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') {
        throw new AcademyError('Open application already exists for this cohort', 'academy.residency_already_open');
      }
      throw err;
    }
  }

  async withdrawResidency(input: { id: string; userId: string }): Promise<ResidencyApplication> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        cohort_slug: string;
        statement: string;
        status: ResidencyStatus;
        applied_at: Date;
        decided_at: Date | null;
        decided_by: string | null;
        decision_note: string | null;
      }>
    >`
      UPDATE academy.residency_applications
         SET status = 'withdrawn',
             decided_at = now(),
             decided_by = ${input.userId},
             decision_note = 'withdrawn by applicant',
             updated_at = now()
       WHERE id = ${input.id}
         AND user_id = ${input.userId}
         AND status = 'applied'
       RETURNING id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
    `;
    if (!rows[0]) {
      const existing = await this.sql<Array<{ status: ResidencyStatus; user_id: string }>>`
        SELECT status, user_id FROM academy.residency_applications WHERE id = ${input.id}
      `;
      if (!existing[0] || existing[0].user_id !== input.userId) {
        throw new AcademyError('Application not found', 'academy.residency_not_found');
      }
      throw new AcademyError(`Application is ${existing[0].status}`, 'academy.residency_not_pending');
    }
    return this.toResidency(rows[0]);
  }

  async decideResidency(input: {
    id: string;
    operatorId: string;
    decision: 'accepted' | 'rejected';
    note?: string;
  }): Promise<ResidencyApplication> {
    const note = (input.note ?? '').trim().slice(0, 500) || null;
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        cohort_slug: string;
        statement: string;
        status: ResidencyStatus;
        applied_at: Date;
        decided_at: Date | null;
        decided_by: string | null;
        decision_note: string | null;
      }>
    >`
      UPDATE academy.residency_applications
         SET status = ${input.decision},
             decided_at = now(),
             decided_by = ${input.operatorId},
             decision_note = ${note},
             updated_at = now()
       WHERE id = ${input.id}
         AND status = 'applied'
       RETURNING id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
    `;
    if (!rows[0]) {
      const existing = await this.sql<Array<{ status: ResidencyStatus }>>`
        SELECT status FROM academy.residency_applications WHERE id = ${input.id}
      `;
      if (!existing[0]) {
        throw new AcademyError('Application not found', 'academy.residency_not_found');
      }
      throw new AcademyError(`Application is ${existing[0].status}`, 'academy.residency_not_pending');
    }
    return this.toResidency(rows[0]);
  }

  async myResidencies(userId: string, requested?: number): Promise<ResidencyApplication[]> {
    const limit = assertMyResidenciesListLimit(requested);
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        cohort_slug: string;
        statement: string;
        status: ResidencyStatus;
        applied_at: Date;
        decided_at: Date | null;
        decided_by: string | null;
        decision_note: string | null;
      }>
    >`
      SELECT id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
        FROM academy.residency_applications
       WHERE user_id = ${userId}
       ORDER BY applied_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => this.toResidency(r));
  }

  async listOpenResidencies(filter: { cohortSlug?: string; limit?: number } = {}): Promise<ResidencyApplication[]> {
    const limit = assertOpenResidenciesListLimit(filter.limit);
    const rows = filter.cohortSlug
      ? await this.sql<
          Array<{
            id: string;
            user_id: string;
            cohort_slug: string;
            statement: string;
            status: ResidencyStatus;
            applied_at: Date;
            decided_at: Date | null;
            decided_by: string | null;
            decision_note: string | null;
          }>
        >`
          SELECT id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
            FROM academy.residency_applications
           WHERE status = 'applied' AND cohort_slug = ${filter.cohortSlug.trim().toLowerCase()}
           ORDER BY applied_at ASC
           LIMIT ${limit}
        `
      : await this.sql<
          Array<{
            id: string;
            user_id: string;
            cohort_slug: string;
            statement: string;
            status: ResidencyStatus;
            applied_at: Date;
            decided_at: Date | null;
            decided_by: string | null;
            decision_note: string | null;
          }>
        >`
          SELECT id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
            FROM academy.residency_applications
           WHERE status = 'applied'
           ORDER BY applied_at ASC
           LIMIT ${limit}
        `;
    return rows.map((r) => this.toResidency(r));
  }

  // ── Certifications Stage-1 (progress + grants — NO XP / NO PAY) ───────────

  private mapCertErr(err: unknown): never {
    if (err instanceof CertError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  listCertDefinitions(): CertDefinition[] {
    return [...this.certs()];
  }

  async enrollCertPath(input: { userId: string; pathSlug: string }): Promise<EnrollmentRecord> {
    this.refuseUnpublishedPath(input.pathSlug);
    const row = await this.customer.enrollCertPath({
      userId: input.userId,
      pathSlug: input.pathSlug,
      ...(this.options.programmeCatalog ? { catalog: this.options.programmeCatalog } : {}),
    });
    return { userId: row.userId, pathSlug: row.pathSlug, enrolledAt: row.enrolledAt };
  }

  myCompletions(input: { userId: string; limit: number | null | undefined; cursor?: string | null }) {
    return this.customer.myCompletions(input);
  }

  myEnrollments(userId: string) {
    return this.customer.myEnrollments(userId);
  }

  leaveCertPath(input: { userId: string; pathSlug: string; clientRequestId: string }) {
    return this.customer.leaveCertPath(input);
  }

  learningState(userId: string) {
    return this.customer.learningState(userId);
  }

  touchLesson(input: { userId: string; slug: string; secondsRead?: number | null; clientRequestId: string; now?: Date }) {
    return this.customer.touchLesson(input);
  }

  residencyCohorts(limit: number | null | undefined) {
    return this.customer.residencyCohorts(limit);
  }

  setVideoProgress(input: { userId: string; videoSlug: string; positionSeconds: number; clientRequestId: string; now?: Date }) {
    return this.customer.setVideoProgress({
      ...input,
      ...(this.options.videoSpine ? { spine: this.options.videoSpine } : {}),
    });
  }

  getVideoProgress(input: { userId: string; videoSlug: string }) {
    return this.customer.getVideoProgress({
      ...input,
      ...(this.options.videoSpine ? { spine: this.options.videoSpine } : {}),
    });
  }

  callerLiveSeats(userId: string) {
    return this.customer.callerLiveSeats(userId);
  }

  myUpcomingSessions(input: { userId: string; limit: number | null | undefined }) {
    return this.customer.myUpcomingSessions(input);
  }

  sessionCalendar(input: { userId: string; sessionId: string; now?: Date }) {
    return this.customer.sessionCalendar(input);
  }

  grantAudit(input: { limit: number | null | undefined; cursor?: string | null; certificateId?: string | null }) {
    return this.customer.grantAudit(input);
  }

  opsMetrics(input: { from: string; to: string }) {
    return this.customer.opsMetrics(input);
  }

  enrolments(input: { from: string; to: string }) {
    return this.customer.enrolments(input);
  }

  completionsByItem(input: { from: string; to: string; pathSlug?: string | null }) {
    return this.customer.completionsByItem(input);
  }

  async markCurriculumComplete(input: { userId: string; itemSlug: string }): Promise<ItemCompletionRecord> {
    const slug = input.itemSlug.trim();
    if (!hasCurriculumSlug(slug)) {
      throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    }
    const existingRows = await this.sql<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
      SELECT user_id, item_slug, completed_at FROM academy.cert_item_completions
       WHERE user_id = ${input.userId} AND item_slug = ${slug}
    `;
    const existing = existingRows[0]
      ? {
          userId: existingRows[0].user_id,
          itemSlug: existingRows[0].item_slug,
          completedAt: existingRows[0].completed_at,
        }
      : null;
    let decision: { record: ItemCompletionRecord; alreadyComplete: boolean };
    try {
      decision = decideItemComplete({ userId: input.userId, itemSlug: slug, existing });
    } catch (err) {
      this.mapCertErr(err);
    }
    if (decision.alreadyComplete) return decision.record;
    const rows = await this.sql<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
      INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at)
      VALUES (${input.userId}, ${slug}, now())
      ON CONFLICT (user_id, item_slug) DO NOTHING
      RETURNING user_id, item_slug, completed_at
    `;
    if (rows[0]) {
      return { userId: rows[0].user_id, itemSlug: rows[0].item_slug, completedAt: rows[0].completed_at };
    }
    // concurrent insert — re-read
    const again = await this.sql<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
      SELECT user_id, item_slug, completed_at FROM academy.cert_item_completions
       WHERE user_id = ${input.userId} AND item_slug = ${slug}
    `;
    return {
      userId: again[0]!.user_id,
      itemSlug: again[0]!.item_slug,
      completedAt: again[0]!.completed_at,
    };
  }

  private async completedSlugs(userId: string): Promise<Set<string>> {
    const rows = await this.sql<Array<{ item_slug: string }>>`
      SELECT item_slug FROM academy.cert_item_completions WHERE user_id = ${userId}
    `;
    return new Set(rows.map((r) => r.item_slug));
  }

  private async existingGrant(userId: string, certId: string): Promise<(CertGrantRecord & { publicId: string }) | null> {
    const key = certIdempotencyKey(userId, certId);
    const rows = await this.sql<Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string; public_id: string }>>`
      SELECT user_id, cert_id, granted_at, idempotency_key, public_id FROM academy.cert_grants
       WHERE user_id = ${userId} AND cert_id = ${certId}
    `;
    if (!rows[0]) return null;
    return {
      userId: rows[0].user_id,
      certId: rows[0].cert_id,
      grantedAt: rows[0].granted_at,
      idempotencyKey: rows[0].idempotency_key ?? key,
      publicId: rows[0].public_id,
    };
  }

  /**
   * Stage-2 — what the XP plane is doing, for the ops surface and /ready.
   * Reads the publisher; writes nothing, awards nothing.
   */
  certXpPlane(): CertXpPlaneStatus {
    return certXpPlaneStatus(this.certXp);
  }

  /**
   * D26-P1-C1 — perk plane honesty: identity SoT for real perks; invent money refuse-closed.
   */
  certPerkPlane(): CertPerkPlaneStatus {
    return certPerkPlaneStatus();
  }

  /**
   * Grant a certification, publish the XP it is worth, then surface real
   * identity perks (or refuse when the SoT is unreadable / invent is requested).
   *
   * TWO THINGS ABOUT THE ORDER, both deliberate:
   *
   * The grant is written FIRST and the award published after. A certification
   * the user earned is the durable fact; the XP is a consequence of it. If the
   * bus is down we keep the fact and report the missing consequence, rather
   * than refusing a cert somebody completed seven curriculum items for.
   *
   * The award is published on the already-granted path TOO. That is not a
   * double award — `xp-publish.ts` keys it on `academy.cert:cert:<user>:<cert>`,
   * a business key, and identity's `xp_events ON CONFLICT (idempotency_key) DO
   * NOTHING` drops the repeat. It is instead the recovery path: a grant whose
   * emit failed heals the next time anyone asks for that cert, with no outbox
   * table and no sweep.
   *
   * Perks are read AFTER XP publish and never invented: svc-identity is SoT.
   * Unpriced certs (`no_policy`) refuse the perk readout so the grant cannot
   * look like a granted perk or perk money.
   */
  async grantCert(input: {
    userId: string;
    certId: string;
  }): Promise<{ grant: CertGrantRecord & { publicId: string }; alreadyGranted: boolean; xp: CertXpEmitResult; perks: CertPerkOutcome }> {
    assertNoCertPerkMoneyAttachment(input);
    const cert = this.certDefinition(input.certId);
    if (!cert) this.refuseUnpublishedPath(input.certId);
    const completed = await this.completedSlugs(input.userId);
    const passed = await this.assessments.passedSlugs(input.userId);
    const existing = await this.existingGrant(input.userId, input.certId);
    let decision: { grant: CertGrantRecord; alreadyGranted: boolean };
    try {
      decision = decideGrant({
        userId: input.userId,
        cert,
        completedSlugs: completed,
        existing,
        passedAssessmentSlugs: passed,
      });
    } catch (err) {
      this.mapCertErr(err);
    }
    if (decision.alreadyGranted) {
      if (!existing) throw new AcademyError(`Grant marked already granted with no row for ${input.certId}`, 'academy.cert_invalid');
      const xp = await this.certXp.publishCertXp(decision.grant);
      const perks = await resolveCertPerkOutcome({ userId: input.userId, hostRights: this.hostRights, xp });
      return { grant: { ...decision.grant, publicId: existing.publicId }, alreadyGranted: true, xp, perks };
    }
    const publicId = randomPublicId();
    // ON CONFLICT DO NOTHING — concurrent second writer must not hardcode
    // alreadyGranted:false (UI would fire "just earned" twice; XP still safe).
    const rows = await this.sql<Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string; public_id: string }>>`
      INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key, public_id)
      VALUES (${decision.grant.userId}, ${decision.grant.certId}, ${decision.grant.grantedAt}, ${decision.grant.idempotencyKey}, ${publicId})
      ON CONFLICT (user_id, cert_id) DO NOTHING
      RETURNING user_id, cert_id, granted_at, idempotency_key, public_id
    `;
    if (rows.length === 0) {
      const raced = await this.existingGrant(input.userId, input.certId);
      if (!raced) {
        throw new AcademyError(`Grant race left no cert row for ${input.certId}`, 'academy.cert_invalid');
      }
      const xp = await this.certXp.publishCertXp(raced);
      const perks = await resolveCertPerkOutcome({ userId: input.userId, hostRights: this.hostRights, xp });
      return {
        grant: raced,
        alreadyGranted: alreadyGrantedAfterInsert(false),
        xp,
        perks,
      };
    }
    const grant: CertGrantRecord & { publicId: string } = {
      userId: rows[0]!.user_id,
      certId: rows[0]!.cert_id,
      grantedAt: rows[0]!.granted_at,
      idempotencyKey: rows[0]!.idempotency_key,
      publicId: rows[0]!.public_id,
    };
    const xp = await this.certXp.publishCertXp(grant);
    const perks = await resolveCertPerkOutcome({ userId: input.userId, hostRights: this.hostRights, xp });
    return {
      alreadyGranted: alreadyGrantedAfterInsert(true),
      grant,
      xp,
      perks,
    };
  }

  async myCertGrants(userId: string, requested?: number): Promise<Array<CertGrantRecord & { publicId: string }>> {
    const limit = assertMyCertsListLimit(requested);
    const rows = await this.sql<Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string; public_id: string }>>`
      SELECT user_id, cert_id, granted_at, idempotency_key, public_id FROM academy.cert_grants
       WHERE user_id = ${userId}
       ORDER BY granted_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      certId: r.cert_id,
      grantedAt: r.granted_at,
      idempotencyKey: r.idempotency_key,
      publicId: r.public_id,
    }));
  }

  async certProgress(input: { userId: string; certId: string }): Promise<ProgressReport> {
    const cert = this.certDefinition(input.certId);
    if (!cert) this.refuseUnpublishedPath(input.certId);
    const completed = await this.completedSlugs(input.userId);
    const passed = await this.assessments.passedSlugs(input.userId);
    const existing = await this.existingGrant(input.userId, input.certId);
    try {
      return progressReport({
        userId: input.userId,
        cert,
        completedSlugs: completed,
        existingGrant: existing,
        passedAssessmentSlugs: passed,
      });
    } catch (err) {
      this.mapCertErr(err);
    }
  }

  getAssessment(slug: string): AssessmentPublic {
    const def = this.assessments.definition(slug);
    if (!def) throw new AcademyError(`academy.assessment_unpublished slug=${slug}`, 'academy.assessment_unpublished');
    if (def.passMark === null) throw new AcademyError(`academy.pass_mark_unset slug=${slug}`, 'academy.pass_mark_unset');
    return {
      slug: def.slug,
      kind: def.kind,
      passMark: def.passMark,
      questions: def.questions.map((question) => ({
        id: question.id,
        prompt: question.prompt,
        kind: question.kind,
        points: question.points,
        choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
      })),
    };
  }

  submitAssessment(input: {
    userId: string;
    slug: string;
    answers: readonly { questionId: string; choiceId: string }[];
    clientAttemptId: string;
    now?: Date;
  }): Promise<AttemptRow> {
    return this.assessments.submit(input);
  }

  assessmentAttempts(userId: string, slug: string): Promise<AttemptRow[]> {
    return this.assessments.attempts(userId, slug);
  }

  /**
   * Public verification. Malformed and unknown ids throw the same error with
   * the same message. The query does not select the account id or the
   * grant reference, and this method does not log either.
   */
  async certVerify(publicId: string): Promise<{
    certId: string;
    title: string;
    grantedAt: Date;
    status: 'valid' | 'revoked';
    holderName?: string;
  }> {
    if (!isPublicId(publicId)) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
    const rows = await this.sql<
      Array<{ cert_id: string; granted_at: Date; status: string; holder_name: string | null; holder_consent_at: Date | null }>
    >`
      SELECT cert_id, granted_at, status, holder_name, holder_consent_at
        FROM academy.cert_grants
       WHERE public_id = ${publicId}
    `;
    const row = rows[0];
    if (!row) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
    const cert = this.certDefinition(row.cert_id);
    if (!cert) throw new AcademyError(`academy.certificate_unpublished cert=${row.cert_id}`, 'academy.certificate_unpublished');
    const status = row.status === 'valid' ? 'valid' : 'revoked';
    const body: { certId: string; title: string; grantedAt: Date; status: 'valid' | 'revoked'; holderName?: string } = {
      certId: row.cert_id,
      title: cert.title,
      grantedAt: row.granted_at,
      status,
    };
    if (row.holder_name !== null && row.holder_consent_at !== null) body.holderName = row.holder_name;
    return body;
  }

  async setCertHolderName(input: {
    userId: string;
    grantId?: string | null;
    publicId?: string | null;
    holderName: string | null;
    clientRequestId: string;
    now?: Date;
  }): Promise<{ publicId: string; holderName: string | null; consentAt: Date | null }> {
    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) throw new AcademyError('clientRequestId is required', 'academy.holder_name_invalid');
    const grantId = input.grantId?.trim() || null;
    const publicId = input.publicId?.trim() || null;
    if ((grantId ? 1 : 0) + (publicId ? 1 : 0) !== 1) {
      throw new AcademyError('pass grantId or publicId', 'academy.holder_name_invalid');
    }
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:holder-name`}, 0))`;
      const replay = await tx<Array<{ public_id: string; holder_name: string | null; consent_at: Date | null }>>`
        SELECT public_id, holder_name, consent_at
          FROM academy.cert_holder_name_requests
         WHERE user_id = ${input.userId} AND client_request_id = ${clientRequestId}
      `;
      if (replay[0]) {
        return { publicId: replay[0].public_id, holderName: replay[0].holder_name, consentAt: replay[0].consent_at };
      }
      const name = normaliseHolderName(input.holderName);
      const grants = await tx<Array<{ public_id: string }>>`
        SELECT public_id FROM academy.cert_grants
         WHERE user_id = ${input.userId}
           AND (
             (${publicId}::text IS NOT NULL AND public_id = ${publicId})
             OR (${grantId}::text IS NOT NULL AND cert_id = ${grantId})
           )
         FOR UPDATE
      `;
      const owned = grants[0];
      if (!owned) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
      const consentAt = name === null ? null : now;
      await tx`
        UPDATE academy.cert_grants
           SET holder_name = ${name}, holder_consent_at = ${consentAt}
         WHERE user_id = ${input.userId} AND public_id = ${owned.public_id}
      `;
      await tx`
        INSERT INTO academy.cert_holder_name_requests (user_id, client_request_id, public_id, holder_name, consent_at)
        VALUES (${input.userId}, ${clientRequestId}, ${owned.public_id}, ${name}, ${consentAt})
      `;
      return { publicId: owned.public_id, holderName: name, consentAt };
    });
  }

  private async liveInvite(roomId: string, userId: string): Promise<{ expiresAt: Date | null } | null> {
    const rows = await this.sql<Array<{ expires_at: Date | null }>>`
      SELECT expires_at FROM academy.room_invites WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
    return rows[0] ? { expiresAt: rows[0].expires_at } : null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private assertHost(ownerId: string, callerId: string, what: 'room' | 'session'): void {
    if (ownerId !== callerId) throw new AcademyError(`You do not host this ${what}`, 'academy.not_host');
  }

  /**
   * May this account host at all? (§4.1 `rank_thresholds.perks.lobbyHostRights`.)
   *
   * Asked once, on `createRoom`, and NOT on the operations that follow —
   * `invite`, `scheduleSession`, `startSession`, `endSession` and `updateScene`
   * all check `assertHost` against a room this account already owns.
   *
   * That asymmetry is deliberate. Rank can fall, and a host whose rank slipped
   * mid-residency must still be able to end the session they are running and
   * empty the room. Re-checking the perk on `endSession` would strand live
   * attendees in a session nobody is allowed to close — the perk gates opening
   * a NEW room, not operating one that exists.
   */
  private async assertMayHost(userId: string): Promise<void> {
    const perks = await this.hostRights.perksOf(userId);
    if (!mayHost(perks)) {
      throw new AcademyError(
        'Hosting a lobby is a rank perk — your rank does not carry lobby host rights yet (§4.1)',
        'academy.host_rights_required',
      );
    }
  }
}
