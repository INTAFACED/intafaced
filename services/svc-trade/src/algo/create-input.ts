import { z } from 'zod';
import { ALGO_KINDS, algoCreateInputSchema } from '@intafaced/contracts/trade-call-schemas';

export type AlgoCreateInput = z.infer<typeof algoCreateInputSchema>;
export { ALGO_KINDS, algoCreateInputSchema };
