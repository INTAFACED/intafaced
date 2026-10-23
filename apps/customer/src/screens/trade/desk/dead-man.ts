/**
 * The dead-man switch's choices, refusals and refresh rhythm, kept out of the component so they can be tested alone.
 * Timeouts are whole seconds, as the service publishes them; 0 always means "off" and is never offered as a choice.
 */

/** The choices offered: the published timeouts above 0, smallest first, each once. */
export function deadManChoices(published: readonly number[] | null | undefined): number[] {
  return [...new Set((published ?? []).filter((s) => Number.isSafeInteger(s) && s > 0))].sort((a, b) => a - b);
}

/** A typed "other" value: a whole number of seconds above 0, or null. */
export function otherSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]{0,6}$/.test(trimmed)) return null;
  // Seven digits at most, so the sum is exact; seconds are not money, but the desk never parses a float.
  return [...trimmed].reduce((n, d) => n * 10 + (d.charCodeAt(0) - 48), 0);
}

export type DeadManRefusal = 'timeout' | 'session' | 'unset' | 'other';

/**
 * Which words a refused arm gets. The service answers both an unpublished timeout and a sign-in that ends too soon with
 * `trade.cancel_all_after_rejected`; a published timeout that is still refused can only be the second.
 */
export function deadManRefusal(code: string | undefined, timeout: number, published: readonly number[] | null | undefined): DeadManRefusal {
  if (code === 'trade.cancel_all_after_unset') return 'unset';
  if (code === 'trade.cancel_all_after_rejected') return deadManChoices(published).includes(timeout) ? 'session' : 'timeout';
  return 'other';
}

/** While "keep refreshing" is on, the switch is pushed out three times per timeout, and at least every second. */
export function refreshEveryMs(timeout: number): number {
  return Math.max(1000, Math.floor((timeout * 1000) / 3));
}
