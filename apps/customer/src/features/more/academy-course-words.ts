import type { AcademyPublishedCourseCard } from '@intafaced/contracts/academy-courses';
import type { academyLmsCopy as copy } from './academy-lms-copy';

/** The stored price in words: free, the owner-set figure, or that none is set. */
export function priceText(t: (typeof copy)['t'], course: Pick<AcademyPublishedCourseCard, 'pricing' | 'price' | 'priceAsset'>): string {
  if (course.pricing === 'free') return t('linkedPriceFree');
  return course.price && course.priceAsset ? t('linkedPrice', { price: course.price, asset: course.priceAsset }) : t('linkedPriceUnset');
}
