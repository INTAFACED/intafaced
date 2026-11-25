/** How old the figures are: the time since they were read, plus any lag the server reported. */
export function ageSeconds(asOf: string, now: number, lagSeconds = 0): number {
  const read = Date.parse(asOf);
  if (!Number.isFinite(read)) return 0;
  return Math.max(0, Math.floor((now - read) / 1000)) + Math.max(0, lagSeconds);
}
