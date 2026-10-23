import { z } from 'zod';

/** SP-csat-02: SUPPORT_SURVEY_CAP, the owner cap on how many surveys exist; blank or absent stays unset (only the first survey). */
export const supportSurveyCapEnv = z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional());
