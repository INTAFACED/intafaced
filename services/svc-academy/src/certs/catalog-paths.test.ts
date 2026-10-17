/**
 * Certificate catalog paths. Markets, Builder and Sovereign have no
 * owner-published definition. foundations-v1 keeps its seven lessons.
 */
import { describe, expect, it } from 'vitest';
import { hasCurriculumSlug } from '../curriculum/catalog.js';
import { FOUNDATIONS_V1, assertCertCatalog, certificateForPath, listCertCatalog, CertCatalogError } from './catalog.js';

const LESSONS = [
  'foundations-risk-first',
  'foundations-order-types',
  'foundations-paper-workbook',
  'foundations-position-sizing',
  'foundations-journal-discipline',
  'foundations-invalidation-first',
  'foundations-fees-are-real',
];

describe('certificate catalog paths', () => {
  it('keeps foundations-v1 and publishes no other path', () => {
    expect(FOUNDATIONS_V1.requiredItemSlugs).toEqual(LESSONS);
    expect(FOUNDATIONS_V1.path).toBe('foundations');
    expect(listCertCatalog().map((row) => row.id)).toEqual(['foundations-v1']);
    expect(certificateForPath('foundations')?.id).toBe('foundations-v1');
    expect(certificateForPath('markets')).toBeNull();
    expect(certificateForPath('builder')).toBeNull();
    expect(certificateForPath('sovereign')).toBeNull();
  });

  it('rejects a certificate that names an unknown lesson or assessment', () => {
    const known = { lesson: hasCurriculumSlug, assessment: () => false };
    expect(() =>
      assertCertCatalog([{ id: 'bad-lesson', title: 'Bad', path: 'markets', requiredItemSlugs: ['no-such-lesson'] }], known),
    ).toThrow(CertCatalogError);
    expect(() =>
      assertCertCatalog([{ id: 'bad-assessment', title: 'Bad', path: 'builder', requiredItemSlugs: ['assessment:no-such'] }], known),
    ).toThrow(CertCatalogError);
    expect(() => assertCertCatalog(listCertCatalog(), known)).not.toThrow();
  });
});
