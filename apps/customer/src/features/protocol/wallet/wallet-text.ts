// The wallet pages' plain text helpers, kept apart from the panels so a caller can use them without loading a panel.

/**
 * svc-protocol's `requireAccountFactoryConfigured` refusal (PRECONDITION_FAILED, no typed code on the wire): named as the
 * factory not being deployed. Every other failure, a region refusal or a network that did not answer included, is shown
 * by the shared Failure, which reads its code.
 */
export function isFactoryUnset(message: string): boolean {
  return /factory\/implementation is not configured/i.test(message);
}

/** "2026-11-07 08:30 UTC": one clock for everyone, as the chain keeps it. */
export function utcTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A decimal amount of native currency in wei; null when it is not a plain number of at most 18 decimals. */
export function toWei(text: string): string | null {
  const match = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!match) return null;
  return (BigInt(match[1]!) * 10n ** 18n + BigInt((match[2] ?? '').padEnd(18, '0'))).toString();
}
