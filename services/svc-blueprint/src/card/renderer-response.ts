import { z } from 'zod';

/**
 * What the card renderer answers (`HttpCardRenderer`). Its own file so the Rust port's recorder
 * (`crates/svc-blueprint/scripts/record-door.mjs`) reads the same schema the renderer runs.
 */
export const responseSchema = z.object({
  url: z.string().url(),
  /** Bytes written. Required: a renderer that reports 0 has not rendered anything. */
  bytes: z.number().int().positive(),
});
