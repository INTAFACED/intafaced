import type { BankRoot } from '../bank-root.js';
import { withdrawNetworksFrom } from '../assets/supported-assets.js';
import type { PartnerPurchaseCustody } from '../partner/partner-purchases.js';
import { AddMoneyService } from './add-money.js';
import type { OnrampPartner } from './payin-sim.js';
import { RampService, type RampServiceOptions } from './ramp-service.js';

/** On- and off-ramps and add money. An area of svc-bank (`area-chain.ts`). */
export interface RampsServices {
  readonly ramps: RampService;
  /** Add money: the ways to pay in with their quotes, and the customer's requests (J-bank-02). */
  readonly addMoney: AddMoneyService;
}

export interface RampsAreaOptions {
  /**
   * Ramp wiring: crypto ledger half, if any.
   *
   * Not defaulted to crypto-ledger. Silence is no programme; every ramp money
   * path refuses `bank.no_ramp_rail`. Kind fiat refuses `bank.fiat_ramp_socket`
   * before any row or ledger post.
   */
  ramps?: RampServiceOptions;
  /** Who opens and says paid an add-money pay-in (J-bank-02 #3, #5). The TEST stand-in is the only one; unset refuses by name. */
  onrampPartner?: OnrampPartner | null;
}

export function composeRampsArea(
  root: BankRoot,
  made: { readonly partnerPurchases: PartnerPurchaseCustody },
  options: RampsAreaOptions,
): RampsServices {
  // No ramp programme = every ramp procedure refuses `bank.no_ramp_rail`.
  // One registry: the address book reads the same one as deposits and the supported-asset list unless a test passes its own.
  const ramps = new RampService(root.sql, root.ledger, {
    ...options.ramps,
    testRamp: root.testPartner,
    onrampPayments: options.ramps?.onrampPayments ?? options.onrampPartner?.payments ?? null,
    withdrawNetworks: options.ramps?.withdrawNetworks ?? (root.assetRegistry ? withdrawNetworksFrom(root.assetRegistry) : null),
  });
  // The pay-in partner opens hosted payments (as the ramps' payment port) and says each was paid; unset everywhere but a
  // dev or test stack with the TEST stand-in chosen.
  return {
    ramps,
    addMoney: new AddMoneyService(root.sql, ramps, {
      ledger: root.ledger,
      partner: options.onrampPartner ?? null,
      purchases: made.partnerPurchases,
    }),
  };
}
