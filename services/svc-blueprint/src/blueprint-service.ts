import type { Sql } from 'postgres';
import { isSerializationFailure, transaction } from '@intafaced/db';
import type { EventBus } from '@intafaced/events';
import {
  blueprintProfileSchema,
  CARD_DIMENSIONS,
  type BlueprintContract,
  type BlueprintExport,
  type BlueprintProfile,
  type BlueprintRecord,
  type CardOpener,
  type CardRender,
  type CardShare,
  type CardSize,
  type CrewRole,
  type EraseReceipt,
  type MentorMatch,
  type OnboardInput,
  type OnboardOutput,
  type OpenerKind,
  type Placement,
  type Visibility,
} from '@intafaced/contracts';
import { composeCard } from './card/compose.js';
import { assertZeroPiiSurface } from './attestations/zero-pii.js';
import { mayViewCard } from './visibility.js';
import type { CardRenderer } from './card/card-renderer.js';
import { EngineProtocolError, EngineUnavailableError, type BlueprintRequest, type NeuralEngineClient } from './engine/neural-engine.js';
import { deterministicUuid } from './deterministic.js';
import { chooseCrew, crewName, newCrewId, rankCrews, type CrewCandidate, type MatchableProfile } from './matching/crew-matching.js';
import { shortlistMentors, type MentorCandidate, type MentorProfile } from './matching/mentor-matching.js';
import { setBlueprintSpanAttribute, withBlueprintSpan } from './tracing.js';

/**
 * svc-blueprint — THE IDENTITY BLUEPRINT (§7.1).
 *
 * The onboarding intelligence is the **Neural Engine**, consumed as an internal
 * service over an HTTP contract (Doctrine §0.7). This service owns the
 * `NeuralEngineClient` interface, the profile it returns, crew matching, mentor
 * shortlists, and the two things §7.2 promises the user: **export** and **hard
 * delete**.
 *
 * ── Three properties this file is built around ──────────────────────────────
 *
 * 1. **No half-written Blueprint.** The engine is called *before* the
 *    transaction opens. If it fails, nothing is written — not a blueprint row
 *    with a null profile, not a crew membership waiting for one. §7.2's failure
 *    path is enforced by ordering, not by cleanup.
 *
 * 2. **Placement is reproducible.** Every input to a placement decision is a
 *    pure function of profiles and crew ids (`matching/crew-matching.ts`). The
 *    only clock in this file writes `ts` columns; none of them is read back by
 *    anything that decides where a person goes.
 *
 * 3. **The profile never leaves except to its owner.** It is not on an event
 *    payload, not on a span, not in an error message, not in a log line. It
 *    goes into `blueprints.profile` and comes back out through `export()` and
 *    the authorised read on the router. §10.
 *
 * ── What this service is not ────────────────────────────────────────────────
 * It holds no balances and posts no ledger transactions. Nothing in this
 * package imports the ledger client, and nothing should: a crew is a social
 * object, and `crews.xp` is a count.
 *
 * (Said without naming the package, deliberately. The DoD gate classifies a
 * file as a money path by searching for that import specifier, so a comment
 * asserting its absence would classify this file as touching money — and the
 * gate would then pass only via its "some test exists nearby" fallback. A gate
 * that passes by coincidence is not a gate.)
 */

export class BlueprintError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'blueprint.not_found'
      | 'blueprint.crew_not_found'
      | 'blueprint.crew_full'
      | 'blueprint.engine_unavailable'
      | 'blueprint.engine_protocol'
      | 'blueprint.invalid_profile'
      | 'blueprint.crew_capacity_unset'
      | 'blueprint.mentor_shortlist_unset'
      | 'blueprint.season_unset'
      | 'blueprint.share_limit_unset'
      | 'blueprint.share_limit_reached'
      | 'blueprint.opens_list_limit_unset'
      | 'blueprint.open_log_unavailable',
  ) {
    super(message);
    this.name = 'BlueprintError';
  }
}

/** Owner-published crew size. Blank / non-integer / out of 2..24 refuses. Never invent 6. */
export function publishedCrewCapacity(value: number | undefined): number {
  if (value === undefined || typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 24) {
    throw new BlueprintError(
      'BLUEPRINT_CREW_CAPACITY is unset — owner must publish a crew size (never invent 6)',
      'blueprint.crew_capacity_unset',
    );
  }
  return value;
}

/** Owner-published shortlist length. Blank / non-integer / out of 1..10 refuses. Never invent 3. */
export function publishedMentorShortlistSize(value: number | undefined): number {
  if (value === undefined || typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new BlueprintError(
      'BLUEPRINT_MENTOR_SHORTLIST_SIZE is unset — owner must publish a shortlist length (never invent 3)',
      'blueprint.mentor_shortlist_unset',
    );
  }
  return value;
}

/** Owner-published season. Blank / non-integer / below 1 refuses. Never invent 1. */
export function publishedSeason(value: number | undefined): number {
  if (value === undefined || typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BlueprintError('BLUEPRINT_SEASON is unset — owner must publish a crew season (never invent 1)', 'blueprint.season_unset');
  }
  return value;
}

/** Active shares one account may hold (MC-blueprint-01). Blank refuses. 0 is a deliberate cap. Never invent a count. */
export function publishedSharesPerOwner(value: number | undefined): number {
  if (value === undefined || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BlueprintError(
      'BLUEPRINT_SHARES_PER_OWNER is unset — owner must publish a share limit (never invent one)',
      'blueprint.share_limit_unset',
    );
  }
  return value;
}

/** How many opener rows one read returns (MC-blueprint-01). Blank refuses. 0 is a deliberate empty page. Never invent a page size. */
export function publishedOpensListLimit(value: number | undefined): number {
  if (value === undefined || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BlueprintError(
      'BLUEPRINT_OPENS_LIST_LIMIT is unset — owner must publish an openers list limit (never invent one)',
      'blueprint.opens_list_limit_unset',
    );
  }
  return value;
}

const CARD_NOT_FOUND = 'No Blueprint to render a card for — run the Blueprint session first';

/**
 * Derived crew id at one step of a start-fresh placement.
 *
 * Step 0 is `newCrewId`. Step 1 is the historical `start-fresh` salt. From
 * step 2 the salt is `start-fresh:2`, `start-fresh:3`, and so on. The walk
 * does not stop at `start-fresh:7`.
 */
function startFreshCrewId(season: number, userId: string, step: number): string {
  if (step === 0) return newCrewId(season, userId);
  const salt = step === 1 ? 'start-fresh' : `start-fresh:${step}`;
  return deterministicUuid(`crew:s${season}:${salt}`, userId);
}

export interface BlueprintServiceOptions {
  /** Owner-published capacity for crews this service forms. Stored per crew. Unset refuses. */
  crewCapacity?: number;
  mentorShortlistSize?: number;
  season?: number;
  /** Active shares per account (MC-blueprint-01). Unset refuses create. */
  sharesPerOwner?: number;
  /** Opener rows returned for one share (MC-blueprint-01). Unset refuses the list. */
  opensListLimit?: number;
}

interface BlueprintRow {
  id: string;
  user_id: string;
  engine_version: string;
  profile: BlueprintProfile;
  card_asset_url: string | null;
  visibility: Visibility;
  mentor_available: boolean;
  created_at: Date;
}

