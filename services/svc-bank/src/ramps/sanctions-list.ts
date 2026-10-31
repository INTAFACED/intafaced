/**
 * The owner's destination sanctions list (W-withdraw-03, J-wallet-05 #2), one owner setting: `BANK_DESTINATION_SANCTIONS`,
 * a comma-separated list of `<network>:<address>` (`*` for every network). An address on it is never saved to a customer's
 * address book (`bank.destination_sanctions_listed`, before anything is written), and a saved entry listed later reads
 * `blocked` before a send.
 *
 * Unlike the fraud list, this is a sanctions list: AGENTS.md product law says a blank one stays blank and refuses. No
 * setting, a blank one or one that cannot be read (an entry without a network or an address) refuses every save with
 * `bank.destination_sanctions_unset`; nothing here supplies entries. The local test stack sets one LOCAL TEST address; no
 * deploy configuration sets it.
 *
 * An EVM address is matched in lower case, however it was typed or listed; any other address exactly as written.
 */
import { BankError } from '../errors.js';
import { isEvmAddressRef } from '../withdraw-destination.js';
import { ANY_NETWORK } from './fraud-list.js';

export const BANK_DESTINATION_SANCTIONS_ENV = 'BANK_DESTINATION_SANCTIONS';

export type SanctionsCheck = 'unset' | 'listed' | 'clear';

/** What the address book asks of the list. */
export interface DestinationSanctionsPort {
  /** `unset` when there is no readable list; otherwise whether `ref` is listed on `network` or on every network. */
  check(network: string | null, ref: string): SanctionsCheck;
}

const keyOf = (ref: string): string => (isEvmAddressRef(ref.trim()) ? ref.trim().toLowerCase() : ref.trim());

/** The list as entries, or null when it is unset, blank or unreadable. */
export function readSanctionsList(raw: string | undefined): ReadonlyArray<{ network: string; ref: string }> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const entries: Array<{ network: string; ref: string }> = [];
  for (const part of raw.split(',')) {
    const at = part.indexOf(':');
    const network = at < 0 ? '' : part.slice(0, at).trim().toLowerCase();
    const ref = at < 0 ? '' : part.slice(at + 1).trim();
    if (!network || !ref) return null;
    entries.push({ network, ref: keyOf(ref) });
  }
  return entries;
}

function matchIn(list: ReadonlyArray<{ network: string; ref: string }>, network: string | null, ref: string): 'listed' | 'clear' {
  const key = keyOf(ref);
  const net = network?.trim().toLowerCase() ?? null;
  // An entry stored without a network matches a listing on any network, as the fraud list does.
  return list.some((e) => e.ref === key && (e.network === ANY_NETWORK || net === null || e.network === net)) ? 'listed' : 'clear';
}

/** A port over a raw setting, read on every check so the answer is the setting as it stands. */
export function destinationSanctions(readRaw: () => string | undefined): DestinationSanctionsPort {
  return {
    check(network, ref) {
      const list = readSanctionsList(readRaw());
      return list === null ? 'unset' : matchIn(list, network, ref);
    },
  };
}

/** The save's refusal, before anything is written. */
export function assertNotSanctioned(port: DestinationSanctionsPort, network: string | null, ref: string): void {
  const answer = port.check(network, ref);
  if (answer === 'unset') {
    throw new BankError(
      'The destination sanctions list is not set, so no address can be screened and none is saved. Nothing was saved',
      'bank.destination_sanctions_unset',
    );
  }
  if (answer === 'listed') {
    throw new BankError(
      'This address is on the sanctions list, so it cannot be saved to your address book. Nothing was saved',
      'bank.destination_sanctions_listed',
    );
  }
}

/**
 * A set list for tests that build the bank without the owner's setting: the entries given, none by default, so every
 * address is clear. A test of the blank list builds the bank without it, or with `destinationSanctions(() => undefined)`.
 */
export function memorySanctions(listed: Array<{ network: string; address: string }> = []): DestinationSanctionsPort {
  const entries = listed.map((l) => ({ network: l.network.trim().toLowerCase(), ref: keyOf(l.address) }));
  return {
    check(network, ref) {
      return matchIn(entries, network, ref);
    },
  };
}
