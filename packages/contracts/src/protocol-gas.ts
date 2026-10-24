import { z } from 'zod';

/**
 * Wire type for `protocol.gasPrice` (D-explorer-01).
 *
 * Wei amounts are decimal strings. Percentiles are the owner-published sample points, not money.
 * `baseFeePerGasWei` and `priorityFeeWei` are null when the node did not report a base fee:
 * the card then shows only `gasPriceWei`.
 */
export const GAS_PERCENTILES_UNSET = 'protocol.gas_percentiles_unset' as const;

const wei = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const protocolGasPriceOutputSchema = z
  .object({
    asOf: z.string().datetime(),
    chainId: z.number().int().positive(),
    blocks: z.number().int().positive(),
    percentiles: z.tuple([z.number().int().min(0).max(100), z.number().int().min(0).max(100), z.number().int().min(0).max(100)]),
    gasPriceWei: wei,
    baseFeePerGasWei: wei.nullable(),
    priorityFeeWei: z
      .object({
        low: wei,
        average: wei,
        high: wei,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ProtocolGasPrice = z.infer<typeof protocolGasPriceOutputSchema>;
