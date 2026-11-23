import { z } from 'zod';
import { tradeCopy as copy } from './copy';
import { positive } from './listing';
import { parseAmount } from '../../shared/money';

/**
 * The order a person is building on the desk, checked before it is previewed or placed, with each refusal in the
 * person's own language. Not a service answer: the person writes it. `previewBody` and `placeBody` turn it into what the
 * service takes.
 */
/** A stop-limit or a stop-market: both wait off the book for their trigger. */
export const isStopType = (type: string): type is 'stop_limit' | 'stop' => type === 'stop_limit' || type === 'stop';

export const draftSchema = z
  .object({
    symbol: z.string().min(3),
    side: z.enum(['buy', 'sell']),
    /** `stop` is a stop-market: a trigger and no price; the service places it at its protection price. */
    type: z.enum(['market', 'limit', 'stop_limit', 'stop']),
    amount: positive,
    price: positive.optional(),
    stopPrice: positive.optional(),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO', 'GTD']),
    postOnly: z.boolean(),
    /** The instant a good-till-date order ends, as a UTC ISO string. Only a GTD order carries one. */
    expireAt: z.string().datetime().optional(),
    clientOrderId: z.string().min(1).max(64),
    /**
     * What happens if the order meets one of the person's own resting orders. The engine has one way: the resting order
     * is cancelled and this one carries on. The other modes are listed on the desk, disabled, and the service refuses them.
     */
    stpMode: z.literal('cancel_maker').optional(),
    /** The person's own label for the order (1 to 16 characters). Shown on the order; never part of its identity. */
    tag: z.string().min(1).max(16).optional(),
    /** The platform token to pay this order's fees in, on a plain limit or market order. Absent: the asset it receives. */
    feeCurrency: z.string().min(1).max(32).optional(),
    /**
     * An OCO or a buy bracket. A bracket: the order above is its entry. A sell OCO: the order above is its take-profit leg.
     * A buy OCO: the order above is a limit buy at the stop-loss limit (where its one hold is sized); `stopLoss` is the trigger.
     */
    exit: z
      .object({ kind: z.enum(['oco', 'bracket']), takeProfit: positive, stopLoss: positive, stopLossLimit: positive.optional() })
      .optional(),
    /**
     * An OTO: the order above is a limit buy, and once it has finished filling the service places one sell limit at this
     * price for the base it received. Never with `exit`.
     */
    close: positive.optional(),
    /**
     * A listed lead's lead switch (J-copy-bots-otc-04 #5): true makes the order a lead trade that followers copy, false
     * marks it as the lead's own order that is never copied. Absent on everyone else's orders.
     */
    lead: z.boolean().optional(),
  })
  .superRefine((draft, ctx) => {
    if (draft.exit) {
      const { kind, takeProfit, stopLoss, stopLossLimit } = draft.exit;
      const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: ['exit', path], message });
      const buyOco = kind === 'oco' && draft.side === 'buy';
      if (kind === 'oco' && (draft.type !== 'limit' || draft.timeInForce !== 'GTC' || draft.postOnly))
        bad('kind', copy.t('enterALimitPrice'));
      if (buyOco) {
        // The engine's order for a buy OCO: take-profit < stop trigger <= stop-loss limit, and the hold is sized at the limit.
        if (stopLossLimit === undefined) bad('stopLossLimit', copy.t('enterALimitPrice'));
        else {
          if (parseAmount(takeProfit) >= parseAmount(stopLoss) || parseAmount(stopLossLimit) < parseAmount(stopLoss))
            bad('takeProfit', copy.t('enterALimitPrice'));
          if (draft.price !== undefined && parseAmount(draft.price) !== parseAmount(stopLossLimit))
            bad('price', copy.t('enterALimitPrice'));
        }
      } else {
        if (parseAmount(takeProfit) <= parseAmount(stopLoss)) bad('takeProfit', copy.t('enterALimitPrice'));
        if (stopLossLimit !== undefined) bad('stopLossLimit', copy.t('enterALimitPrice'));
        if (kind === 'oco' && draft.price !== undefined && parseAmount(draft.price) !== parseAmount(takeProfit))
          bad('price', copy.t('enterALimitPrice'));
      }
      if (kind === 'bracket' && (draft.side !== 'buy' || isStopType(draft.type) || draft.postOnly || draft.timeInForce === 'PO'))
        bad('kind', copy.t('enterALimitPrice'));
    }
    if (draft.close !== undefined) {
      const ok =
        !draft.exit &&
        draft.side === 'buy' &&
        draft.type === 'limit' &&
        !draft.postOnly &&
        ['GTC', 'IOC', 'FOK'].includes(draft.timeInForce) &&
        draft.price !== undefined &&
        parseAmount(draft.close) > parseAmount(draft.price);
      if (!ok) ctx.addIssue({ code: 'custom', path: ['close'], message: copy.t('enterALimitPrice') });
    }
    if (isStopType(draft.type) && !draft.stopPrice)
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: copy.t('enterALimitPrice') });
    if (!isStopType(draft.type) && draft.stopPrice !== undefined)
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: copy.t('enterALimitPrice') });
    if (draft.type !== 'market' && draft.type !== 'stop' && !draft.price)
      ctx.addIssue({ code: 'custom', path: ['price'], message: copy.t('enterALimitPrice') });
    if ((draft.type === 'market' || draft.type === 'stop') && draft.price !== undefined)
      ctx.addIssue({ code: 'custom', path: ['price'], message: copy.t('aMarketOrderCannotCarryALimitPrice') });
    if (draft.timeInForce === 'GTD' && (draft.type !== 'limit' || !draft.expireAt || draft.exit))
      ctx.addIssue({ code: 'custom', path: ['expireAt'], message: copy.t('aGoodTillDateLimitOrderNeedsAnExpiry') });
    if (draft.timeInForce !== 'GTD' && draft.expireAt !== undefined)
      ctx.addIssue({ code: 'custom', path: ['expireAt'], message: copy.t('aGoodTillDateLimitOrderNeedsAnExpiry') });
    if (draft.postOnly && (draft.type === 'market' || !['GTC', 'PO'].includes(draft.timeInForce)))
      ctx.addIssue({ code: 'custom', path: ['postOnly'], message: copy.t('postOnlyRequiresALimitOrderWithGtc') });
  });
