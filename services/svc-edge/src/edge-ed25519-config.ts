import { createPrivateKey } from 'node:crypto';

/** The Ed25519 signing setting, or undefined while the shared secret signs. One half set without the other, or a key that is not a PKCS8 Ed25519 private key, refuses boot. */
export function edgeEd25519Config(source: {
  EDGE_PRINCIPAL_PRIVATE_KEY?: string | undefined;
  EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS?: number | undefined;
}): { privateKey: string; maxLifetimeSeconds: number } | undefined {
  const privateKey = source.EDGE_PRINCIPAL_PRIVATE_KEY;
  const maxLifetimeSeconds = source.EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS;
  if (privateKey === undefined && maxLifetimeSeconds === undefined) return undefined;
  if (privateKey === undefined || maxLifetimeSeconds === undefined) {
    throw new Error(
      'EDGE_PRINCIPAL_PRIVATE_KEY and EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS must be set together; there is no default lifetime.',
    );
  }
  assertEd25519PrivateKey(privateKey);
  return { privateKey, maxLifetimeSeconds };
}

/** Refuse at boot, not on the first proxied request, a key that cannot sign. */
function assertEd25519PrivateKey(privateKey: string): void {
  let type: string | undefined;
  try {
    type = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' }).asymmetricKeyType;
  } catch {
    throw new Error('EDGE_PRINCIPAL_PRIVATE_KEY must be a PKCS8 Ed25519 private key, base64url.');
  }
  if (type !== 'ed25519') throw new Error('EDGE_PRINCIPAL_PRIVATE_KEY must be an Ed25519 key.');
}
