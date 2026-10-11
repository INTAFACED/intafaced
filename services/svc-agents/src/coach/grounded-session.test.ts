import { describe, expect, it } from 'vitest';
import { assertNotAdvice, inventedLibraryTitles, looksLikeAdvice, runCoachSession, type CoachGrounding } from './grounded-session.js';

const spine: CoachGrounding = {
  licensedLibraryImported: false,
  items: [{ slug: 'foundations-risk-first', title: 'Risk first' }],
};

const licensed: CoachGrounding = {
  licensedLibraryImported: true,
  items: [
    { slug: 'foundations-risk-first', title: 'Risk first' },
    { slug: 'markets-spot-path', title: 'Spot path' },
  ],
};

describe('coach grounded session — empty is a chatbot, not a coach', () => {
  it('refuses an empty catalog — not a chatbot session', () => {
    const result = runCoachSession({
      ask: 'explain risk',
      grounding: { items: [], licensedLibraryImported: false },
    });
    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'curriculum_empty',
      kind: 'not_advice',
      isAdvice: false,
      inventedLibrary: false,
      citedCount: 0,
    });
    expect(looksLikeAdvice(result)).toBe(false);
    assertNotAdvice(result);
  });

  it('production default grounding is empty — public door is refuse, not invention', () => {
    const result = runCoachSession({ ask: 'teach me markets' });
    expect(result.status).toBe('refuse');
    if (result.status !== 'refuse') return;
    expect(result.reason).toBe('curriculum_empty');
    expect(result.licensedLibraryImported).toBe(false);
  });

  it('refuses position-grounded asks — owner has not ruled', () => {
    expect(runCoachSession({ ask: 'should I close my BTC position?', grounding: spine })).toMatchObject({
      status: 'refuse',
      reason: 'positions_not_decided',
      positionsReferenced: false,
    });
    expect(runCoachSession({ ask: 'explain risk', includePositions: true, grounding: spine })).toMatchObject({
      reason: 'positions_not_decided',
    });
  });

  it('refuses asAdvice so a citation cannot become a recommendation', () => {
    expect(runCoachSession({ requestedSlug: 'foundations-risk-first', asAdvice: true, grounding: spine })).toMatchObject({
      status: 'refuse',
      reason: 'advice_forbidden',
    });
  });

  it('refuses a slug that is not in the catalog — no invented library titles', () => {
    const result = runCoachSession({ requestedSlug: 'deriv-desk-secret-playbook-19', grounding: spine });
    expect(result).toMatchObject({ status: 'refuse', reason: 'invented_library', inventedLibrary: false });
    expect(inventedLibraryTitles(result)).toBe(false);
  });

  it('cites an existing spine slug without claiming the licensed library imported', () => {
    const result = runCoachSession({ requestedSlug: 'foundations-risk-first', grounding: spine });
    expect(result.status).toBe('grounded');
    if (result.status !== 'grounded') return;
    expect(result.kind).toBe('citation');
    expect(result.isAdvice).toBe(false);
    expect(result.licensedLibraryImported).toBe(false);
    expect(result.citations).toEqual([{ slug: 'foundations-risk-first', title: 'Risk first' }]);
    expect(result).not.toHaveProperty('recommendation');
    assertNotAdvice(result);
  });

  it('refuses a free-text ask while the licensed library is still pending', () => {
    const result = runCoachSession({ ask: 'walk the whole library', grounding: spine });
    expect(result).toMatchObject({ status: 'refuse', reason: 'library_import_pending', licensedLibraryImported: false });
  });

  it('cites catalog rows only once a licensed import is declared on the seam', () => {
    const result = runCoachSession({ ask: 'start here', grounding: licensed });
    expect(result.status).toBe('grounded');
    if (result.status !== 'grounded') return;
    expect(result.licensedLibraryImported).toBe(true);
    expect(result.citedCount).toBeGreaterThan(0);
    expect(result.citations.every((c) => licensed.items.some((i) => i.slug === c.slug))).toBe(true);
    assertNotAdvice(result);
  });

  it('a blank ask with a present catalog is not an empty curriculum', () => {
    const licensedResult = runCoachSession({ ask: '', grounding: licensed });
    expect(licensedResult.status).toBe('grounded');
    if (licensedResult.status !== 'grounded') return;
    expect(licensedResult.citedCount).toBe(licensed.items.length);
    expect(licensedResult.citations).toEqual([
      { slug: 'foundations-risk-first', title: 'Risk first' },
      { slug: 'markets-spot-path', title: 'Spot path' },
    ]);
    expect(licensedResult.licensedLibraryImported).toBe(true);
    assertNotAdvice(licensedResult);

    expect(runCoachSession({ ask: '   ', grounding: spine })).toMatchObject({
      status: 'refuse',
      reason: 'library_import_pending',
      licensedLibraryImported: false,
      citedCount: 0,
    });
  });

  it('a blank ask still refuses when the catalog is actually empty', () => {
    expect(
      runCoachSession({
        ask: '',
        grounding: { items: [], licensedLibraryImported: true },
      }),
    ).toMatchObject({
      status: 'refuse',
      reason: 'curriculum_empty',
      citedCount: 0,
      licensedLibraryImported: true,
    });
  });

  it('fails if a session is dressed as advice or a live recommendation', () => {
    expect(looksLikeAdvice({ status: 'grounded', kind: 'advice', isAdvice: true })).toBe(true);
    expect(looksLikeAdvice({ status: 'ok', positionsReferenced: true })).toBe(true);
    expect(() =>
      assertNotAdvice({
        status: 'grounded',
        kind: 'advice',
        isAdvice: true,
        positionsReferenced: false,
        licensedLibraryImported: false,
        inventedLibrary: false,
        citedCount: 0,
        citations: [],
        userMessageKey: 'agents.error.capability_unavailable',
      } as never),
    ).toThrow(/advice/);
  });
});
