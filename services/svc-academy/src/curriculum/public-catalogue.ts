/**
 * AC-catalogue-01 — the signed-out catalogue: the published spine, filtered and sorted, with no learner data.
 *
 * Until courses are rows (AC-course-structure-01) the shipped list order is the `recommended` order. A query
 * matches title and summary, case-folded; an empty query matches everything. No search service is involved.
 */
import { ACADEMY_CURRICULUM_PATHS, type AcademyPublicCatalogueSort as PublicCatalogueSort } from '@intafaced/contracts';
import { publishedCourse } from './course-enrolment.js';
import { getCurriculumItem, listCurriculum, type CurriculumItemSummary, type CurriculumKind, type CurriculumPath } from './catalog.js';

export function searchPublicCurriculum(input: {
  readonly q?: string;
  readonly path?: CurriculumPath;
  readonly kind?: CurriculumKind;
  readonly sort?: PublicCatalogueSort;
  readonly limit: number;
}): CurriculumItemSummary[] {
  const needle = (input.q ?? '').trim().toLocaleLowerCase('en');
  const rows = listCurriculum({
    ...(input.path ? { path: input.path } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  }).filter((row) => !needle || row.title.toLocaleLowerCase('en').includes(needle) || row.summary.toLocaleLowerCase('en').includes(needle));
  const sort = input.sort ?? 'recommended';
  if (sort !== 'recommended') {
    rows.sort((a, b) => a.title.localeCompare(b.title, 'en') || a.slug.localeCompare(b.slug));
    if (sort === 'name_desc') rows.reverse();
  }
  return rows.slice(0, input.limit);
}

const COURSES: readonly CurriculumPath[] = ACADEMY_CURRICULUM_PATHS;

/** AC-catalogue-03 — one card per course with published items. Until courses are rows, a course is one curriculum path. */
export function listPublicCourses(): { slug: CurriculumPath; items: number; estimatedMinutes: number }[] {
  return COURSES.map((slug) => ({ slug, rows: listCurriculum({ path: slug }) }))
    .filter(({ rows }) => rows.length > 0)
    .map(({ slug, rows }) => ({ slug, items: rows.length, estimatedMinutes: rows.reduce((sum, row) => sum + row.estimatedMinutes, 0) }));
}

/**
 * The public course page. Summary and instructor stay null: nobody has written them for a path, and none is invented.
 * Outcomes are the objectives of the lessons a visitor can open, once each, in syllabus order. An unknown course and a course with no
 * published item give the same `academy.course_not_found`, so a draft is never told apart from a missing one.
 */
export async function publicCourse(
  slug: string,
  certificateTitle: (path: CurriculumPath) => string | null,
  opensSignedOut: (itemSlug: string) => Promise<boolean>,
): Promise<{
  slug: CurriculumPath;
  summary: null;
  instructor: null;
  outcomes: string[];
  syllabus: CurriculumItemSummary[];
  certificate: string | null;
}> {
  const path = publishedCourse(slug);
  const syllabus = listCurriculum({ path });
  // A lesson the signed-out reader would refuse keeps its objectives behind that refusal; its title stays in the syllabus.
  const open = await Promise.all(syllabus.map((row) => opensSignedOut(row.slug)));
  const outcomes = [...new Set(syllabus.flatMap((row, i) => (open[i] ? (getCurriculumItem(row.slug)?.objectives ?? []) : [])))];
  return { slug: path, summary: null, instructor: null, outcomes, syllabus, certificate: certificateTitle(path) };
}
