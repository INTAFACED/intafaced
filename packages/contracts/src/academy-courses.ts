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
  .object({ courseId: z.string().guid(), revision: z.number().int().positive(), ...details })
  .strict()
  .refine(pricingHolds, PRICING_RULE);
export type AcademyUpdateCourseInput = z.infer<typeof academyUpdateCourseInputSchema>;

/** `admin.setCourseState`: one lifecycle move over the revision the editor read, with the reason staff give. */
export const academySetCourseStateInputSchema = z
  .object({
    courseId: z.string().guid(),
    to: z.enum(ACADEMY_COURSE_MOVES),
    revision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetCourseStateInput = z.infer<typeof academySetCourseStateInputSchema>;

const isoInstant = z.string().datetime({ offset: true });

export const academyCourseSchema = z.object({
  id: z.string().guid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  pricing: z.enum(ACADEMY_COURSE_PRICING),
  price: z.string().nullable(),
  priceAsset: z.string().nullable(),
  state: z.enum(ACADEMY_COURSE_STATES),
  revision: z.number().int().positive(),
  /** Items in the course's outline a learner can open (subheaders are labels and are not counted). */
  items: z.number().int().nonnegative(),
  createdBy: z.string().guid(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type AcademyCourse = z.infer<typeof academyCourseSchema>;

export const ACADEMY_COURSE_EVENT_KINDS = ['created', 'updated', 'state', 'outline', 'lesson'] as const;
export const academyCourseEventSchema = z.object({
  kind: z.enum(ACADEMY_COURSE_EVENT_KINDS),
  revision: z.number().int().positive(),
  fromState: z.enum(ACADEMY_COURSE_STATES).nullable(),
  toState: z.enum(ACADEMY_COURSE_STATES),
  actor: z.string().guid(),
  reason: z.string().nullable(),
  at: isoInstant,
});
export type AcademyCourseEvent = z.infer<typeof academyCourseEventSchema>;

/**
 * AC-course-structure-02: a course's outline is ordered sections of typed items. A `subheader` is a label inside a
 * section, not something to open; a `link` carries an https address and opens in a new tab (nothing launches a tool);
 * every other kind's content is written in the lesson editor (AC-course-structure-03). `indent` is 0 to 2.
 */
export const ACADEMY_OUTLINE_ITEM_KINDS = ['lesson', 'video', 'file', 'quiz', 'assignment', 'discussion', 'link', 'subheader'] as const;
export type AcademyOutlineItemKind = (typeof ACADEMY_OUTLINE_ITEM_KINDS)[number];

const outlineItemInput = z
  .object({
    /** A stored item keeps its id (and with it its lesson revisions); a new one has none. */
    id: z.string().guid().optional(),
    kind: z.enum(ACADEMY_OUTLINE_ITEM_KINDS),
    title: z.string().trim().min(1).max(120),
    indent: z.number().int().min(0).max(2),
    url: z.string().max(2048).url().startsWith('https://').nullable(),
  })
  .strict()
  .refine((i) => (i.kind === 'link') === (i.url !== null), { message: 'a link item has an https address, and only a link has one' });

/**
 * `admin.saveOutline`: the whole outline, over the revision the editor read. The owner's section and item limits bound
 * it; while either limit is blank the save refuses `academy.outline_limits_unset`, and nothing is defaulted.
 */
export const academySaveOutlineInputSchema = z
  .object({
    courseId: z.string().guid(),
    revision: z.number().int().positive(),
    sections: z
      .array(
        z
          .object({
            id: z.string().guid().optional(),
            title: z.string().trim().min(1).max(120),
            items: z.array(outlineItemInput).max(1000),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type AcademySaveOutlineInput = z.infer<typeof academySaveOutlineInputSchema>;

export const academyOutlineItemSchema = z.object({
  id: z.string().guid(),
  kind: z.enum(ACADEMY_OUTLINE_ITEM_KINDS),
  title: z.string().min(1),
  indent: z.number().int().min(0).max(2),
  url: z.string().nullable(),
  /** The item's newest lesson revision, or null when nothing is written yet. */
  lessonRevision: z.number().int().positive().nullable(),
  /** The lesson revision learners see, or null when none is published. */
  liveRevision: z.number().int().positive().nullable(),
});
export const academyOutlineSectionSchema = z.object({
  id: z.string().guid(),
  title: z.string().min(1),
  items: z.array(academyOutlineItemSchema),
});
export type AcademyOutlineSection = z.infer<typeof academyOutlineSectionSchema>;

/** The owner's outline limits: null is "not set", and a save refuses until both are set. */
export const academyOutlineLimitsSchema = z.object({
  maxSections: z.number().int().positive().nullable(),
  maxItems: z.number().int().positive().nullable(),
});

/** `admin.course`: one course with its outline, the owner's outline limits and its history, newest first. */
export const academyCourseDetailSchema = z.object({
  course: academyCourseSchema,
  outline: z.array(academyOutlineSectionSchema),
  limits: academyOutlineLimitsSchema,
  events: z.array(academyCourseEventSchema),
});
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

/**
 * AC-course-structure-03: a lesson is an outline item's content, written as ordered blocks. Every save is a new lesson
 * revision (keyed `lesson:<item>:<revision>`); revert copies an old revision into a new one. Learners see the revision
 * staff published for the item and keep it until a newer one is published. Blocks are data only: no script, embed or
 * markup is accepted, and every address is https.
 */
export const ACADEMY_LESSON_BLOCK_TYPES = ['text', 'image', 'audio', 'pdf', 'code'] as const;
export type AcademyLessonBlockType = (typeof ACADEMY_LESSON_BLOCK_TYPES)[number];
/** Outline kinds that hold no lesson: a subheader is a label and a link opens an address. */
export const ACADEMY_ITEMS_WITHOUT_LESSON = ['subheader', 'link'] as const;

const httpsUrl = z.string().max(2048).url().startsWith('https://');
const caption = z.string().trim().min(1).max(200);
export const academyLessonBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), markdown: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal('image'), url: httpsUrl, alt: caption }).strict(),
  z.object({ type: z.literal('audio'), url: httpsUrl, title: caption }).strict(),
  z.object({ type: z.literal('pdf'), url: httpsUrl, title: caption }).strict(),
  z.object({ type: z.literal('code'), language: z.string().regex(/^[a-z0-9+#-]{1,20}$/), source: z.string().min(1).max(20_000) }).strict(),
]);
export type AcademyLessonBlock = z.infer<typeof academyLessonBlockSchema>;
export const academyLessonBlocksSchema = z.array(academyLessonBlockSchema).min(1).max(200);

/** `admin.saveLesson`: the blocks as a whole over the lesson revision the editor read (0 when nothing is written yet). */
export const academySaveLessonInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), blocks: academyLessonBlocksSchema })
  .strict();
export type AcademySaveLessonInput = z.infer<typeof academySaveLessonInputSchema>;

/** `admin.revertLesson`: a new revision with an older one's blocks, over the newest revision the editor read. */
export const academyRevertLessonInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().positive(), toRevision: z.number().int().positive() })
  .strict();
export type AcademyRevertLessonInput = z.infer<typeof academyRevertLessonInputSchema>;

/** `admin.publishLesson`: learners see this lesson revision from now on, with the reason staff give. */
export const academyPublishLessonInputSchema = z
  .object({
    itemId: z.string().guid(),
    lessonRevision: z.number().int().positive(),
    courseRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademyPublishLessonInput = z.infer<typeof academyPublishLessonInputSchema>;

/** `admin.duplicateItem`: a copy of a draft course's item right after it, with its newest lesson as revision 1. */
export const academyDuplicateItemInputSchema = z
  .object({ itemId: z.string().guid(), courseRevision: z.number().int().positive() })
  .strict();
export type AcademyDuplicateItemInput = z.infer<typeof academyDuplicateItemInputSchema>;

export const ACADEMY_LESSON_SOURCES = ['saved', 'reverted', 'duplicated', 'imported', 'assisted'] as const;
export const academyLessonRevisionSchema = z.object({
  revision: z.number().int().positive(),
  source: z.enum(ACADEMY_LESSON_SOURCES),
  /** The revision a revert copied, or null. */
  fromRevision: z.number().int().positive().nullable(),
  /** The item a duplicate was copied from, or null. */
  fromItemId: z.string().guid().nullable(),
  blocks: academyLessonBlocksSchema,
  actor: z.string().guid(),
  at: isoInstant,
});
export type AcademyLessonRevision = z.infer<typeof academyLessonRevisionSchema>;

/** `admin.lesson`: one item with every lesson revision, newest first, and which one learners see. */
export const academyLessonSchema = z.object({
  courseId: z.string().guid(),
  courseTitle: z.string().min(1),
  courseState: z.enum(ACADEMY_COURSE_STATES),
  courseRevision: z.number().int().positive(),
  item: academyOutlineItemSchema,
  revisions: z.array(academyLessonRevisionSchema),
  /** The owner's lesson import size limit in bytes (`ACADEMY_LESSON_IMPORT_MAX_BYTES`), or null when it is not set. */
  importMaxBytes: z.number().int().positive().nullable(),
  /** The assistant draft waiting for a person to accept or discard it, or null. It is never what learners see. */
  draft: z
    .object({
      basedOnRevision: z.number().int().nonnegative(),
      kind: z.literal('template'),
      blocks: academyLessonBlocksSchema,
      createdBy: z.string().guid(),
      createdAt: isoInstant,
    })
    .nullable(),
});
export type AcademyLesson = z.infer<typeof academyLessonSchema>;

/**
 * `admin.importLesson`: a lesson file (`intafaced.lesson.v1`: `{ "format": "intafaced.lesson.v1", "blocks": [...] }`)
 * as a new revision over the one read. A file over the owner's size limit is refused before it is parsed
 * (`academy.import_too_large`; a blank limit refuses `academy.import_limit_unset`). A file that parses but holds an
 * unknown block type or a bad block answers with a report naming each one, and nothing is created.
 */
export const ACADEMY_LESSON_FORMAT = 'intafaced.lesson.v1';
export const academyImportLessonInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), document: z.string().max(1_048_576) })
  .strict();
export type AcademyImportLessonInput = z.infer<typeof academyImportLessonInputSchema>;
export const academyImportProblemSchema = z.object({
  /** The block's place in the file, from 1, or null for the file as a whole. */
  block: z.number().int().positive().nullable(),
  problem: z.string().min(1),
});
export const academyImportLessonResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('imported'), lesson: academyLessonSchema }),
  z.object({ outcome: z.literal('invalid'), problems: z.array(academyImportProblemSchema).min(1), lesson: academyLessonSchema }),
]);
export type AcademyImportLessonResult = z.infer<typeof academyImportLessonResultSchema>;

