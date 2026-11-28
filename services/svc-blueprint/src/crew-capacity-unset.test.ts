/**
 * Unit card — forming a crew / writing a shortlist refuses unpublished knobs
 *
 * 1. Promise: omitted / invalid capacity → blueprint.crew_capacity_unset
 *    (no invented 6). Same for mentor shortlist (3) and season (1).
 *    Owner-explicit 6 / 3 / 1 are published numbers, not git defaults.
 * 2. Break: constructor `?? 6` / `?? 3` / `?? 1` lets blank look published.
 * 3. Done bar: helper refuse before SQL; source has no `?? 6`.
 * 4. Class M
 * 5. Paths: blueprint-service.ts publishedCrewCapacity / publishedMentorShortlistSize / publishedSeason
 * 6. RED: unset helper returns 6 / 3 / 1 or source git-defaults them
 */
import { describe, expect, it } from 'vitest';
import { publishedCrewCapacity, publishedMentorShortlistSize, publishedSeason } from './blueprint-service.js';

describe('unpublished crew / mentor / season knobs', () => {
  it('unset / NaN / 0 / 25 refuse capacity — never invent 6', () => {
    for (const value of [undefined, Number.NaN, 0, 1, 25] as const) {
      try {
        publishedCrewCapacity(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: 'blueprint.crew_capacity_unset' });
      }
    }
  });

  it('owner-published 6 is the crew size', () => {
    expect(publishedCrewCapacity(6)).toBe(6);
  });

  it('unset / NaN / 0 / 11 refuse shortlist — never invent 3', () => {
    for (const value of [undefined, Number.NaN, 0, 11] as const) {
      try {
        publishedMentorShortlistSize(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: 'blueprint.mentor_shortlist_unset' });
      }
    }
  });

  it('owner-published 3 is the shortlist length', () => {
    expect(publishedMentorShortlistSize(3)).toBe(3);
  });

  it('unset / NaN / 0 refuse season — never invent 1', () => {
    for (const value of [undefined, Number.NaN, 0] as const) {
      try {
        publishedSeason(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: 'blueprint.season_unset' });
      }
    }
  });

  it('owner-published 1 is the season', () => {
    expect(publishedSeason(1)).toBe(1);
  });
});
