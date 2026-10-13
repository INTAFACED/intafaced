import type { BlueprintProfile, CrewRole } from '@intafaced/contracts';
import { deterministicUuid, digest, pick } from '../deterministic.js';

/**
 * CREW MATCHING — "complementary-profile heuristics" (§7.1).
 *
 * Pure. No I/O, no clock, no randomness. Every function in this file is a
 * total function of its arguments, which is what makes the guarantee testable:
 *
 *     the same user, scored against the same crews, is placed in the same crew.
 *
 * ── Why complementary and not similar ───────────────────────────────────────
 * A crew of four people who all decide analytically, all wake at dawn and all
 * learn by reading is a crew with one perspective and four voices. The whole
 * value of a crew is that someone in it sees what you do not. So the score
 * rewards *difference* — a candidate scores highest against the crew that
 * shares least with them.
 *
 * ── Why categorical axes and integer basis points ───────────────────────────
 * The axes are categories, not positions on a line: 'intuitive' is not
 * two-thirds of the way to 'decisive', and pretending otherwise would invent a
 * geometry the engine never claimed. So "difference" means "not equal", and the
 * score is a weighted count.
 *
 * The count is then scaled to basis points with integer division. Not because
 * floats would be non-deterministic (IEEE 754 is deterministic), but because
 * the score is persisted in `match_runs.scores`, compared across processes and
 * asserted on in tests — and an integer says exactly what it is in all three
 * places, with no formatting question and no `0.30000000000000004`.
 */

/** The axes a crew is balanced on, most consequential first. */
export const CREW_AXES = ['crewRole', 'decisionStyle', 'riskTemperament', 'energyRhythm', 'learningMode'] as const;
export type CrewAxis = (typeof CREW_AXES)[number];

/**
 * Axis weights.
 *
 * `crewRole` dominates because it is the axis a crew most visibly needs spread
 * on — four builders and no anchor is a crew that ships nothing and notices
 * nobody. Decision style and risk temperament are the axes that produce useful
 * argument. Rhythm and learning mode matter, but a crew that disagrees about
 * when to wake up is a scheduling problem, not a blind spot.
 */
export const AXIS_WEIGHTS: Readonly<Record<CrewAxis, number>> = {
  crewRole: 3,
  decisionStyle: 2,
  riskTemperament: 2,
  energyRhythm: 1,
  learningMode: 1,
};

const TOTAL_WEIGHT = Object.values(AXIS_WEIGHTS).reduce((a, b) => a + b, 0);

/** Scores are basis points: 10000 = shares nothing, 0 = shares everything. */
export const SCORE_SCALE = 10_000;

/**
 * What an empty crew scores.
 *
 * This is the one genuinely arbitrary number here, so it gets stated plainly:
 * a crew with no members has nothing to complement, so there is no principled
 * score to compute — only a policy about when forming a new crew beats joining
 * an existing one.
 *
 * 6000 means: a fresh crew beats a crew that shares more than ~40% of a
 * candidate's weighted profile, and loses to any crew that is genuinely
 * complementary. That keeps people out of echo chambers without shattering the
 * population into crews of one — which is what a high value would do, and which
 * would make the entire crew feature inert at launch when every crew is small.
 */
export const EMPTY_CREW_SCORE = 6_000;

/** The subset of a profile matching reads. Nothing else influences placement. */
export type MatchableProfile = Pick<BlueprintProfile, CrewAxis>;

export interface CrewCandidate {
  readonly crewId: string;
  readonly capacity: number;
  /**
   * Members whose blueprint profile is present, so they can be scored.
   * Order does not affect the score. A seat with no profile is absent here
   * and still counted in `occupied`.
   */
  readonly members: readonly MatchableProfile[];
  /** Every `crew_members` row. Fullness uses this, the same set as capacity enforcement. */
  readonly occupied: number;
}

export interface ScoredCrew {
  readonly crewId: string;
  /** 0–10000 basis points of complementarity. */
  readonly score: number;
  readonly size: number;
}

export function isFull(candidate: CrewCandidate): boolean {
  return candidate.occupied >= candidate.capacity;
}

/**
 * Complementarity of `profile` against one crew, in basis points.
 *
 * For each axis: the fraction of members who do NOT share the candidate's value,
 * weighted. Summed, scaled, floored. A crew of clones scores 0; a crew sharing
 * nothing scores 10000.
 *
 * The arithmetic is deliberately done as one integer division at the end rather
 * than per-axis, so no rounding error accumulates and the maximum is exactly
 * 10000 rather than 9998.
 */
export function complementarity(profile: MatchableProfile, members: readonly MatchableProfile[]): number {
  if (members.length === 0) return EMPTY_CREW_SCORE;

  let weighted = 0;
  for (const axis of CREW_AXES) {
    const differing = members.reduce((acc, member) => acc + (member[axis] === profile[axis] ? 0 : 1), 0);
    weighted += AXIS_WEIGHTS[axis] * differing;
  }

  return Math.floor((weighted * SCORE_SCALE) / (members.length * TOTAL_WEIGHT));
}

