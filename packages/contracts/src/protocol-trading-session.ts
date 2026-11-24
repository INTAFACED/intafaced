/**
 * svc-trade's user-venue door (services/svc-trade/src/venue/user-venue-rest.ts) and its session-key answers
 * (src/venue/session-key.ts) as the trading session room reads them (J-wallet-22 #8, slice D-venue-09): the door's
 * status, the session record, the prepare and submit answers, the builder-fee approval and the venue's markets.
 * Browser-safe (zod only).
 */
import { z } from 'zod';

export const tradingDoorStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(false),
    refusal: z.object({ code: z.string(), detail: z.string() }).passthrough(),
  }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(true),
    venue: z.object({ id: z.string(), displayName: z.string(), proofLevel: z.string() }),
    test: z.boolean(),
    builder: z.object({ address: z.string(), feeBps: z.string() }).nullable(),
  }),
]);
export type TradingDoorStatus = z.infer<typeof tradingDoorStatusSchema>;

export const tradingSessionStateSchema = z.enum(['awaiting_signature', 'approving', 'live', 'expired', 'ended', 'replaced', 'refused']);
export type TradingSessionState = z.infer<typeof tradingSessionStateSchema>;
export const tradingSessionViewSchema = z
  .object({
    sessionId: z.string(),
    actionKey: z.string(),
    agentAddress: z.string(),
    validUntil: z.string().nullable(),
    state: tradingSessionStateSchema,
    replacedBy: z.enum(['this_sign_in', 'another_sign_in']).nullable(),
    refusal: z.object({ code: z.string(), detail: z.string() }).passthrough().nullable(),
  })
  .passthrough();
export type TradingSessionView = z.infer<typeof tradingSessionViewSchema>;
export const tradingSessionStatusSchema = z.object({
  venueId: z.string(),
  owner: z.string(),
  current: tradingSessionViewSchema.nullable(),
  asOf: z.string(),
});
export type TradingSessionStatus = z.infer<typeof tradingSessionStatusSchema>;

export const tradingPreparedSchema = z
  .object({
    actionKey: z.string(),
    reused: z.boolean(),
    signed: z.boolean(),
    prepared: z.object({ digest: z.string(), typedData: z.unknown(), venueClientOrderId: z.string().nullable() }).passthrough(),
  })
  .passthrough();
export type TradingPrepared = z.infer<typeof tradingPreparedSchema>;
/** `POST /venue/session/start` and `/venue/session/end`: the prepared approval, with the session it belongs to. */
export const tradingSessionPreparedSchema = tradingPreparedSchema.and(z.object({ sessionId: z.string() }));
const tradingOutcomeSchema = z.union([
  z
    .object({ definite: z.literal(true), accepted: z.literal(true), order: z.object({ status: z.string() }).passthrough().nullable() })
    .passthrough(),
  z
    .object({
      definite: z.literal(true),
      accepted: z.literal(false),
      refusal: z.object({ code: z.string(), detail: z.string() }).passthrough(),
    })
    .passthrough(),
  z.object({ definite: z.literal(false), reason: z.string() }).passthrough(),
]);
export const tradingSubmitSchema = z.object({ actionKey: z.string(), outcome: tradingOutcomeSchema }).passthrough();
export type TradingSubmitAnswer = z.infer<typeof tradingSubmitSchema>;
export const builderFeeApprovalSchema = z.object({ value: z.string() }).passthrough();

/** `GET /venue/markets`: each market's symbol, kind and the order types the venue takes on it. */
export const tradingMarketsSchema = z
  .object({ value: z.array(z.object({ symbol: z.string(), kind: z.string(), orderTypes: z.array(z.string()) }).passthrough()) })
  .passthrough();
