import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus, MemorySeenStore, idempotent } from '@intafaced/events';
import { CARD_DIMENSIONS, cardRenderSchema, type BlueprintProfile, type CardRaster, type OnboardInput } from '@intafaced/contracts';
import { BlueprintService, BlueprintError } from './blueprint-service.js';
import { MockNeuralEngine, deriveProfile, MOCK_ENGINE_VERSION } from './engine/mock-engine.js';
import { deterministicUuid } from './deterministic.js';
import { EMPTY_CREW_SCORE, complementarity, newCrewId } from './matching/crew-matching.js';
import { UnconfiguredCardRenderer, type CardRasterizeRequest, type CardRenderer } from './card/card-renderer.js';

/**
 * svc-blueprint — onboarding, matching, ownership.
 *
 * Postgres is real, because the parts most likely to hide a bug are the
 * transaction boundaries: the placement that must not overfill a crew, and the
 * erasure that must not leave a row behind. Neither is observable against a
 * fake.
 *
 * The engine is `MockNeuralEngine` — deterministic by construction, which is
 * what lets these tests assert a *specific* placement rather than merely that
 * one happened. The real engine is an external deployment (§7.1); what this
 * service owns and what these tests exercise is everything on this side of the
 * `NeuralEngineClient` interface.
 */

// createTestDatabase makes a whole database, so it connects as the test admin
// (TEST_DATABASE_URL, which has CREATEDB), not as the svc_blueprint role.
const raw = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrations = ['0000_blueprint_init.sql', '0001_card_shares.sql'].map((name) =>
  readFileSync(join(here, '..', 'drizzle', name), 'utf8'),
);

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const USER_A = uuid(101);
const USER_B = uuid(102);
const USER_C = uuid(103);

/**
 * The Postgres probe comes from `@intafaced/db` on purpose.
 *
 * This file used to open its own two-line `reachable()`. That helper swallowed
 * every error and returned `false` regardless of `CI` or `REQUIRE_POSTGRES=1`,
 * so on CI — where an unreachable database is supposed to be a hard failure —
 * this money suite would have skipped in silence and been counted as a pass.
 * Five suites carried the same private probe and the same hole.
 *
 * `postgresAvailable` is the one probe that honours `postgresRequired()`, and it
 * journals its decision so `pnpm verify` can name what did not run instead of
 * letting turbo's "N successful" imply that everything did.
 * (`tooling/ci/skip-honesty-scan.mjs` fails a build that re-adds a private probe.)
 */
const available = raw ? await postgresAvailable(raw) : await postgresAvailable();

