import { describe, expect, it } from 'vitest';
import {
  PROGRAMME_CATALOG,
  PROGRAMME_SLUGS,
  ProgrammeCatalogError,
  assertProgrammeCatalog,
  type ProgrammeDefinition,
} from './programmes.js';
import { metricFromCount } from '../learning/metrics.js';
import { ACADEMY_CUSTOMER_LIST_MAX, TOUCH_LESSON_MAX_SECONDS } from '../learning/limits.js';
import { getVideoSpineItem } from '../video/catalog.js';

describe('programme catalog', () => {
  it('ships an empty prerequisite list on every path', () => {
    expect(PROGRAMME_CATALOG.map((p) => p.slug)).toEqual([...PROGRAMME_SLUGS]);
    expect(PROGRAMME_CATALOG.every((p) => p.prerequisites.length === 0)).toBe(true);
  });

  it('fails when a prerequisite slug is not a programme', () => {
    const bad: ProgrammeDefinition[] = PROGRAMME_SLUGS.map((slug) =>
      slug === 'markets' ? { slug, prerequisites: ['not-a-programme'] } : { slug, prerequisites: [] },
    );
    expect(() => assertProgrammeCatalog(bad)).toThrow(ProgrammeCatalogError);
    expect(() => assertProgrammeCatalog(bad)).toThrow(/unknown prerequisite slug: not-a-programme/);
  });
});

describe('recorded versus unrecorded metrics', () => {
  it('an unrecorded metric is null with its reason, and a recorded zero stays zero', () => {
    expect(metricFromCount(0, false)).toEqual({ value: null, reason: 'metric_not_recorded' });
    expect(metricFromCount(undefined, true)).toEqual({ value: 0, reason: null });
  });
});

describe('named bounds', () => {
  it('publishes the list cap and the touch-seconds cap', () => {
    expect(ACADEMY_CUSTOMER_LIST_MAX).toBe(200);
    expect(TOUCH_LESSON_MAX_SECONDS).toBe(86_400);
  });

  it('leaves video metadata null until the owner sets it', () => {
    const video = getVideoSpineItem('foundations-risk-first');
    expect(video?.durationSeconds).toBeNull();
    expect(video?.thumbnailUrl).toBeNull();
    expect(video?.language).toBeNull();
    expect(video?.captionsUrl).toBeNull();
  });
});
