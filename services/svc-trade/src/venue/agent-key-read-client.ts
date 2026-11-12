import {
  AGENT_KEY_READ_PATH,
  agentKeyReadSchema,
  serviceCallSigner,
  type AgentKeyRead,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';

/**
 * Identity's read of one of a person's own API keys (`POST /internal/agent-keys/read`; svc-identity agent-key-read.ts),
 * before svc-trade binds it to an agent account (J-agents-21 #6). Services never read each other's tables: this is the
 * one door. `null` when identity could not be asked or answered outside the contract; the caller refuses then.
 */
export interface AgentKeyReader {
  read(userId: string, keyId: string): Promise<AgentKeyRead | null>;
}

const FETCH_MS = 3_000;

export function createAgentKeyReader(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): AgentKeyReader {
  const target = `${baseUrl.replace(/\/+$/, '')}${AGENT_KEY_READ_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async read(userId, keyId) {
      const raw = JSON.stringify({ userId, keyId });
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
      if (!response.ok) return null;
      try {
        const parsed = agentKeyReadSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