/**
 * Rank every open crew for a candidate.
 *
 * Full crews are excluded here rather than scored and skipped later, so a full
 * crew cannot win a placement that then has to be rejected downstream.
 *
 * **The tie-break is the load-bearing part of this function.** Equal scores are
 * common — most crews are small and many share the same shape — and the order
 * `Array.prototype.sort` leaves equal elements in is stable but depends on the
 * order rows came back from Postgres, which is not guaranteed without an ORDER
 * BY and is not stable across a vacuum. Breaking ties on `crewId` makes the
 * result a function of the *set* of candidates, not of the sequence they
 * arrived in.
 */
export function rankCrews(profile: MatchableProfile, candidates: readonly CrewCandidate[]): ScoredCrew[] {
  return candidates
    .filter((candidate) => !isFull(candidate))
    .map((candidate) => ({
      crewId: candidate.crewId,
      score: complementarity(profile, candidate.members),
      size: candidate.members.length,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      // Prefer the fuller crew at equal complementarity: a crew of four that is
      // as complementary as a crew of one is the better placement, because the
      // score already says the difference is there and joining it puts the
      // candidate among more people rather than fewer.
      if (a.size !== b.size) return b.size - a.size;
      return a.crewId < b.crewId ? -1 : a.crewId > b.crewId ? 1 : 0;
    });
}

export interface CrewChoice {
  readonly crewId: string;
  readonly score: number;
  readonly ranked: readonly ScoredCrew[];
}

/**
 * Choose a crew, or return null when the caller should form a new one.
 *
 * Null means one of two things, and deliberately does not distinguish them:
 * every crew is full, or **no crew is good enough**. The second is the case
 * `formThreshold` exists for. Without it, a candidate whose only open crew is
 * three people identical to them would be placed there — the echo chamber the
 * complementarity score was written to avoid — because "best available" is not
 * the same question as "good enough".
 *
 * The threshold defaults to `EMPTY_CREW_SCORE`, which is what makes that
 * constant mean one thing in both places it is used: a crew scoring below what
 * an empty crew scores is, by definition, worse than starting fresh.
 *
 * Returning null rather than inventing an id keeps this file pure — id
 * generation needs a namespace and belongs with the code that knows about
 * seasons.
 */
export function chooseCrew(
  profile: MatchableProfile,
  candidates: readonly CrewCandidate[],
  formThreshold: number = EMPTY_CREW_SCORE,
): CrewChoice | null {
  const ranked = rankCrews(profile, candidates);
  const best = ranked[0];
  if (!best || best.score < formThreshold) return null;
  return { crewId: best.crewId, score: best.score, ranked };
}

// ── Naming a new crew ────────────────────────────────────────────────────────

/**
 * Crew name vocabulary.
 *
 * Deliberately abstract — constellations, currents, signals. Two constraints
 * shaped this list: it must contain no partner, vendor or model name (Doctrine
 * §0.7, and this is precisely the kind of user-visible string that gets one
 * typed into it), and it must not accidentally read as a rank, a tier or a
 * jurisdiction, because a crew name is not a status.
 */
const CREW_PREFIXES = [
  'Meridian',
  'Vector',
  'Halcyon',
  'Lumen',
  'Cinder',
  'Tessera',
  'Verge',
  'Quorum',
  'Solstice',
  'Aperture',
  'Bastion',
  'Cadence',
  'Drift',
  'Ember',
  'Fathom',
  'Gradient',
] as const;

const CREW_SUFFIXES = [
  'Circuit',
  'Current',
  'Signal',
  'Array',
  'Cohort',
  'Lattice',
  'Chorus',
  'Compass',
  'Foundry',
  'Beacon',
  'Cascade',
  'Anchorage',
] as const;

/**
 * A crew's name, derived from its id. Same id, same name, forever — including
 * after a restore from backup, which a name column populated by a counter would
 * not survive.
 */
export function crewName(crewId: string): string {
  const seed = digest('crew-name', crewId);
  return `${pick(CREW_PREFIXES, seed, 0)} ${pick(CREW_SUFFIXES, seed, 1)}`;
}

/**
 * The id a newly formed crew gets.
 *
 * Derived from the season and the founding member, NOT generated. Two
 * concurrent onboarding runs that both find every crew full compute different
 * ids (different founders) and correctly form two crews; the same run retried
 * computes the SAME id, collides on the primary key, and forms one. With
 * `gen_random_uuid()` a retry after a network blip would leave a stranded
 * empty crew behind every time.
 */
export function newCrewId(season: number, founderUserId: string): string {
  return deterministicUuid(`crew:s${season}`, founderUserId);
}

/** Roles a crew is missing — what the lobby shows as "we could use a…". */
export function missingRoles(members: readonly MatchableProfile[]): CrewRole[] {
  const present = new Set(members.map((m) => m.crewRole));
  return (['anchor', 'scout', 'builder', 'catalyst'] as const).filter((role) => !present.has(role));
}