/**
 * AC-course-structure-04: the authoring assistant. `template` drafts a lesson from the course's own structure (its
 * title, section and neighbours) with headings to fill in, and needs no provider. `model` is the model-backed path: it
 * refuses `owner.decision` while the owner has not chosen a provider, and copy never names one. A draft is keyed
 * `draft:<item>:<revision>:<kind>` and goes nowhere until a person accepts it, which writes a new lesson revision.
 */
export const ACADEMY_ASSISTANT_PATHS = ['template', 'model'] as const;
export const academyAssistantDraftInputSchema = z
  .object({ itemId: z.string().guid(), revision: z.number().int().nonnegative(), path: z.enum(ACADEMY_ASSISTANT_PATHS) })
  .strict();
export type AcademyAssistantDraftInput = z.infer<typeof academyAssistantDraftInputSchema>;

/** `admin.decideDraft`: a person accepts (a new lesson revision, with them as the actor) or discards the open draft. */
export const academyDecideDraftInputSchema = z
  .object({
    itemId: z.string().guid(),
    basedOnRevision: z.number().int().nonnegative(),
    kind: z.literal('template'),
    decision: z.enum(['accept', 'discard']),
  })
  .strict();
export type AcademyDecideDraftInput = z.infer<typeof academyDecideDraftInputSchema>;

