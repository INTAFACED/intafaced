import { z } from 'zod';

/** A list that comes as `{items,nextCursor}` or as a plain array: both read as a page. */
export const tolerantPage = <T extends z.ZodTypeAny>(item: T) =>
  z
    .union([
      z.object({ items: z.array(item), nextCursor: z.string().nullable().optional() }),
      z.array(item).transform((items) => ({ items, nextCursor: null as string | null })),
    ])
    .transform((value) => ({ items: value.items, nextCursor: value.nextCursor ?? null }));

export const stamp = z.string().datetime({ offset: true });
