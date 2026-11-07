import { z } from 'zod';
import { protocolTypedDataSchema } from './protocol-swap.js';

/**
 * Wire types for signed intent orders with a Dutch-auction decay (D-swap-09). The swapper's own wallet signs the order
 * (no gas); a filler fills it on chain through SovereignReactor, which moves the input straight to the filler and the
 * output straight to the swapper. Amounts are base-unit decimal strings; times are chain seconds. Nothing posts to the
 * ledger, and the platform holds nothing.
 */
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const positive = z.string().regex(/^[1-9][0-9]{0,77}$/);
const seconds = z.string().regex(/^[1-9][0-9]{0,15}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

/** SovereignReactor is not configured for this network. */
export const INTENT_REACTOR_UNSET = 'dex.intent.reactor_unset' as const;
/** The owner has not published the allowed decay window bounds. */
export const INTENT_DECAY_BOUNDS_UNSET = 'dex.intent.decay_bounds_unset' as const;
/** The decay is not a decay: it ends before it starts, rises, or runs past the deadline. Nothing is stored. */
export const INTENT_BAD_DECAY = 'dex.intent.bad_decay' as const;
/** The decay window is shorter or longer than the owner's bounds. */
export const INTENT_DECAY_OUT_OF_BOUNDS = 'dex.intent.decay_out_of_bounds' as const;
/** The signature is not the swapper's for this order. */
export const INTENT_BAD_SIGNATURE = 'dex.intent.bad_signature' as const;
/** This swapper already has an order with that nonce. */
export const INTENT_NONCE_USED = 'dex.intent.nonce_used' as const;

/** One order as the swapper signs it. */
export const protocolIntentOrderSchema = z
  .object({
    swapper: address,
    tokenIn: address,
    amountIn: positive,
    tokenOut: address,
    startOut: positive,
    endOut: positive,
    decayStart: seconds,
    decayEnd: seconds,
    deadline: seconds,
    nonce: units,
  })
  .strict();
export type ProtocolIntentOrder = z.infer<typeof protocolIntentOrderSchema>;

/** `protocol.intent.settings`: the reactor and the owner's decay window bounds (null when blank). */
export const protocolIntentSettingsSchema = z
  .object({
    reactor: address,
    decayBounds: z.object({ minSeconds: z.number().int().positive(), maxSeconds: z.number().int().positive() }).strict().nullable(),
  })
  .strict();
export type ProtocolIntentSettings = z.infer<typeof protocolIntentSettingsSchema>;

/** `protocol.intent.create` input: what the swapper asks for; the service fills in the times and a fresh nonce. */
export const protocolIntentCreateInputSchema = z
  .object({
    swapper: address,
    tokenIn: address,
    amountIn: positive,
    tokenOut: address,
    /** The output at the start of the decay: the best price now, as the person saw it quoted. */
    startOut: positive,
    /** The floor: the output at the end of the decay. */
    endOut: positive,
    decaySeconds: z.number().int().positive(),
    /** Sign the token's own permit for the reactor with the order, so the swapper sends nothing (gasless). */
    gasless: z.boolean().default(true),
  })
  .strict();
export type ProtocolIntentCreateInput = z.infer<typeof protocolIntentCreateInputSchema>;

/** `protocol.intent.create`: the order and what the wallet signs (the order, and the token's permit when gasless). */
export const protocolIntentCreateOutputSchema = z
  .object({
    order: protocolIntentOrderSchema,
    typedData: protocolTypedDataSchema,
    permit: protocolTypedDataSchema.nullable(),
  })
  .strict();
export type ProtocolIntentCreateOutput = z.infer<typeof protocolIntentCreateOutputSchema>;

/** `protocol.intent.post` input: the signed order, and the signed permit when gasless. */
export const protocolIntentPostInputSchema = z
  .object({
    order: protocolIntentOrderSchema,
    signature,
    permit: z.object({ value: positive, deadline: seconds, signature }).strict().nullable().default(null),
  })
  .strict();
export type ProtocolIntentPostInput = z.infer<typeof protocolIntentPostInputSchema>;

export const protocolIntentStateSchema = z.enum(['open', 'filled', 'cancelled', 'expired']);

/** One stored order and what the chain shows about it. */
export const protocolIntentRowSchema = z
  .object({
    id: z.string(),
    order: protocolIntentOrderSchema,
    state: protocolIntentStateSchema,
    /** Filled: what the swapper received (the Filled event), the second it was mined, the decayed price at that second
     * (read from the reactor), and the transaction. */
    amountOut: units.nullable(),
    filledAt: seconds.nullable(),
    priceAtFill: units.nullable(),
    fillTx: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ProtocolIntentRow = z.infer<typeof protocolIntentRowSchema>;

/** `protocol.intent.list`: the swapper's orders, newest first, reconciled with the chain at `blockNumber`. */
export const protocolIntentListOutputSchema = z
  .object({ swapper: address, blockNumber: units, blockTime: seconds, orders: z.array(protocolIntentRowSchema) })
  .strict();
export type ProtocolIntentList = z.infer<typeof protocolIntentListOutputSchema>;
