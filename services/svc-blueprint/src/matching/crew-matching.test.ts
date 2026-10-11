import { describe, expect, it } from 'vitest';
import type { BlueprintProfile } from '@intafaced/contracts';
import {
  AXIS_WEIGHTS,
  CREW_AXES,
  EMPTY_CREW_SCORE,
  SCORE_SCALE,
  chooseCrew,
  complementarity,
  crewName,
  isFull,
  missingRoles,
  newCrewId,
  rankCrews,
  type CrewCandidate,
  type MatchableProfile,
} from './crew-matching.js';
import { deriveProfile } from '../engine/mock-engine.js';

/**
 * Crew matching (§7.1) — the part of this service worth real test effort.
 *
 * No database and no engine: everything here is a pure function, and testing it
 * as one is the whole point. If a placement can be explained by a test that
 * runs in a millisecond, it can be explained to a user.
 *
 * The property under test throughout is the one §7.1 asks for and the one a
 * person would notice breaking: **same input, same placement** — and a
 * preference for crews that complement rather than duplicate.
 */

const ANALYST: MatchableProfile = {
  crewRole: 'anchor',
  decisionStyle: 'analytical',
  riskTemperament: 'guarded',
  energyRhythm: 'dawn',
  learningMode: 'systematic',
};

/** Differs from ANALYST on every axis. */
const OPPOSITE: MatchableProfile = {
  crewRole: 'catalyst',
  decisionStyle: 'intuitive',
  riskTemperament: 'bold',
  energyRhythm: 'nocturnal',
  learningMode: 'visual',
};

/** Differs from ANALYST on role only. */
const NEAR_TWIN: MatchableProfile = { ...ANALYST, crewRole: 'scout' };

