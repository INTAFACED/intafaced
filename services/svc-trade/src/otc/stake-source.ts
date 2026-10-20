/**
 * Stake gate source for OTC (token.stakeOf via S2S).
 * Fails closed — never invent a stake total.
 */

import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { OtcError } from './errors.js';

export interface OtcStakeSource {
  stakeOf(userId: string): Promise<Amount>;
}

export function createOtcStakeSource(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): OtcStakeSource {
  const url = baseUrl.replace(/\/$/, '');
  const authHeaders = serviceCallSigner({ service: 'svc-trade', audience: 'svc-token', legacySecret: internalSecret, s2s });

  return {
    async stakeOf(userId: string): Promise<Amount> {
      let response: Response;
      try {
        const target = `${url}/internal/stake/${encodeURIComponent(userId)}`;
        response = await fetch(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...authHeaders('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch (err) {
        throw new OtcError(`OTC stake gate unavailable: ${(err as Error).message}`, 'trade.otc_stake_unavailable');
      }

      if (!response.ok) {
        throw new OtcError(`OTC stake gate unavailable (${response.status})`, 'trade.otc_stake_unavailable');
      }

      const body = (await response.json().catch(() => null)) as { staked?: unknown } | null;
      if (typeof body?.staked !== 'string') {
        throw new OtcError('OTC stake gate returned an unusable payload', 'trade.otc_stake_unavailable');
      }

      try {
        return parseAmount(body.staked);
      } catch {
        throw new OtcError('OTC stake gate returned an unparseable amount', 'trade.otc_stake_unavailable');
      }
    },
  };
}

/** Explicit fixed stake for tests — never a production fallback. */
export class FixedOtcStake implements OtcStakeSource {
  constructor(private readonly staked: Amount) {}
  async stakeOf(): Promise<Amount> {
    return this.staked;
  }
}
