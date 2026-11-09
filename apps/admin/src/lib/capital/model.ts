import type { OpsCapitalBufferState, OpsCapitalReserve, LedgerOwnFundsAccount } from '@intafaced/contracts/ops-capital';

/**
 * The capital monitor's words (J-ops-console-24 #1). Pure, so the page and its tests share one source. Each typed code
 * svc-ops answers has one sentence; a state is never shown as "ok" unless svc-ops judged it ok against a set minimum.
 */
export const CAPITAL_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'ops.capital.threshold_unset':
    'No minimum buffer is set for this asset, so it is not monitored. A founder sets one below, with a second founder’s approval.',
  'ops.capital.source_unavailable':
    'This part could not be read, so it shows as unknown. Nothing is shown in its place and nothing is read as zero.',
  'ops.capital.scenario_input_missing': 'No scenario was run: every input is needed, and nothing is assumed for a blank one.',
  'ops.capital.venue_not_connected':
    'No venue adapter reports INTAFACED’s builder account to this console yet, so no venue balance or published minimum is shown.',
  'ops.capital.threshold_invalid': 'svc-ops refused the threshold as entered. Nothing was saved.',
  'ops.capital.storage_unconfigured':
    'svc-ops has no durable storage for the capital monitor on this deployment, so nothing can be read or saved.',
};

export const STATE_WORDS: Readonly<Record<OpsCapitalBufferState, string>> = {
  not_monitored: 'Not monitored',
  ok: 'At or above the minimum',
  below_minimum: 'Below the minimum',
  unknown: 'Unknown',
};

/** A partner reserve in words: "not known" is never a zero, and none is the partner's own answer. */
export function reserveWords(reserve: OpsCapitalReserve): string {
  switch (reserve.status) {
    case 'not_known':
      return 'not known';
    case 'none':
      return 'None required, as the partner reports';
    case 'reported':
      return `${reserve.amount} ${reserve.assetId}, as the partner reports`;
  }
}

/** Which ledger account a figure comes from, as an operator reads it. */
export function accountName(a: Pick<LedgerOwnFundsAccount, 'ownerType' | 'ownerId' | 'kind' | 'purpose'>): string {
  const base = `${a.ownerType} ${a.ownerId}`;
  const kind = a.kind === 'available' ? '' : ` (${a.kind}${a.purpose ? ` ${a.purpose}` : ''})`;
  return base + kind;
}

export const PARTNER_SOURCE: Readonly<Record<'bank' | 'card', string>> = {
  bank: 'svc-bank, the partner bank adapter',
  card: 'svc-bank, the card partner’s terms',
};
