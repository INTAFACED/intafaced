import { KYC_LADDER_LEVELS } from '@intafaced/contracts/identity-kyc-levels';
import { verificationStatus } from '../../../features/account/verification-guards';
import { useSession } from '../../../features/session/session';
import { useResource } from '../../../shared/resource';
import { Button } from './deps';
import { marketsCopy } from './copy';

/** The lowest level the spot desk takes orders from (svc-trade's `requireTier(principal, 'basic')`). */
const TRADE_LEVEL = KYC_LADDER_LEVELS.indexOf('basic');

export type TradeAccessState =
  | { kind: 'verify' }
  | { kind: 'pending' }
  | { kind: 'verified'; level: Exclude<(typeof KYC_LADDER_LEVELS)[number], 'none'> }
  | { kind: 'unread' };

/** What the Trade door says about trading, from identity's own answer: the level held now and the newest request. */
export function tradeAccess(
  answer: { tier: (typeof KYC_LADDER_LEVELS)[number]; records: readonly { status: string }[] } | null,
): TradeAccessState {
  if (answer === null) return { kind: 'unread' };
  if (answer.tier !== 'none' && KYC_LADDER_LEVELS.indexOf(answer.tier) >= TRADE_LEVEL) return { kind: 'verified', level: answer.tier };
  return answer.records[0]?.status === 'pending' ? { kind: 'pending' } : { kind: 'verify' };
}

/** The levels the verified line can name: basic and up (below basic the door asks to verify instead). */
const LEVEL_WORD: Record<Exclude<(typeof KYC_LADDER_LEVELS)[number], 'none'>, 'Level basic' | 'Level full' | 'Level institutional'> = {
  basic: 'Level basic',
  full: 'Level full',
  institutional: 'Level institutional',
};

/**
 * The Trade door's line about the person's own trading access: "Verify to trade" with the way to Verify, "Verification
 * pending", or "Verified to trade" with the level. Signed out, it says nothing (the desk asks to sign in); while the read
 * is under way it says nothing; a read that fails says so, with a retry, and never guesses.
 */
export function TradeAccess() {
  const { api, userId } = useSession();
  const { t } = marketsCopy.useCopy();
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'kyc.status', { limit: 1 }, verificationStatus(userId, 1), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `trade-access:${userId ?? 'guest'}`,
  );
  if (!userId || resource.status === 'loading') return null;
  const state = tradeAccess(resource.status === 'ready' ? resource.data : null);
  if (state.kind === 'unread')
    return (
      <div data-testid="trade-access" data-state="unread" className="mkt-access" role="status">
        <strong>{t('Access unread')}</strong>
        <Button variant="ghost" size={28} onClick={reload}>
          {t('Try again')}
        </Button>
      </div>
    );
  if (state.kind === 'verified')
    return (
      <div data-testid="trade-access" data-state="verified" data-level={state.level} className="mkt-access">
        <strong>{t('Verified to trade')}</strong>
        <span className="mkt-muted">{t('Access level', { level: t(LEVEL_WORD[state.level]) })}</span>
      </div>
    );
  return (
    <div data-testid="trade-access" data-state={state.kind} className="mkt-access">
      <strong>{t(state.kind === 'pending' ? 'Verification pending' : 'Verify to trade')}</strong>
      <span className="mkt-muted">{t(state.kind === 'pending' ? 'Access pending body' : 'Access verify body')}</span>
      <a className="mkt-access__link" href="/verification">
        {t(state.kind === 'pending' ? 'See your request' : 'Verify now')}
      </a>
    </div>
  );
}