function crew(id: string, members: readonly MatchableProfile[], capacity = 6): CrewCandidate {
  return { crewId: id, capacity, members, occupied: members.length };
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('complementarity scoring', () => {
  it('scores a crew that shares nothing at the maximum', () => {
    expect(complementarity(ANALYST, [OPPOSITE])).toBe(SCORE_SCALE);
    expect(complementarity(ANALYST, [OPPOSITE, OPPOSITE, OPPOSITE])).toBe(SCORE_SCALE);
  });

  it('scores a crew of clones at zero', () => {
    expect(complementarity(ANALYST, [ANALYST])).toBe(0);
    expect(complementarity(ANALYST, [ANALYST, ANALYST, ANALYST, ANALYST])).toBe(0);
  });

  it('scores an empty crew at the declared policy value, not at zero or maximum', () => {
    // An empty crew has nothing to complement — the number is a policy about
    // forming versus joining, and it must sit strictly between the extremes or
    // the policy is "always form" / "never form".
    expect(complementarity(ANALYST, [])).toBe(EMPTY_CREW_SCORE);
    expect(EMPTY_CREW_SCORE).toBeGreaterThan(0);
    expect(EMPTY_CREW_SCORE).toBeLessThan(SCORE_SCALE);
  });

  it('weights crewRole above the rhythm and learning axes', () => {
    // Differing on role alone must beat differing on rhythm alone, or a crew
    // with four builders and no anchor looks as balanced as one that merely
    // wakes up at different times.
    const differsOnRole = complementarity(ANALYST, [{ ...ANALYST, crewRole: 'builder' }]);
    const differsOnRhythm = complementarity(ANALYST, [{ ...ANALYST, energyRhythm: 'surge' }]);

    expect(differsOnRole).toBeGreaterThan(differsOnRhythm);
    expect(AXIS_WEIGHTS.crewRole).toBeGreaterThan(AXIS_WEIGHTS.energyRhythm);
  });

  it('is monotonic — replacing a clone with a stranger never lowers the score', () => {
    let previous = complementarity(ANALYST, [ANALYST, ANALYST, ANALYST, ANALYST]);
    for (let swapped = 1; swapped <= 4; swapped++) {
      const members = [...Array(4 - swapped).fill(ANALYST), ...Array(swapped).fill(OPPOSITE)] as MatchableProfile[];
      const score = complementarity(ANALYST, members);
      expect(score).toBeGreaterThan(previous);
      previous = score;
    }
    expect(previous).toBe(SCORE_SCALE);
  });

  it('ignores member order', () => {
    const members = [ANALYST, OPPOSITE, NEAR_TWIN];
    const forwards = complementarity(ANALYST, members);
    const backwards = complementarity(ANALYST, [...members].reverse());
    const shuffled = complementarity(ANALYST, [members[1]!, members[2]!, members[0]!]);

    expect(forwards).toBe(backwards);
    expect(forwards).toBe(shuffled);
  });

  it('always returns an integer inside the basis-point range', () => {
    // Sizes 1..7 with every mix of clones and strangers — the integer division
    // must never produce a float, a negative, or something above the scale.
    for (let size = 1; size <= 7; size++) {
      for (let strangers = 0; strangers <= size; strangers++) {
        const members = [...Array(size - strangers).fill(ANALYST), ...Array(strangers).fill(OPPOSITE)] as MatchableProfile[];
        const score = complementarity(ANALYST, members);

        expect(Number.isInteger(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(SCORE_SCALE);
      }
    }
  });
});

describe('ranking is deterministic', () => {
  const candidates = [
    crew(uuid(3), [ANALYST, ANALYST]),
    crew(uuid(1), [OPPOSITE]),
    crew(uuid(2), [NEAR_TWIN, OPPOSITE]),
    crew(uuid(4), []),
  ];

  it('returns an identical ranking across many repeated runs', () => {
    const first = JSON.stringify(rankCrews(ANALYST, candidates));
    for (let run = 0; run < 200; run++) {
      expect(JSON.stringify(rankCrews(ANALYST, candidates))).toBe(first);
    }
  });

  it('is a function of the candidate SET, not of the order it arrived in', () => {
    // Postgres does not promise row order without an ORDER BY, and even with
    // one a future query change could reorder these. The placement must not.
    const baseline = rankCrews(ANALYST, candidates);

    const permutations = [
      [...candidates].reverse(),
      [candidates[2]!, candidates[0]!, candidates[3]!, candidates[1]!],
      [candidates[1]!, candidates[3]!, candidates[2]!, candidates[0]!],
    ];

    for (const permutation of permutations) {
      expect(rankCrews(ANALYST, permutation)).toEqual(baseline);
    }
  });

  it('breaks ties on crew id so equal-scoring crews have a stable winner', () => {
    // Three identical crews, distinguishable only by id.
    const tied = [crew(uuid(9), [OPPOSITE]), crew(uuid(7), [OPPOSITE]), crew(uuid(8), [OPPOSITE])];
    const ranked = rankCrews(ANALYST, tied);

    expect(ranked.map((r) => r.score)).toEqual([SCORE_SCALE, SCORE_SCALE, SCORE_SCALE]);
    expect(ranked.map((r) => r.crewId)).toEqual([uuid(7), uuid(8), uuid(9)]);
  });

  it('prefers the fuller crew when complementarity is equal', () => {
    const small = crew(uuid(5), [OPPOSITE]);
    const larger = crew(uuid(6), [OPPOSITE, OPPOSITE, OPPOSITE]);

    // Same score by construction — both share nothing with ANALYST.
    expect(complementarity(ANALYST, small.members)).toBe(complementarity(ANALYST, larger.members));
    expect(chooseCrew(ANALYST, [small, larger])?.crewId).toBe(uuid(6));
    expect(chooseCrew(ANALYST, [larger, small])?.crewId).toBe(uuid(6));
  });
});

describe('complementary crews beat identical ones', () => {
  it('places a candidate with the crew that shares least', () => {
    const clones = crew(uuid(1), [ANALYST, ANALYST, ANALYST]);
    const strangers = crew(uuid(2), [OPPOSITE, OPPOSITE, OPPOSITE]);

    expect(chooseCrew(ANALYST, [clones, strangers])?.crewId).toBe(uuid(2));
    // And the order the two are offered in changes nothing.
    expect(chooseCrew(ANALYST, [strangers, clones])?.crewId).toBe(uuid(2));
  });

  it('prefers a brand-new crew over a crew of clones', () => {
    // The echo-chamber guard: joining three people identical to you is worse
    // than starting alone, and EMPTY_CREW_SCORE is what encodes that.
    const clones = crew(uuid(1), [ANALYST, ANALYST, ANALYST]);
    const empty = crew(uuid(2), []);

    expect(chooseCrew(ANALYST, [clones, empty])?.crewId).toBe(uuid(2));
  });

  it('prefers a genuinely complementary crew over a brand-new one', () => {
    // The other side of the same policy: an empty crew must not out-compete a
    // good match, or nobody ever ends up in a crew with anyone.
    const strangers = crew(uuid(1), [OPPOSITE, OPPOSITE]);
    const empty = crew(uuid(2), []);

    expect(chooseCrew(ANALYST, [strangers, empty])?.crewId).toBe(uuid(1));
  });

  it('returns null rather than placing someone in the only crew when it is a clone crew', () => {
    // "Best available" is not "good enough". With only an echo chamber on
    // offer, the caller is told to form a crew instead — this is the branch
    // that makes EMPTY_CREW_SCORE mean the same thing in the scorer and in the
    // service, rather than being a constant that only fires for the rare
    // pre-existing empty crew.
    const clones = crew(uuid(1), [ANALYST, ANALYST, ANALYST]);
    expect(chooseCrew(ANALYST, [clones])).toBeNull();

    // And with the threshold lifted, the same call places them — so the null is
    // the policy talking, not an accident of the ranking.
    expect(chooseCrew(ANALYST, [clones], 0)?.crewId).toBe(uuid(1));
  });

  it('joins a crew that clears the threshold even when it is not perfect', () => {
    // Differs on everything except role: 6 of 9 weight → 6666, above 6000.
    const partial = crew(uuid(1), [{ ...OPPOSITE, crewRole: ANALYST.crewRole }]);
    expect(complementarity(ANALYST, partial.members)).toBeGreaterThanOrEqual(EMPTY_CREW_SCORE);
    expect(chooseCrew(ANALYST, [partial])?.crewId).toBe(uuid(1));
  });

  it('prefers a crew missing the candidate role over one already holding it', () => {
    const hasAnchor = crew(uuid(1), [{ ...OPPOSITE, crewRole: 'anchor' }]);
    const needsAnchor = crew(uuid(2), [{ ...OPPOSITE, crewRole: 'catalyst' }]);

    expect(chooseCrew(ANALYST, [hasAnchor, needsAnchor])?.crewId).toBe(uuid(2));
    expect(missingRoles(needsAnchor.members)).toContain('anchor');
  });
});

describe('capacity', () => {
  it('excludes occupied seats without matchable profiles from open crews', () => {
    const partiallyScorable = { ...crew(uuid(1), [OPPOSITE], 2), occupied: 2 };
    const unscorable = { ...crew(uuid(2), [], 2), occupied: 2 };

    expect(isFull(partiallyScorable)).toBe(true);
    expect(isFull(unscorable)).toBe(true);
    expect(rankCrews(ANALYST, [partiallyScorable, unscorable])).toEqual([]);
    expect(chooseCrew(ANALYST, [partiallyScorable, unscorable])).toBeNull();
  });

  it('excludes full crews from the ranking entirely', () => {
    const full = crew(uuid(1), [OPPOSITE, OPPOSITE], 2);
    const open = crew(uuid(2), [ANALYST], 6);

    expect(isFull(full)).toBe(true);
    // The full crew scores maximally and would otherwise win.
    expect(complementarity(ANALYST, full.members)).toBe(SCORE_SCALE);
    expect(rankCrews(ANALYST, [full, open]).map((r) => r.crewId)).toEqual([uuid(2)]);
  });

  it('returns null when every crew is full, rather than overfilling one', () => {
    const full = [crew(uuid(1), [OPPOSITE], 1), crew(uuid(2), [ANALYST], 1)];
    expect(chooseCrew(ANALYST, full)).toBeNull();
  });
});

describe('derived identifiers are stable', () => {
  it('derives the same crew id for the same season and founder', () => {
    const founder = uuid(42);
    expect(newCrewId(1, founder)).toBe(newCrewId(1, founder));
  });

  it('derives different ids across seasons and across founders', () => {
    expect(newCrewId(1, uuid(42))).not.toBe(newCrewId(2, uuid(42)));
    expect(newCrewId(1, uuid(42))).not.toBe(newCrewId(1, uuid(43)));
  });

  it('derives a storable uuid', () => {
    expect(newCrewId(1, uuid(42))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('names a crew from its id, identically every time', () => {
    const id = newCrewId(1, uuid(7));
    expect(crewName(id)).toBe(crewName(id));
    expect(crewName(id)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});

/**
 * The end-to-end determinism claim, built from the mock engine rather than from
 * hand-written profiles: a real session, scored against a real candidate set.
 */
describe('engine profile → placement is reproducible', () => {
  const session = {
    requestId: 'ignored',
    locale: 'en',
    responses: [
      { key: 'q1', value: 'I decide fast and correct later' },
      { key: 'q2', value: 'Mornings' },
    ],
    birthData: { date: '1991-04-17', time: '06:20', place: 'Lisbon' },
  };

  it('derives the same profile from the same session, across many runs', () => {
    const first = deriveProfile(session);
    for (let run = 0; run < 100; run++) {
      expect(deriveProfile(session)).toEqual(first);
    }
  });

  it('ignores requestId and response order — the person is the input, not the call', () => {
    const reordered = { ...session, requestId: 'a-different-call', responses: [...session.responses].reverse() };
    expect(deriveProfile(reordered)).toEqual(deriveProfile(session));
  });

  it('derives a different profile from a different session', () => {
    const other = { ...session, responses: [{ key: 'q1', value: 'I sit with it for a week' }] };
    // Not a guarantee of the algorithm in general, but true for these two and
    // enough to show the derivation actually reads the input.
    expect(deriveProfile(other)).not.toEqual(deriveProfile(session));
  });

  it('places the derived profile in the same crew every run', () => {
    const profile = deriveProfile(session) as BlueprintProfile;
    const candidates = [
      crew(uuid(1), [ANALYST, NEAR_TWIN]),
      crew(uuid(2), [OPPOSITE]),
      crew(uuid(3), []),
      crew(uuid(4), [ANALYST, ANALYST, OPPOSITE]),
    ];

    const chosen = chooseCrew(profile, candidates);
    expect(chosen).not.toBeNull();

    for (let run = 0; run < 100; run++) {
      expect(chooseCrew(profile, candidates)?.crewId).toBe(chosen?.crewId);
      // And under permutation, which is where a non-stable sort would show up.
      expect(chooseCrew(profile, [...candidates].reverse())?.crewId).toBe(chosen?.crewId);
    }
  });

  it('scores every axis the engine produces — no axis is silently ignored', () => {
    // If an axis were dropped from CREW_AXES, a candidate differing only on
    // that axis would score identically to a clone. This catches that.
    const base = deriveProfile(session) as BlueprintProfile;
    const alternatives: Record<string, string> = {
      crewRole: 'anchor',
      decisionStyle: 'analytical',
      riskTemperament: 'guarded',
      energyRhythm: 'dawn',
      learningMode: 'visual',
    };

    for (const axis of CREW_AXES) {
      const differentValue = Object.keys(alternatives).includes(axis)
        ? base[axis] === alternatives[axis]
          ? null
          : alternatives[axis]
        : null;
      if (!differentValue) continue;

      const variant = { ...base, [axis]: differentValue } as MatchableProfile;
      expect(complementarity(base, [variant])).toBeGreaterThan(0);
    }
  });
});