/**
 * AC-videos-02: a course item's video, caption files and handouts. Every file goes to our own object store through a
 * signed upload: an intent first (keyed `media:<item>:<kind>:<sha256>`, so the same file resumes the same row), then the
 * bytes, then a confirm in which svc-academy reads the stored object back and checks its size and leading bytes against
 * what was declared (`academy.file_type_mismatch`). The owner's limits (size, video types, handout types) are blank until
 * set, and a blank one refuses `academy.upload_limits_unset`. Captions are SRT or WebVTT per video and language, checked
 * line by line.
 */
export const ACADEMY_MEDIA_KINDS = ['video', 'handout'] as const;
export type AcademyMediaKind = (typeof ACADEMY_MEDIA_KINDS)[number];
const mimeType = z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/);

export const academyUploadLimitsSchema = z.object({
  maxBytes: z.number().int().positive().nullable(),
  videoTypes: z.array(mimeType).nullable(),
  handoutTypes: z.array(mimeType).nullable(),
});
export type AcademyUploadLimits = z.infer<typeof academyUploadLimitsSchema>;

export const academyMediaSchema = z.object({
  id: z.string().guid(),
  kind: z.enum(ACADEMY_MEDIA_KINDS),
  fileName: z.string().min(1),
  contentType: mimeType,
  bytes: z.number().int().positive(),
  state: z.enum(['pending', 'ready', 'refused']),
  /** Why a confirm refused the stored object, or null. */
  refusal: z.string().nullable(),
  createdAt: isoInstant,
  /** A short-lived signed address to view a ready file, or null. */
  url: z.string().url().nullable(),
});
export type AcademyMedia = z.infer<typeof academyMediaSchema>;

