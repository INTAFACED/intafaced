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
import { ANY_NETWORK, fraudAddressKey, fraudNetworkKey } from './fraud-list.js';

export const BANK_DESTINATION_SANCTIONS_ENV = 'BANK_DESTINATION_SANCTIONS';

export type SanctionsCheck = 'unset' | 'listed' | 'clear';

/** What the address book asks of the list. */
export interface DestinationSanctionsPort {
  /** `unset` when there is no readable list; otherwise whether `ref` is listed on `network` or on every network. */
  check(network: string | null, ref: string): SanctionsCheck;
}

/** Matched as the fraud list matches: an EVM address in lower case, anything else exactly as written. */
const keyOf = fraudAddressKey;

/** The list as entries, or null when it is unset, blank or unreadable. */
export function readSanctionsList(raw: string | undefined): ReadonlyArray<{ network: string; ref: string }> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const entries: Array<{ network: string; ref: string }> = [];
  for (const part of raw.split(',')) {
    const at = part.indexOf(':');
    const ref = at < 0 ? '' : part.slice(at + 1).trim();
    if (at < 0 || !ref) return null;
    // A network that is not a network id or `*` makes the whole list unreadable: a mistyped one would match nothing.
    let network: string;
    try {
      network = fraudNetworkKey(part.slice(0, at));
    } catch {
      return null;
    }
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

/** A port over a raw setting, read at each check: the server passes its parsed env, tests change `process.env`. */
export function destinationSanctions(readRaw: () => string | undefined): DestinationSanctionsPort {
  return {
    check(network, ref) {
      const list = readSanctionsList(readRaw());
      return list === null ? 'unset' : matchIn(list, network, ref);
    },
  };
}

/** The refusal for a save or a send to `ref` on `network`: none while the list is set and the address is not on it. */
export function sanctionsRefusal(port: DestinationSanctionsPort, network: string | null, ref: string): BankError | null {
  const answer = port.check(network, ref);
  if (answer === 'unset') {
    return new BankError(
      'The destination sanctions list is not set, so no address can be screened, saved or sent to. Nothing was saved or sent',
      'bank.destination_sanctions_unset',
    );
  }
  if (answer === 'listed') {
    return new BankError(
      'This address is on the sanctions list, so it cannot be saved or sent to. Nothing was saved or sent',
      'bank.destination_sanctions_listed',
    );
  }
  return null;
}

/** Refuses as `sanctionsRefusal` says, before anything is written. */
export function assertNotSanctioned(port: DestinationSanctionsPort, network: string | null, ref: string): void {
  const refusal = sanctionsRefusal(port, network, ref);
  if (refusal) throw refusal;
}

/**
 * A set list for tests that build the bank without the owner's setting: the entries given, none by default, so every
 * address is clear. A test of the blank list builds the bank without it, or with `destinationSanctions(() => undefined)`.
 */
export function memorySanctions(listed: Array<{ network: string; address: string }> = []): DestinationSanctionsPort {
  const entries = listed.map((l) => ({ network: fraudNetworkKey(l.network), ref: keyOf(l.address) }));
  return {
    check(network, ref) {
      return matchIn(entries, network, ref);
    },
  };
}
