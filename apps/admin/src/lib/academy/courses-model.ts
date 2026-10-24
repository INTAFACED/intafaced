import type { AcademyCourse, AcademyCourseDetail, AcademyCourseList } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * The Academy course desk (AC-course-structure-01): the courses staff created, one course with its history, and the
 * create and publish steps. Pure, so the server loader, the route and the browser components share it.
 */
export type { AcademyCourse, AcademyCourseDetail, AcademyCourseList };

export const COURSE_PAGE = 100;

export interface CourseListView {
  readonly list: Part<AcademyCourseList>;
  readonly asOf: string;
}

export interface CourseDetailView {
  readonly detail: Part<AcademyCourseDetail>;
  readonly asOf: string;
}

export type CourseDeskReply =
  | { readonly ok: true; readonly what: string; readonly course: AcademyCourse }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

/** What the create form sends. Blank fields are null, never filled in. */
export interface CourseDraftInput {
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly thumbnailUrl: string | null;
  readonly pricing: 'free' | 'paid';
  readonly price: string | null;
  readonly priceAsset: string | null;
}

const blank = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** The form's fields as the service takes them: trimmed, blank as null, and a free course with no price. */
export function draftFrom(body: Record<string, unknown>): CourseDraftInput {
  const pricing = body.pricing === 'paid' ? 'paid' : 'free';
  return {
    slug: typeof body.slug === 'string' ? body.slug.trim() : '',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    summary: blank(body.summary),
    thumbnailUrl: blank(body.thumbnailUrl),
    pricing,
    price: pricing === 'paid' ? blank(body.price) : null,
    priceAsset: pricing === 'paid' ? (blank(body.priceAsset)?.toUpperCase() ?? null) : null,
  };
}

/** "25.5 USDT", "Paid, no price set" or "Free". */
export function priceLabel(course: Pick<AcademyCourse, 'pricing' | 'price' | 'priceAsset'>): string {
  if (course.pricing === 'free') return 'Free';
  return course.price === null ? 'Paid, no price set' : `${course.price} ${course.priceAsset}`;
}
