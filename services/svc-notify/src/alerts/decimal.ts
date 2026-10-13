/**
 * Decimal-string compare for alert targets and marks.
 *
 * No `number` — doctrine §0 money discipline. Accepts optional leading `+`,
 * optional leading zeros, and a single `.` fractional part. Rejects scientific
 * notation, NaN spellings, and empty strings.
 */

export type DecimalParse =
  | { readonly ok: true; readonly negative: boolean; readonly int: string; readonly frac: string }
  | { readonly ok: false; readonly reason: string };

export function parseDecimalString(raw: string): DecimalParse {
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (/[eE]/.test(s)) return { ok: false, reason: 'scientific_notation' };
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, reason: 'malformed' };
  const negative = m[1] === '-';
  // Strip leading zeros from the integer half; keep at least one digit.
  const intRaw = m[2]!.replace(/^0+(?=\d)/, '') || '0';
  const frac = (m[3] ?? '').replace(/0+$/, '');
  // -0 === 0
  if (intRaw === '0' && frac === '') {
    return { ok: true, negative: false, int: '0', frac: '' };
  }
  return { ok: true, negative, int: intRaw, frac };
}

/**
 * Spelling `compareDecimalStrings` treats as equal.
 * `100.50` and `100.5` are one cross. Not the raw feed text.
 */
export function canonicalDecimalString(raw: string): string {
  const p = parseDecimalString(raw);
  if (!p.ok) throw new Error(`invalid decimal: ${p.reason}`);
  const body = p.frac.length > 0 ? `${p.int}.${p.frac}` : p.int;
  return p.negative ? `-${body}` : body;
}

/** -1 if a < b, 0 if equal, 1 if a > b. Both must parse or throws. */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const pa = parseDecimalString(a);
  const pb = parseDecimalString(b);
  if (!pa.ok) throw new Error(`invalid decimal a: ${pa.reason}`);
  if (!pb.ok) throw new Error(`invalid decimal b: ${pb.reason}`);
  if (pa.negative !== pb.negative) return pa.negative ? -1 : 1;
  const sign = pa.negative ? -1 : 1;
  if (pa.int.length !== pb.int.length) {
    return ((pa.int.length < pb.int.length ? -1 : 1) * sign) as -1 | 0 | 1;
  }
  if (pa.int !== pb.int) {
    return ((pa.int < pb.int ? -1 : 1) * sign) as -1 | 0 | 1;
  }
  const maxFrac = Math.max(pa.frac.length, pb.frac.length);
  const fa = pa.frac.padEnd(maxFrac, '0');
  const fb = pb.frac.padEnd(maxFrac, '0');
  if (fa === fb) return 0;
  return ((fa < fb ? -1 : 1) * sign) as -1 | 0 | 1;
}

export function isValidPositivePrice(raw: string): boolean {
  const p = parseDecimalString(raw);
  if (!p.ok || p.negative) return false;
  // Zero is not a tradable alert target for price watches.
  return !(p.int === '0' && p.frac === '');
}
