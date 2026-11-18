import type { BankRoot } from '../bank-root.js';
import { ZERO, type Amount } from '@intafaced/ledger-client';
import { partnerFeeKnown } from '../partner/test-partner.js';
import type { OnrampPartner } from '../ramps/payin-sim.js';
import type { RampService } from '../ramps/ramp-service.js';
import { OwnMoveService } from './own-move-service.js';

/** Moves between a person's own spending and trading accounts (J-derivatives-25). An area of svc-bank (`area-chain.ts`). */
export interface OwnMovesServices {
  readonly ownMoves: OwnMoveService;
}

export interface OwnMovesAreaOptions {
  /** The pay-in partner, whose send to a wallet a move in uses. Unset: every move in refuses `bank.own_move_rail_unset`. */
  onrampPartner?: OnrampPartner | null;
}

export function composeOwnMovesArea(root: BankRoot, made: { readonly ramps: RampService }, options: OwnMovesAreaOptions): OwnMovesServices {
  const deliver = options.onrampPartner?.deliver ?? null;
  return {
    ownMoves: new OwnMoveService(root.sql, {
      custody: root.custody,
      deliver: deliver ? (input) => deliver(input) : null,
      screenWallet: (address) => made.ramps.screenWallet(address),
      // The TEST partner charges nothing for its send (TEST) when it says what a move costs; with its fee switch `unknown`
      // it says nothing, read as "not known", never 0.
      partnerFee: (userId): Amount | null => (partnerFeeKnown(root.testPartner, userId) ? ZERO : null),
    }),
  };
}
