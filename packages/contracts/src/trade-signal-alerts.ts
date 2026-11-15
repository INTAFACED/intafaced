/**
 * A chart alert's order fields, as svc-trade's public alert intake reads them (CB-bots-api-signal-01,
 * J-copy-bots-otc-20). Money is a decimal string only: a JSON number may already have lost digits before it reaches
 * us, and `decimalString` refuses it rather than coercing it. The webhook's token, time and alert id are read by the
 * intake itself (they are not money); this schema holds the fields an order is built from.
 */
import { z } from 'zod';
import { decimalString } from './instruments.js';

/** A text field arrives from a chart's template, so surrounding spaces are dropped before it is read. */
const trimmed = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), schema);

export const signalAlertOrderSchema = z.object({
  side: z.enum(['buy', 'sell']),
  /** The quantity to buy or sell, in the market's base asset. */
  amount: trimmed(decimalString),
  /** The worst price the market order accepts, as TradingView's {{close}} can send it. */
  price: trimmed(decimalString),
});
export type SignalAlertOrder = z.infer<typeof signalAlertOrderSchema>;

/** The order fields in the order the intake names a refusal: the first bad field is the one reported. */
export const SIGNAL_ALERT_ORDER_FIELDS = ['side', 'amount', 'price'] as const;
