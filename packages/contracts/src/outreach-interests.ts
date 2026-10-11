import { z } from 'zod';
import { outreachAudienceSchema, outreachContinuationInputSchema, type OutreachDraft } from './outreach-crm.js';

/** Additions only; omission never removes a selected audience. */
export const outreachAddInterestsInputSchema = outreachContinuationInputSchema
  .extend({
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().positive().safe(),
    interests: z
      .array(outreachAudienceSchema)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length, 'Duplicate interests are not allowed'),
  })
  .strict();
export type OutreachAddInterestsInput = z.infer<typeof outreachAddInterestsInputSchema>;
export interface OutreachInterestExtensionContract {
  addInterests(input: OutreachAddInterestsInput): Promise<OutreachDraft>;
}
