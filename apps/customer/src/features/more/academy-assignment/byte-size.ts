/** A byte count in the largest binary unit it fills: 1048576 is "1 MiB". */
export function byteSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${+(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** A share of the points ("0.1", up to four places) as a percentage with up to two places ("10", "3.33"), worked out in digits. */
export function percentOf(share: string): string {
  const [whole, frac = ''] = share.split('.');
  const basis = BigInt(whole! + frac.padEnd(4, '0').slice(0, 4));
  const hundredths = (basis % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return hundredths ? `${basis / 100n}.${hundredths}` : `${basis / 100n}`;
}
