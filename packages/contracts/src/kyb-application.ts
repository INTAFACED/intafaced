import { z } from 'zod';
import { kybCountrySchema, kybEntityTypeSchema } from './kyb-entity-types.js';
import { payMerchantIdSchema } from './merchant-control.js';

/**
 * Business verification (KYB) application: one draft per merchant, saved a section at a time, then submitted.
 *
 * Which sections a type needs is decided when the application starts, from the requirements the owner published for
 * that type (`kyb-entity-types.ts`); nothing here lists a requirement. A submitted application cannot be edited.
 */
export const KYB_APPLICATION_SECTIONS = ['company_details', 'people', 'owners', 'documents', 'questionnaires'] as const;
export const kybApplicationSectionSchema = z.enum(KYB_APPLICATION_SECTIONS);
export type KybApplicationSection = z.infer<typeof kybApplicationSectionSchema>;

export const kybApplicationSectionStateSchema = z.enum(['empty', 'draft', 'complete']);
export const kybApplicationStateSchema = z.enum(['draft', 'submitted']);

const answerKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const answerSchema = z.union([z.string().max(2000), z.boolean(), z.array(z.string().max(500)).max(50)]);

/** A section's answers: named fields, each a short text, a yes/no or a short list. Bounded; the shape per type is the owner's. */
export const kybApplicationSectionDataSchema = z
  .record(answerKeySchema, answerSchema)
  .refine((data) => Object.keys(data).length <= 100, { message: 'a section holds at most 100 fields' });
export type KybApplicationSectionData = z.infer<typeof kybApplicationSectionDataSchema>;

export const kybApplicationSectionViewSchema = z
  .object({
    section: kybApplicationSectionSchema,
    state: kybApplicationSectionStateSchema,
    /** 0 while empty; each save adds one. A save names the version it read. */
    version: z.number().int().min(0),
    required: z.boolean(),
    data: kybApplicationSectionDataSchema,
    updatedAt: z.string().nullable(),
  })
  .strict();

export const kybApplicationViewSchema = z
  .object({
    applicationId: z.string().guid(),
    merchantId: payMerchantIdSchema,
    entityType: kybEntityTypeSchema,
    country: kybCountrySchema,
    state: kybApplicationStateSchema,
    sections: z.array(kybApplicationSectionViewSchema),
    /** Required sections that are not complete yet. Submit refuses while this is not empty. */
    missing: z.array(kybApplicationSectionSchema),
    kybRef: z.string().nullable(),
    submittedAt: z.string().nullable(),
  })
  .strict();
export type KybApplicationView = z.infer<typeof kybApplicationViewSchema>;

export const kybApplicationStartInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    entityType: kybEntityTypeSchema,
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((c) => c.toUpperCase()),
  })
  .strict();

export const kybApplicationCurrentInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();

export const kybApplicationSaveSectionInputSchema = z
  .object({
    applicationId: z.string().guid(),
    section: kybApplicationSectionSchema,
    /** The version this client read. A save from an older read is a conflict, never a silent overwrite. */
    expectedVersion: z.number().int().min(0),
    complete: z.boolean(),
    data: kybApplicationSectionDataSchema,
  })
  .strict();

/** Clearing a draft needs the caller to say so. History of the earlier saves is kept. */
export const kybApplicationRestartInputSchema = z.object({ applicationId: z.string().guid(), confirm: z.literal(true) }).strict();

export const kybApplicationSubmitInputSchema = z.object({ applicationId: z.string().guid() }).strict();
