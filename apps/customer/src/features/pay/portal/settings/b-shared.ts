import { z } from 'zod';
import { stamp } from '@intafaced/contracts/pay-merchant-ops-procedures';

/** A list that comes as `{items,nextCursor}` or as a plain array. Pass the result through `pagedResult` to get one shape. */
export const tolerantPage = <T extends z.ZodTypeAny>(item: T) =>
  z.union([z.object({ items: z.array(item), nextCursor: z.string().nullable().optional() }), z.array(item)]);
export { stamp };