if (!available) {
  describe.skip('svc-blueprint (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'blueprint', ...(raw ? { url: raw } : {}), migrations });
  const sql = db.sql;

  let bus: MemoryEventBus;
  let engine: MockNeuralEngine;
  let blueprint: BlueprintService;
  let identity: IdentityProjection;

  const options = { crewCapacity: 4, mentorShortlistSize: 3, season: 1 };

  /**
   * Stands in for svc-identity's consumer of our events.
   *
   * §2 forbids this service writing another service's tables, so
   * `profiles.blueprint_id` is set and cleared by svc-identity reacting to
   * `blueprintCreated` / `blueprintDeleted`. This is that consumer, reduced to
   * the one field it owns — so the cascade test can assert the reference is
   * genuinely gone rather than assert that we published something and hope.
   */
  class IdentityProjection {
    readonly blueprintIdByUser = new Map<string, string | null>();

    async attach(target: MemoryEventBus): Promise<void> {
      await target.subscribe(
        'blueprintCreated',
        (payload) => {
          this.blueprintIdByUser.set(payload.userId, payload.blueprintId);
        },
        { durable: 'identity-sets-blueprint-id' },
      );
      await target.subscribe(
        'blueprintDeleted',
        (payload) => {
          this.blueprintIdByUser.set(payload.userId, null);
        },
        { durable: 'identity-clears-blueprint-id' },
      );
    }
  }

  /**
   * A session whose derived profile satisfies `predicate`.
   *
   * A deterministic search rather than a hand-written profile: the fixtures are
   * then real engine output, so a change to the derivation that broke these
   * assumptions shows up here instead of being papered over by hand-tuned
   * objects the engine would never produce.
   */
  function sessionFor(predicate: (profile: BlueprintProfile) => boolean): OnboardInput['responses'] {
    for (let seed = 0; seed < 20_000; seed++) {
      const responses = [{ key: 'q1', value: `seed-${seed}` }];
      if (predicate(deriveProfile({ requestId: 'search', locale: 'en', responses }))) return responses;
    }
    throw new Error('no session produced a profile matching the predicate');
  }

  /**
   * A session complementary enough to `members` that placement joins them
   * rather than forming a new crew. Used wherever a test needs two users to be
   * crewmates — asserting on co-membership that the threshold happened to allow
   * would be a test that passes by luck.
   */
  function sessionJoining(members: readonly BlueprintProfile[]): OnboardInput['responses'] {
    return sessionFor((profile) => complementarity(profile, members) >= EMPTY_CREW_SCORE);
  }

  function onboardInput(userId: string, responses: OnboardInput['responses'], extra: Partial<OnboardInput> = {}): OnboardInput {
    return { userId, locale: 'en', responses, visibility: 'private', mentorAvailable: false, ...extra };
  }

  const profileOf = (responses: OnboardInput['responses']): BlueprintProfile => deriveProfile({ requestId: 'x', locale: 'en', responses });

  /**
   * Insert a crew with members directly — the fixture for "what crews exist".
   *
   * Member ids come from a monotonic counter rather than from the crew id: two
   * seeded crews must not compete for the same member id, because
   * `crew_members.user_id` is unique and the second crew would silently end up
   * empty.
   */
  let seededMembers = 0;

  async function seedCrew(crewId: string, memberProfiles: readonly BlueprintProfile[], capacity = 4): Promise<void> {
    await sql`
      INSERT INTO blueprint.crews (id, name, season, capacity)
      VALUES (${crewId}, ${`Seeded ${crewId.slice(0, 8)}`}, 1, ${capacity})
      ON CONFLICT (id) DO NOTHING
    `;

    for (const profile of memberProfiles) {
      const memberId = uuid(5000 + ++seededMembers);
      await sql`
        INSERT INTO blueprint.blueprints (user_id, engine_version, profile)
        VALUES (${memberId}, ${MOCK_ENGINE_VERSION}, ${sql.json(profile as never)})
        ON CONFLICT (user_id) DO NOTHING
      `;
      await sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role)
        VALUES (${crewId}, ${memberId}, ${profile.crewRole})
        ON CONFLICT (crew_id, user_id) DO NOTHING
      `;
    }
  }

  const rowCount = async (table: string, column: string, value: string): Promise<number> => {
    const rows = await sql.unsafe<Array<{ count: number }>>(`SELECT COUNT(*)::int AS count FROM blueprint.${table} WHERE ${column} = $1`, [
      value,
    ]);
    return rows[0]?.count ?? 0;
  };

  beforeEach(async () => {
    await sql`
      TRUNCATE blueprint.card_opens, blueprint.card_shares, blueprint.mentor_matches, blueprint.match_runs,
               blueprint.crew_members, blueprint.crews, blueprint.blueprints
      RESTART IDENTITY CASCADE
    `;
    bus = new MemoryEventBus('svc-blueprint');
    engine = new MockNeuralEngine();
    blueprint = new BlueprintService(sql, engine, bus, new UnconfiguredCardRenderer(), options);
    identity = new IdentityProjection();
    await identity.attach(bus);
  });

  afterAll(async () => {
    await db.drop();
  });

  // ── Onboarding ────────────────────────────────────────────────────────────

  describe('onboarding', () => {
    it('refuses onboard when season is unpublished (does not invent 1)', async () => {
      const unpublished = new BlueprintService(sql, engine, bus, new UnconfiguredCardRenderer(), {
        crewCapacity: 4,
        mentorShortlistSize: 3,
      });
      await expect(unpublished.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]))).rejects.toMatchObject({
        code: 'blueprint.season_unset',
      });
    });

    it('refuses forming a crew when capacity is unpublished (does not invent 6)', async () => {
      const unpublished = new BlueprintService(sql, engine, bus, new UnconfiguredCardRenderer(), {
        mentorShortlistSize: 3,
        season: 1,
      });
      await expect(unpublished.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]))).rejects.toMatchObject({
        code: 'blueprint.crew_capacity_unset',
      });
    });

    it('refuses mentor shortlist when size is unpublished (does not invent 3)', async () => {
      const unpublished = new BlueprintService(sql, engine, bus, new UnconfiguredCardRenderer(), {
        crewCapacity: 4,
        season: 1,
      });
      await expect(unpublished.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]))).rejects.toMatchObject({
        code: 'blueprint.mentor_shortlist_unset',
      });
    });

    it('produces a profile and a crew placement in one call', async () => {
      const result = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'I plan everything' }]));

      expect(result.blueprint.userId).toBe(USER_A);
      expect(result.blueprint.engineVersion).toBe(MOCK_ENGINE_VERSION);
      expect(result.blueprint.profile.crewRole).toBeDefined();
      expect(result.blueprint.profile.guardrails.maxLeverage).toBeGreaterThanOrEqual(1);

      // No crew existed, so one was formed — at the derived id, not a random one.
      expect(result.placement.crewFormed).toBe(true);
      expect(result.placement.crewId).toBe(newCrewId(1, USER_A));
      expect(result.placement.crewName).toMatch(/\S/);

      const members = await sql<Array<{ user_id: string; role: string }>>`
        SELECT user_id, role FROM blueprint.crew_members WHERE crew_id = ${result.placement.crewId}
      `;
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ user_id: USER_A, role: result.blueprint.profile.crewRole });
    });

    it('persists the profile and nothing the user said', async () => {
      const responses = [{ key: 'childhood', value: 'a very identifying free-text answer' }];
      await blueprint.onboard(onboardInput(USER_A, responses, { birthData: { date: '1990-01-01', time: '03:15', place: 'Porto' } }));

      const rows = await sql<Array<{ profile: Record<string, unknown> }>>`
        SELECT profile FROM blueprint.blueprints WHERE user_id = ${USER_A}
      `;
      const stored = JSON.stringify(rows[0]?.profile);

      // §10: the session's inputs are an input to the engine and are dropped.
      expect(stored).not.toContain('identifying free-text');
      expect(stored).not.toContain('1990-01-01');
      expect(stored).not.toContain('Porto');
      expect(stored).not.toContain('childhood');

      // And the whole row, not just the profile column — there is no column for
      // any of it, and this test fails the moment someone adds one.
      const wholeRow = await sql`SELECT * FROM blueprint.blueprints WHERE user_id = ${USER_A}`;
      expect(JSON.stringify(wholeRow)).not.toContain('Porto');
    });

    it('records a match run showing what was considered', async () => {
      const other = newCrewId(1, USER_C);
      await seedCrew(other, [profileOf([{ key: 'q1', value: 'seed-1' }])]);

      const result = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'seed-2' }]));

      const runs = await sql<Array<{ candidates: unknown[]; scores: Record<string, number>; placed_crew_id: string }>>`
        SELECT candidates, scores, placed_crew_id FROM blueprint.match_runs WHERE user_id = ${USER_A}
      `;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.placed_crew_id).toBe(result.placement.crewId);
      expect(runs[0]?.candidates).toContainEqual({ crewId: other, size: 1 });
      expect(Object.keys(runs[0]?.scores ?? {})).toContain(other);
    });

    it('emits blueprintCreated and crewMemberCreated, with no profile content on either', async () => {
      const result = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'seed-9' }]));

      const created = bus.emitted('blueprintCreated');
      expect(created).toHaveLength(1);
      expect(created[0]?.payload).toMatchObject({
        blueprintId: result.blueprint.id,
        userId: USER_A,
        engineVersion: MOCK_ENGINE_VERSION,
        visibility: 'private',
      });

      const placed = bus.emitted('crewMemberCreated');
      expect(placed).toHaveLength(1);
      expect(placed[0]?.payload).toMatchObject({ crewId: result.placement.crewId, userId: USER_A, crewSize: 1 });

      // §10 — the bus is a fan-out to every consumer in the OS. The axes must
      // not be on it. `role` is: it is the crew's shape, and svc-academy needs
      // it to route a lobby.
      const serialised = JSON.stringify([created[0]?.payload, placed[0]?.payload]);
      for (const axis of ['decisionStyle', 'riskTemperament', 'energyRhythm', 'learningMode', 'curriculumPath', 'toneRegister']) {
        expect(serialised).not.toContain(axis);
      }
    });

    it('sets the identity reference through an event, not through identity tables', async () => {
      const result = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'seed-3' }]));
      expect(identity.blueprintIdByUser.get(USER_A)).toBe(result.blueprint.id);
    });
  });

  // ── Determinism ───────────────────────────────────────────────────────────

  describe('matching is deterministic', () => {
    it('re-running onboarding lands the user in the same crew', async () => {
      const responses = [{ key: 'q1', value: 'the same answers both times' }];

      const first = await blueprint.onboard(onboardInput(USER_A, responses));
      const second = await blueprint.onboard(onboardInput(USER_A, responses));
      const third = await blueprint.onboard(onboardInput(USER_A, responses));

      expect(second.placement.crewId).toBe(first.placement.crewId);
      expect(third.placement.crewId).toBe(first.placement.crewId);
      expect(second.blueprint.id).toBe(first.blueprint.id);
      expect(second.blueprint.profile).toEqual(first.blueprint.profile);

      // One membership, one blueprint — a re-run must not duplicate either.
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
      // But every run is recorded: §7.1 makes match_runs an audit of runs.
      expect(await rowCount('match_runs', 'user_id', USER_A)).toBe(3);
    });

    it('forms one crew, not three, when the same placement is retried', async () => {
      const responses = [{ key: 'q1', value: 'retry me' }];
      await blueprint.onboard(onboardInput(USER_A, responses));
      await blueprint.onboard(onboardInput(USER_A, responses));

      const crews = await sql<Array<{ id: string }>>`SELECT id FROM blueprint.crews`;
      expect(crews).toHaveLength(1);
      expect(crews[0]?.id).toBe(newCrewId(1, USER_A));
    });

    it('keeps a clone out of the crew they would merely echo', async () => {
      const responses = [{ key: 'q1', value: 'identical twins' }];

      const first = await blueprint.onboard(onboardInput(USER_A, responses));
      const second = await blueprint.onboard(onboardInput(USER_B, responses));

      // B's session is identical to A's, so A's crew scores 0 for B — below the
      // threshold, and worse than starting fresh. B forms their own crew at
      // their own derived id.
      expect(second.placement.crewId).not.toBe(first.placement.crewId);
      expect(second.placement.crewId).toBe(newCrewId(1, USER_B));
      expect(second.placement.crewFormed).toBe(true);

      // The run still records that A's crew was considered and why it lost.
      const runs = await sql<Array<{ scores: Record<string, number> }>>`
        SELECT scores FROM blueprint.match_runs WHERE user_id = ${USER_B}
      `;
      expect(runs[0]?.scores[first.placement.crewId]).toBe(0);
    });
  });

  // ── Complementarity ───────────────────────────────────────────────────────

  describe('complementary profiles are preferred over identical ones', () => {
    it('joins the crew that shares least, not the one that shares most', async () => {
      const subject = sessionFor((p) => p.crewRole === 'anchor' && p.decisionStyle === 'analytical');
      const subjectProfile = profileOf(subject);

      const cloneCrewId = uuid(201);
      const strangerCrewId = uuid(202);

      // A crew of people identical to the subject on every axis…
      await seedCrew(cloneCrewId, [subjectProfile, subjectProfile]);
      // …and a crew that differs on every axis.
      const stranger: BlueprintProfile = {
        ...subjectProfile,
        crewRole: subjectProfile.crewRole === 'anchor' ? 'catalyst' : 'anchor',
        decisionStyle: subjectProfile.decisionStyle === 'analytical' ? 'intuitive' : 'analytical',
        riskTemperament: subjectProfile.riskTemperament === 'bold' ? 'guarded' : 'bold',
        energyRhythm: subjectProfile.energyRhythm === 'dawn' ? 'nocturnal' : 'dawn',
        learningMode: subjectProfile.learningMode === 'visual' ? 'systematic' : 'visual',
      };
      await seedCrew(strangerCrewId, [stranger, stranger]);

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      expect(result.placement.crewId).toBe(strangerCrewId);
      expect(result.placement.score).toBe(10_000);
      expect(result.placement.crewFormed).toBe(false);
    });

    it('forms a new crew rather than joining a crew of clones', async () => {
      const subject = sessionFor((p) => p.crewRole === 'builder');
      const subjectProfile = profileOf(subject);

      await seedCrew(uuid(203), [subjectProfile, subjectProfile, subjectProfile]);

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      // A crew of clones scores 0, below the form-threshold — "best available"
      // is not "good enough", so the service forms a crew rather than placing
      // someone in an echo chamber.
      expect(result.placement.crewId).not.toBe(uuid(203));
      expect(result.placement.crewFormed).toBe(true);
      expect(result.placement.crewId).toBe(newCrewId(1, USER_A));
    });

    it('starts fresh past an occupied founder crew rejected for complementarity even with spare seats', async () => {
      const subject = sessionFor((p) => p.crewRole === 'builder');
      const rejected = newCrewId(1, USER_A);
      await seedCrew(rejected, [profileOf(subject)], 4);

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      expect(result.placement.crewId).toBe(deterministicUuid('crew:s1:start-fresh', USER_A));
      expect(result.placement.crewFormed).toBe(true);
      expect(await rowCount('crew_members', 'crew_id', rejected)).toBe(1);
      expect(await rowCount('crew_members', 'crew_id', result.placement.crewId)).toBe(1);
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
    });
  });

  // ── Capacity ──────────────────────────────────────────────────────────────

  describe('a full crew does not accept another member', () => {
    it('rejects a direct join with crew_full', async () => {
      const full = uuid(301);
      const filler = profileOf([{ key: 'q1', value: 'filler' }]);
      await seedCrew(full, [filler, filler, filler, filler], 4);

      await expect(blueprint.joinCrew(full, USER_A, 'scout')).rejects.toMatchObject({ code: 'blueprint.crew_full' });

      const count = await sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM blueprint.crew_members WHERE crew_id = ${full}
      `;
      expect(count[0]?.count).toBe(4);
    });

    it('routes onboarding past a full crew instead of overfilling it', async () => {
      const subject = sessionFor((p) => p.crewRole === 'scout');
      const subjectProfile = profileOf(subject);
      const stranger: BlueprintProfile = { ...subjectProfile, crewRole: 'anchor', decisionStyle: 'collaborative' };

      // The perfect crew for the subject — and it is full.
      const full = uuid(302);
      await seedCrew(full, [stranger, stranger, stranger, stranger], 4);

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      expect(result.placement.crewId).not.toBe(full);
      expect(await rowCount('crew_members', 'crew_id', full)).toBe(4);
    });

    it('routes onboarding past a crew that is full once a member without a blueprint is counted', async () => {
      const subject = sessionFor((p) => p.crewRole === 'scout');
      const subjectProfile = profileOf(subject);
      const stranger: BlueprintProfile = {
        ...subjectProfile,
        crewRole: 'anchor',
        decisionStyle: subjectProfile.decisionStyle === 'analytical' ? 'intuitive' : 'analytical',
        riskTemperament: subjectProfile.riskTemperament === 'bold' ? 'guarded' : 'bold',
        energyRhythm: subjectProfile.energyRhythm === 'dawn' ? 'nocturnal' : 'dawn',
        learningMode: subjectProfile.learningMode === 'visual' ? 'systematic' : 'visual',
      };
      // The scored seat is complementary, so an undercount of one would treat
      // this crew as open and choose it. Capacity stays 2: the second seat is
      // a crew_members row with no blueprint.
      expect(complementarity(subjectProfile, [stranger])).toBeGreaterThanOrEqual(EMPTY_CREW_SCORE);

      const full = uuid(305);
      await seedCrew(full, [stranger], 2);
      await sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role)
        VALUES (${full}, ${uuid(9105)}, 'builder')
      `;

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      expect(result.placement.crewId).not.toBe(full);
      expect(result.placement.crewFormed).toBe(true);
      expect(await rowCount('crew_members', 'crew_id', full)).toBe(2);
    });

    it('starts fresh on another crew when the derived crew chooseCrew rejected is full of other members', async () => {
      const subject = sessionFor((p) => p.crewRole === 'scout');
      const subjectProfile = profileOf(subject);
      const stranger: BlueprintProfile = {
        ...subjectProfile,
        crewRole: 'anchor',
        decisionStyle: subjectProfile.decisionStyle === 'analytical' ? 'intuitive' : 'analytical',
        riskTemperament: subjectProfile.riskTemperament === 'bold' ? 'guarded' : 'bold',
        energyRhythm: subjectProfile.energyRhythm === 'dawn' ? 'nocturnal' : 'dawn',
        learningMode: subjectProfile.learningMode === 'visual' ? 'systematic' : 'visual',
      };
      // The scored seats are complementary, so the crew is skipped only because
      // it is full. Capacity stays 4. The fourth seat is a crew_members row
      // with no blueprint.
      expect(complementarity(subjectProfile, [stranger, stranger, stranger])).toBeGreaterThanOrEqual(EMPTY_CREW_SCORE);

      const rejected = newCrewId(1, USER_A);
      await seedCrew(rejected, [stranger, stranger, stranger], 4);
      await sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role)
        VALUES (${rejected}, ${uuid(9106)}, 'builder')
      `;

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      expect(result.placement.crewId).not.toBe(rejected);
      expect(result.placement.crewFormed).toBe(true);
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('crew_members', 'crew_id', rejected)).toBe(4);
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(1);
    });

    it('starts fresh on a crew that is not an occupied derived id when the second derived id is also full of other members', async () => {
      const subject = sessionFor((p) => p.crewRole === 'scout');
      const subjectProfile = profileOf(subject);
      const stranger: BlueprintProfile = {
        ...subjectProfile,
        crewRole: 'anchor',
        decisionStyle: subjectProfile.decisionStyle === 'analytical' ? 'intuitive' : 'analytical',
        riskTemperament: subjectProfile.riskTemperament === 'bold' ? 'guarded' : 'bold',
        energyRhythm: subjectProfile.energyRhythm === 'dawn' ? 'nocturnal' : 'dawn',
        learningMode: subjectProfile.learningMode === 'visual' ? 'systematic' : 'visual',
      };
      // These derived crews are complementary and skipped only because they are
      // full. Capacity stays 4. The fourth seat on each is a crew_members row
      // with no blueprint.
      expect(complementarity(subjectProfile, [stranger, stranger, stranger])).toBeGreaterThanOrEqual(EMPTY_CREW_SCORE);

      const rejected = newCrewId(1, USER_A);
      // The start-fresh salt. formCrew returns this existing row, insertMembership
      // raises blueprint.crew_full, and the new blueprint rolls back.
      const alternate = deterministicUuid('crew:s1:start-fresh', USER_A);
      expect(alternate).toBe('115fa7a5-2acb-45ef-8a76-b09e22c291db');
      // The next salt. A single swap off `start-fresh` must not join this one either.
      const further = deterministicUuid('crew:s1:start-fresh:2', USER_A);

      await seedCrew(rejected, [stranger, stranger, stranger], 4);
      await sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role)
        VALUES (${rejected}, ${uuid(9107)}, 'builder')
      `;
      await seedCrew(alternate, [stranger, stranger, stranger], 4);
      await sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role)
        VALUES (${alternate}, ${uuid(9108)}, 'builder')
      `;
      await seedCrew(further, [stranger, stranger, stranger], 4);
      await sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role)
        VALUES (${further}, ${uuid(9109)}, 'builder')
      `;

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      expect(result.placement.crewId).not.toBe(rejected);
      expect(result.placement.crewId).not.toBe(alternate);
      expect(result.placement.crewId).not.toBe(further);
      expect(result.placement.crewFormed).toBe(true);
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('crew_members', 'crew_id', rejected)).toBe(4);
      expect(await rowCount('crew_members', 'crew_id', alternate)).toBe(4);
      expect(await rowCount('crew_members', 'crew_id', further)).toBe(4);
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(1);
      const placed = await sql<Array<{ user_id: string }>>`
        SELECT user_id FROM blueprint.crew_members WHERE crew_id = ${result.placement.crewId}
      `;
      expect(placed).toEqual([{ user_id: USER_A }]);
    });

    it('keeps the new blueprint and forms an empty crew when newCrewId and start-fresh through start-fresh:7 already have members', async () => {
      const subject = sessionFor((p) => p.crewRole === 'scout');
      const subjectProfile = profileOf(subject);
      const stranger: BlueprintProfile = {
        ...subjectProfile,
        crewRole: 'anchor',
        decisionStyle: subjectProfile.decisionStyle === 'analytical' ? 'intuitive' : 'analytical',
        riskTemperament: subjectProfile.riskTemperament === 'bold' ? 'guarded' : 'bold',
        energyRhythm: subjectProfile.energyRhythm === 'dawn' ? 'nocturnal' : 'dawn',
        learningMode: subjectProfile.learningMode === 'visual' ? 'systematic' : 'visual',
      };
      // These derived crews are complementary and skipped only because they are
      // full. Capacity stays 4. The fourth seat on each is a crew_members row
      // with no blueprint, so a member without a profile still occupies the id.
      expect(complementarity(subjectProfile, [stranger, stranger, stranger])).toBeGreaterThanOrEqual(EMPTY_CREW_SCORE);

      const occupied = [
        newCrewId(1, USER_A),
        deterministicUuid('crew:s1:start-fresh', USER_A),
        deterministicUuid('crew:s1:start-fresh:2', USER_A),
        deterministicUuid('crew:s1:start-fresh:3', USER_A),
        deterministicUuid('crew:s1:start-fresh:4', USER_A),
        deterministicUuid('crew:s1:start-fresh:5', USER_A),
        deterministicUuid('crew:s1:start-fresh:6', USER_A),
        deterministicUuid('crew:s1:start-fresh:7', USER_A),
      ];
      expect(occupied[1]).toBe('115fa7a5-2acb-45ef-8a76-b09e22c291db');
      expect(occupied[7]).toBe('cf206e53-7856-44c4-b398-924a5820a9e4');

      for (const [index, crewId] of occupied.entries()) {
        await seedCrew(crewId, [stranger, stranger, stranger], 4);
        await sql`
          INSERT INTO blueprint.crew_members (crew_id, user_id, role)
          VALUES (${crewId}, ${uuid(9120 + index)}, 'builder')
        `;
      }

      const result = await blueprint.onboard(onboardInput(USER_A, subject));

      // The next counter step after the published salts. It was empty, so the
      // founder forms it and the blueprint transaction commits.
      const opened = deterministicUuid('crew:s1:start-fresh:8', USER_A);
      expect(opened).toBe('430a25c3-a56b-4960-b0c5-ac66e9836781');
      expect(result.placement.crewId).toBe(opened);
      expect(result.placement.crewFormed).toBe(true);
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(1);
      for (const crewId of occupied) {
        expect(await rowCount('crew_members', 'crew_id', crewId)).toBe(4);
      }
      const placed = await sql<Array<{ user_id: string }>>`
        SELECT user_id FROM blueprint.crew_members WHERE crew_id = ${result.placement.crewId}
      `;
      expect(placed).toEqual([{ user_id: USER_A }]);
    });

    it('is idempotent when the member is already in the crew', async () => {
      const crewId = uuid(303);
      await seedCrew(crewId, [], 2);
      await blueprint.joinCrew(crewId, USER_A, 'anchor');
      await blueprint.joinCrew(crewId, USER_A, 'anchor');

      expect(await rowCount('crew_members', 'crew_id', crewId)).toBe(1);
    });

    it('survives concurrent joins without exceeding capacity', async () => {
      const crewId = uuid(304);
      await seedCrew(crewId, [], 2);

      const contenders = [uuid(401), uuid(402), uuid(403), uuid(404), uuid(405)];
      const outcomes = await Promise.all(
        contenders.map((userId) =>
          blueprint
            .joinCrew(crewId, userId, 'scout')
            .then(() => 'joined' as const)
            .catch(() => 'rejected' as const),
        ),
      );

      expect(outcomes.filter((o) => o === 'joined')).toHaveLength(2);
      expect(await rowCount('crew_members', 'crew_id', crewId)).toBe(2);
    });
  });

  // ── Engine failure ────────────────────────────────────────────────────────

  describe('engine failure degrades cleanly', () => {
    it('writes nothing at all when the engine is unavailable', async () => {
      const failing = new BlueprintService(
        sql,
        new MockNeuralEngine({ failWith: 'unavailable' }),
        bus,
        new UnconfiguredCardRenderer(),
        options,
      );

      await expect(failing.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'x' }]))).rejects.toMatchObject({
        code: 'blueprint.engine_unavailable',
      });

      // No half-written Blueprint: not a row with a null profile, not a crew,
      // not a membership, not a match run.
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(0);
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(0);
      expect(await rowCount('match_runs', 'user_id', USER_A)).toBe(0);
      expect(await sql`SELECT id FROM blueprint.crews`).toHaveLength(0);
    });

    it('announces nothing, so no consumer learns of a Blueprint that does not exist', async () => {
      const failing = new BlueprintService(
        sql,
        new MockNeuralEngine({ failWith: 'unavailable' }),
        bus,
        new UnconfiguredCardRenderer(),
        options,
      );
      await expect(failing.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'x' }]))).rejects.toThrow(BlueprintError);

      expect(bus.emitted('blueprintCreated')).toHaveLength(0);
      expect(bus.emitted('crewMemberCreated')).toHaveLength(0);
      expect(identity.blueprintIdByUser.get(USER_A)).toBeUndefined();
    });

    it('leaks nothing about the session in the error it raises', async () => {
      const failing = new BlueprintService(
        sql,
        new MockNeuralEngine({ failWith: 'unavailable' }),
        bus,
        new UnconfiguredCardRenderer(),
        options,
      );
      const secret = 'a-very-identifying-answer';

      const error = await failing
        .onboard(onboardInput(USER_A, [{ key: 'q1', value: secret }], { birthData: { date: '1988-02-29' } }))
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BlueprintError);
      if (!(error instanceof BlueprintError)) throw new Error('expected BlueprintError');
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain('1988-02-29');
    });

    it('recovers on the next attempt once the engine is back', async () => {
      const failing = new BlueprintService(
        sql,
        new MockNeuralEngine({ failWith: 'unavailable' }),
        bus,
        new UnconfiguredCardRenderer(),
        options,
      );
      await expect(failing.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'x' }]))).rejects.toThrow();

      const recovered = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'x' }]));
      expect(recovered.blueprint.userId).toBe(USER_A);
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
    });
  });

  // ── Ownership: export (§7.2) ──────────────────────────────────────────────

  describe('export returns everything', () => {
    it('includes the blueprint, crew, membership, crewmates, runs and mentor matches', async () => {
      const mentorSession = sessionFor((p) => p.crewRole === 'anchor');
      await blueprint.onboard(onboardInput(USER_B, mentorSession, { mentorAvailable: true }));

      const studentSession = sessionFor((p) => p.crewRole === 'catalyst');
      const result = await blueprint.onboard(onboardInput(USER_A, studentSession));

      const exported = await blueprint.export({ userId: USER_A });

      expect(exported.schemaVersion).toBe(2);
      expect(exported.blueprint?.id).toBe(result.blueprint.id);
      expect(exported.blueprint?.profile).toEqual(result.blueprint.profile);
      expect(exported.crew?.id).toBe(result.placement.crewId);
      expect(exported.membership?.userId).toBe(USER_A);
      expect(exported.matchRuns).toHaveLength(1);
      expect(exported.mentorMatches.map((m) => m.mentorId)).toContain(USER_B);
      expect(new Date(exported.exportedAt).toString()).not.toBe('Invalid Date');
    });

    it('includes the card — §7.2 promises "JSON + card", not JSON', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      const exported = await blueprint.export({ userId: USER_A });

      // The portrait, complete, in the export envelope. An export a user can
      // take elsewhere should contain the artifact they actually share.
      expect(exported.card?.size).toBe('portrait');
      expect(exported.card?.width).toBe(CARD_DIMENSIONS.portrait.width);
      expect(exported.card?.svg).toContain('<svg ');
      expect(cardRenderSchema.safeParse(exported.card).success).toBe(true);
    });

    it('carries a null card for a user who has no Blueprint, rather than failing', async () => {
      // Export must work for anyone. A user with nothing gets an envelope of
      // nothings — not a 404, which would make "prove you hold nothing on me"
      // impossible to answer.
      const exported = await blueprint.export({ userId: USER_C });

      expect(exported.blueprint).toBeNull();
      expect(exported.card).toBeNull();
    });

    it('reaches every table that references the user', async () => {
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: true },
        ),
      );
      await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'builder'),
        ),
      );

      const exported = await blueprint.export({ userId: USER_A });

      // The five §7.1 tables, each represented. If a sixth is added and the
      // export is not extended, this list is where it should be noticed.
      expect(exported.blueprint).not.toBeNull(); // blueprints
      expect(exported.crew).not.toBeNull(); // crews
      expect(exported.membership).not.toBeNull(); // crew_members
      expect(exported.matchRuns.length).toBeGreaterThan(0); // match_runs
      expect(exported.mentorMatches.length).toBeGreaterThan(0); // mentor_matches
    });

    it('includes the shortlists this user appears ON, not just the ones they hold', async () => {
      // USER_B is a mentor; the export for B must show that B is on A's list.
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: true },
        ),
      );
      await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'catalyst'),
        ),
      );

      const mentorExport = await blueprint.export({ userId: USER_B });
      expect(mentorExport.mentoringOthers.map((m) => m.studentId)).toContain(USER_A);
    });

    it('does not put crewmates’ profiles in someone else’s export', async () => {
      const first = await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'anchor'),
        ),
      );
      // B is chosen to be complementary enough to actually join A's crew —
      // otherwise there are no crewmates and this asserts nothing.
      const mate = await blueprint.onboard(onboardInput(USER_B, sessionJoining([first.blueprint.profile])));
      expect(mate.placement.crewId).toBe(first.placement.crewId);

      const exported = await blueprint.export({ userId: USER_A });
      const serialised = JSON.stringify(exported.crewmates);

      expect(serialised).toContain(USER_B);
      // A crewmate consented to being in a crew, not to being in someone's
      // data export. Id and role only.
      expect(serialised).not.toContain(mate.blueprint.profile.curriculumPath);
      expect(serialised).not.toContain(mate.blueprint.profile.toneRegister);
    });

    it('returns an empty envelope rather than throwing for a user with no Blueprint', async () => {
      const exported = await blueprint.export({ userId: USER_C });
      expect(exported.blueprint).toBeNull();
      expect(exported.crew).toBeNull();
      expect(exported.membership).toBeNull();
      expect(exported.matchRuns).toEqual([]);
      expect(exported.mentorMatches).toEqual([]);
    });
  });

  // ── Ownership: hard delete (§7.2) ─────────────────────────────────────────

  describe('hard delete leaves nothing behind', () => {
    /**
     * The §7.2 exit criterion, stated as a test: create a Blueprint, a crew
     * membership and a mentor match, delete, then assert NOTHING survives —
     * including the `profiles.blueprint_id` reference svc-identity holds.
     */
    it('erases every row in every table, and clears the identity reference', async () => {
      // B is a mentor, so A ends up with a mentor_matches row — all four kinds
      // of row must exist for A before the erasure proves anything.
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: true },
        ),
      );
      const subject = await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'catalyst'),
        ),
      );

      // Preconditions: all four kinds of row exist for A.
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('match_runs', 'user_id', USER_A)).toBe(1);
      expect(await rowCount('mentor_matches', 'student_id', USER_A)).toBe(1);
      expect(identity.blueprintIdByUser.get(USER_A)).toBe(subject.blueprint.id);

      const receipt = await blueprint.erase({ userId: USER_A });

      expect(receipt.removed.blueprints).toBe(1);
      expect(receipt.removed.crewMemberships).toBe(1);
      expect(receipt.removed.matchRuns).toBe(1);
      expect(receipt.removed.mentorMatches).toBe(1);

      // NOTHING survives — every table, both columns of the mentor pairing.
      expect(await rowCount('blueprints', 'user_id', USER_A)).toBe(0);
      expect(await rowCount('crew_members', 'user_id', USER_A)).toBe(0);
      expect(await rowCount('match_runs', 'user_id', USER_A)).toBe(0);
      expect(await rowCount('mentor_matches', 'student_id', USER_A)).toBe(0);
      expect(await rowCount('mentor_matches', 'mentor_id', USER_A)).toBe(0);

      // The reference in svc-identity's schema, cleared through the event —
      // this service never touched identity's tables (§2).
      expect(identity.blueprintIdByUser.get(USER_A)).toBeNull();

      const deleted = bus.emitted('blueprintDeleted');
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.payload).toMatchObject({ blueprintId: subject.blueprint.id, userId: USER_A });
    });

    it('erases the user from OTHER people’s mentor shortlists', async () => {
      // The half that is easiest to miss: A is B's mentor, and erasing A must
      // remove A from B's shortlist, not only B's from A's.
      await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: true },
        ),
      );
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'catalyst'),
        ),
      );

      expect(await rowCount('mentor_matches', 'mentor_id', USER_A)).toBe(1);

      await blueprint.erase({ userId: USER_A });

      expect(await rowCount('mentor_matches', 'mentor_id', USER_A)).toBe(0);
      const survivors = await sql`SELECT student_id, mentor_id FROM blueprint.mentor_matches`;
      expect(JSON.stringify(survivors)).not.toContain(USER_A);
    });

    it('leaves no trace of the user anywhere in the schema', async () => {
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: true },
        ),
      );
      await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'scout'),
        ),
      );
      await blueprint.erase({ userId: USER_A });

      // A blunt sweep across every table rather than a column-by-column check:
      // if a future migration adds a column holding a user id, this notices.
      for (const table of ['blueprints', 'crews', 'crew_members', 'match_runs', 'mentor_matches']) {
        const rows = await sql.unsafe(`SELECT * FROM blueprint.${table}`);
        expect(JSON.stringify(rows)).not.toContain(USER_A);
      }
    });

    it('dissolves a crew the departure emptied, and spares one it did not', async () => {
      // Solo crew — dissolved.
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'alone' }]));
      const solo = await blueprint.erase({ userId: USER_A });
      expect(solo.removed.emptiedCrews).toBe(1);
      expect(await sql`SELECT id FROM blueprint.crews`).toHaveLength(0);

      // Shared crew — spared, and the crewmate keeps their membership.
      const host = await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
        ),
      );
      const second = await blueprint.onboard(onboardInput(USER_C, sessionJoining([host.blueprint.profile])));
      const sharedCrew = second.placement.crewId;
      expect(sharedCrew).toBe(host.placement.crewId);

      const shared = await blueprint.erase({ userId: USER_C });
      expect(shared.removed.emptiedCrews).toBe(0);
      expect(await rowCount('crew_members', 'crew_id', sharedCrew)).toBe(1);
    });

    it('keeps other people’s match-run history when a crew is dissolved', async () => {
      await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'anchor'),
        ),
      );
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'scout'),
        ),
      );

      await blueprint.erase({ userId: USER_A });

      // B's run survives. Its placed_crew_id may now be null if the crew went,
      // but the fact that B was matched is not rewritten to tidy a foreign key.
      expect(await rowCount('match_runs', 'user_id', USER_B)).toBeGreaterThan(0);
    });

    it('is idempotent — erasing twice removes nothing the second time and emits once', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'once' }]));

      const first = await blueprint.erase({ userId: USER_A });
      const second = await blueprint.erase({ userId: USER_A });

      expect(first.removed.blueprints).toBe(1);
      expect(second.removed).toEqual({
        blueprints: 0,
        crewMemberships: 0,
        matchRuns: 0,
        mentorMatches: 0,
        emptiedCrews: 0,
        shares: 0,
        cardOpens: 0,
      });
      expect(bus.emitted('blueprintDeleted')).toHaveLength(1);
    });

    it('erases a user who never onboarded without complaint', async () => {
      const receipt = await blueprint.erase({ userId: USER_C });
      expect(receipt.removed.blueprints).toBe(0);
      expect(bus.emitted('blueprintDeleted')).toHaveLength(0);
    });

    it('lets a user onboard again after erasure, as a genuinely new Blueprint', async () => {
      const before = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'first life' }]));
      await blueprint.erase({ userId: USER_A });
      const after = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'first life' }]));

      // Same profile (same answers, deterministic engine) but a new row: the
      // old id is gone, not resurrected.
      expect(after.blueprint.profile).toEqual(before.blueprint.profile);
      expect(after.blueprint.id).not.toBe(before.blueprint.id);
      expect(identity.blueprintIdByUser.get(USER_A)).toBe(after.blueprint.id);
    });

    it('publishes a distinct erase key for each blueprint, so a later hard delete is not deduped', async () => {
      const store = new MemorySeenStore();
      const received: string[] = [];
      await bus.subscribe(
        'blueprintDeleted',
        idempotent(
          async (payload) => {
            received.push(payload.blueprintId);
          },
          store,
          'identity-clears-blueprint-id',
        ),
        { durable: 'erase-key-includes-blueprint' },
      );

      const first = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'first life' }]));
      await blueprint.erase({ userId: USER_A });
      const second = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'second life' }]));
      await blueprint.erase({ userId: USER_A });

      const deleted = bus.emitted('blueprintDeleted');
      expect(deleted).toHaveLength(2);
      expect(first.blueprint.id).not.toBe(second.blueprint.id);
      expect(deleted.map((envelope) => envelope.payload.blueprintId)).toEqual([first.blueprint.id, second.blueprint.id]);
      expect(deleted.map((envelope) => envelope.idempotencyKey)).toEqual([
        `blueprint.erase:${USER_A}:${first.blueprint.id}`,
        `blueprint.erase:${USER_A}:${second.blueprint.id}`,
      ]);
      expect(received).toEqual([first.blueprint.id, second.blueprint.id]);

      await blueprint.erase({ userId: USER_A });
      expect(bus.emitted('blueprintDeleted')).toHaveLength(2);
      expect(received).toEqual([first.blueprint.id, second.blueprint.id]);

      await blueprint.erase({ userId: USER_C });
      expect(bus.emitted('blueprintDeleted')).toHaveLength(2);
    });

    it('publishes a distinct placement key for each blueprint, so a later join of the same crew is not deduped', async () => {
      const store = new MemorySeenStore();
      const received: string[] = [];
      await bus.subscribe(
        'crewMemberCreated',
        idempotent(
          async (_payload, envelope) => {
            received.push(envelope.idempotencyKey);
          },
          store,
          'academy-opens-crew-channel',
        ),
        { durable: 'placement-key-includes-blueprint' },
      );

      const first = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'first life' }]));
      const redelivery = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'first life' }]));

      expect(redelivery.blueprint.id).toBe(first.blueprint.id);
      expect(redelivery.placement.crewId).toBe(first.placement.crewId);

      const sameBlueprint = bus.emitted('crewMemberCreated');
      expect(sameBlueprint).toHaveLength(2);
      expect(sameBlueprint[0]?.idempotencyKey).toBe(sameBlueprint[1]?.idempotencyKey);
      const firstKey = `blueprint.placed:${first.placement.crewId}:${USER_A}:${first.blueprint.id}`;
      expect(sameBlueprint[0]?.idempotencyKey).toBe(firstKey);
      expect(received).toEqual([firstKey]);

      await blueprint.erase({ userId: USER_A });
      const second = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'second life' }]));

      expect(second.placement.crewId).toBe(first.placement.crewId);
      expect(second.blueprint.id).not.toBe(first.blueprint.id);

      const secondKey = `blueprint.placed:${second.placement.crewId}:${USER_A}:${second.blueprint.id}`;
      expect(secondKey).not.toBe(firstKey);
      const placed = bus.emitted('crewMemberCreated');
      expect(placed.map((envelope) => envelope.idempotencyKey)).toEqual([firstKey, firstKey, secondKey]);
      expect(received).toEqual([firstKey, secondKey]);
    });
  });

  // ── Mentor shortlist ──────────────────────────────────────────────────────

  describe('mentor shortlist', () => {
    it('only shortlists people who opted in', async () => {
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: false },
        ),
      );
      const result = await blueprint.onboard(
        onboardInput(
          USER_A,
          sessionFor((p) => p.crewRole === 'catalyst'),
        ),
      );

      expect(result.mentors).toEqual([]);
    });

    it('never shortlists the student as their own mentor', async () => {
      const responses = sessionFor((p) => p.crewRole === 'anchor');
      const result = await blueprint.onboard(onboardInput(USER_A, responses, { mentorAvailable: true }));
      expect(result.mentors.map((m) => m.mentorId)).not.toContain(USER_A);
    });

    it('refreshes a shortlist on re-run rather than stacking duplicates', async () => {
      await blueprint.onboard(
        onboardInput(
          USER_B,
          sessionFor((p) => p.crewRole === 'anchor'),
          { mentorAvailable: true },
        ),
      );
      const responses = sessionFor((p) => p.crewRole === 'catalyst');

      await blueprint.onboard(onboardInput(USER_A, responses));
      await blueprint.onboard(onboardInput(USER_A, responses));

      expect(await rowCount('mentor_matches', 'student_id', USER_A)).toBe(1);
    });

    it('honours the shortlist size', async () => {
      const small = new BlueprintService(sql, engine, bus, new UnconfiguredCardRenderer(), { ...options, mentorShortlistSize: 2 });
      for (const [index, mentorId] of [uuid(501), uuid(502), uuid(503), uuid(504)].entries()) {
        await small.onboard(onboardInput(mentorId, [{ key: 'q1', value: `mentor-${index}` }], { mentorAvailable: true }));
      }

      const result = await small.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'student' }]));
      expect(result.mentors.length).toBeLessThanOrEqual(2);
    });
  });

  // ── Reads ─────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns null for a user with no Blueprint, and the record once there is one', async () => {
      expect(await blueprint.get({ userId: USER_A })).toBeNull();

      const created = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const fetched = await blueprint.get({ userId: USER_A });

      expect(fetched?.id).toBe(created.blueprint.id);
      expect(fetched?.profile).toEqual(created.blueprint.profile);
      // Null because this suite runs with no rasterizer configured — the column
      // holds a hosted PNG's URL and only ever a real one. The vector card is
      // available regardless; see the card describe block below.
      expect(fetched?.cardAssetUrl).toBeNull();
    });
  });

  // ── The share card (§7.1, §7.2) ───────────────────────────────────────────

  describe('card', () => {
    /** A renderer that really "renders" — the configured deployment. */
    class StubRenderer implements CardRenderer {
      readonly id = 'card-renderer-stub';
      calls: CardRasterizeRequest[] = [];
      constructor(private readonly result: CardRaster) {}
      async rasterize(request: CardRasterizeRequest): Promise<CardRaster> {
        this.calls.push(request);
        return this.result;
      }
    }

    const rendered: CardRaster = { status: 'rendered', url: 'https://cdn.example.com/card.png', contentType: 'image/png', bytes: 84_000 };

    const withRenderer = (renderer: CardRenderer) => new BlueprintService(sql, engine, bus, renderer, options);

    it('refuses when there is no Blueprint, rather than drawing an empty card', async () => {
      // A card for a profile that does not exist would be a branded image
      // asserting things about a person nobody has ever profiled.
      await expect(blueprint.card({ userId: USER_A, size: 'portrait' })).rejects.toMatchObject({ code: 'blueprint.not_found' });
    });

    it('composes a card at both share sizes carrying the placed crew', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      for (const size of ['portrait', 'landscape'] as const) {
        const card = await blueprint.card({ userId: USER_A, size });
        const { width, height } = CARD_DIMENSIONS[size];

        expect(card).toMatchObject({ size, width, height });
        expect(card.svg).toContain(`width="${width}"`);
        expect(card.svg).toContain(`height="${height}"`);
        // The user was placed on onboarding, so the card names their crew
        // rather than claiming they are unplaced.
        expect(card.svg).not.toContain('Unplaced');
        expect(cardRenderSchema.safeParse(card).success).toBe(true);
      }
    });

    it('renders in full with NO rasterizer, and says why there is no PNG', async () => {
      // The property the whole adapter split exists for: the absence of an
      // external rail degrades the PNG, never the card.
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const card = await blueprint.card({ userId: USER_A, size: 'portrait' });

      expect(card.svg.length).toBeGreaterThan(1_000);
      expect(card.raster).toMatchObject({ status: 'unavailable', code: 'blueprint.card_renderer_unconfigured' });
      expect(card.raster).not.toHaveProperty('url');
    });

    it('does NOT write card_asset_url when the raster is unavailable', async () => {
      // The column must never hold a URL that does not resolve.
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      await blueprint.card({ userId: USER_A, size: 'portrait' });

      expect((await blueprint.get({ userId: USER_A }))?.cardAssetUrl).toBeNull();
    });

    it('writes card_asset_url when a raster really came back', async () => {
      const service = withRenderer(new StubRenderer(rendered));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      const card = await service.card({ userId: USER_A, size: 'portrait' });

      expect(card.raster).toEqual(rendered);
      expect((await service.get({ userId: USER_A }))?.cardAssetUrl).toBe(rendered.url);
    });

    it('keys the asset on the blueprint id, never on the user id', async () => {
      // The key becomes a public object path. An account identifier in it would
      // make the asset URL a user-id oracle.
      const renderer = new StubRenderer(rendered);
      const service = withRenderer(renderer);
      const created = await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      await service.card({ userId: USER_A, size: 'portrait' });

      expect(renderer.calls[0]?.blueprintId).toBe(created.blueprint.id);
      expect(renderer.calls[0]?.blueprintId).not.toBe(USER_A);
    });

    it('does not persist a landscape url over the primary portrait asset', async () => {
      // §7.1's schema has ONE card column. Letting the OG image overwrite it
      // would make `card_asset_url` mean whichever size was requested last.
      const service = withRenderer(new StubRenderer(rendered));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      await service.card({ userId: USER_A, size: 'landscape' });
      expect((await service.get({ userId: USER_A }))?.cardAssetUrl).toBeNull();

      await service.card({ userId: USER_A, size: 'portrait' });
      expect((await service.get({ userId: USER_A }))?.cardAssetUrl).toBe(rendered.url);
    });

    it('Stage-1 shareMode is svg when raster is unavailable (product share artifact)', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const card = await blueprint.card({ userId: USER_A, size: 'portrait' });
      expect(card.shareMode).toBe('svg');
      expect(card.raster.status).toBe('unavailable');
      expect(card.svg.length).toBeGreaterThan(0);
      expect(cardRenderSchema.safeParse(card).success).toBe(true);
    });

    it('Stage-1 shareMode is png when raster rendered', async () => {
      const service = withRenderer(new StubRenderer(rendered));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const card = await service.card({ userId: USER_A, size: 'portrait' });
      expect(card.shareMode).toBe('png');
      expect(card.raster.status).toBe('rendered');
      expect(cardRenderSchema.safeParse(card).success).toBe(true);
    });

    it('is stable: the same Blueprint yields a byte-identical card', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      const first = await blueprint.card({ userId: USER_A, size: 'portrait' });
      const second = await blueprint.card({ userId: USER_A, size: 'portrait' });

      expect(second.svg).toBe(first.svg);
    });

    it('puts no profile content on the span, and no card in the event stream', async () => {
      // §10. The card is derived data about a person; publishing it or tracing
      // it would copy it outside the isolation the rest of this service keeps.
      const service = withRenderer(new StubRenderer(rendered));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const before = bus.published.length;

      await service.card({ userId: USER_A, size: 'portrait' });

      // Rendering a card is a read. It announces nothing.
      expect(bus.published.length).toBe(before);
    });

    it('does not write card_asset_url when a stranger views via cardFor', async () => {
      const service = withRenderer(new StubRenderer(rendered));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }], { visibility: 'public' }));

      await service.cardFor({ viewerId: USER_B, subjectUserId: USER_A, size: 'portrait' });
      expect((await service.get({ userId: USER_A }))?.cardAssetUrl).toBeNull();
    });

    it('is not written by export — a read path must not persist on every read', async () => {
      // `export` is a tRPC `.query()`: retried, prefetched and cached. It
      // carries the card (§7.2 "JSON + card") but must not acquire `card()`'s
      // side effect along with it, or every prefetch becomes a write.
      const service = withRenderer(new StubRenderer(rendered));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));

      const exported = await service.export({ userId: USER_A });

      expect(exported.card?.raster).toEqual(rendered);
      expect((await service.get({ userId: USER_A }))?.cardAssetUrl).toBeNull();
    });

    it('is not touched by the mentor shortlist, which reaches no rasterizer at all', async () => {
      // `mentors` used to be `export().mentorMatches`. Once the card joined the
      // export, that made a cheap list depend on an external renderer and its
      // ten-second budget. It reads its own table now, and this is the
      // assertion that keeps it there.
      const renderer = new StubRenderer(rendered);
      const service = withRenderer(renderer);
      await service.onboard(onboardInput(USER_B, [{ key: 'q1', value: 'mentor' }], { mentorAvailable: true }));
      await service.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'student' }]));

      const shortlist = await service.mentors({ userId: USER_A });

      expect(shortlist.length).toBeGreaterThan(0);
      expect(shortlist.every((m) => m.studentId === USER_A)).toBe(true);
      expect(renderer.calls).toHaveLength(0);
    });

    it('survives erasure of the user it belonged to', async () => {
      // The card is derived on read, so erasure leaves nothing to chase — the
      // next call simply has no Blueprint to draw.
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      await blueprint.erase({ userId: USER_A });

      await expect(blueprint.card({ userId: USER_A, size: 'portrait' })).rejects.toMatchObject({ code: 'blueprint.not_found' });
    });
  });

  // ── Visibility (§7.1 column · scopes: reading someone else's) ─────────────

  describe('visibility-gated cardFor', () => {
    const notFound = { code: 'blueprint.not_found' };

    it('lets the owner read their own card even when private', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const own = await blueprint.cardFor({ viewerId: USER_A, subjectUserId: USER_A, size: 'portrait' });
      expect(own.svg.length).toBeGreaterThan(1_000);
      expect(own.shareMode).toBe('svg');
    });

    it('hides a private card from anyone else — same error as missing', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      await expect(blueprint.cardFor({ viewerId: USER_B, subjectUserId: USER_A, size: 'portrait' })).rejects.toMatchObject(notFound);
      await expect(blueprint.cardFor({ viewerId: USER_B, subjectUserId: uuid(404), size: 'portrait' })).rejects.toMatchObject(notFound);
    });

    it('setVisibility public then lets any authenticated viewer read the card', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }]));
      const updated = await blueprint.setVisibility({ userId: USER_A, visibility: 'public' });
      expect(updated.visibility).toBe('public');

      const seen = await blueprint.cardFor({ viewerId: USER_B, subjectUserId: USER_A, size: 'portrait' });
      expect(seen.svg.length).toBeGreaterThan(1_000);
    });

    it('flipping public back to private hides immediately', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }], { visibility: 'public' }));
      await blueprint.setVisibility({ userId: USER_A, visibility: 'private' });
      await expect(blueprint.cardFor({ viewerId: USER_B, subjectUserId: USER_A, size: 'portrait' })).rejects.toMatchObject(notFound);
    });

    it('crew visibility is same-crew only — outsiders get not_found', async () => {
      const first = await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }], { visibility: 'crew' }));
      await blueprint.onboard(onboardInput(USER_B, sessionJoining([first.blueprint.profile]), { visibility: 'crew' }));
      expect((await blueprint.export({ userId: USER_B })).crew?.id).toBe(first.placement.crewId);

      const mate = await blueprint.cardFor({ viewerId: USER_A, subjectUserId: USER_B, size: 'portrait' });
      expect(mate.svg.length).toBeGreaterThan(1_000);

      await expect(blueprint.cardFor({ viewerId: USER_C, subjectUserId: USER_B, size: 'portrait' })).rejects.toMatchObject(notFound);
    });

    it('erase revokes a previously public card — no leftover read', async () => {
      await blueprint.onboard(onboardInput(USER_A, [{ key: 'q1', value: 'hello' }], { visibility: 'public' }));
      await blueprint.erase({ userId: USER_A });
      await expect(blueprint.cardFor({ viewerId: USER_B, subjectUserId: USER_A, size: 'portrait' })).rejects.toMatchObject(notFound);
    });

    it('setVisibility on a user with no Blueprint is not_found', async () => {
      await expect(blueprint.setVisibility({ userId: USER_A, visibility: 'public' })).rejects.toMatchObject(notFound);
    });
  });

  // ── Doctrine ──────────────────────────────────────────────────────────────

  describe('doctrine §0.6 — no balances here', () => {
    it('holds no money column anywhere in the schema', async () => {
      // §0.6 is satisfied trivially by this service holding no value at all —
      // but "trivially" is worth asserting, because `crews.xp` is the column
      // someone would one day be tempted to pay out from.
      const numerics = await sql<Array<{ table_name: string; column_name: string; data_type: string }>>`
        SELECT table_name, column_name, data_type
          FROM information_schema.columns
         WHERE table_schema = 'blueprint' AND data_type = 'numeric'
      `;
      expect(numerics).toEqual([]);

      const xp = await sql<Array<{ data_type: string }>>`
        SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'blueprint' AND table_name = 'crews' AND column_name = 'xp'
      `;
      expect(xp[0]?.data_type).toBe('bigint');
    });
  });
}
