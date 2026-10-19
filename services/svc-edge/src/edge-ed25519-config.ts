/** The Ed25519 signing setting, or undefined while the shared secret signs. One half set without the other refuses boot. */
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
  return { privateKey, maxLifetimeSeconds };
}
