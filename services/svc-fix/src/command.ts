import { z } from 'zod';

/** Decimal string. Never a JSON number. At most 18 fraction digits. */
export const decimalString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings with at most 18 decimal places');

export const supportedBeginStringSchema = z.enum(['FIX.4.2', 'FIX.4.4', 'FIX.5.0', 'FIXT.1.1']);
export type SupportedBeginString = z.infer<typeof supportedBeginStringSchema>;

/** Matching TIF. Missing refuses tif_missing — never invent GTC. */
export const matchingTifSchema = z.enum(['GTC', 'IOC', 'FOK', 'GTD', 'DAY']);
export type MatchingTif = z.infer<typeof matchingTifSchema>;

export const matchingOrderCommandSchema = z
  .object({
    kind: z.literal('new_order_single'),
    clOrdId: z.string().min(1),
    beginString: supportedBeginStringSchema,
    applVerId: z.string().min(1).optional(),
    symbol: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    ordType: z.enum(['market', 'limit']),
    qty: decimalString,
    // Limit requires an explicit decimal price. Market forwards Price (44) when set, otherwise null. Never invent one.
    price: decimalString.nullable(),
    senderCompId: z.string().min(1).optional(),
    tif: matchingTifSchema.optional(),
  })
  .superRefine((command, ctx) => {
    if (command.ordType !== 'limit' || command.price !== null) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['price'],
      message: 'limit new_order_single requires an explicit decimal price',
    });
  });

export type MatchingOrderCommand = z.infer<typeof matchingOrderCommandSchema>;

export const adaptErrorSchema = z.object({
  code: z.enum([
    'unsupported_begin_string',
    'unsupported_appl_ver',
    'unsupported_msg_type',
    'unsupported_tag',
    'unsupported_side',
    'unsupported_ord_type',
    'missing_cl_ord_id',
    'missing_qty',
    'missing_price',
    'invalid_decimal',
    'invalid_message',
    'tif_missing',
    'gtd_expiry_missing',
    'unmapped_economic_tag',
    'matching_account_unmapped',
  ]),
  message: z.string().min(1),
});

export const adaptResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), command: matchingOrderCommandSchema }),
  z.object({ ok: z.literal(false), error: adaptErrorSchema }),
]);

export type AdaptResult = z.infer<typeof adaptResultSchema>;

export function parseMatchingOrderCommand(input: unknown): MatchingOrderCommand {
  return matchingOrderCommandSchema.parse(input);
}
