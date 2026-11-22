/**
 * What the amount box on Send globally keeps after a keystroke, as the old kit's AmountInput did (the Volt kit has no
 * amount field yet): digits and one decimal mark ("," reads as "."), at most `precision` decimals, never a float.
 * Returns the canonical decimal string, or null to refuse the keystroke (a second mark, too many decimals, or both
 * "." and ","). An unfinished "12." is kept so the person can keep typing; `settledAmount` drops it on blur.
 */
export function typedAmount(raw: string, precision: number): string | null {
  if (raw.includes('.') && raw.includes(',')) return null;
  let out = '';
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '.' || ch === ',') out += '.';
  }
  const dots = out.split('.').length - 1;
  if (dots > 1) return null;
  if (dots === 1 && precision === 0) return null;
  if (out.startsWith('.')) out = `0${out}`;
  const [int = '', frac] = out.split('.');
  if (frac !== undefined && frac.length > precision) return null;
  if (int === '' && frac === undefined) return '';
  const trimmed = int.replace(/^0+(?=\d)/, '');
  const whole = trimmed === '' ? '0' : trimmed;
  return frac === undefined ? whole : `${whole}.${frac}`;
}

/** An unfinished trailing "." is dropped when the box loses focus. */
export const settledAmount = (value: string) => (value.endsWith('.') ? value.slice(0, -1) : value);
