import type { EventBus } from '@intafaced/events';
import { formatAmount } from '@intafaced/ledger-client';
import type { MarginCallSink } from './loan-service.js';

/**
 * THE MARGIN CALL, ON THE BUS.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 *
 * `bankMarginCalled` was a complete event with a complete consumer and no
 * publisher. svc-notify's handler was finished — severity `critical`, business
 * key `<loanId>:<sequence>`, the lot — and parked on a stream that had never
 * existed, logging that it could not attach on every boot since it shipped.
 *
 * So a margin call started a grace clock that gates liquidation, and the
 * borrower was never told. `risk.ts` argues at length against exactly that
 * outcome — "the borrower's first notice of the loan would be its liquidation
 * receipt" — and the ordering guarantee it wrote to prevent it was, in
 * production, guaranteeing an interval of silence rather than an interval of
 * warning. The call was raised. Nothing carried it. This file is the transport.
 *
 * ── The split this implements, from the catalog docstring ───────────────────
 *
 * "This subject exists so that RAISING a call and TELLING the borrower stay two
 *  separable facts. svc-bank writes the call durably — a `loan_margin_calls`
 *  row whose grace clock gates liquidation — and publishes this. Whether the
 *  borrower was actually reached is svc-notify's answer, recorded per channel,
 *  and it is allowed to be 'no'."
 *
 * Which is why this is a `MarginCallSink` and not a call inside the risk sweep.
 * The row is written and committed first, by `raiseMarginCall`; this runs after
 * it, and a failure here is caught by the caller and written to `notify_error`
 * rather than rolled back. A margin call that exists with a grace clock running
 * is a real margin call even if the publish bounced, and a borrower disputing a
 * liquidation later is owed both halves of that story rather than an all-or-
 * nothing that would have silently un-called the loan when NATS was down.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * `bank.margin_call:<loanId>:<band>:<episode>`. `sequence` stays on the payload
 * because the consumer dedupes on `<loanId>:<sequence>`, and for a margin call
 * that sequence is the episode. A loan can be called, cured and called again:
 * the second episode is a different fact and must produce a second notification.
 * Keying on `loanId` alone would swallow every call after the first. Keying on
 * the envelope id would notify twice on a redelivered publish. Sweeps that stay
 * inside one episode reuse this key and do not send a second notice.
 *
 * ── Not a money event ───────────────────────────────────────────────────────
 *
 * Nothing moves. `cureCollateralAmount` is what the borrower would have to ADD
 * to clear the call — a figure quoted at one mark, not a balance and not a
 * movement — and it crosses as a decimal string like every other amount on this
 * bus (§0.6, §10). No ledger recipe is touched from here.
 */
export function eventMarginCallSink(bus: EventBus): MarginCallSink {
  return {
    send: async (input) => {
      await bus.publish(
        'bankMarginCalled',
        {
          loanId: input.loanId,
          userId: input.userId,
          sequence: input.sequence,
          ltvBps: input.ltvBps,
          cureCollateralAmount: formatAmount(input.cureCollateralAmount),
          collateralAssetId: input.collateralAssetId,
          calledAt: input.calledAt.toISOString(),
          graceExpiresAt: input.graceExpiresAt.toISOString(),
        },
        { idempotencyKey: `bank.margin_call:${input.loanId}:${input.band}:${input.episode}` },
      );
    },
  };
}
