import { z } from 'zod';
import { SUPPORT_ATTACHMENT_REASON_MAX } from './support-attachments.js';
import { supportTicketTypeSchema } from './support.js';

/**
 * SP-csat-02: satisfaction survey configuration, owned by svc-support (`support.survey.configure`, founder-ops).
 * One active survey at a time. The maximum number of surveys is a blank owner value: unset refuses with
 * `support.survey_cap_unset`, never defaulted. Existing ratings keep the scale they were given on.
 * Email delivery is `vendor.email` (NotConnected); in-app is our own.
 */
export const SUPPORT_SURVEY_CAP_UNSET = 'support.survey_cap_unset' as const;
/** The owner-set survey cap is reached: a new survey is refused, never an old one silently replaced. */
export const SUPPORT_SURVEY_CAP_REACHED = 'support.survey_cap_reached' as const;
export const SUPPORT_SURVEY_SCALE_INVALID = 'support.survey_scale_invalid' as const;
export const supportSurveyErrorCodeSchema = z.enum([SUPPORT_SURVEY_CAP_UNSET, SUPPORT_SURVEY_CAP_REACHED, SUPPORT_SURVEY_SCALE_INVALID]);
export type SupportSurveyErrorCode = z.infer<typeof supportSurveyErrorCodeSchema>;

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const label = z.string().trim().min(1).max(60);

/** Integer scale with one label per point; a bad scale maps to `support.survey_scale_invalid`. */
export const supportSurveyScaleSchema = z
  .object({ min: z.number().int().min(0).max(10), max: z.number().int().min(1).max(10), labels: z.array(label).max(11) })
  .strict()
  .superRefine((scale, ctx) => {
    if (scale.max <= scale.min) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max'], message: SUPPORT_SURVEY_SCALE_INVALID });
    else if (scale.labels.length !== 0 && scale.labels.length !== scale.max - scale.min + 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labels'], message: SUPPORT_SURVEY_SCALE_INVALID });
  });
export type SupportSurveyScale = z.infer<typeof supportSurveyScaleSchema>;

export const supportSurveyFollowUpSchema = z
  .object({ question: z.string().trim().min(1).max(300), askAtOrBelow: z.number().int().min(0).max(10) })
  .strict();

export const supportSurveyChannelSchema = z.enum(['in_app', 'email']);

export const supportSurveyConfigSchema = z
  .object({
    scale: supportSurveyScaleSchema,
    followUp: supportSurveyFollowUpSchema.nullable(),
    /** Delay after solve before sending; owner-chosen, no default. */
    sendAfterMinutes: z.number().int().nonnegative().max(43_200),
    channels: z
      .array(supportSurveyChannelSchema)
      .min(1)
      .refine((v) => new Set(v).size === v.length, 'Duplicate channels'),
    requestTypes: z
      .array(supportTicketTypeSchema)
      .min(1)
      .refine((v) => new Set(v).size === v.length, 'Duplicate request types'),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.followUp && (config.followUp.askAtOrBelow < config.scale.min || config.followUp.askAtOrBelow > config.scale.max))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['followUp', 'askAtOrBelow'], message: SUPPORT_SURVEY_SCALE_INVALID });
  });
export type SupportSurveyConfig = z.infer<typeof supportSurveyConfigSchema>;

/** Configure carries the revision read (a stale one is refused by the service) and an audit reason. */
export const supportSurveyConfigureInputSchema = z
  .object({
    surveyId: id.nullable(),
    expectedRevision: z.number().int().nonnegative().safe(),
    reason: z.string().trim().min(1).max(SUPPORT_ATTACHMENT_REASON_MAX),
    config: supportSurveyConfigSchema,
  })
  .strict();
export type SupportSurveyConfigureInput = z.infer<typeof supportSurveyConfigureInputSchema>;

export const supportSurveyCapSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unset'), code: z.literal(SUPPORT_SURVEY_CAP_UNSET) }).strict(),
  z.object({ status: z.literal('set'), cap: z.number().int().positive().safe() }).strict(),
]);

export const supportSurveySchema = z
  .object({
    surveyId: id,
    revision: z.number().int().positive().safe(),
    active: z.boolean(),
    config: supportSurveyConfigSchema,
    updatedAt: timestamp,
  })
  .strict();
export type SupportSurvey = z.infer<typeof supportSurveySchema>;

export const supportSurveyListSchema = z
  .object({ cap: supportSurveyCapSchema, surveys: z.array(supportSurveySchema) })
  .strict()
  .refine((list) => list.surveys.filter((s) => s.active).length <= 1, { path: ['surveys'], message: 'One active survey at a time' });
export type SupportSurveyList = z.infer<typeof supportSurveyListSchema>;
