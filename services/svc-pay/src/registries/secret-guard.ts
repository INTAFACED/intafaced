/**
 * The registries hold routing data and never a credential. Strict input schemas
 * already reject an unknown `secret` or `apiKey` field. This guard covers the
 * remaining door: a secret pasted into a free-text field (display name, reason).
 * It is a tripwire, not a vault: it errs towards refusing.
 */
const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PGP)/i,
  /\b0x[0-9a-fA-F]{64}\b/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\b(?:api[ _-]?key|api[ _-]?secret|secret|passphrase|password|private[ _-]?key|token|bearer)\b\s*[:=]/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  // Any single unbroken token of 32+ key-like characters mixing letters and digits.
  /(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}/,
];

export function looksLikeSecret(value: string): boolean {
  return PATTERNS.some((p) => p.test(value));
}
