/**
 * Paying a spot fee in the platform token (J-cex-spot-10 #9). Three reads, all the service's own figures:
 *
 *   · the owner's terms in the published fee schedule (`GET /api/v1/fees/published` → `feeToken`): which token, and
 *     what one unit of each fee asset is worth in it. No terms: the choice is not offered, with its reason.
 *   · the person's stake discount (svc-token `accessOf`), read at placement by svc-trade too. Refused (the owner has not
 *     published the decay ladder): not offered, with its reason.
 *   · the decay ladder itself (svc-token `feeDiscount.get`), shown so the person sees how a larger stake lowers the fee.
 *
 * Nothing here prices a fee: the order check and the fill do. A plain market or limit order is the only one that can
 * carry the choice (the service refuses it on a stop, an OCO, a bracket or an OTO), so the others are not offered.
 */
import { feeDiscountLadderSchema, tokenAccessSchema } from '@intafaced/contracts/token-fee-discount';
import { TOKEN_ACCESS_OF } from '@intafaced/contracts/token-procedures';
import { feeTokenTermsSchema, publishedFeeTokenSchema } from '@intafaced/contracts/trade-desk-reads';
import type { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';
import type { Fetcher } from '../../../data/poll';
import type { Loadable } from '../../../data/types';
import type { OrderType } from './order-math';

export type FeeTokenTerms = z.infer<typeof feeTokenTermsSchema>;
export interface FeeToken {
  readonly terms: FeeTokenTerms | null;
  /** The person's stake and its discount, or null when svc-token refused (`accessRefused` says why) or no one is signed in. */
  readonly access: { readonly staked: string; readonly discountBps: number } | null;
  readonly accessRefused: string | null;
  /** The published decay ladder, lowest stake first; null when it could not be read. */
  readonly ladder: ReadonlyArray<{ readonly minStake: string; readonly discountBps: number }> | null;
}

const FEE_SCHEDULE_BLANK = 'trade.fee_schedule_blank';

/** The three reads as one desk source. The token reads run only when terms are published and someone is signed in. */
export const feeTokenFetcher =
  (api: ApiClient, signedIn: boolean): Fetcher<FeeToken> =>
  async (signal): Promise<ApiResult<FeeToken>> => {
    const published = await api.rest('/fees/published', publishedFeeTokenSchema, { signal });
    if (!published.ok && published.code !== FEE_SCHEDULE_BLANK) return published;
    const terms = published.ok ? (published.data.feeToken ?? null) : null;
    if (!terms || !signedIn) return { ok: true, data: { terms, access: null, accessRefused: null, ladder: null } };
    const [access, ladder] = await Promise.all([
      api.call(TOKEN_ACCESS_OF, undefined, { signal, accept: (access) => tokenAccessSchema.safeParse(access).success }),
      api.query('token', 'feeDiscount.get', undefined, feeDiscountLadderSchema, { signal }),
    ]);
    return {
      ok: true,
      data: {
        terms,
        access: access.ok ? { staked: access.data.staked, discountBps: access.data.feeDiscountBps } : null,
        accessRefused: access.ok ? null : (access.code ?? 'unavailable'),
        ladder: ladder.ok ? (ladder.data.schedule?.tiers ?? null) : null,
      },
    };
  };

export type FeeTokenChoice =
  | {
      readonly kind: 'offered';
      readonly token: string;
      readonly discountBps: number;
      readonly staked: string;
      readonly ladder: FeeToken['ladder'];
    }
  | {
      readonly kind: 'not_offered';
      /** `no_terms` also covers a schedule that is unpublished or still loading: nothing is offered until it answers. */
      /** `received`: the order receives the token itself, so its fee is paid in it already. */
      readonly reason: 'no_terms' | 'received' | 'no_price' | 'no_discount' | 'order_type' | 'signed_out';
      readonly token: string | null;
    };

/** Whether this order can pay its fee in the token, and if not, why. */
export function feeTokenChoice(source: Loadable<FeeToken>, receive: string, type: OrderType, signedIn: boolean): FeeTokenChoice {
  const data = source.status === 'ready' ? source.data : null;
  const terms = data?.terms ?? null;
  if (!terms) return { kind: 'not_offered', reason: 'no_terms', token: null };
  const token = terms.asset;
  if (receive === token) return { kind: 'not_offered', reason: 'received', token };
  if (terms.perUnit[receive] === undefined) return { kind: 'not_offered', reason: 'no_price', token };
  if (!signedIn) return { kind: 'not_offered', reason: 'signed_out', token };
  if (type !== 'limit' && type !== 'market') return { kind: 'not_offered', reason: 'order_type', token };
  if (!data?.access) return { kind: 'not_offered', reason: 'no_discount', token };
  return { kind: 'offered', token, discountBps: data.access.discountBps, staked: data.access.staked, ladder: data.ladder };
}
