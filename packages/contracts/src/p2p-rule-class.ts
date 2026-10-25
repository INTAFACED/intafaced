/**
 * A P2P ad content rule class (P-ads-merchant-05): the short lower-case slug compliance names a rule by in
 * `P2P_AD_CONTENT_RULES`. svc-p2p reads the list with it, the error shape carries one on `p2p.content_rule_violation`,
 * and the customer app checks it the same way. Browser-safe: no server imports.
 */
export const P2P_RULE_CLASS = /^[a-z][a-z_]{0,31}$/;

/**
 * A payment-method field key (svc-p2p method schemas, P-ads-merchant-18): the error shape carries one on a field refusal
 * (`p2p.account_format_invalid`, a field missing or invalid), and the customer app checks it the same way.
 */
export const P2P_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * What a payment-method change's confirmation names about the details (P-ads-merchant-18): the SHA-256, lower-case hex,
 * of the details exactly as sent, as `[key, value]` pairs sorted by key. The person's passkey or authenticator code then
 * approves this account number and no other, while identity sees only the digest. A change that sends no details (a
 * removal, a label-only update) names the empty string. svc-p2p and the customer app compute it with this one function.
 */
export async function p2pInstrumentDetailsDigest(details: Readonly<Record<string, string>> | undefined): Promise<string> {
  if (details === undefined) return '';
  const pairs = Object.keys(details)
    .sort()
    .map((key) => [key, details[key]]);
  const bytes = new TextEncoder().encode(JSON.stringify(pairs));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
