import { GAS_SPONSOR_UNSET } from '@intafaced/contracts/protocol-embedded-wallet';

/**
 * The owner's gas-sponsor setting (J-wallet-24 #2), read once at boot. Paying the network fee of a person's own deposit
 * would be INTAFACED's spending, so it is the owner's alone: blank is unset, and the embedded wallet's status says so
 * with `wallet.gas_sponsor_unset`, so no sponsored deposit is offered and the person is told how to add the gas token
 * themselves. This build has no sponsor to pay with, so any value refuses to boot rather than read as one.
 */
export type GasSponsorSetting = { readonly set: false; readonly code: typeof GAS_SPONSOR_UNSET };

export function gasSponsorFromSetting(raw: string | undefined): GasSponsorSetting {
  const value = raw?.trim() ?? '';
  if (value)
    throw new Error(
      `PROTOCOL_GAS_SPONSOR="${value}" names a gas sponsor, but this build pays no one's network fee: no sponsor is wired. Leave it blank. Refusing to boot.`,
    );
  return { set: false, code: GAS_SPONSOR_UNSET };
}
