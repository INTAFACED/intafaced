import { serviceCallSigner, unwrapTrpcData, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * svc-agents' own gate for one action of a person's own agent on one account (`own.policy.forService`; svc-agents
 * own/routes.ts), asked by svc-trade before it grants an allowance on a sub-account and before the agent key signs an
 * order there (J-agents-08 #4 #6). The person's rules and the sub-accounts they gave the agent access to are svc-agents'
 * own; services never read each other's tables, so this is the one door.
 *
 * `allowed` is svc-agents' yes; `refused` carries its code (`agents.policy_denied`, `agents.policy_no_match`,
 * `agents.access_account_denied`, `agents.access_expired`, `agents.own.not_found`); `null` means svc-agents could not be
 * asked or answered outside the contract, and the caller refuses then. Never a guess.
 */
export type OwnAgentPolicyAnswer = { readonly allowed: true } | { readonly allowed: false; readonly code: string };

export interface OwnAgentPolicy {
  check(userId: string, agentId: string, action: 'place_order', account: `sub:${string}`): Promise<OwnAgentPolicyAnswer | null>;
}

export const OWN_AGENT_POLICY_PATH = '/trpc/own.policy.forService';
const FETCH_MS = 3_000;
const CODE_RE = /^agents\.[a-z_.]+$/;

export function createOwnAgentPolicy(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): OwnAgentPolicy {
  const target = `${baseUrl.replace(/\/+$/, '')}${OWN_AGENT_POLICY_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-agents', legacySecret: internalSecret, s2s });
  return {
    async check(userId, agentId, action, account) {
      const raw = JSON.stringify({ userId, id: agentId, action, account });
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...sign(raw, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body: raw,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        return null;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      if (response.ok) {
        const outcome = (unwrapTrpcData(body) as { outcome?: unknown } | null)?.outcome;
        return outcome === 'allowed' || outcome === 'no_rule' ? { allowed: true } : null;
      }
      const message = (body as { error?: { message?: unknown } })?.error?.message;
      if ((response.status === 403 || response.status === 404) && typeof message === 'string' && CODE_RE.test(message)) {
        return { allowed: false, code: message };
      }
      return null;
    },
  };
}

/** A fixed answer, for tests: every check answers `answer` and is recorded. */
export class FixedOwnAgentPolicy implements OwnAgentPolicy {
  readonly calls: Array<{ userId: string; agentId: string; account: string }> = [];
  constructor(public answer: OwnAgentPolicyAnswer | null = { allowed: true }) {}
  async check(userId: string, agentId: string, _action: 'place_order', account: `sub:${string}`) {
    this.calls.push({ userId, agentId, account });
    return this.answer;
  }
}
