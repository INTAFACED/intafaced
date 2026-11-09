import type { AccountRef } from './types.js';
import { LedgerError } from './types.js';

/**
 * THE CUSTODY SWITCH (OWNER 226: INTAFACED launches holding no customer money).
 *
 * The custodial layer stays built and is switched off at launch: a trader's money is in their own wallet and at the
 * outside market, bank and card money is at the partner, and our ledger records only what INTAFACED itself owes or is
 * owed (project-state research/system-design-2026-11-07/CUSTODY-DELTA.md §3). With the switch off, svc-ledger refuses
 * every post that would move a customer's balance in our book. With it on (the TEST journey stack, which still runs
 * the custodial journeys marked Later), the custodial layer posts as it always has.
 *
 * Two enforcement points, so neither has to be trusted alone:
 *   1. RUNTIME: `LedgerService.post` refuses a customer-balance post while the switch is off (svc-ledger).
 *   2. STATIC: `pnpm scan:custody` check 4 fails any source file that posts a customer-balance recipe and is not in
 *      the reviewed custodial-layer inventory (`tooling/ci/custody-layer-inventory.json`).
 */

export const CUSTODY_LAYER_STATES = ['on', 'off'] as const;
export type CustodyLayerState = (typeof CUSTODY_LAYER_STATES)[number];

/** Refused because the post moves a customer's balance and the custodial layer is switched off. */
export const CUSTODY_LAYER_OFF_CODE = 'ledger.custody_layer_off';

/**
 * Module accounts that hold a merchant's own money (clearing before settlement, proceeds before payout). A merchant is
 * a customer: with no custody at launch their balances are the acquiring partner's figures, never ours.
 */
const MERCHANT_MONEY_PREFIXES = ['pay:clearing:', 'pay:proceeds:'] as const;

/**
 * Does this account hold a customer's money in our book?
 *
 * True for every account a person or their sub-account owns (`user`, `subaccount`: available, hold, escrow, stake,
 * collateral, whatever the purpose), and for a merchant's clearing and proceeds pots. False for INTAFACED's own pots:
 * house fees, insurance, rewards engine, treasury and rail boundaries, and module reserves.
 */
export function isCustomerBalanceAccount(ref: Pick<AccountRef, 'ownerType' | 'ownerId'>): boolean {
  if (ref.ownerType === 'user' || ref.ownerType === 'subaccount') return true;
  if (ref.ownerType === 'module') return MERCHANT_MONEY_PREFIXES.some((p) => ref.ownerId.startsWith(p));
  return false;
}

/** True when any leg of the post moves a customer balance. */
export function movesCustomerBalance(entries: readonly { readonly account: Pick<AccountRef, 'ownerType' | 'ownerId'> }[]): boolean {
  return entries.some((e) => isCustomerBalanceAccount(e.account));
}

export class CustodyLayerOffError extends LedgerError {
  constructor(
    readonly module: string,
    readonly reason: string,
  ) {
    super(
      `The custodial layer is switched off: ${module}/${reason} would move a customer balance in INTAFACED's ledger, ` +
        'and INTAFACED holds no customer money (OWNER 226). Nothing was posted.',
      CUSTODY_LAYER_OFF_CODE,
    );
    this.name = 'CustodyLayerOffError';
  }
}

/**
 * Parse the switch from its environment value. Unset or blank is OFF: no customer money is the launch decision, so
 * the safe reading of a missing value is the decided one. Any other value than `on` or `off` throws, so a typo
 * (`of`, `true`) can never silently turn custody on.
 */
export function parseCustodyLayer(raw: string | undefined | null): CustodyLayerState {
  if (raw === undefined || raw === null || raw.trim() === '') return 'off';
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'off') return v;
  throw new Error(`LEDGER_CUSTODY_LAYER must be "on" or "off", got "${raw}"`);
}
