/**
 * What an approval list may show of a payout destination.
 *
 * The full account or address stays on the approval row. Callers get either the
 * last 4 of an account (`••••1234`) or the first 6 and last 4 of an address
 * (`0x1234…abcd`). A value too short to hide anything becomes `••••` with no digits.
 */

const MASK = '••••';
const ELLIPSIS = '…';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;

export function maskDestination(kind: string, ref: string): string {
  const compact = ref.trim().replace(/\s+/g, '');
  const address = kind.trim().toLowerCase() === 'crypto' || /^0x[0-9a-fA-F]{40}$/.test(compact);
  if (address) {
    if (compact.length < 10) return MASK;
    return `${compact.slice(0, 6)}${ELLIPSIS}${compact.slice(-4)}`;
  }
  if (compact.length <= 4) return MASK;
  return `${MASK}${compact.slice(-4)}`;
}

/**
 * A rail id or destination kind is a short label. Anything that does not look
 * like one, or that repeats the destination, is `unknown` rather than echoed.
 */
export function safeDestinationLabel(value: string, destinationRef: string): string {
  const trimmed = value.trim();
  const ref = destinationRef.replace(/\s+/g, '');
  if (!LABEL.test(trimmed)) return 'unknown';
  if (trimmed.length >= 4 && ref.includes(trimmed)) return 'unknown';
  return trimmed;
}
