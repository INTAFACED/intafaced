import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';

/** The edge's Ed25519 signing setting (see `edgeEd25519Config`). Absent while the shared secret signs. */
export interface EdgeEd25519Signing {
  readonly privateKey: string;
  readonly maxLifetimeSeconds: number;
}

/**
 * The two headers that carry a principal the edge forwards to another service. Ed25519 when the edge has a signing
 * key (the principal then carries `iat` and a short expiry), else the shared secret. Every door that forwards a
 * principal signs through here so the flip to the key moves them all together.
 */
export function forwardedPrincipalHeaders(
  principal: Principal,
  signing: { readonly edgeSecret: string; readonly ed25519?: EdgeEd25519Signing | undefined; readonly region: string; readonly now?: Date },
): Record<typeof EDGE_PRINCIPAL_HEADER | typeof EDGE_SIGNATURE_HEADER, string> {
  if (signing.ed25519) {
    const raw = encodeForwardedPrincipal(principal, signing.ed25519.maxLifetimeSeconds, signing.now);
    return {
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeaderEd25519(raw, signing.ed25519.privateKey, signing.region),
    };
  }
  const raw = encodePrincipal(principal);
  return { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, signing.edgeSecret, signing.region) };
}
