import { z } from 'zod';

/** `/internal/jobs/run-scheduled-notices`: how many rows each step of one pass may take. Required: blank is not a size. */
export const scheduledNoticesBody = z.object({ limit: z.number().int().min(1).max(1000) }).strict();