export const academyItemCaptionSchema = z.object({
  language: z.string().min(2),
  label: z.string().min(1),
  format: z.enum(['srt', 'vtt']),
  cues: z.number().int().positive(),
  firstCue: z.string(),
});

/**
 * `admin.itemMedia`: one item's uploads (newest first), the owner's upload limits, the item's current video (the newest
 * checked one, or null) and that video's caption languages. Captions belong to one video, so a re-cut starts with none.
 */
export const academyItemMediaSchema = z.object({
  itemId: z.string().guid(),
  videoId: z.string().guid().nullable(),
  limits: academyUploadLimitsSchema,
  media: z.array(academyMediaSchema),
  captions: z.array(academyItemCaptionSchema),
});
export type AcademyItemMedia = z.infer<typeof academyItemMediaSchema>;

/** `admin.mediaUploadIntent`: what the browser declares before sending a byte. */
export const academyMediaIntentInputSchema = z
  .object({
    itemId: z.string().guid(),
    kind: z.enum(ACADEMY_MEDIA_KINDS),
    fileName: z.string().trim().min(1).max(200),
    contentType: mimeType,
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type AcademyMediaIntentInput = z.infer<typeof academyMediaIntentInputSchema>;
export const academyMediaIntentSchema = z.object({
  media: academyMediaSchema,
  /** The signed address to PUT the bytes to, or null when this file is already stored and confirmed. */
  uploadUrl: z.string().url().nullable(),
});
export type AcademyMediaIntent = z.infer<typeof academyMediaIntentSchema>;

export const academyConfirmMediaInputSchema = z.object({ mediaId: z.string().guid() }).strict();

/** `admin.setItemCaptions`: one language's SRT or WebVTT file for the item's current video. */
export const academySetItemCaptionsInputSchema = z
  .object({
    itemId: z.string().guid(),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/),
    label: z.string().trim().min(1).max(60),
    format: z.enum(['srt', 'vtt']),
    text: z.string().max(524_288),
  })
  .strict();
export type AcademySetItemCaptionsInput = z.infer<typeof academySetItemCaptionsInputSchema>;
export const academySetItemCaptionsResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('saved'), media: academyItemMediaSchema }),
  /** The first line that is not a caption, with its number, and nothing stored. */
  z.object({ outcome: z.literal('invalid'), problem: z.string().min(1), media: academyItemMediaSchema }),
]);
