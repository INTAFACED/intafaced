/**
 * The income sorter's percent fields (BK-pots-03): a percent with up to two decimals is a whole number of basis points,
 * read from the typed text and never through a float.
 */

/** "60" → 6000, "33.33" → 3333, "0.01" → 1; anything else, or outside 0.01 to 100, is null. */
export function percentToBp(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/** 6000 → "60%", 3333 → "33.33%". */
export function bpToPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const part = bp % 100;
  return part === 0 ? `${whole}%` : `${whole}.${String(part).padStart(2, '0').replace(/0$/, '')}%`;
}

/** The legs a filled form names, in field order, and their total in basis points. Blank fields are skipped. */
export function sorterLegs(fields: Array<{ spaceId: string; text: string }>): {
  legs: Array<{ spaceId: string; shareBp: number }>;
  totalBp: number;
} {
  const legs: Array<{ spaceId: string; shareBp: number }> = [];
  for (const field of fields) {
    if (!field.text.trim()) continue;
    const bp = percentToBp(field.text);
    if (bp !== null) legs.push({ spaceId: field.spaceId, shareBp: bp });
  }
  return { legs, totalBp: legs.reduce((sum, leg) => sum + leg.shareBp, 0) };
}
