import type { ServiceAuthMode, ServiceSigner } from '@intafaced/contracts';
import { selfFreezeStateSchema } from '@intafaced/contracts/identity';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import { trpcRecordReply, trpcRecordRequest } from '@intafaced/contracts/procedure-trpc';
import { QUANT_STUDIO_GET } from '@intafaced/contracts/quant-studio-procedures';

/**
 * What a live run asks of other services (services never read each other's tables):
 *
 *   · svc-quant, for the strategy version the run trades: `studio.get` (its record, `QUANT_STUDIO_GET`) as the person themselves, with the edge-signed
 *     principal of their own request passed on byte for byte, so svc-quant answers only that person's strategy. Asked
 *     once, at the start; the run keeps the version's order blocks it read.
 *   · svc-identity, for the owner's own freeze (J-wallet-13): `GET /internal/self-freeze/:userId`, the read every service
 *     that acts for the person uses. A run never writes a freeze.
 */

export interface StrategyVersionRead {
  readonly name: string;
  readonly version: number;
  readonly blocks: ReadonlyArray<{ readonly side: 'buy' | 'sell'; readonly symbol: string; readonly qty: string }>;
  /** True when the version trades by signal rules rather than order blocks. */
  readonly signalRules: boolean;
  /**
   * The account's live approval policy as svc-quant reads it (J-algo-dev-16 #4): on, and this version holds no current
   * approval by a different member, means it may not go live. A svc-quant answer without it reads as no policy.
   */
  readonly approvalRequired: boolean;
}

export interface StrategySource {
  /** The person's own strategy version; null when svc-quant has no such strategy or version for them. Throws when svc-quant can't be asked. */
  version(forwarded: Record<string, string>, strategyId: string, version: number): Promise<StrategyVersionRead | null>;
}

export class StrategySourceUnavailable extends Error {}

const FETCH_MS = 3_000;

export function createQuantStrategySource(baseUrl: string, fetchFn: typeof globalThis.fetch = globalThis.fetch): StrategySource {
  return {
    async version(forwarded, strategyId, version) {
      let target: string;
      try {
        target = trpcRecordRequest(QUANT_STUDIO_GET, baseUrl.replace(/\/+$/, ''), { id: strategyId }).url;
      } catch {
        throw new StrategySourceUnavailable('svc-quant cannot be asked for that strategy');
      }
      let response: Response;
      try {
        response = await fetchFn(target, { method: 'GET', headers: forwarded, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
      } catch {
        throw new StrategySourceUnavailable('svc-quant did not answer');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new StrategySourceUnavailable('svc-quant answered outside its contract');
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new StrategySourceUnavailable(`svc-quant refused the read (${response.status})`);
      const head = trpcRecordReply(QUANT_STUDIO_GET, body);
      if (!head) throw new StrategySourceUnavailable('svc-quant answered outside its contract');
      const v = head.versions.find((x) => x.version === version);
      if (!v) return null;
      const approved = head.liveApproval.approvedVersions.includes(version);
      return {
        name: v.name,
        version,
        blocks: v.blocks,
        signalRules: v.modules !== null,
        approvalRequired: head.liveApproval.required && !approved,
      };
    },
  };
}

export interface AccountFreezeRead {
  /** True while the owner's own freeze is on. Throws when identity can't be asked: the caller then changes nothing. */
  frozen(userId: string): Promise<boolean>;
}

export class AccountFreezeUnavailable extends Error {}

export function createIdentityFreezeRead(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): AccountFreezeRead {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async frozen(userId) {
      const target = `${base}/internal/self-freeze/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        throw new AccountFreezeUnavailable('identity did not answer the freeze read');
      }
      if (!response.ok) throw new AccountFreezeUnavailable(`identity refused the freeze read (${response.status})`);
      const parsed = selfFreezeStateSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.userId.toLowerCase() !== userId.toLowerCase()) {
        throw new AccountFreezeUnavailable('identity answered the freeze read outside its contract');
      }
      return parsed.data.frozen;
    },
  };
}

/** For tests: a fixed set of frozen people. */
export class MemoryFreezeRead implements AccountFreezeRead {
  readonly frozenUsers = new Set<string>();
  down = false;
  async frozen(userId: string) {
    if (this.down) throw new AccountFreezeUnavailable('TEST: identity down');
    return this.frozenUsers.has(userId);
  }
}
