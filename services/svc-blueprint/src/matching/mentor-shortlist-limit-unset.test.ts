/**
 * Unit card — shortlistMentors unset refuse (no invented 3)
 *
 * 1. Promise: omitted / undefined / null limit throws (never invent 3).
 *    Owner-explicit 3 is a published window, not a git default.
 * 2. Break: `shortlistMentors(..., limit = 3)` still invented shortlist length
 *    after BLUEPRINT_MENTOR_SHORTLIST_SIZE mill.
 * 3. Done bar: unset/null throw; 3 reads; mentor-matching.ts has no
 *    `limit = 3` on shortlistMentors.
 * 4. Class N
 * 5. Paths: matching/mentor-matching.ts shortlistMentors()
 * 6. RED: omitting limit returns a 3-entry shortlist
 */
import { describe, expect, it } from 'vitest';
import { shortlistMentors, type MentorCandidate, type MentorProfile } from './mentor-matching.js';

const STUDENT: MentorProfile = {
  crewRole: 'scout',
  decisionStyle: 'intuitive',
  riskTemperament: 'bold',
  energyRhythm: 'nocturnal',
  learningMode: 'narrative',
};

const IDEAL: MentorProfile = {
  crewRole: 'anchor',
  decisionStyle: 'analytical',
  riskTemperament: 'guarded',
  energyRhythm: 'nocturnal',
  learningMode: 'narrative',
};

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const candidates: MentorCandidate[] = [
  { userId: uuid(1), profile: STUDENT },
  { userId: uuid(2), profile: IDEAL },
  { userId: uuid(3), profile: { ...IDEAL, learningMode: 'systematic' } },
  { userId: uuid(4), profile: { ...IDEAL, riskTemperament: STUDENT.riskTemperament } },
];

describe('shortlistMentors limit refuse-closed', () => {
  it('unset limit refuses (no invent 3)', () => {
    expect(() => shortlistMentors(uuid(99), STUDENT, candidates)).toThrow(/refuse to invent 3/);
    expect(() => shortlistMentors(uuid(99), STUDENT, candidates, undefined)).toThrow(/refuse to invent 3/);
  });

  it('null limit refuses (no invent 3)', () => {
    expect(() => shortlistMentors(uuid(99), STUDENT, candidates, null)).toThrow(/refuse to invent 3/);
  });

  it('owner-explicit 3 is published (not invented)', () => {
    const shortlist = shortlistMentors(uuid(99), STUDENT, candidates, 3);
    expect(shortlist).toHaveLength(3);
    expect(shortlist[0]?.mentorId).toBe(uuid(2));
  });
});
