/**
 * AC-articles-02 — related items for the reader. Until topics exist, related
 * means "same path", in shipped order, excluding the item itself. None → [].
 */
import { AcademyError } from '../errors.js';
import { getCurriculumItem, listCurriculum, type CurriculumItemSummary } from './catalog.js';

export function relatedItems(slug: string, limit: number): CurriculumItemSummary[] {
  const item = getCurriculumItem(slug);
  if (!item) throw new AcademyError(`Curriculum item "${slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
  return listCurriculum({ path: item.path })
    .filter((i) => i.slug !== slug)
    .slice(0, limit);
}
