/**
 * trade.futures D3 ladder owner policy — refuse-closed when unset.
 *
 * Owner publishes JSON `FuturesLadderPolicy`. Never invents DEFAULT_FUTURES_LADDER_POLICY.
 */
import { assertLadderPolicyCoherent, type FuturesLadderPolicy } from './maintenance-ladder.js';

export const TRADE_FUTURES_LADDER_POLICY_ENV = 'TRADE_FUTURES_LADDER_POLICY' as const;

export type FuturesLadderRefuseReason = 'ladder_unset' | 'ladder_invalid_json' | 'ladder_incoherent';

export type FuturesLadderGate =
  | { readonly configured: true; readonly policy: FuturesLadderPolicy }
  | { readonly configured: false; readonly reason: FuturesLadderRefuseReason; readonly detail: string };

export function futuresLadderPolicyGate(env: NodeJS.ProcessEnv = process.env): FuturesLadderGate {
  const raw = env[TRADE_FUTURES_LADDER_POLICY_ENV]?.trim() ?? '';
  if (!raw) {
    return { configured: false, reason: 'ladder_unset', detail: `${TRADE_FUTURES_LADDER_POLICY_ENV} is unset` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { configured: false, reason: 'ladder_invalid_json', detail: 'ladder policy is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { configured: false, reason: 'ladder_invalid_json', detail: 'ladder policy must be a JSON object' };
  }

  const policy = parsed as FuturesLadderPolicy;
  try {
    assertLadderPolicyCoherent(policy);
  } catch (err) {
    return {
      configured: false,
      reason: 'ladder_incoherent',
      detail: err instanceof Error ? err.message : 'ladder policy failed coherence checks',
    };
  }

  return { configured: true, policy };
}

/**
 * The ladder the service runs with: the owner's policy, or undefined when the setting is blank. A value that is set but
 * is not valid JSON or not a coherent policy throws, so a typo stops the boot instead of running with no ladder.
 */
export function ownerLadderPolicy(raw: string | undefined): FuturesLadderPolicy | undefined {
  const gate = futuresLadderPolicyGate({ [TRADE_FUTURES_LADDER_POLICY_ENV]: raw ?? '' });
  if (gate.configured) return gate.policy;
  if (gate.reason === 'ladder_unset') return undefined;
  throw new Error(`${TRADE_FUTURES_LADDER_POLICY_ENV}: ${gate.detail}`);
}
