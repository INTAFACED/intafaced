/**
 * The envelope every service answer arrives in, as the app reads it: a tRPC result, or a refusal's error with the details
 * a screen acts on (a new-device sign-in, the second steps, a P2P limit). Browser-safe (zod only); the server side that
 * writes these details is `deviceAuthorisationOf`, `secondStepOf` and `p2pLimitOf` in ./trpc.ts.
 */
import { z } from 'zod';
import { P2P_DELIST_REASONS } from './p2p-delist.js';
import { P2P_FIELD_KEY, P2P_RULE_CLASS } from './p2p-rule-class.js';

/** A new-device sign-in waiting for approval (svc-identity I-signin-sessions-07, contracts `deviceAuthorisationOf`). */
export const deviceAuthorisationSchema = z.object({
  flowId: z.string().guid(),
  secret: z.string().min(16).max(128),
  expiresAt: z.string().datetime({ offset: true }),
  mailed: z.boolean(),
  /** Only when this sign-in's second step spent a recovery code: how many are left (I-signin-sessions-12). */
  recoveryCodesLeft: z.number().int().min(0).optional(),
});
/** The second steps a sign-in may answer with, and the passkey challenge when one does (contracts `secondStepOf`). */
export const secondStepSchema = z.object({
  totp: z.boolean(),
  passkey: z
    .object({
      challenge: z.string().min(1),
      timeout: z.number().optional(),
      rpId: z.string().optional(),
      allowCredentials: z
        .array(z.object({ id: z.string().min(1), type: z.literal('public-key'), transports: z.array(z.string()).optional() }))
        .min(1),
      userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
    })
    .nullable(),
});
const limitDecimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
/** The figures behind a P2P take limit, as svc-p2p sends them (contracts `p2pLimitOf`). Anything malformed is dropped. */
export const p2pLimitSchema = z.object({
  until: z.string().datetime().nullable(),
  cap: limitDecimal.optional(),
  min: limitDecimal.optional(),
  max: limitDecimal.optional(),
  remaining: limitDecimal.optional(),
  windowHours: limitDecimal.optional(),
  available: limitDecimal.optional(),
  shortBy: limitDecimal.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  openTradeIds: z.array(z.string().guid()).max(50).optional(),
  /** On `p2p.offer_has_open_trades`: how many orders on the ad are open. */
  openTrades: limitDecimal.optional(),
  reason: z.enum(P2P_DELIST_REASONS).optional(),
  ruleClass: z.string().regex(P2P_RULE_CLASS).optional(),
  /** The field a refused payment-method detail is about (`p2p.account_format_invalid`, field missing or invalid). */
  field: z.string().regex(P2P_FIELD_KEY).optional(),
});

/** A refused call's body: a tRPC error, or a REST route's `{ error, message, code }`. Each detail that does not parse is dropped. */
export const errorEnvelopeSchema = z
  .object({
    error: z
      .union([
        z.string(),
        z
          .object({
            message: z.string().optional(),
            code: z.union([z.string(), z.number()]).optional(),
            data: z
              .object({
                code: z.string().optional(),
                intafacedCode: z.string().optional(),
                requestId: z.string().optional(),
                retryAfterSeconds: z.number().int().positive().optional(),
                accountState: z.enum(['frozen', 'closed']).optional().catch(undefined),
                p2pLimit: p2pLimitSchema.optional().catch(undefined),
                deviceAuthorisation: deviceAuthorisationSchema.optional().catch(undefined),
                secondStep: secondStepSchema.optional().catch(undefined),
                cause: z.object({ code: z.string().optional() }).passthrough().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      ])
      .optional(),
    message: z.string().optional(),
    code: z.string().optional(),
    // The public market routes answer in the exchange error shape: `code` is a broad class such as "ExchangeError" and the
    // specific reason, such as `trade.no_book`, sits beside it.
    intafacedCode: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

/** A tRPC result: the answer is under `result.data`. */
export const resultEnvelopeSchema = z.object({ result: z.object({ data: z.unknown() }) });
