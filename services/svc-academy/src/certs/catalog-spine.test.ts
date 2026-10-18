/**
 * Every cert required slug must exist on the curriculum spine.
 * Without this, grantCert can be permanently incomplete after a silent rename.
 */
import { describe, expect, it } from 'vitest';
import { hasCurriculumSlug } from '../curriculum/catalog.js';
import { listCertCatalog } from './catalog.js';
import { listXpPolicyCertIds, xpPolicyCatalogConsistent, xpPolicyGhostCertIds } from './xp-policy.js';

describe('cert catalog ↔ curriculum spine integrity', () => {
  it('every requiredItemSlug exists on the platform-native curriculum spine', () => {
    const missing: string[] = [];
    for (const cert of listCertCatalog()) {
      for (const slug of cert.requiredItemSlugs) {
        if (slug.startsWith('assessment:')) continue;
        if (!hasCurriculumSlug(slug)) missing.push(`${cert.id}:${slug}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every XP policy cert is grantable (no ghost policies)', () => {
    expect(xpPolicyCatalogConsistent()).toBe(true);
    expect(xpPolicyGhostCertIds()).toEqual([]);
    for (const id of listXpPolicyCertIds()) {
      expect(listCertCatalog().some((c) => c.id === id)).toBe(true);
    }
  });

  it('required set is non-empty for every cert (no empty-shell grant)', () => {
    for (const cert of listCertCatalog()) {
      expect(cert.requiredItemSlugs.length).toBeGreaterThan(0);
    }
  });
});
