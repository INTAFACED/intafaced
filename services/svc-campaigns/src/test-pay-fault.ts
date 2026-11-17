import { z } from 'zod';
import type { RewardChain } from './reward-payer.js';

/**
 * TEST pay faults (J-campaigns-19 #1 #2): on a TEST stack only, a journey asks that the next payment of ONE reward meet
 * one of the faults a real chain send can meet, so the payout board and the reconciler can be seen handling it on the
 * stack's own anvil. Nothing is faked downstream: the chain, the receipt and the ledger answer as they really do.
 *
 * - `lost_after_broadcast`: the transfer is broadcast to the chain, and then the send answers with an error, as a node
 *   that took the transaction and timed out does. The payer must find it on the chain by the payment's own facts and
 *   never send it again.
 * - `unanswered`: the send answers with an error and nothing reaches the chain. The payment is looked for on every pass
 *   and never sent again (`campaigns.reward_payment_unconfirmed` after the wait), so it stays `sending`.
 * - `revert`: the transfer is broadcast with too little gas for the token, so the chain mines it and reverts it. The
 *   payment is `failed` and never sent again.
 *
 * Each fault is used once, by the next send of that reward. The door is open only where the TEST age door is
 * (`TEST_AGE_DOOR=on`, refused outside APP_ENV dev or test and under NODE_ENV production), and only behind a signed
 * service call; the faults live in this process's memory and are gone on restart.
 */

export const TEST_PAY_FAULT_PATH = '/internal/test/pay-fault' as const;
export const PAY_FAULTS = ['lost_after_broadcast', 'unanswered', 'revert'] as const;
export type PayFault = (typeof PAY_FAULTS)[number];

/** Too little gas for a token transfer, enough to be mined: the chain reverts it (status 0). */
export const REVERT_GAS = 30_000n;

export const payFaultInputSchema = z.object({ rewardKey: z.string().trim().min(1).max(200), fault: z.enum(PAY_FAULTS) }).strict();

export class PayFaults {
  private readonly faults = new Map<string, PayFault>();

  set(rewardKey: string, fault: PayFault): void {
    this.faults.set(rewardKey, fault);
  }

  /** The fault waiting for this reward's next send, used up as it is read. */
  take(rewardKey: string | undefined): PayFault | null {
    if (!rewardKey) return null;
    const fault = this.faults.get(rewardKey) ?? null;
    if (fault) this.faults.delete(rewardKey);
    return fault;
  }
}

/** A send that answered with an error: the error a lost answer gives (the payer treats every throw the same way). */
export class PaySendLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaySendLostError';
  }
}

/** The TEST chain, with each reward's waiting fault applied to its next send. Every other call goes straight through. */
export function withPayFaults(
  chain: RewardChain & { sendWithGas(from: string, to: string, units: bigint, gas: bigint): Promise<string> },
  faults: PayFaults,
): RewardChain {
  return {
    ...chain,
    async send(from, to, units, ref) {
      const fault = faults.take(ref?.rewardKey);
      if (fault === 'unanswered') throw new PaySendLostError('TEST: the send timed out and nothing reached the chain');
      if (fault === 'lost_after_broadcast') {
        await chain.send(from, to, units, ref);
        throw new PaySendLostError('TEST: the send timed out after the chain took it');
      }
      if (fault === 'revert') return chain.sendWithGas(from, to, units, REVERT_GAS);
      return chain.send(from, to, units, ref);
    },
  };
}
