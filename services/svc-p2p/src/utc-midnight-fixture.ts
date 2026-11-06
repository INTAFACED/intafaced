/** Test fixture (P-trade-orders-05): cancels are counted per UTC day. */

/**
 * The counting window is the UTC day: a test that reads "the next midnight" and then cancels must not straddle it. Near
 * midnight (within two minutes), wait until just after it.
 */
export async function awayFromUtcMidnight(): Promise<void> {
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const left = midnight.getTime() - now;
  if (left < 120_000) await new Promise((resolve) => setTimeout(resolve, left + 2_000));
}
