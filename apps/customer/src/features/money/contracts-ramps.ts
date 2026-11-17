/** Ramps and saved withdrawal destinations: on and off ramps, the address book, wallet proofs and readiness. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';
import { programmeSchema } from './contracts-cards';

export const rampProgrammeSchema = programmeSchema.extend({
  cryptoRail: z.string().nullable(),
  fiatLeg: z.literal('socket.psp-partners'),
  fiatVia: z.literal('svc-pay.RailAdapter'),
});
const rampBase = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: money,
  kind: z.enum(['crypto', 'fiat']),
  rail: z.string(),
  simulated: z.boolean(),
  status: z.string(),
  createdAt: z.string(),
});
export const onrampSchema = rampBase.extend({ railRef: z.string(), ledgerTxId: z.string().nullable() });
export const offrampSchema = rampBase.extend({
  destinationRef: z.string(),
  clientRef: z.string(),
  holdLedgerTxId: z.string().nullable(),
  settleLedgerTxId: z.string().nullable(),
});

export const destinationSchema = z.object({
  destinationId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['crypto', 'bank']),
  ref: z.string(),
  addedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
  coolingBlocker: z.literal('bank.offramp_cooling_unset').nullable(),
  // The bank also returns which asset and network an entry is for and where it stands; optional so an older answer still reads.
  assetId: z.string().nullable().optional(),
  network: z.string().nullable().optional(),
  tag: z.string().nullable().optional(),
  state: z.enum(['pending', 'cooling', 'active', 'blocked', 'archived']).optional(),
  // `customer`: an address-book entry; `legacy`: the one-per-kind slot an older withdrawal wrote.
  origin: z.enum(['legacy', 'customer']).optional(),
  // When the customer confirmed this address is not the saved one it looks like (W-withdraw-03).
  lookalikeConfirmedAt: z.string().nullable().optional(),
  // Whether the customer has proved they control this wallet by signing a message (W-withdraw-17), from the latest proof.
  ownership: z
    .object({
      state: z.enum(['none', 'pending', 'verified', 'expired']),
      verifiedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      offerExpiresAt: z.string().nullable(),
    })
    .optional(),
  // A new address waits (`pending`) until approved by an emailed link or from another signed-in device (W-withdraw-09).
  approvedAt: z.string().nullable().optional(),
  approvedBy: z.enum(['link', 'device']).nullable().optional(),
  // Until when the newest emailed approval link works, while one is open.
  approvalLinkExpiresAt: z.string().nullable().optional(),
});
export type Destination = z.infer<typeof destinationSchema>;
/** svc-bank `bank.ramps.destinations.approval.requestMail`: the approval link was asked for, and works until `expiresAt`. */
export const approvalMailAskedSchema = z.object({ destinationId: z.string(), expiresAt: z.string() });
/** A message the bank offers to sign, proving the customer controls a saved wallet. */
export const walletProofStartedSchema = z.object({
  proofId: z.string(),
  destinationId: z.string(),
  message: z.string(),
  expiresAt: z.string(),
});
/** A checked wallet proof. */
export const walletProofVerifiedSchema = z.object({
  proofId: z.string(),
  destinationId: z.string(),
  state: z.enum(['none', 'pending', 'verified', 'expired']),
  verifiedAt: z.string().nullable(),
  validUntil: z.string().nullable(),
});
/** One asset an address may be saved for, with the networks it is sent on (the bank's read of the ledger's asset list). */
export const withdrawAssetSchema = z.object({
  assetId: z.string(),
  precision: z.number().int(),
  networks: z.array(z.object({ networkId: z.string(), label: z.string() })),
  defaultNetworkId: z.string().nullable(),
});
export type WithdrawAsset = z.infer<typeof withdrawAssetSchema>;
export const destinationRemovedSchema = z.object({ destinationId: z.string(), removed: z.literal(true) });
/** svc-bank `bank.ramps.destinations.readiness`: whether money may be sent to one saved address now, or what stands first. */
export const destinationReadinessSchema = z.object({
  destinationId: z.string(),
  state: z.enum(['ready', 'locked', 'blocked', 'approval_pending', 'cooling_unset', 'cooling']),
  coolingOffEndsAt: z.string().nullable(),
  lockUnlocksAt: z.string().nullable(),
  approvalLinkExpiresAt: z.string().nullable().optional(),
});
export type DestinationReadiness = z.infer<typeof destinationReadinessSchema>;
/** svc-bank `bank.ramps.destinations.check`: whether the bank takes an address as typed, before any confirmation. */
export const destinationCheckSchema = z.object({
  address: z.enum(['ok', 'invalid', 'checksum_mismatch']),
  lookalike: z.object({ destinationId: z.string(), label: z.string().nullable(), refMasked: z.string() }).nullable(),
  /** On the owner's fraud list for the network asked (W-withdraw-03); the bank refuses it on save. An older bank sends none. */
  fraudListed: z.boolean().optional(),
});
export type DestinationCheck = z.infer<typeof destinationCheckSchema>;

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const rampsReads = {
  'ramps.programme': rampProgrammeSchema,
  'ramps.fiatSettle': z.object({ canSettle: z.literal(true), onrampRailId: z.string(), offrampRailId: z.string() }),
  'ramps.onramps': z.array(onrampSchema),
  'ramps.offramps': z.array(offrampSchema),
  // svc-bank `bank.ramps.destinations.list`: the customer's own saved wallets and bank accounts. No asset or network field.
  'ramps.destinations.list': z.array(destinationSchema),
  'ramps.destinations.networks': z.array(withdrawAssetSchema),
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const rampsWrites = {
  'ramps.destinations.rename': destinationSchema,
  'ramps.setWithdrawDestination': z.object({ kind: z.string(), ref: z.string() }),
  'ramps.offramp': offrampSchema,
} as const;
