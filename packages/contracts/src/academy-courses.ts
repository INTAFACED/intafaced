import { z } from 'zod';

/**
 * AC-course-structure-01: a course is a record staff create on the Academy desk. Its slug is fixed at creation; its details
 * change by revision while it is a draft. A paid course carries a one-time price as a decimal string with its asset, and
 * may be saved without one, but never published without one (`academy.price_unset`). No money moves here: the price is a
 * catalogue figure the purchase slice (AC-commerce-01) will read, never a balance.
 */
export const ACADEMY_COURSE_STATES = ['draft', 'published', 'concluded', 'archived', 'deleted'] as const;
export type AcademyCourseState = (typeof ACADEMY_COURSE_STATES)[number];
export const ACADEMY_COURSE_PRICING = ['free', 'paid'] as const;
export type AcademyCoursePricing = (typeof ACADEMY_COURSE_PRICING)[number];
/** The moves the desk offers today. Conclude, archive, delete and undelete are the lifecycle's next part. */
export const ACADEMY_COURSE_MOVES = ['published'] as const;

/** Lower-case words joined by single hyphens, 3 to 64 characters: the course page's address. */
export const ACADEMY_COURSE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const academyCourseSlugSchema = z.string().min(3).max(64).regex(ACADEMY_COURSE_SLUG);
/** A positive decimal string, at most 18 places: never a JavaScript number. */
export const ACADEMY_PRICE = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;
export const academyPriceSchema = z
  .string()
  .regex(ACADEMY_PRICE)
  .refine((v) => /[1-9]/.test(v), { message: 'a price is more than zero' });
export const academyPriceAssetSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/);

const details = {
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(1000).nullable(),
  /** An https image address, or null for none. The desk shows it; the service never fetches it. */
  thumbnailUrl: z.string().max(2048).url().startsWith('https://').nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: academyPriceSchema.nullable(),
  priceAsset: academyPriceAssetSchema.nullable(),
};

type Details = { pricing: AcademyCoursePricing; price: string | null; priceAsset: string | null };
const pricingHolds = (d: Details) => (d.price === null) === (d.priceAsset === null) && (d.pricing === 'paid' || d.price === null);
const PRICING_RULE = { message: 'a price comes with its asset, and only a paid course has one' };

/** `admin.createCourse`. A repeat with the same slug and details answers with the stored course; nothing is created twice. */
export const academyCreateCourseInputSchema = z
  .object({ slug: academyCourseSlugSchema, ...details })
  .strict()
  .refine(pricingHolds, PRICING_RULE);
export type AcademyCreateCourseInput = z.infer<typeof academyCreateCourseInputSchema>;

/** `admin.updateCourse`: the details as a whole, over the revision the editor read. The slug never changes. */
export const academyUpdateCourseInputSchema = z
  .object({ courseId: z.string().uuid(), revision: z.number().int().positive(), ...details })
  .strict()
  .refine(pricingHolds, PRICING_RULE);
export type AcademyUpdateCourseInput = z.infer<typeof academyUpdateCourseInputSchema>;

/** `admin.setCourseState`: one lifecycle move over the revision the editor read, with the reason staff give. */
export const academySetCourseStateInputSchema = z
  .object({
    courseId: z.string().uuid(),
    to: z.enum(ACADEMY_COURSE_MOVES),
    revision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetCourseStateInput = z.infer<typeof academySetCourseStateInputSchema>;

const isoInstant = z.string().datetime({ offset: true });

export const academyCourseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: z.string().nullable(),
  priceAsset: z.string().nullable(),
  state: z.enum(ACADEMY_COURSE_STATES),
  revision: z.number().int().positive(),
  /** Items in the course's outline. Zero until the outline is built (AC-course-structure-02). */
  items: z.number().int().nonnegative(),
  createdBy: z.string().uuid(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type AcademyCourse = z.infer<typeof academyCourseSchema>;

export const ACADEMY_COURSE_EVENT_KINDS = ['created', 'updated', 'state'] as const;
export const academyCourseEventSchema = z.object({
  kind: z.enum(ACADEMY_COURSE_EVENT_KINDS),
  revision: z.number().int().positive(),
  fromState: z.enum(ACADEMY_COURSE_STATES).nullable(),
  toState: z.enum(ACADEMY_COURSE_STATES),
  actor: z.string().uuid(),
  reason: z.string().nullable(),
  at: isoInstant,
});
export type AcademyCourseEvent = z.infer<typeof academyCourseEventSchema>;

/** `admin.course`: one course with its history, newest first. */
export const academyCourseDetailSchema = z.object({ course: academyCourseSchema, events: z.array(academyCourseEventSchema) });
export type AcademyCourseDetail = z.infer<typeof academyCourseDetailSchema>;

/** `admin.courses` input. The page size is the caller's to send; a missing one refuses rather than dumping the table. */
export const academyCourseListInputSchema = z
  .object({ state: z.enum(ACADEMY_COURSE_STATES).optional(), limit: z.number().int().positive().max(500).optional() })
  .strict();
export type AcademyCourseListInput = z.infer<typeof academyCourseListInputSchema>;

/** `admin.courses`: the page asked for, newest first, and how many courses are in each state (all of them, not the page). */
export const academyCourseListSchema = z.object({
  courses: z.array(academyCourseSchema),
  counts: z.object(
    Object.fromEntries(ACADEMY_COURSE_STATES.map((s) => [s, z.number().int().nonnegative()])) as {
      [K in AcademyCourseState]: z.ZodNumber;
    },
  ),
});
export type AcademyCourseList = z.infer<typeof academyCourseListSchema>;
