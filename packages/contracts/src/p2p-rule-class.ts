/**
 * A P2P ad content rule class (P-ads-merchant-05): the short lower-case slug compliance names a rule by in
 * `P2P_AD_CONTENT_RULES`. svc-p2p reads the list with it, the error shape carries one on `p2p.content_rule_violation`,
 * and the customer app checks it the same way. Browser-safe: no server imports.
 */
export const P2P_RULE_CLASS = /^[a-z][a-z_]{0,31}$/;
