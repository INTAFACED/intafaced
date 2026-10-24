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
