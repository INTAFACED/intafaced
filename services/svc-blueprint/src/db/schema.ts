import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgSchema, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * BLUEPRINT (§7.1).
 *
 * Five tables, and a hard rule about what is in them: the engine's derived
 * profile, and nothing a user typed. §10 PII isolation reads "services get
 * status flags, never documents"; the equivalent here is that we keep the
 * *conclusion* and discard the *evidence*. There is no birth-data column
 * anywhere below, and that absence is the design — a column that does not exist
 * cannot leak, cannot be logged, and cannot be subpoenaed out of a backup.
 *
 * The service holds no balances and posts no ledger transactions (Doctrine
 * §0.6 is satisfied trivially — there is no money here). `crews.xp` is a count.
 */
export const blueprint = pgSchema('blueprint');

export const visibilityEnum = blueprint.enum('blueprint_visibility', ['private', 'crew', 'public']);
export const crewRoleEnum = blueprint.enum('crew_role', ['anchor', 'scout', 'builder', 'catalyst']);
export const mentorStatusEnum = blueprint.enum('mentor_match_status', ['shortlisted', 'accepted', 'declined', 'ended']);

export const blueprints = blueprint.table(
  'blueprints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One Blueprint per account. A second would make "which one is you" ambiguous. */
    userId: uuid('user_id').notNull(),
    /** The engine build that produced `profile`. Profiles compare only within a version. */
    engineVersion: text('engine_version').notNull(),
    /**
     * The derived profile — the five axes plus curriculum path, tone register
     * and default agent guardrails (§7.1). Validated against
     * `blueprintProfileSchema` in packages/contracts on the way in and out.
     *
     * NEVER logged. NEVER put on a span. NEVER carried on an event payload.
     */
    profile: jsonb('profile').notNull(),
    /** Set by `blueprint.card` — a separate feature. Null until it lands. */
    cardAssetUrl: text('card_asset_url'),
    visibility: visibilityEnum('visibility').notNull().default('private'),
    /**
     * Opt-in to appearing in other people's mentor shortlists. Not in the §7.1
     * column list, but `mentor_matches` is meaningless without knowing who is
     * willing — and inferring willingness from rank would opt people in silently.
     */
    mentorAvailable: boolean('mentor_available').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('blueprints_user_idx').on(t.userId), index('blueprints_mentor_idx').on(t.mentorAvailable)],
);

export const crews = blueprint.table(
  'crews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    formedAt: tstz('formed_at').notNull().defaultNow(),
    season: integer('season').notNull().default(1),
    /** A count of shared achievement, not money. Never a ledger balance. */
    xp: bigint('xp', { mode: 'bigint' }).notNull().default(0n),
    /** svc-academy's lobby, once one exists. Null until then. */
    lobbyId: uuid('lobby_id'),
    /**
     * Capacity is data, not a constant, so a season can run larger or smaller
     * crews without a migration or a redeploy.
     */
    capacity: integer('capacity').notNull().default(6),
  },
  (t) => [uniqueIndex('crews_name_season_idx').on(t.name, t.season), index('crews_season_idx').on(t.season)],
);

export const crewMembers = blueprint.table(
  'crew_members',
  {
    crewId: uuid('crew_id')
      .notNull()
      .references(() => crews.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: crewRoleEnum('role').notNull(),
    joinedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('crew_members_pk').on(t.crewId, t.userId),
    /**
     * ONE CREW PER USER. Without this, a retried placement puts someone in two
     * crews and every "your crew" query silently picks whichever row it read
     * first — the same class of bug as two rows of token params.
     */
    uniqueIndex('crew_members_user_idx').on(t.userId),
    index('crew_members_crew_idx').on(t.crewId),
  ],
);

export const matchRuns = blueprint.table(
  'match_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /**
     * The crews considered, as `[{ crewId, size }]`. Crew ids and sizes only —
     * putting the candidates' profiles here would copy other people's PII into
     * this user's export.
     */
    candidates: jsonb('candidates').notNull().default([]),
    /** `{ [crewId]: score }` in basis points. Integers, so a re-run is comparable. */
    scores: jsonb('scores').notNull().default({}),
    placedCrewId: uuid('placed_crew_id').references(() => crews.id, { onDelete: 'set null' }),
    ts: tstz('ts').notNull().defaultNow(),
  },
  (t) => [index('match_runs_user_idx').on(t.userId, t.ts)],
);

export const mentorMatches = blueprint.table(
  'mentor_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentId: uuid('student_id').notNull(),
    mentorId: uuid('mentor_id').notNull(),
    /** 0–10000 basis points. An integer, because a reproducible score cannot be a float. */
    fitScore: integer('fit_score').notNull(),
    status: mentorStatusEnum('status').notNull().default('shortlisted'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mentor_matches_pair_idx').on(t.studentId, t.mentorId),
    index('mentor_matches_student_idx').on(t.studentId, t.status),
    /** Erasing a mentor must find their rows as fast as erasing a student's. */
    index('mentor_matches_mentor_idx').on(t.mentorId),
  ],
);

/** One share of one card size (MC-blueprint-01). The id is the shared-card route parameter. */
export const cardShares = blueprint.table(
  'card_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id').notNull(),
    size: text('size').notNull(),
    createdAt: createdAt(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    check('card_shares_size_chk', sql`${t.size} IN ('portrait', 'landscape')`),
    uniqueIndex('card_shares_owner_size_active_idx')
      .on(t.ownerUserId, t.size)
      .where(sql`${t.revokedAt} IS NULL`),
    index('card_shares_owner_idx').on(t.ownerUserId, t.createdAt),
  ],
);

/** One row per share and viewer. The viewer id is stored for counting and erase, and is not returned. */
export const cardOpens = blueprint.table(
  'card_opens',
  {
    shareId: uuid('share_id')
      .notNull()
      .references(() => cardShares.id, { onDelete: 'cascade' }),
    viewerUserId: uuid('viewer_user_id').notNull(),
    firstOpened: tstz('first_opened').notNull().defaultNow(),
    lastOpened: tstz('last_opened').notNull().defaultNow(),
    openCount: integer('open_count').notNull().default(1),
  },
  (t) => [
    uniqueIndex('card_opens_pk').on(t.shareId, t.viewerUserId),
    check('card_opens_count_chk', sql`${t.openCount} >= 1`),
    index('card_opens_viewer_idx').on(t.viewerUserId),
  ],
);

export const schema = { blueprints, crews, crewMembers, matchRuns, mentorMatches, cardShares, cardOpens };
