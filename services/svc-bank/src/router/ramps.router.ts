import { z } from 'zod';
import {
  BANK_SEND_DESTINATION_CALLERS,
  bankSendDestinationInputSchema,
  bankSendDestinationSchema,
  router,
  scopedProcedure,
  serviceProcedureFor,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { ONRAMP_METHODS } from '../ramps/customer-ports.js';
import { destinationViewOutput, amountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createRampsRouter(c: BankRouterContext) {
  const { bank } = c;
  /**
   * RAMPS — crypto ledger half. Fiat is socket.psp-partners commercially.
   * Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post.
   *
   * `simulated` is never omitted: this surface does not broadcast to a chain and
   * never claims a live PSP. Live confirmation stays in svc-pay; Class X is a
   * human decision to point working code at real money.
   */
  const rampProgrammeOutput = z.object({
    id: z.string(),
    simulated: z.boolean(),
    displayName: z.string(),
    cryptoRail: z.string().nullable(),
    fiatLeg: z.literal('socket.psp-partners'),
    fiatVia: z.literal('svc-pay.RailAdapter'),
  });

  const onrampOutput = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: amountString,
    kind: z.enum(['crypto', 'fiat']),
    rail: z.string(),
    railRef: z.string(),
    simulated: z.boolean(),
    status: z.string(),
    ledgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const offrampOutput = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: amountString,
    kind: z.enum(['crypto', 'fiat']),
    rail: z.string(),
    destinationRef: z.string(),
    clientRef: z.string(),
    simulated: z.boolean(),
    status: z.string(),
    holdLedgerTxId: z.string().nullable(),
    settleLedgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  return router({
    /** What this deployment's ramp programme is — including that it is not one. */
    programme: scopedProcedure('bank:read', { module: 'bank' })
      .output(rampProgrammeOutput)
      .query(async () => guard(async () => bank.ramps.programmeInfo())),

    /**
     * Live cash ramp. Refuses until a cash rail exists. Posts nothing.
     * The simulated programme is a different surface and stays marked simulated.
     */
    live: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ amount: amountString.optional() }).optional())
      .output(z.object({ ramp: z.null() }))
      .mutation(() =>
        guard(async () => {
          bank.ramps.liveRamp();
          return { ramp: null };
        }),
      ),

    /**
     * Fiat settle probe. Refuses with a typed code when no svc-pay adapter can
     * settle fiat (empty / sandbox / absent). Does not invent FX. Live partner
     * rails remain Class X — this door never claims simulated: false.
     */
    fiatSettle: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          canSettle: z.literal(true),
          onrampRailId: z.string(),
          offrampRailId: z.string(),
        }),
      )
      .query(async () => guard(async () => bank.ramps.fiatSettle())),

    onramps: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.onramps_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(onrampOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.ramps.onrampsOf(ctx.principal.userId, input?.limit);
          return rows.map((r) => ({
            id: r.id,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            kind: r.kind,
            rail: r.rail,
            railRef: r.railRef,
            simulated: r.simulated,
            status: r.status,
            ledgerTxId: r.ledgerTxId,
            createdAt: r.createdAt.toISOString(),
          }));
        }),
      ),

    offramps: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.offramps_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(offrampOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.ramps.offrampsOf(ctx.principal.userId, input?.limit);
          return rows.map((r) => ({
            id: r.id,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            kind: r.kind,
            rail: r.rail,
            destinationRef: r.destinationRef,
            clientRef: r.clientRef,
            simulated: r.simulated,
            status: r.status,
            holdLedgerTxId: r.holdLedgerTxId,
            settleLedgerTxId: r.settleLedgerTxId,
            createdAt: r.createdAt.toISOString(),
          }));
        }),
      ),

    /**
     * Persist a user withdraw dest (IBAN/IFSC/EVM) so a later offramp has a
     * real ref before withdrawHold. Does not move value and does not invent a PSP.
     */
    // `trade:withdraw` is the step-up scope: no API key may hold it and a normal session does not carry it,
    // `auth.stepUp` mints it for five minutes against a second factor (§9). `bank:write` alone let a leaked
    // key or an XSS-stolen access token change where money is sent and send it.
    setWithdrawDestination: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(
        z.object({
          kind: z.enum(['crypto', 'bank']),
          ref: z.string().min(1).max(256),
          label: z.string().min(1).max(64).optional(),
        }),
      )
      .output(z.object({ kind: z.string(), ref: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () =>
          bank.ramps.setWithdrawDestination({
            userId: ctx.principal.userId,
            kind: input.kind,
            ref: input.ref,
            ...(input.label !== undefined ? { label: input.label } : {}),
          }),
        ),
      ),

    /**
     * Saved wallets and bank accounts. Cooling end uses the owner window.
     * When that window is unpublished, `coolingOffEndsAt` is null and
     * `coolingBlocker` names `bank.offramp_cooling_unset`. No 24h default.
     */
    destinations: router({
      list: scopedProcedure('bank:read', { module: 'bank' })
        .output(z.array(destinationViewOutput))
        .query(async ({ ctx }) => guard(async () => bank.ramps.listDestinations(ctx.principal.userId))),

      /**
       * The assets an address may be saved for, each with the networks it is sent on: svc-ledger's registry, filtered
       * to active assets that allow withdrawals. An empty list is the honest answer while nothing is published.
       */
      networks: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.array(
            z
              .object({
                assetId: z.string(),
                precision: z.number().int(),
                networks: z.array(z.object({ networkId: z.string(), label: z.string() }).strict()),
                defaultNetworkId: z.string().nullable(),
              })
              .strict(),
          ),
        )
        .query(async () => guard(async () => bank.ramps.withdrawNetworks())),

      /**
       * Check an address before the confirmation step, with the rules `save` applies: `address` is `checksum_mismatch`
       * when its mixed case does not match its EIP-55 checksum (a changed character), and `lookalike` names the saved
       * entry it shows like but is not (address poisoning). With a `network`, `fraudListed` says whether the owner's fraud list
       * holds the address on that network or on every network (W-withdraw-03); without one it is false and unasked. Read-only
       * (`bank:read`); `save` enforces all three again.
       */
      check: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ ref: z.string().min(1).max(256), network: z.string().min(2).max(32).optional() }).strict())
        .output(
          z
            .object({
              address: z.enum(['ok', 'invalid', 'checksum_mismatch']),
              lookalike: z
                .object({ destinationId: z.string().guid(), label: z.string().nullable(), refMasked: z.string() })
                .strict()
                .nullable(),
              fraudListed: z.boolean(),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.checkDestination({
              userId: ctx.principal.userId,
              ref: input.ref,
              ...(input.network !== undefined ? { network: input.network } : {}),
            }),
          ),
        ),

      /**
       * Save an address-book entry. `trade:withdraw` (the step-up scope), like removing one: a leaked key or a
       * stolen access token must not be able to add the address that money is then sent to. The same
       * (asset, network, address, tag) again returns the stored entry. The label is unique per customer, and the
       * number of entries is the owner's `BANK_ADDRESS_BOOK_CAP` (blank refuses `bank.address_book_cap_unset`). The
       * network must be one svc-ledger's registry lists for the asset now (`bank.withdraw_network_unsupported`),
       * checked first: once an asset or network is delisted, saving that entry again refuses even if it is stored.
       * A mixed-case address must match its checksum (`bank.address_checksum_mismatch`), and an address that shows like
       * a saved one but is not refuses `bank.address_lookalike` unless `confirmLookalike` is true (the customer checked).
       * An address on the owner's fraud list for that network or every network refuses `bank.destination_fraud_listed`
       * before anything is stored (W-withdraw-03).
       */
      save: scopedProcedure('trade:withdraw', { module: 'bank' })
        .input(
          z
            .object({
              assetId: z.string().min(1).max(16),
              network: z.string().min(2).max(32),
              ref: z.string().min(1).max(256),
              tag: z.string().min(1).max(64).optional(),
              label: z.string().min(1).max(64),
              confirmLookalike: z.boolean().optional(),
            })
            .strict(),
        )
        .output(destinationViewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.saveDestination({
              userId: ctx.principal.userId,
              assetId: input.assetId,
              network: input.network,
              ref: input.ref,
              ...(input.tag !== undefined ? { tag: input.tag } : {}),
              label: input.label,
              ...(input.confirmLookalike !== undefined ? { confirmLookalike: input.confirmLookalike } : {}),
              // The saving sign-in and device, so another device can approve it (W-withdraw-09); never from the request body.
              savedOn: { fam: ctx.principal.fam ?? null, dev: ctx.principal.dev ?? null },
            }),
          ),
        ),

      /**
       * New-address approval (W-withdraw-09, J-wallet-04 #5). A saved entry waits, `pending`, until the customer approves it;
       * its cooling-off starts then. `requestMail` asks identity to mail a single-use link to the address on the account
       * (`bank:write`: it only sends the customer's own mail; the answer says until when the link works, never that it
       * arrived). `confirmLink` approves the entry the link names, for the customer it was sent to, after a fresh
       * confirmation (`trade:withdraw`, the step-up scope), so approving takes the mailbox as well as the second factor.
       * `onDevice` approves from a signed-in device that did not save the entry, also after a fresh confirmation; the
       * sign-in and device are read from the verified access token (`fam`, `dev`), never from the request. All refuse
       * while the security lock holds.
       */
      approval: router({
        requestMail: scopedProcedure('bank:write', { module: 'bank' })
          .input(z.object({ destinationId: z.string().guid() }).strict())
          .output(z.object({ destinationId: z.string(), expiresAt: z.string() }).strict())
          .mutation(async ({ ctx, input }) =>
            guard(async () => bank.ramps.requestAddressApproval({ userId: ctx.principal.userId, destinationId: input.destinationId })),
          ),
        confirmLink: scopedProcedure('trade:withdraw', { module: 'bank' })
          .input(z.object({ token: z.string().min(1).max(256) }).strict())
          .output(destinationViewOutput)
          .mutation(async ({ ctx, input }) =>
            guard(async () => bank.ramps.approveAddressByLink({ userId: ctx.principal.userId, token: input.token })),
          ),
        onDevice: scopedProcedure('trade:withdraw', { module: 'bank' })
          .input(z.object({ destinationId: z.string().guid() }).strict())
          .output(destinationViewOutput)
          .mutation(async ({ ctx, input }) =>
            guard(async () =>
              bank.ramps.approveAddressOnDevice({
                userId: ctx.principal.userId,
                destinationId: input.destinationId,
                approving: { fam: ctx.principal.fam ?? null, dev: ctx.principal.dev ?? null },
              }),
            ),
          ),
      }),

      /**
       * Rename. Changes only the label, so `bank:write` is enough and the cooling window does not restart. It cannot
       * add or change an address; a stolen plain token could only swap labels between the customer's own saved ones.
       */
      rename: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ destinationId: z.string().guid(), label: z.string().min(1).max(64) }).strict())
        .output(destinationViewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.renameDestination({ userId: ctx.principal.userId, destinationId: input.destinationId, label: input.label }),
          ),
        ),

      /**
       * Prove the customer controls a saved wallet by signing a message with its key (W-withdraw-17; EIP-191, EVM).
       * `start` offers the message to sign, open for the owner's `BANK_WALLET_PROOF_WINDOW_MINUTES`; `verify` recovers the
       * signer and marks the entry proved for the owner's `BANK_WALLET_PROOF_VALID_DAYS`. Another signer is refused by
       * name and the offer stays open. `bank:write`: nothing here adds an address or moves money, and a signature only
       * the wallet's key can make is the proof.
       */
      ownership: router({
        start: scopedProcedure('bank:write', { module: 'bank' })
          .input(z.object({ destinationId: z.string().guid() }).strict())
          .output(
            z.object({ proofId: z.string().guid(), destinationId: z.string().guid(), message: z.string(), expiresAt: z.string() }).strict(),
          )
          .mutation(async ({ ctx, input }) =>
            guard(async () => bank.ramps.startWalletProof({ userId: ctx.principal.userId, destinationId: input.destinationId })),
          ),
        verify: scopedProcedure('bank:write', { module: 'bank' })
          .input(z.object({ proofId: z.string().guid(), signature: z.string().min(1).max(200) }).strict())
          .output(
            z
              .object({
                proofId: z.string().guid(),
                destinationId: z.string().guid(),
                state: z.enum(['none', 'pending', 'verified', 'expired']),
                verifiedAt: z.string().nullable(),
                validUntil: z.string().nullable(),
                offerExpiresAt: z.string().nullable(),
              })
              .strict(),
          )
          .mutation(async ({ ctx, input }) =>
            guard(async () =>
              bank.ramps.verifyWalletProof({ userId: ctx.principal.userId, proofId: input.proofId, signature: input.signature }),
            ),
          ),
      }),

      /**
       * Whether money may be sent to one saved address now (W-withdraw-09), or what stands in the way first: the owner's
       * security lock (`locked`, with `lockUnlocksAt` once an unlock is asked for), an entry not held as active
       * (`blocked`), a new address not approved yet (`approval_pending`, with `approvalLinkExpiresAt` while an emailed link
       * works), no published cooling-off (`cooling_unset`) or a cooling-off still running (`cooling`, with
       * `coolingOffEndsAt`). Read-only (`bank:read`); the send path applies the same rules and refuses on its own.
       */
      readiness: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ destinationId: z.string().guid() }).strict())
        .output(
          z
            .object({
              destinationId: z.string().guid(),
              state: z.enum(['ready', 'locked', 'blocked', 'approval_pending', 'cooling_unset', 'cooling']),
              coolingOffEndsAt: z.string().nullable(),
              lockUnlocksAt: z.string().nullable(),
              approvalLinkExpiresAt: z.string().nullable(),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => bank.ramps.destinationReadiness({ userId: ctx.principal.userId, destinationId: input.destinationId })),
        ),

      /**
       * Whether money may be sent to one address of one asset on one network now (J-wallet-05 #6, issue #6517): asked by svc-pay
       * before it claims a withdrawal to a wallet outside the platform, so the address book decides on the server. Service-only:
       * `serviceProcedureFor` proves the caller is svc-pay before the input is parsed. A read; a POST only because the caller
       * signs the body.
       */
      sendable: serviceProcedureFor(BANK_SEND_DESTINATION_CALLERS)
        .input(bankSendDestinationInputSchema)
        .output(bankSendDestinationSchema)
        .mutation(async ({ input }) => guard(async () => bank.ramps.sendableDestination(input))),

      /** Remove, with the same step-up scope as saving. A withdrawal that already copied the address is not touched. */
      remove: scopedProcedure('trade:withdraw', { module: 'bank' })
        .input(z.object({ destinationId: z.string().guid(), idempotencyKey: z.string().min(1).max(128) }))
        .output(z.object({ destinationId: z.string(), removed: z.literal(true) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.removeDestination({
              userId: ctx.principal.userId,
              destinationId: input.destinationId,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
    }),

    /**
     * On-ramp quote. Pay amount, fee, and rate come from the rate source.
     * A blank PSP or a blank source refuses. This door does not invent them.
     */
    onrampQuote: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          amount: amountString,
          method: z.enum(ONRAMP_METHODS),
          country: z.string().regex(/^[A-Za-z]{2}$/),
        }),
      )
      .output(
        z.object({
          quoteId: z.string(),
          assetId: z.string(),
          amount: amountString,
          method: z.enum(ONRAMP_METHODS),
          country: z.string(),
          payAmount: amountString,
          fee: amountString,
          rate: amountString,
          payCurrency: z.string(),
          expiresAt: z.string(),
          deliveryEstimate: z.string().nullable(),
          simulated: z.literal(true),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.ramps.onrampQuote({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            amount: input.amount,
            method: input.method,
            country: input.country,
          }),
        ),
      ),

    /**
     * Customer on-ramp. Idempotent by `onrampId`. Stores the partner's hosted
     * URL or bank-transfer instruction and does not credit the ledger.
     * A blank partner refuses `bank.fiat_ramp_socket` before any row.
     */
    onrampCreate: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          onrampId: z.string().guid(),
          quoteId: z.string().guid(),
          method: z.enum(ONRAMP_METHODS),
        }),
      )
      .output(
        z.object({
          onrampId: z.string(),
          quoteId: z.string(),
          assetId: z.string(),
          amount: amountString,
          method: z.enum(ONRAMP_METHODS),
          payAmount: amountString,
          fee: amountString,
          rate: amountString,
          payCurrency: z.string(),
          status: z.literal('pending_payment'),
          simulated: z.literal(true),
          partnerRail: z.string(),
          hostedUrl: z.string().nullable(),
          bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
          createdAt: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.ramps.onrampCreate({
            userId: ctx.principal.userId,
            onrampId: input.onrampId,
            quoteId: input.quoteId,
            method: input.method,
          });
          return {
            onrampId: row.onrampId,
            quoteId: row.quoteId,
            assetId: row.assetId,
            amount: row.amount,
            method: row.method,
            payAmount: row.payAmount,
            fee: row.fee,
            rate: row.rate,
            payCurrency: row.payCurrency,
            status: row.status,
            simulated: row.simulated,
            partnerRail: row.partnerRail,
            hostedUrl: row.hostedUrl,
            bankInstructions: row.bankInstructions,
            createdAt: row.createdAt,
          };
        }),
      ),

    /**
     * Off-ramp fee quote. Kind fiat refuses `bank.fiat_ramp_socket`.
     * Crypto refuses `bank.offramp_fee_unset` until a fee schedule is published.
     */
    offrampQuote: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']),
          destinationRef: z.string().min(1).max(256),
        }),
      )
      .output(
        z.object({
          assetId: z.string(),
          amount: amountString,
          kind: z.literal('crypto'),
          destinationRef: z.string(),
          fee: amountString,
          netAmount: amountString,
          expiresAt: z.string(),
          simulated: z.literal(true),
        }),
      )
      .query(async ({ input }) =>
        guard(async () =>
          bank.ramps.offrampQuote({
            assetId: input.assetId,
            amount: input.amount,
            kind: input.kind,
            destinationRef: input.destinationRef,
          }),
        ),
      ),

    /**
     * User off-ramp. `offrampId` + `clientRef` are client-supplied so a retry
     * is the same withdrawal (§5). Kind fiat refuses `bank.fiat_ramp_socket`
     * before any row or ledger post.
     * Crypto destination is persisted (or loaded) before withdrawHold.
     */
    // `trade:withdraw` is the step-up scope: no API key may hold it and a normal session does not carry it,
    // `auth.stepUp` mints it for five minutes against a second factor (§9). `bank:write` alone let a leaked
    // key or an XSS-stolen access token change where money is sent and send it.
    offramp: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(
        z.object({
          offrampId: z.string().guid(),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']).default('crypto'),
          destinationRef: z.string().min(1).max(256).optional(),
          clientRef: z.string().min(1).max(128),
        }),
      )
      .output(offrampOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.ramps.offramp({
            offrampId: input.offrampId,
            userId: ctx.principal.userId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            kind: input.kind,
            destinationRef: input.destinationRef,
            clientRef: input.clientRef,
          });
          return {
            id: row.id,
            assetId: row.assetId,
            amount: formatAmount(row.amount),
            kind: row.kind,
            rail: row.rail,
            destinationRef: row.destinationRef,
            clientRef: row.clientRef,
            simulated: row.simulated,
            status: row.status,
            holdLedgerTxId: row.holdLedgerTxId,
            settleLedgerTxId: row.settleLedgerTxId,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      ),
  });
}
