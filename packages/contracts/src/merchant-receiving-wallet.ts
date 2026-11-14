import { z } from 'zod';

/**
 * The business's own receiving wallet (J-merchant-04, launch money model, OWNER 226): `merchantReceivingWallet.*` on svc-pay.
 *
 * At launch INTAFACED holds no customer money, so a payer's crypto at hosted checkout goes straight to the business's own
 * wallet. The business gives its wallet's extended public key (an `xpub`, the account key of an EVM wallet); svc-pay derives
 * a fresh receiving address from it for each payment, so each payment is told apart on the chain without anyone holding a
 * private key. A private key (`xprv`) is refused and never stored: with it we could move the money.
 *
 * Every team role reads it; the owner and admins set it, from an interactive session. Nothing here moves money.
 */
export const RECEIVING_WALLET_FAMILIES = ['evm'] as const;
export const receivingWalletFamilySchema = z.enum(RECEIVING_WALLET_FAMILIES);

/** An extended public key as wallets export it: base58, `xpub…`. Checked in full (checksum, depth) by svc-pay. */
export const extendedPublicKeySchema = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{100,120}$/, 'an extended public key, starting xpub');

export const receivingWalletGetInputSchema = z.object({}).strict();

export const receivingWalletSchema = z
  .object({
    /** False until the owner sets it: crypto at hosted checkout is then refused with `pay.receiving_wallet_unset`. */
    set: z.boolean(),
    family: receivingWalletFamilySchema.nullable(),
    /** The key as saved, so the owner can compare it with their wallet's. */
    extendedPublicKey: z.string().nullable(),
    /** The address at child index 0: the owner checks it is their wallet's own. */
    firstAddress: z.string().nullable(),
    savedAt: z.string().datetime().nullable(),
    /** 0 when never set. A save names the version it was made from. */
    version: z.number().int().min(0),
  })
  .strict();
export type ReceivingWallet = z.infer<typeof receivingWalletSchema>;

export const receivingWalletSaveInputSchema = z
  .object({
    requestId: z.string().guid(),
    /** The version this save was made from: 0 when none was set. An older one refuses `pay.receiving_wallet_stale`. */
    expectedVersion: z.number().int().min(0),
    family: receivingWalletFamilySchema,
    extendedPublicKey: z.string().trim().min(1).max(200),
  })
  .strict();
export type ReceivingWalletSaveInput = z.infer<typeof receivingWalletSaveInputSchema>;

export const receivingWalletSavedSchema = z.object({ wallet: receivingWalletSchema, replayed: z.boolean() }).strict();

/**
 * A business's money held outside our book (launch money model): in its own wallet, or with the acquiring partner, per
 * asset. `clearing` and `available` are the chain's or the partner's own figures as they last reported them, never a
 * ledger balance, and `asOf` is when that report came. A business with none has an empty list, never a row of zeros.
 */
export const outsideFundsGetInputSchema = z.object({}).strict();
export const outsideFundsRowSchema = z
  .object({
    assetId: z.string(),
    /** Where the money is: the business's own wallet, or the acquiring partner. */
    holder: z.enum(['own_wallet', 'partner']),
    /** Who reported the figures: the chain for the business's own wallet, the partner for a partner payment. */
    source: z.enum(['chain', 'partner']),
    /** Reported but not yet final (the chain) or still held (the partner), a decimal string. */
    clearing: z.string(),
    /** Final in the business's own wallet, or released by the partner, a decimal string. */
    available: z.string(),
    /** When the newest report behind these figures came. */
    asOf: z.string().datetime(),
    /** How many payments the figures come from. */
    payments: z.number().int().min(1),
  })
  .strict();
export const outsideFundsSchema = z.object({ rows: z.array(outsideFundsRowSchema) }).strict();
export type OutsideFunds = z.infer<typeof outsideFundsSchema>;
