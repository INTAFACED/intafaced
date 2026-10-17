/**
 * Certification definitions Stage-1 — code-seeded catalog (no DB).
 *
 * Spec: docs/ops/trk/academy.certs.md Stage 1.
 * Required items are curriculum slugs, or `assessment:<slug>` for a published
 * assessment. XP policy is Stage-2 shipped for priced certs only; perks stay
 * identity rank SoT; no ledger here.
 *
 * Markets, Builder and Sovereign can each carry one certificate. A definition
 * is added only when the owner has published the required lessons and rules
 * in this repo. None of those three paths has a published definition, so
 * `certProgress` and `enrollCertPath` for them refuse
 * `academy.certificate_unpublished`.
 */

import { hasCurriculumSlug } from '../curriculum/catalog.js';
import { ASSESSMENT_CATALOG, assessmentBySlug } from '../assessment/catalog.js';
import type { CertDefinition, CertPath } from './progress.js';

/** Foundations path cert — all foundations curriculum items on tip. */
export const FOUNDATIONS_V1: CertDefinition = {
  id: 'foundations-v1',
  title: 'Foundations',
  path: 'foundations',
  requiredItemSlugs: [
    'foundations-risk-first',
    'foundations-order-types',
    'foundations-paper-workbook',
    'foundations-position-sizing',
    'foundations-journal-discipline',
    'foundations-invalidation-first',
    'foundations-fees-are-real',
  ],
};

/**
 * Owner-published certificates. Markets, Builder and Sovereign are absent
 * until the owner writes their definitions here.
 */
export const CERT_CATALOG: readonly CertDefinition[] = [FOUNDATIONS_V1];

export class CertCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertCatalogError';
  }
}

const CERT_PATHS: readonly CertPath[] = ['foundations', 'markets', 'builder', 'sovereign'];

export function assertCertCatalog(
  defs: readonly CertDefinition[],
  known: {
    lesson: (slug: string) => boolean;
    assessment: (slug: string) => boolean;
  } = {
    lesson: hasCurriculumSlug,
    assessment: (slug) => assessmentBySlug(slug, ASSESSMENT_CATALOG) !== null,
  },
): void {
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const def of defs) {
    if (!def.id || !def.title?.trim() || ids.has(def.id)) {
      throw new CertCatalogError(`certificate ${def.id || '(blank)'} is blank or duplicated`);
    }
    ids.add(def.id);
    if (!def.path || !CERT_PATHS.includes(def.path)) {
      throw new CertCatalogError(`${def.id} has no path among foundations, markets, builder, sovereign`);
    }
    if (paths.has(def.path)) {
      throw new CertCatalogError(`two certificates on path ${def.path}`);
    }
    paths.add(def.path);
    if (def.requiredItemSlugs.length === 0) {
      throw new CertCatalogError(`${def.id} has no requirements`);
    }
    for (const slug of def.requiredItemSlugs) {
      if (slug.startsWith('assessment:')) {
        const assessment = slug.slice('assessment:'.length);
        if (!assessment || assessment.includes(':') || !known.assessment(assessment)) {
          throw new CertCatalogError(`${def.id} names unknown assessment ${slug}`);
        }
      } else if (!known.lesson(slug)) {
        throw new CertCatalogError(`${def.id} names unknown lesson ${slug}`);
      }
    }
  }
}

assertCertCatalog(CERT_CATALOG);

export function certById(id: string, catalog: readonly CertDefinition[] = CERT_CATALOG): CertDefinition | null {
  return catalog.find((c) => c.id === id) ?? null;
}

export function certificateForPath(path: string, catalog: readonly CertDefinition[] = CERT_CATALOG): CertDefinition | null {
  return catalog.find((c) => c.path === path) ?? null;
}

export function listCertCatalog(catalog: readonly CertDefinition[] = CERT_CATALOG): readonly CertDefinition[] {
  return catalog;
}
