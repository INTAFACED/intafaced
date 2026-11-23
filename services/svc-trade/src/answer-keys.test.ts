import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { answerKeys } from './answer-keys.js';

interface Answer {
  readonly id: string;
  readonly rows: ReadonlyArray<{ readonly amount: string; readonly at: string | null }>;
  readonly next?: { readonly cursor: string } | null;
}

const full = z.object({
  id: z.string(),
  rows: z.array(z.object({ amount: z.string(), at: z.string().nullable() })).readonly(),
  next: z.object({ cursor: z.string() }).nullable().optional(),
});

describe('answerKeys: an answer schema names every key its handler answers with', () => {
  it('takes a schema with exactly the answer type’s keys, at every depth', () => {
    expect(answerKeys<Answer>()(full)).toBe(full);
  });

  it('refuses, at compile time, a schema that would strip a key from the wire', () => {
    const topMissing = z.object({ id: z.string(), rows: full.shape.rows });
    // @ts-expect-error `next` is answered but not named: tRPC would strip it.
    answerKeys<Answer>()(topMissing);
    const deepMissing = full.extend({ rows: z.array(z.object({ amount: z.string() })).readonly() });
    // @ts-expect-error `rows[].at` is answered but not named.
    answerKeys<Answer>()(deepMissing);
    const extra = full.extend({ total: z.string() });
    // @ts-expect-error `total` is named but never answered.
    answerKeys<Answer>()(extra);
    expect(true).toBe(true);
  });
});
