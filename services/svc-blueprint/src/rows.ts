import { z } from 'zod';
import { blueprintProfileSchema, cardSizeSchema, guardrailsSchema, visibilitySchema } from '@intafaced/contracts/blueprint';

/**
 * The rows `BlueprintService` checks as it reads them. Their own file so the Rust port's recorder
 * (`crates/svc-blueprint/scripts/record-door.mjs`) reads the same schemas the service runs.
 */

/**
 * `blueprints.profile` as stored. Every write goes through
 * `blueprintProfileSchema` first; `loose` keeps any key a row holds beyond it,
 * so a read returns the stored object unchanged.
 */
export const StoredProfile = blueprintProfileSchema.extend({ guardrails: guardrailsSchema.loose() }).loose();

export const BlueprintRow = z.object({
  id: z.string(),
  user_id: z.string(),
  engine_version: z.string(),
  profile: StoredProfile,
  card_asset_url: z.string().nullable(),
  visibility: visibilitySchema,
  mentor_available: z.boolean(),
  created_at: z.date(),
});

export const MentorMatchRow = z.object({ student_id: z.string(), mentor_id: z.string(), fit_score: z.number(), status: z.string() });

export const ShareRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  size: cardSizeSchema,
  created_at: z.date(),
  revoked_at: z.date().nullable(),
});
