/**
 * Our fee rate with each payment partner (`PAY_PARTNER_FEE_BPS`, launch money model): `<partner>=<bps>` pairs separated by
 * commas, a partner being the rail that takes the payment (`bank-transfer-sandbox=250`). The rate is the owner's number in
 * that partner's contract, so blank is no partner at all, never 0. A pair that does not read (a repeat, a non-integer, out
 * of 0..10000) refuses the whole value: a typo must not silently leave a partner unset or book a fee nobody agreed.
 */
export function parsePartnerFeeBpsEnv(raw: string | null | undefined): Readonly<Record<string, number>> {
  const rates: Record<string, number> = {};
  const s = (raw ?? '').trim();
  if (s === '') return Object.freeze(rates);
  for (const pair of s.split(',')) {
    const m = /^\s*([a-z0-9][a-z0-9_-]*)\s*=\s*(\d+)\s*$/.exec(pair);
    if (!m) throw new Error(`PAY_PARTNER_FEE_BPS: "${pair.trim()}" is not <partner>=<bps>`);
    const partner = m[1]!;
    const bps = Number(m[2]);
    if (!Number.isSafeInteger(bps) || bps > 10_000) throw new Error(`PAY_PARTNER_FEE_BPS: ${partner} must be 0..10000 bps`);
    if (partner in rates) throw new Error(`PAY_PARTNER_FEE_BPS: ${partner} is given twice`);
    rates[partner] = bps;
  }
  return Object.freeze(rates);
}

/** Owner integer env (bps). Blank / unset / non-integer → null. Never invent 0. */
export function parseOwnerIntegerEnv(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}