export type Draft = z.infer<typeof draftSchema>;

/**
 * The advisory preview: the order itself, plus its exit legs so the service can price their fees. The service
 * names a bracket's exit `bracket_exit`; the prices ride as the decimal strings the person entered.
 */
export function previewBody(
  draft: Draft,
): Omit<Draft, 'exit' | 'stpMode' | 'tag' | 'close' | 'feeCurrency' | 'lead'> & { exit?: Record<string, string> } {
  // The preview takes only what prices the order: a self-trade mode, a tag and the fee currency change none of it (the
  // rate is the same; the token conversion happens at the fill), and it refuses unknown fields. The lead switch is
  // decided when the order is placed, not priced, so it is not sent either.
  // An OTO's close is not placed until the buy fills, so the preview prices the buy alone.
  const { exit, stpMode: _stpMode, tag: _tag, close: _close, feeCurrency: _feeCurrency, lead: _lead, ...order } = draft;
  if (!exit) return order;
  const { kind, takeProfit, stopLoss, stopLossLimit } = exit;
  return {
    ...order,
    exit: { kind: kind === 'bracket' ? 'bracket_exit' : 'oco', takeProfit, stopLoss, ...(stopLossLimit ? { stopLossLimit } : {}) },
  };
}

/**
 * The create-order body: the order, plus `oco` or `bracket` with both exit prices as decimal strings, or `oto` with its
 * close price. A bracket's exit and an OTO's close are placed by the service after the entry fills, for the base
 * actually received.
 */
export function placeBody(draft: Draft): Record<string, unknown> {
  const { exit, close, ...order } = draft;
  if (close !== undefined) return { ...order, oto: true, close: { price: close } };
  if (!exit) return order;
  // A buy OCO's stop-loss leg is a stop-limit: its limit price rides beside its trigger.
  const legs = {
    takeProfit: { stopPrice: exit.takeProfit },
    stopLoss: { stopPrice: exit.stopLoss, ...(exit.stopLossLimit ? { price: exit.stopLossLimit } : {}) },
  };
  return exit.kind === 'oco' ? { ...order, oco: true, ...legs } : { ...order, bracket: true, ...legs };
}
