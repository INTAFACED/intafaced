/**
 * Published catalogue rows.
 *
 * Until course rows exist (AC-course-structure-01), the shipped spine is the
 * published, listed catalogue. There is no draft to hide and no author to
 * invent: `author` is null on every spine row.
 */
import { getCurriculumItem, listCurriculum, type CurriculumKind, type CurriculumPath } from '../curriculum/catalog.js';

export type CatalogueItem = {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly path: CurriculumPath;
  readonly kind: CurriculumKind | 'quiz' | 'assignment';
  readonly order: number;
  readonly estimatedMinutes: number;
  readonly author: string | null;
  readonly body: string;
};

export type CatalogueCard = {
  readonly slug: string;
  readonly title: string;
  readonly kind: CurriculumKind;
  readonly path: CurriculumPath;
  readonly order: number;
  readonly summary: string;
  readonly estimatedMinutes: number;
};

export function spineCatalogueItems(): readonly CatalogueItem[] {
  return listCurriculum().map((summary) => {
    const item = getCurriculumItem(summary.slug);
    if (!item) throw new Error(`catalogue: spine slug ${summary.slug} has no item`);
    return {
      slug: item.slug,
      title: item.title,
      summary: item.summary,
      path: item.path,
      kind: item.kind,
      order: item.order,
      estimatedMinutes: item.estimatedMinutes,
      author: null,
      body: item.body,
    };
  });
}

export function toCard(item: CatalogueItem): CatalogueCard {
  if (item.kind === 'quiz' || item.kind === 'assignment') {
    throw new Error(`catalogue: ${item.slug} is not a catalogue card`);
  }
  return {
    slug: item.slug,
    title: item.title,
    kind: item.kind,
    path: item.path,
    order: item.order,
    summary: item.summary,
    estimatedMinutes: item.estimatedMinutes,
  };
}
