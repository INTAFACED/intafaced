import { useResource } from '../../../shared/resource';
import { useSession } from '../../../features/session/session';
import { verificationStatus } from '../../../features/account/verification-guards';
import { tradeAccess } from '../markets/TradeAccess';

/** The trade jurisdiction's refusal for a person below the tier trading needs (svc-trade, packages/config). */
export const KYC_REQUIRED = 'denied.kyc_required';

/** The lowest level the desk takes orders from, read as the Trade door reads it (identity's own kyc.status). */
export type Access = 'loading' | 'unread' | 'verified' | 'verify';
export function useTradeAccess(): Access {
  const { api, userId } = useSession();
  const { resource } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'kyc.status', { limit: 1 }, verificationStatus(userId, 1), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `venue-desk-access:${userId ?? 'guest'}`,
  );
  if (resource.status === 'loading') return 'loading';
  if (resource.status !== 'ready' || resource.data === null) return 'unread';
  const state = tradeAccess(resource.data);
  if (state.kind === 'verified') return 'verified';
  return state.kind === 'unread' ? 'unread' : 'verify';
}