export class BlueprintService implements BlueprintContract {
  private readonly crewCapacity: number | undefined;
  private readonly mentorShortlistSize: number | undefined;
  private readonly season: number | undefined;
  private readonly sharesPerOwner: number | undefined;
  private readonly opensListLimit: number | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly engine: NeuralEngineClient,
    private readonly bus: EventBus,
    /**
     * The card rasterizer. Required rather than optional, and defaulted by the
     * caller to `UnconfiguredCardRenderer` — so a deployment without a renderer
     * is an explicit choice at the composition root (`index.ts`) rather than an
     * `undefined` this class quietly works around.
     */
    private readonly renderer: CardRenderer,
    options: BlueprintServiceOptions = {},
  ) {
    this.crewCapacity = options.crewCapacity;
    this.mentorShortlistSize = options.mentorShortlistSize;
    this.season = options.season;
    this.sharesPerOwner = options.sharesPerOwner;
    this.opensListLimit = options.opensListLimit;
  }

  // ── Onboarding (§7.1 flow) ─────────────────────────────────────────────────

  /**
   * The whole flow: session → engine → persist → crew placement → mentor
   * shortlist.
   *
   * Deliberately one call. The §7.2 target is end-to-end ("signup → session →
   * reveal → crew placement < 3 minutes"), and splitting this into four
   * round-trips would spend most of that budget on latency between steps that
   * have nothing to wait for.
   *
   * Re-running it for the same user is safe: the Blueprint is upserted on
   * `user_id` and the placement short-circuits to the existing crew. That is
   * the "same input, same placement" guarantee at the service level; the
   * scoring function guarantees it at the algorithmic level.
   */
  async onboard(input: OnboardInput): Promise<OnboardOutput> {
    return withBlueprintSpan('blueprint.onboard', { stage: 'session', userId: input.userId }, async () => {
      // ── 1 · The engine, OUTSIDE any transaction ──────────────────────────
      // If this throws, no row was ever written and none needs cleaning up.
      // Holding a transaction open across a 20-second network call would also
      // pin a connection and a snapshot for the duration, which is how a slow
      // engine turns into a database incident.
      const result = await this.deriveProfile(input);

      // Defence in depth: the HTTP adapter validated the engine's response and
      // the mock validates its own output. Validating again here means a future
      // adapter that forgets cannot write an unreadable profile into a column
      // that four other services read.
      const parsed = blueprintProfileSchema.safeParse(result.profile);
      if (!parsed.success) {
        throw new BlueprintError('Neural Engine returned a profile this service cannot store', 'blueprint.invalid_profile');
      }
      const profile = parsed.data;

      // ── 2 · Persist + place, atomically ──────────────────────────────────
      const written = await transaction(
        this.sql,
        async (tx) => {
          const blueprint = await this.upsertBlueprint(tx, input, result.engineVersion, profile);
          const placement = await this.placeInCrew(tx, input.userId, profile);
          const mentors = await this.writeMentorShortlist(tx, input.userId, profile);
          return { blueprint, placement, mentors };
        },
        // Serializable: placement reads every open crew's membership and then
        // inserts a membership, so two people onboarding at once are exactly
        // the read-write conflict this level exists to detect. Without it both
        // could see the same crew at 5/6 and both join.
        { isolation: 'serializable', maxAttempts: 5 },
      );

      // ── 3 · Announce, AFTER the commit ───────────────────────────────────
      // Publishing inside the transaction would announce a Blueprint that a
      // serialization failure then rolled back — and svc-identity would be
      // holding a blueprint_id pointing at nothing.
      await this.announce(written.blueprint, written.placement, input.userId);

      return {
        blueprint: written.blueprint,
        placement: written.placement,
        mentors: written.mentors,
      };
    });
  }

  /** Call the engine and translate its failures into this service's taxonomy. */
  private async deriveProfile(input: OnboardInput): Promise<{ engineVersion: string; profile: BlueprintProfile }> {
    return withBlueprintSpan('blueprint.engine', { stage: 'engine', userId: input.userId }, async (span) => {
      const request: BlueprintRequest = {
        requestId: crypto.randomUUID(),
        locale: input.locale,
        responses: input.responses,
        ...(input.birthData ? { birthData: input.birthData } : {}),
      };

      try {
        const result = await this.engine.profile(request);
        span.setAttribute('intafaced.engineVersion', result.engineVersion);
        span.setAttribute('intafaced.latencyMs', result.latencyMs);
        return { engineVersion: result.engineVersion, profile: result.profile };
      } catch (err) {
        if (err instanceof EngineUnavailableError) {
          throw new BlueprintError('The Neural Engine is unavailable — no Blueprint was created', 'blueprint.engine_unavailable');
        }
        if (err instanceof EngineProtocolError) {
          throw new BlueprintError('The Neural Engine returned an unusable profile', 'blueprint.engine_protocol');
        }
        throw err;
      }
      // Note what is NOT in either message: the session, the birth data, or any
      // part of the profile. An error string is logged, aggregated and often
      // shown to a user (§10).
    });
  }

  private async upsertBlueprint(tx: Sql, input: OnboardInput, engineVersion: string, profile: BlueprintProfile): Promise<BlueprintRecord> {
    const rows = await tx<BlueprintRow[]>`
      INSERT INTO blueprint.blueprints (user_id, engine_version, profile, visibility, mentor_available)
      VALUES (
        ${input.userId}, ${engineVersion}, ${this.sql.json(profile as never)},
        ${input.visibility}, ${input.mentorAvailable}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        engine_version   = EXCLUDED.engine_version,
        profile          = EXCLUDED.profile,
        visibility       = EXCLUDED.visibility,
        mentor_available = EXCLUDED.mentor_available,
        updated_at       = now()
      RETURNING id, user_id, engine_version, profile, card_asset_url, visibility, mentor_available, created_at
    `;

    const row = rows[0];
    if (!row) throw new BlueprintError('Blueprint write returned no row', 'blueprint.not_found');
    return toBlueprintRecord(row);
  }

  // ── Crew matching (§7.1) ───────────────────────────────────────────────────

  /**
   * Place a user in a crew, or form one.
   *
   * The short-circuit on an existing membership is the service-level half of
   * the determinism guarantee. The other half — that scoring the same crews
   * twice ranks them identically — lives in `rankCrews`, is pure, and is tested
   * without a database.
   *
   * A `match_run` is written on every call, including the short-circuit, because
   * §7.1 makes it the audit trail of *runs*, not of *changes*. "Why am I in this
   * crew" should be answerable from the row, and a re-run that changed nothing
   * is itself a fact worth having.
   */
  private async placeInCrew(tx: Sql, userId: string, profile: BlueprintProfile): Promise<Placement> {
    const season = publishedSeason(this.season);
    const candidates = await this.loadCandidates(tx, season);
    const ranked = rankCrews(profile, candidates);
    const choice = chooseCrew(profile, candidates);

    const existing = await tx<Array<{ crew_id: string }>>`
      SELECT crew_id FROM blueprint.crew_members WHERE user_id = ${userId}
    `;

    // The audit trail records EVERY open crew that was scored, not just the
    // ones that cleared the threshold — "why was I not put with them" is the
    // question a match run has to be able to answer.
    const scores: Record<string, number> = {};
    for (const scored of ranked) scores[scored.crewId] = scored.score;
    const candidateSummary = candidates.map((c) => ({ crewId: c.crewId, size: c.members.length }));

    // Already placed: the crew a user is in does not change because they
    // re-ran onboarding. Moving them would break every crew's composition to
    // no one's benefit, and would make "re-run and land in the same crew"
    // false by design.
    const current = existing[0];
    if (current) {
      const crew = await this.loadCrew(tx, current.crew_id);
      const matchRunId = await this.recordMatchRun(tx, userId, candidateSummary, scores, current.crew_id);
      return {
        crewId: crew.id,
        crewName: crew.name,
        score: scores[current.crew_id] ?? 0,
        matchRunId,
        crewFormed: false,
      };
    }

    if (choice) {
      await this.insertMembership(tx, choice.crewId, userId, profile.crewRole);
      const crew = await this.loadCrew(tx, choice.crewId);
      const matchRunId = await this.recordMatchRun(tx, userId, candidateSummary, scores, choice.crewId);
      return { crewId: crew.id, crewName: crew.name, score: choice.score, matchRunId, crewFormed: false };
    }

    // No crew is open, or none is better than starting fresh — form one. The id is derived
    // from the season and this user, so a retry of this exact placement forms
    // the same crew rather than stranding an empty one.
    //
    // formCrew returns the existing row for whatever id it is given. An id that
    // already has other members is not a fresh start: joining it reopens a crew
    // chooseCrew rejected. Walk newCrewId, then start-fresh, start-fresh:2,
    // start-fresh:3, and onward. Each step reads membershipCount and stops at
    // the first zero. An empty derived crew is still reused. A member without
    // a blueprint still counts. This path does not raise blueprint.crew_full.
    const crew = await this.formStartFreshCrew(tx, season, userId);
    await this.insertMembership(tx, crew.id, userId, profile.crewRole);
    const matchRunId = await this.recordMatchRun(tx, userId, candidateSummary, scores, crew.id);

    return { crewId: crew.id, crewName: crew.name, score: 0, matchRunId, crewFormed: true };
  }

  /**
   * Every crew in the current season, with its members' matchable axes.
   *
   * `members` keeps only people we can score (`b.profile IS NOT NULL`).
   * `occupied` counts every `crew_members` row, the same set
   * `insertMembership` enforces capacity against, so a member without a
   * blueprint still occupies a seat. `ORDER BY c.id` makes the row order
   * itself stable, which matters less than the tie-break in `rankCrews`
   * but costs nothing and removes a variable.
   */
  private async loadCandidates(tx: Sql, season: number): Promise<CrewCandidate[]> {
    const rows = await tx<Array<{ crew_id: string; capacity: number; occupied: number; members: MatchableProfile[] }>>`
      SELECT
        c.id AS crew_id,
        c.capacity,
        COUNT(m.user_id)::int AS occupied,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'crewRole',        b.profile ->> 'crewRole',
              'decisionStyle',   b.profile ->> 'decisionStyle',
              'riskTemperament', b.profile ->> 'riskTemperament',
              'energyRhythm',    b.profile ->> 'energyRhythm',
              'learningMode',    b.profile ->> 'learningMode'
            )
            ORDER BY m.user_id
          ) FILTER (WHERE b.profile IS NOT NULL),
          '[]'::jsonb
        ) AS members
      FROM blueprint.crews c
      LEFT JOIN blueprint.crew_members m ON m.crew_id = c.id
      LEFT JOIN blueprint.blueprints  b ON b.user_id = m.user_id
      WHERE c.season = ${season}
      GROUP BY c.id, c.capacity
      ORDER BY c.id
    `;

    return rows.map((row) => ({
      crewId: row.crew_id,
      capacity: row.capacity,
      occupied: row.occupied,
      members: row.members,
    }));
  }

  /**
   * Membership rows for this id, including a member who has no blueprint.
   *
   * Zero when the crew does not exist yet. This is the same set
   * `insertMembership` enforces capacity against, so a seat with no profile
   * still makes the derived crew occupied.
   */
  private async membershipCount(tx: Sql, crewId: string): Promise<number> {
    const counted = await tx<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM blueprint.crew_members WHERE crew_id = ${crewId}
    `;
    return counted[0]?.count ?? 0;
  }

  /**
   * Form the first derived start-fresh crew whose membership count is zero.
   *
   * Step 0 is the founder id. Later steps are `start-fresh`, `start-fresh:2`,
   * `start-fresh:3`, and so on. Each step reads `membershipCount` before
   * forming, and the first zero wins. An empty row is reused. A crew that
   * already has members, including a member with no blueprint, is left alone.
   */
  private async formStartFreshCrew(tx: Sql, season: number, userId: string): Promise<{ id: string; name: string }> {
    for (let step = 0; ; step += 1) {
      const crewId = startFreshCrewId(season, userId, step);
      if ((await this.membershipCount(tx, crewId)) > 0) continue;
      return this.formCrew(tx, crewId, season);
    }
  }

  /**
   * Insert a membership, enforcing capacity.
   *
   * The crew row is locked before the count is taken. Under `serializable` the
   * conflict would be detected anyway, but the lock turns "two people raced and
   * one transaction aborted" into "two people queued" — and, more importantly,
   * makes the check correct even if a future caller runs this at a weaker
   * isolation level.
   */
  private async insertMembership(tx: Sql, crewId: string, userId: string, role: CrewRole): Promise<void> {
    const crews = await tx<Array<{ capacity: number }>>`
      SELECT capacity FROM blueprint.crews WHERE id = ${crewId} FOR UPDATE
    `;
    const crew = crews[0];
    if (!crew) throw new BlueprintError(`Crew ${crewId} does not exist`, 'blueprint.crew_not_found');

    const counted = await tx<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM blueprint.crew_members WHERE crew_id = ${crewId}
    `;
    const size = counted[0]?.count ?? 0;

    // Already a member — idempotent, and not a capacity breach.
    const mine = await tx<Array<{ user_id: string }>>`
      SELECT user_id FROM blueprint.crew_members WHERE crew_id = ${crewId} AND user_id = ${userId}
    `;
    if (mine[0]) return;

    if (size >= crew.capacity) {
      throw new BlueprintError(`Crew ${crewId} is full (${size}/${crew.capacity})`, 'blueprint.crew_full');
    }

    await tx`
      INSERT INTO blueprint.crew_members (crew_id, user_id, role)
      VALUES (${crewId}, ${userId}, ${role})
      ON CONFLICT (crew_id, user_id) DO NOTHING
    `;
  }

  /**
   * Form a crew at a derived id.
   *
   * The name is derived from the id, so it survives a restore that a counter
   * would not. The collision branch exists because the name vocabulary is
   * finite: when a season already holds the derived name, the id's first bytes
   * disambiguate — still deterministic, still the same name on every retry.
   */
  private async formCrew(tx: Sql, crewId: string, season: number): Promise<{ id: string; name: string }> {
    const existing = await tx<Array<{ id: string; name: string }>>`
      SELECT id, name FROM blueprint.crews WHERE id = ${crewId}
    `;
    if (existing[0]) return existing[0];

    const capacity = publishedCrewCapacity(this.crewCapacity);
    const base = crewName(crewId);
    const taken = await tx<Array<{ id: string }>>`
      SELECT id FROM blueprint.crews WHERE name = ${base} AND season = ${season}
    `;
    const name = taken.length > 0 ? `${base} ${crewId.slice(0, 4).toUpperCase()}` : base;

    const rows = await tx<Array<{ id: string; name: string }>>`
      INSERT INTO blueprint.crews (id, name, season, capacity)
      VALUES (${crewId}, ${name}, ${season}, ${capacity})
      ON CONFLICT (id) DO NOTHING
      RETURNING id, name
    `;

    const row = rows[0] ?? (await this.loadCrew(tx, crewId));
    return { id: row.id, name: row.name };
  }

  private async loadCrew(tx: Sql, crewId: string): Promise<{ id: string; name: string }> {
    const rows = await tx<Array<{ id: string; name: string }>>`
      SELECT id, name FROM blueprint.crews WHERE id = ${crewId}
    `;
    const row = rows[0];
    if (!row) throw new BlueprintError(`Crew ${crewId} does not exist`, 'blueprint.crew_not_found');
    return row;
  }

  private async recordMatchRun(
    tx: Sql,
    userId: string,
    candidates: ReadonlyArray<{ crewId: string; size: number }>,
    scores: Record<string, number>,
    placedCrewId: string | null,
  ): Promise<string> {
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO blueprint.match_runs (user_id, candidates, scores, placed_crew_id)
      VALUES (${userId}, ${this.sql.json(candidates as never)}, ${this.sql.json(scores as never)}, ${placedCrewId})
      RETURNING id
    `;
    const row = rows[0];
    if (!row) throw new BlueprintError('Match run write returned no row', 'blueprint.not_found');
    return row.id;
  }

  /**
   * Public join, for an invite or an operator move rather than a match run.
   *
   * Its own transaction, and the same capacity check — §7.2 says a full crew
   * does not take another member, and a second code path that forgot would make
   * that statement false for the one case (invites) where people care most.
   */
  async joinCrew(crewId: string, userId: string, role: CrewRole): Promise<void> {
    await transaction(
      this.sql,
      async (tx) => {
        await this.insertMembership(tx, crewId, userId, role);
      },
      { isolation: 'serializable', maxAttempts: 5 },
    );
  }

  // ── Mentor shortlist (§7.1) ────────────────────────────────────────────────

  private async writeMentorShortlist(tx: Sql, studentId: string, profile: BlueprintProfile): Promise<MentorMatch[]> {
    const rows = await tx<Array<{ user_id: string; profile: MentorProfile }>>`
      SELECT user_id, profile
        FROM blueprint.blueprints
       WHERE mentor_available = true AND user_id <> ${studentId}
       ORDER BY user_id
    `;

    const candidates: MentorCandidate[] = rows.map((r) => ({ userId: r.user_id, profile: r.profile }));
    const shortlist = shortlistMentors(studentId, profile, candidates, publishedMentorShortlistSize(this.mentorShortlistSize));

    const written: MentorMatch[] = [];
    for (const entry of shortlist) {
      // Upsert on the pair: a re-run refreshes the score rather than stacking a
      // second row that would then appear twice in the same shortlist.
      await tx`
        INSERT INTO blueprint.mentor_matches (student_id, mentor_id, fit_score, status)
        VALUES (${studentId}, ${entry.mentorId}, ${entry.fitScore}, 'shortlisted')
        ON CONFLICT (student_id, mentor_id) DO UPDATE SET fit_score = EXCLUDED.fit_score, updated_at = now()
      `;
      written.push({ studentId, mentorId: entry.mentorId, fitScore: entry.fitScore, status: 'shortlisted' });
    }

    return written;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async get(input: { userId: string }): Promise<BlueprintRecord | null> {
    const rows = await this.sql<BlueprintRow[]>`
      SELECT id, user_id, engine_version, profile, card_asset_url, visibility, mentor_available, created_at
        FROM blueprint.blueprints WHERE user_id = ${input.userId}
    `;
    const row = rows[0];
    return row ? toBlueprintRecord(row) : null;
  }

  // ── The share card (§7.1 acquisition artifact, §7.2 exit criterion) ────────

  /**
   * Compose the caller's share card, and raster it if a renderer exists.
   *
   * Three properties, each of which is a decision:
   *
   * 1. **The card is derived on read, never stored.** It is a pure function of
   *    the profile and the crew name (`card/compose.ts`), so a stored copy would
   *    be a second copy of personal data that erasure has to chase and that goes
   *    stale the moment a user re-runs onboarding. What IS stored is the hosted
   *    PNG's URL, because that is a fact about the outside world we cannot
   *    recompute.
   *
   * 2. **The vector card always succeeds; only the raster can be absent.** A
   *    missing renderer returns the `unavailable` arm with a code — it does not
   *    throw, does not degrade the SVG, and above all does not invent a URL.
   *    See `card/card-renderer.ts` for why that is the sharpest rule here.
   *
   * 3. **`card_asset_url` is written only on a real render, and only for the
   *    portrait.** §7.1's schema has one column and portrait is the primary
   *    artifact; the landscape unfurl is rendered on demand. Writing the column
   *    on an `unavailable` result would persist a lie, and clearing it on one
   *    would throw away a perfectly good URL from the last time the renderer was
   *    up.
   */
  async card(input: { userId: string; size: CardSize }): Promise<CardRender> {
    return withBlueprintSpan('blueprint.card', { stage: 'card', userId: input.userId }, async (span) => {
      const blueprint = await this.get(input);
      if (!blueprint) {
        throw new BlueprintError('No Blueprint to render a card for — run the Blueprint session first', 'blueprint.not_found');
      }

      const render = await this.renderCard(blueprint, input.size);
      setBlueprintSpanAttribute(span, 'cardRaster', render.raster.status);

      if (render.raster.status === 'rendered' && input.size === 'portrait') {
        await this.sql`
          UPDATE blueprint.blueprints SET card_asset_url = ${render.raster.url}, updated_at = now()
           WHERE user_id = ${blueprint.userId}
        `;
      }

      return render;
    });
  }

  /**
   * Visibility-gated card read (`packages/auth` scopes: reading someone else's
   * is governed by `blueprints.visibility` on top of `blueprint:read`).
   *
   * Self is the owner path (`card`) — it may persist a real portrait PNG URL.
   * Any other viewer is a read: compose + raster, never a write, so a stranger
   * hitting `cardOf` cannot stamp `card_asset_url`. Denied and missing throw
   * the same `blueprint.not_found` — a private row is not enumerable.
   *
   * A `shareId` (MC-blueprint-01) names one share. The revoked check, the
   * open-log write and the card render commit together, with no cached card.
   * The share stays `FOR UPDATE` through the render. After the card is
   * composed, `revoked_at` is read again under that lock. If it is revoked,
   * this throws `blueprint.not_found` and the transaction rolls back, so no
   * new open row remains. A revoke that commits first is the same
   * `blueprint.not_found`. The share's stored size is the card that is returned.
   *
   * This is still authenticated. It is not a public unfurl URL (those need a
   * revocable token + object storage — ops.social-promotion / Class X).
   */
  async cardFor(input: { viewerId: string; subjectUserId?: string; size: CardSize; shareId?: string }): Promise<CardRender> {
    return withBlueprintSpan('blueprint.cardFor', { stage: 'card', userId: input.viewerId }, async (span) => {
      if (input.shareId) {
        const render = await this.openThroughShare(input.viewerId, input.shareId, input.subjectUserId);
        setBlueprintSpanAttribute(span, 'cardRaster', render.raster.status);
        return render;
      }

      if (!input.subjectUserId) {
        throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
      }
      if (input.viewerId === input.subjectUserId) {
        return this.card({ userId: input.viewerId, size: input.size });
      }

      const blueprint = await this.visibleBlueprint(input.viewerId, input.subjectUserId);
      const render = await this.renderCard(blueprint, input.size);
      setBlueprintSpanAttribute(span, 'cardRaster', render.raster.status);
      return render;
    });
  }

  /**
   * One active share per (owner, size). A repeat returns that share, so a lost
   * reply cannot create a second. A revoked size may be shared again.
   * Open-log retention has no refusal code in MC-blueprint-01 and no sweep:
   * rows stay until erase. This does not invent a window.
   */
  async createShare(input: { userId: string; size: CardSize }): Promise<CardShare> {
    const limit = publishedSharesPerOwner(this.sharesPerOwner);
    return withBlueprintSpan('blueprint.shares.create', { stage: 'share', userId: input.userId }, async () =>
      transaction(this.sql, async (tx) => {
        const owner = await tx<Array<{ id: string }>>`
          SELECT id FROM blueprint.blueprints WHERE user_id = ${input.userId} FOR UPDATE
        `;
        if (!owner[0]) throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');

        const existing = await tx<ShareRow[]>`
          SELECT id, owner_user_id, size, created_at, revoked_at
            FROM blueprint.card_shares
           WHERE owner_user_id = ${input.userId} AND size = ${input.size} AND revoked_at IS NULL
        `;
        const already = existing[0];
        if (already) return this.toCardShare(tx, already);

        const active = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n
            FROM blueprint.card_shares
           WHERE owner_user_id = ${input.userId} AND revoked_at IS NULL
        `;
        if ((active[0]?.n ?? 0) >= limit) {
          throw new BlueprintError(
            'No active share slot is left under the published shares-per-owner limit',
            'blueprint.share_limit_reached',
          );
        }

        const inserted = await tx<ShareRow[]>`
          INSERT INTO blueprint.card_shares (owner_user_id, size)
          VALUES (${input.userId}, ${input.size})
          RETURNING id, owner_user_id, size, created_at, revoked_at
        `;
        const row = inserted[0];
        if (!row) {
          throw new BlueprintError('The share could not be recorded', 'blueprint.share_limit_reached');
        }
        return this.toCardShare(tx, row);
      }),
    );
  }

  async listShares(input: { userId: string }): Promise<CardShare[]> {
    return withBlueprintSpan('blueprint.shares.list', { stage: 'share', userId: input.userId }, async () => {
      const rows = await this.sql<ShareRow[]>`
        SELECT id, owner_user_id, size, created_at, revoked_at
          FROM blueprint.card_shares
         WHERE owner_user_id = ${input.userId}
         ORDER BY created_at DESC, id DESC
      `;
      const listed: CardShare[] = [];
      for (const row of rows) listed.push(await this.toCardShare(this.sql, row));
      return listed;
    });
  }

  /** Revoking a revoked share returns the stored row. Someone else's share is not found. */
  async revokeShare(input: { userId: string; shareId: string }): Promise<CardShare> {
    return withBlueprintSpan('blueprint.shares.revoke', { stage: 'share', userId: input.userId }, async () =>
      transaction(this.sql, async (tx) => {
        const updated = await tx<ShareRow[]>`
          UPDATE blueprint.card_shares
             SET revoked_at = now()
           WHERE id = ${input.shareId} AND owner_user_id = ${input.userId} AND revoked_at IS NULL
          RETURNING id, owner_user_id, size, created_at, revoked_at
        `;
        const fresh = updated[0];
        if (fresh) return this.toCardShare(tx, fresh);

        const stored = await tx<ShareRow[]>`
          SELECT id, owner_user_id, size, created_at, revoked_at
            FROM blueprint.card_shares
           WHERE id = ${input.shareId} AND owner_user_id = ${input.userId}
        `;
        const row = stored[0];
        if (!row) throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
        return this.toCardShare(tx, row);
      }),
    );
  }

  /**
   * Opener rows for the owner's own share. Newest first. No account id.
   * A blank list limit refuses before any read. A share the caller does not
   * own is the same not-found as a share that does not exist.
   */
  async shareOpeners(input: { userId: string; shareId: string }): Promise<CardOpener[]> {
    const limit = publishedOpensListLimit(this.opensListLimit);
    return withBlueprintSpan('blueprint.shares.openers', { stage: 'share', userId: input.userId }, async () => {
      const owned = await this.sql<Array<{ id: string }>>`
        SELECT id FROM blueprint.card_shares WHERE id = ${input.shareId} AND owner_user_id = ${input.userId}
      `;
      if (!owned[0]) throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
      if (limit === 0) return [];
      const rows = await this.sql<OpenerRow[]>`
        SELECT CASE
                 WHEN EXISTS (
                   SELECT 1
                     FROM blueprint.crew_members viewer
                     JOIN blueprint.crew_members owner_member ON owner_member.crew_id = viewer.crew_id
                    WHERE viewer.user_id = o.viewer_user_id
                      AND owner_member.user_id = ${input.userId}
                 ) THEN 'crew member'
                 ELSE 'signed-in account'
               END AS kind,
               o.first_opened, o.last_opened, o.open_count
          FROM blueprint.card_opens o
          JOIN blueprint.card_shares s ON s.id = o.share_id
         WHERE s.id = ${input.shareId} AND s.owner_user_id = ${input.userId}
         ORDER BY o.last_opened DESC, o.first_opened DESC
         LIMIT ${limit}
      `;
      return rows.map(toOpener);
    });
  }

  /**
   * Change the caller's own visibility. Write-once-at-onboard would make the
   * column decorative for anyone who accepted the default (`private`).
   */
  async setVisibility(input: { userId: string; visibility: Visibility }): Promise<BlueprintRecord> {
    return withBlueprintSpan('blueprint.setVisibility', { stage: 'visibility', userId: input.userId }, async () => {
      const rows = await this.sql<BlueprintRow[]>`
        UPDATE blueprint.blueprints
           SET visibility = ${input.visibility}, updated_at = now()
         WHERE user_id = ${input.userId}
        RETURNING id, user_id, engine_version, profile, card_asset_url, visibility, mentor_available, created_at
      `;
      const row = rows[0];
      if (!row) {
        throw new BlueprintError('No Blueprint to update — run the Blueprint session first', 'blueprint.not_found');
      }
      return toBlueprintRecord(row);
    });
  }

  /**
   * Compose the card and ask the renderer for a raster. **Writes nothing.**
   *
   * Split out of `card()` so `export()` can carry the same artifact without
   * inheriting the side effect. `export` is a tRPC `.query()` — retried,
   * prefetched, and cached by any sane client — and a read path that persists a
   * column on every call is a write path wearing a read's clothes. `card()` writes
   * `card_asset_url`, and so does an owner's read of their own share (a real
   * portrait render only, inside that share transaction). A stranger's read does not.
   */
  private async renderCard(blueprint: BlueprintRecord, size: CardSize, sql?: Sql): Promise<CardRender> {
    const db = sql ?? this.sql;
    // The crew name is the only thing on the card this service does not already
    // hold in the profile. Absent rows mean "unplaced", which is a real state
    // the card renders honestly rather than a reason to fail.
    const placed = await db<Array<{ name: string; season: number }>>`
      SELECT c.name, c.season
        FROM blueprint.crew_members m
        JOIN blueprint.crews c ON c.id = m.crew_id
       WHERE m.user_id = ${blueprint.userId}
    `;
    const crew = placed[0] ?? null;

    const svg = composeCard({ profile: blueprint.profile, crewName: crew?.name ?? null, season: crew?.season ?? null }, size);
    const { width, height } = CARD_DIMENSIONS[size];

    const raster = await this.renderer.rasterize({ svg, size, width, height, blueprintId: blueprint.id });

    const shareMode = raster.status === 'rendered' ? 'png' : 'svg';
    const render: CardRender = { size, width, height, svg, raster, shareMode };
    assertZeroPiiSurface('card.render', render);
    return render;
  }

  /**
   * The caller's mentor shortlist.
   *
   * Its own query rather than a field plucked off `export()`. `export` reads six
   * tables and — since the card joined it — composes an SVG and calls an
   * external rasterizer with a ten-second budget. Reading a shortlist through
   * that would make a cheap list depend on a rail it has nothing to do with,
   * and time out behind one.
   */
  async mentors(input: { userId: string }): Promise<MentorMatch[]> {
    return withBlueprintSpan('blueprint.mentors', { stage: 'mentors', userId: input.userId }, async () => {
      const rows = await this.sql<Array<{ student_id: string; mentor_id: string; fit_score: number; status: string }>>`
        SELECT student_id, mentor_id, fit_score, status
          FROM blueprint.mentor_matches WHERE student_id = ${input.userId} ORDER BY fit_score DESC, mentor_id ASC
      `;
      return rows.map(toMentorMatch);
    });
  }

  // ── Ownership: export (§7.2) ───────────────────────────────────────────────

  /**
   * Everything this service holds about a user, as JSON.
   *
   * "Complete" is the exit criterion, so the shape follows the tables rather
   * than the UI: if a row in this schema references the user, it is in here.
   * That includes `mentoringOthers` — the shortlists this user appears ON —
   * which a UI would never show but which is unambiguously data about them.
   *
   * What is deliberately absent is other people's profiles. A crewmate is
   * listed by id and role, not by profile: this is the user's export, and their
   * crewmates did not consent to being in it.
   */
  async export(input: { userId: string }): Promise<BlueprintExport> {
    return withBlueprintSpan('blueprint.export', { stage: 'export', userId: input.userId }, async () => {
      const blueprint = await this.get(input);

      const memberships = await this.sql<Array<{ crew_id: string; user_id: string; role: CrewRole; joined_at: Date }>>`
        SELECT crew_id, user_id, role, joined_at FROM blueprint.crew_members WHERE user_id = ${input.userId}
      `;
      const membership = memberships[0] ?? null;

      const crews = membership
        ? await this.sql<
            Array<{
              id: string;
              name: string;
              formed_at: Date;
              season: number;
              xp: string;
              lobby_id: string | null;
              capacity: number;
            }>
          >`
            SELECT id, name, formed_at, season, xp, lobby_id, capacity
              FROM blueprint.crews WHERE id = ${membership.crew_id}
          `
        : [];
      const crew = crews[0] ?? null;

      const crewmates = membership
        ? await this.sql<Array<{ user_id: string; role: CrewRole; joined_at: Date }>>`
            SELECT user_id, role, joined_at
              FROM blueprint.crew_members
             WHERE crew_id = ${membership.crew_id} AND user_id <> ${input.userId}
             ORDER BY user_id
          `
        : [];

      const runs = await this.sql<Array<{ id: string; candidates: unknown; scores: unknown; placed_crew_id: string | null; ts: Date }>>`
        SELECT id, candidates, scores, placed_crew_id, ts
          FROM blueprint.match_runs WHERE user_id = ${input.userId} ORDER BY ts ASC
      `;

      const asStudent = await this.sql<Array<{ student_id: string; mentor_id: string; fit_score: number; status: string }>>`
        SELECT student_id, mentor_id, fit_score, status
          FROM blueprint.mentor_matches WHERE student_id = ${input.userId} ORDER BY fit_score DESC, mentor_id ASC
      `;

      const asMentor = await this.sql<Array<{ student_id: string; mentor_id: string; fit_score: number; status: string }>>`
        SELECT student_id, mentor_id, fit_score, status
          FROM blueprint.mentor_matches WHERE mentor_id = ${input.userId} ORDER BY fit_score DESC, student_id ASC
      `;

      // §7.2 says "export (JSON + card)". The portrait is the primary artifact,
      // and composing it here costs one pure function call — the raster is
      // whatever the renderer can honestly say, which in a deployment with no
      // renderer is `unavailable`. An export is a snapshot of what the user
      // has, and "you have a vector card and no hosted PNG" is what they have.
      //
      // `renderCard`, not `card()`: the blueprint is already in hand, and an
      // export must not write `card_asset_url` as a side effect of being read.
      const card = blueprint ? await this.renderCard(blueprint, 'portrait') : null;

      return {
        exportedAt: new Date().toISOString(),
        schemaVersion: 2 as const,
        blueprint,
        card,
        crew: crew
          ? {
              id: crew.id,
              name: crew.name,
              formedAt: crew.formed_at.toISOString(),
              season: crew.season,
              xp: String(crew.xp),
              lobbyId: crew.lobby_id,
              capacity: crew.capacity,
            }
          : null,
        membership: membership
          ? {
              crewId: membership.crew_id,
              userId: membership.user_id,
              role: membership.role,
              joinedAt: membership.joined_at.toISOString(),
            }
          : null,
        crewmates: crewmates.map((c) => ({ userId: c.user_id, role: c.role, joinedAt: c.joined_at.toISOString() })),
        matchRuns: runs.map((r) => ({
          id: r.id,
          candidates: r.candidates,
          scores: r.scores,
          placedCrewId: r.placed_crew_id,
          ts: r.ts.toISOString(),
        })),
        mentorMatches: asStudent.map(toMentorMatch),
        mentoringOthers: asMentor.map(toMentorMatch),
        shares: await this.sharesForExport(input.userId),
      };
    });
  }

  // ── Ownership: hard delete (§7.2) ──────────────────────────────────────────

  /**
   * HARD DELETE. §7.2: "Deletion truly cascades."
   *
   * Not a soft delete, not a tombstone, not an anonymisation. Five statements in
   * one transaction, and afterwards no row in this schema references the user.
   *
   * Four decisions worth stating, because each is a way this could have quietly
   * failed to cascade:
   *
   *  · **Mentor rows are deleted on BOTH sides.** Deleting only `student_id`
   *    would leave the user on other people's shortlists — their id, their fit
   *    score, still queryable. That is the single easiest half of this to miss.
   *
   *  · **Match runs go with them.** They are keyed by user and describe that
   *    user's placement history. They hold crew ids and integers, never another
   *    person's profile, precisely so that deleting them is complete rather
   *    than partial.
   *
   *  · **A crew emptied by the departure is dissolved.** Otherwise a hard
   *    delete leaves a crew of zero that still appears in matching, still gets
   *    scored, and still carries the name derived from its founder.
   *
   *  · **`profiles.blueprint_id` in svc-identity is cleared by an EVENT.** This
   *    service does not and must not write another service's tables (§2). The
   *    `blueprintDeleted` event is our half of the contract; svc-identity's
   *    consumer is theirs. The test asserts the event is published with the
   *    payload that consumer needs, because that is the boundary we own.
   *
   * Idempotent: erasing an already-erased user deletes nothing, publishes
   * nothing, and returns a receipt of zeroes.
   */
  async erase(input: { userId: string }): Promise<EraseReceipt> {
    return withBlueprintSpan('blueprint.erase', { stage: 'erase', userId: input.userId }, async () => {
      const outcome = await transaction(
        this.sql,
        async (tx) => {
          const found = await tx<Array<{ id: string }>>`
            SELECT id FROM blueprint.blueprints WHERE user_id = ${input.userId}
          `;
          const blueprintId = found[0]?.id ?? null;

          const touchedCrews = await tx<Array<{ crew_id: string }>>`
            SELECT crew_id FROM blueprint.crew_members WHERE user_id = ${input.userId}
          `;
          const crewIds = touchedCrews.map((r) => r.crew_id);

          const cardOpens = await tx<Array<{ share_id: string }>>`
            DELETE FROM blueprint.card_opens AS o
             USING blueprint.card_shares AS s
             WHERE o.share_id = s.id
               AND (o.viewer_user_id = ${input.userId} OR s.owner_user_id = ${input.userId})
            RETURNING o.share_id
          `;

          const shares = await tx<Array<{ id: string }>>`
            DELETE FROM blueprint.card_shares WHERE owner_user_id = ${input.userId} RETURNING id
          `;

          const mentorMatches = await tx<Array<{ id: string }>>`
            DELETE FROM blueprint.mentor_matches
             WHERE student_id = ${input.userId} OR mentor_id = ${input.userId}
            RETURNING id
          `;

          const memberships = await tx<Array<{ crew_id: string }>>`
            DELETE FROM blueprint.crew_members WHERE user_id = ${input.userId} RETURNING crew_id
          `;

          const matchRuns = await tx<Array<{ id: string }>>`
            DELETE FROM blueprint.match_runs WHERE user_id = ${input.userId} RETURNING id
          `;

          const blueprints = await tx<Array<{ id: string }>>`
            DELETE FROM blueprint.blueprints WHERE user_id = ${input.userId} RETURNING id
          `;

          let emptiedCrews = 0;
          if (crewIds.length > 0) {
            // Only crews this user was actually in, and only if now empty.
            // Other people's crews are none of this operation's business.
            const dissolved = await tx<Array<{ id: string }>>`
              DELETE FROM blueprint.crews AS c
               WHERE c.id = ANY(${crewIds}::uuid[])
                 AND NOT EXISTS (SELECT 1 FROM blueprint.crew_members m WHERE m.crew_id = c.id)
              RETURNING c.id
            `;
            emptiedCrews = dissolved.length;
          }

          return {
            blueprintId,
            removed: {
              blueprints: blueprints.length,
              crewMemberships: memberships.length,
              matchRuns: matchRuns.length,
              mentorMatches: mentorMatches.length,
              emptiedCrews,
              shares: shares.length,
              cardOpens: cardOpens.length,
            },
          };
        },
        { isolation: 'serializable', maxAttempts: 5 },
      );

      const erasedAt = new Date().toISOString();

      if (outcome.blueprintId) {
        await this.bus.publish(
          'blueprintDeleted',
          { blueprintId: outcome.blueprintId, userId: input.userId, erasedAt },
          // The key names the blueprint that was just erased. A second hard
          // delete after the user onboards again is a different fact; a key of
          // only the user id is deduped, and consumers never clear the new
          // blueprint id. A redelivery of this same erase still shares the key.
          // svc-identity clears `profiles.blueprint_id` only when it still
          // matches the payload blueprintId, so a late duplicate of an earlier
          // erase cannot clear a blueprint the user has since created.
          { idempotencyKey: `blueprint.erase:${input.userId}:${outcome.blueprintId}` },
        );
      }

      return { userId: input.userId, erasedAt, removed: outcome.removed };
    });
  }

  /**
   * Subject Blueprint the viewer may see, or `not_found`.
   *
   * `private` and "no row" are the same answer. `public` is any authenticated
   * viewer. `crew` is same-crew only — an unplaced subject has no crew, so
   * crew-visibility is never visible to anyone else.
   */
  /**
   * Lock the share, refuse a revoked or invisible card, render it, and record
   * the open in the same transaction. The share stays FOR UPDATE through the
   * render. revoked_at is read again after the card is composed. If it is
   * revoked, the transaction rolls back and the card is not returned. The
   * owner is not an opener of their own share. A failed open write aborts the
   * transaction, so the card is not returned.
   */
  private async openThroughShare(viewerId: string, shareId: string, subjectUserId: string | undefined): Promise<CardRender> {
    return transaction(this.sql, async (tx) => {
      const shares = await tx<ShareRow[]>`
        SELECT id, owner_user_id, size, created_at, revoked_at
          FROM blueprint.card_shares
         WHERE id = ${shareId}
         FOR UPDATE
      `;
      const share = shares[0];
      if (!share || share.revoked_at !== null) throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
      if (subjectUserId !== undefined && subjectUserId !== share.owner_user_id) {
        throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
      }

      const rows = await tx<BlueprintRow[]>`
        SELECT id, user_id, engine_version, profile, card_asset_url, visibility, mentor_available, created_at
          FROM blueprint.blueprints
         WHERE user_id = ${share.owner_user_id}
      `;
      const row = rows[0];
      if (!row) throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
      const blueprint = toBlueprintRecord(row);

      let sameCrew = false;
      if (viewerId !== share.owner_user_id && blueprint.visibility === 'crew') {
        const same = await tx<Array<{ ok: number }>>`
          SELECT 1 AS ok
            FROM blueprint.crew_members a
            JOIN blueprint.crew_members b ON a.crew_id = b.crew_id
           WHERE a.user_id = ${viewerId} AND b.user_id = ${share.owner_user_id}
           LIMIT 1
        `;
        sameCrew = Boolean(same[0]);
      }
      if (
        !mayViewCard({
          viewerId,
          subjectUserId: share.owner_user_id,
          visibility: blueprint.visibility,
          sameCrew,
        })
      ) {
        throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');
      }

      if (viewerId !== share.owner_user_id) {
        try {
          const written = await tx<Array<{ share_id: string }>>`
            INSERT INTO blueprint.card_opens (share_id, viewer_user_id, first_opened, last_opened, open_count)
            VALUES (${share.id}, ${viewerId}, now(), now(), 1)
            ON CONFLICT (share_id, viewer_user_id)
            DO UPDATE SET last_opened = now(), open_count = blueprint.card_opens.open_count + 1
            RETURNING share_id
          `;
          if (!written[0]) {
            throw new BlueprintError('The open could not be recorded, so the card was not returned', 'blueprint.open_log_unavailable');
          }
        } catch (err) {
          if (err instanceof BlueprintError || isSerializationFailure(err)) throw err;
          throw new BlueprintError('The open could not be recorded, so the card was not returned', 'blueprint.open_log_unavailable');
        }
      }

      const render = await this.renderCard(blueprint, share.size, tx);
      const again = await tx<Array<{ revoked_at: Date | null }>>`
        SELECT revoked_at
          FROM blueprint.card_shares
         WHERE id = ${share.id}
         FOR UPDATE
      `;
      if (!again[0] || again[0].revoked_at !== null) throw new BlueprintError(CARD_NOT_FOUND, 'blueprint.not_found');

      if (viewerId === share.owner_user_id && render.raster.status === 'rendered' && share.size === 'portrait') {
        await tx`
          UPDATE blueprint.blueprints SET card_asset_url = ${render.raster.url}, updated_at = now()
           WHERE user_id = ${blueprint.userId}
        `;
      }

      return render;
    });
  }

  private async toCardShare(sql: Sql, row: ShareRow): Promise<CardShare> {
    const counts = await sql<Array<{ n: number }>>`
      SELECT COALESCE(SUM(open_count), 0)::int AS n FROM blueprint.card_opens WHERE share_id = ${row.id}
    `;
    return {
      id: row.id,
      size: row.size,
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      state: row.revoked_at ? 'revoked' : 'active',
      openCount: counts[0]?.n ?? 0,
    };
  }

  /** Owner export of shares. Opener rows have no account id (MC-blueprint-01). */
  private async sharesForExport(userId: string): Promise<BlueprintExport['shares']> {
    const shareRows = await this.sql<ShareRow[]>`
      SELECT id, owner_user_id, size, created_at, revoked_at
        FROM blueprint.card_shares
       WHERE owner_user_id = ${userId}
       ORDER BY created_at DESC, id DESC
    `;
    if (shareRows.length === 0) return [];
    const ids = shareRows.map((share) => share.id);
    const openers = await this.sql<Array<OpenerRow & { share_id: string }>>`
      SELECT o.share_id,
             CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM blueprint.crew_members viewer
                   JOIN blueprint.crew_members owner_member ON owner_member.crew_id = viewer.crew_id
                  WHERE viewer.user_id = o.viewer_user_id
                    AND owner_member.user_id = ${userId}
               ) THEN 'crew member'
               ELSE 'signed-in account'
             END AS kind,
             o.first_opened, o.last_opened, o.open_count
        FROM blueprint.card_opens o
       WHERE o.share_id = ANY(${ids}::uuid[])
       ORDER BY o.last_opened DESC, o.first_opened DESC
    `;
    return Promise.all(
      shareRows.map(async (share) => {
        const rows = openers.filter((opener) => opener.share_id === share.id);
        const counted = await this.toCardShare(this.sql, share);
        return {
          ...counted,
          openers: rows.map(toOpener),
        };
      }),
    );
  }

  private async visibleBlueprint(viewerId: string, subjectUserId: string): Promise<BlueprintRecord> {
    const blueprint = await this.get({ userId: subjectUserId });
    if (!blueprint) {
      throw new BlueprintError('No Blueprint to render a card for — run the Blueprint session first', 'blueprint.not_found');
    }

    let sameCrew = false;
    if (blueprint.visibility === 'crew') {
      const same = await this.sql<Array<{ ok: number }>>`
        SELECT 1 AS ok
          FROM blueprint.crew_members a
          JOIN blueprint.crew_members b ON a.crew_id = b.crew_id
         WHERE a.user_id = ${viewerId} AND b.user_id = ${subjectUserId}
         LIMIT 1
      `;
      sameCrew = Boolean(same[0]);
    }

    if (!mayViewCard({ viewerId, subjectUserId, visibility: blueprint.visibility, sameCrew })) {
      throw new BlueprintError('No Blueprint to render a card for — run the Blueprint session first', 'blueprint.not_found');
    }
    return blueprint;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * Announce the Blueprint and the placement.
   *
   * Neither payload carries a single field of the profile — §10. What
   * svc-identity needs is the id; what svc-academy needs is the crew; neither
   * needs to know how anyone decides.
   */
  private async announce(blueprint: BlueprintRecord, placement: Placement, userId: string): Promise<void> {
    await this.bus.publish(
      'blueprintCreated',
      {
        blueprintId: blueprint.id,
        userId,
        engineVersion: blueprint.engineVersion,
        visibility: blueprint.visibility,
      },
      { idempotencyKey: `blueprint.created:${blueprint.id}` },
    );

    const sized = await this.sql<Array<{ count: number; role: CrewRole }>>`
      SELECT (SELECT COUNT(*)::int FROM blueprint.crew_members WHERE crew_id = ${placement.crewId}) AS count,
             (SELECT role FROM blueprint.crew_members WHERE crew_id = ${placement.crewId} AND user_id = ${userId}) AS role
    `;
    const row = sized[0];
    if (!row?.role) return;

    await this.bus.publish(
      'crewMemberCreated',
      {
        crewId: placement.crewId,
        userId,
        role: row.role,
        crewSize: row.count,
        matchRunId: placement.matchRunId,
      },
      // The key names the blueprint that owns this membership. newCrewId is
      // stable per season and user, so after erase a later join of that same
      // crew reuses crew id and user id. A key of only those two is deduped,
      // and consumers never observe the new membership. A redelivery of this
      // same blueprint still shares the key: re-running onboarding produces a
      // new match run but the same membership, and a consumer opening a crew
      // channel must not open a second one.
      { idempotencyKey: `blueprint.placed:${placement.crewId}:${userId}:${blueprint.id}` },
    );
  }
}

interface ShareRow {
  id: string;
  owner_user_id: string;
  size: CardSize;
  created_at: Date;
  revoked_at: Date | null;
}

interface OpenerRow {
  kind: OpenerKind;
  first_opened: Date;
  last_opened: Date;
  open_count: number;
}

function toOpener(row: OpenerRow): CardOpener {
  return {
    kind: row.kind,
    firstOpened: row.first_opened.toISOString(),
    lastOpened: row.last_opened.toISOString(),
    openCount: row.open_count,
  };
}

function toBlueprintRecord(row: BlueprintRow): BlueprintRecord {
  return {
    id: row.id,
    userId: row.user_id,
    engineVersion: row.engine_version,
    profile: row.profile,
    cardAssetUrl: row.card_asset_url,
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
  };
}

function toMentorMatch(row: { student_id: string; mentor_id: string; fit_score: number; status: string }): MentorMatch {
  return {
    studentId: row.student_id,
    mentorId: row.mentor_id,
    fitScore: row.fit_score,
    status: row.status as MentorMatch['status'],
  };
}
