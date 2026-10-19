import type { EdgeContextOptions } from '@intafaced/contracts';

type EdgeTrust = Pick<EdgeContextOptions, 'edgePublicKey' | 'principalLimits'>;

const wholeSeconds = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim() ?? '';
  return /^[1-9][0-9]*$/.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
};

/**
 * The edge public key and principal limits from the environment, for `createEdgeContext`.
 * Empty when `EDGE_PRINCIPAL_PUBLIC_KEY` is unset. With a key and a missing or unparsable limit the
 * limit is left out, so `createEdgeContext` refuses with its typed error instead of this inventing one.
 */
export function edgeTrustFromProcessEnv(env: Record<string, string | undefined>): EdgeTrust {
  const edgePublicKey = env.EDGE_PRINCIPAL_PUBLIC_KEY?.trim();
  if (!edgePublicKey) return {};
  const maxLifetimeSeconds = wholeSeconds(env.EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS);
  const clockSkewSeconds = wholeSeconds(env.EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS);
  return {
    edgePublicKey,
    ...(maxLifetimeSeconds !== undefined && clockSkewSeconds !== undefined
      ? { principalLimits: { maxLifetimeSeconds, clockSkewSeconds } }
      : {}),
  };
}
