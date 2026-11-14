import { accountStatusSchema } from '@intafaced/contracts/identity-account-status';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { accountStatusCopy as copy } from './account-status-copy';

/**
 * J-identity-14 #2: a trading-hold refusal (`trade.account_restricted`) on any screen gives the restriction's stored
 * reason in the same words the account status page uses: the owner's sentence for the code staff chose, and its next
 * step, read from identity's `accountStatus.mine`. Never the code. Shows nothing while it loads, when the read fails, or
 * when staff restricted with no listed code: the refusal's own words still stand.
 */
export function TradingHoldReason() {
  const { api, userId } = useSession();
  const { Copy } = copy.useCopy();
  const { resource } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'accountStatus.mine', undefined, accountStatusSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `trading-hold-reason:${userId}`,
  );
  if (resource.status !== 'ready' || !resource.data) return null;
  const owner = resource.data.restrictions.find((r) => r.kind === 'trading_restricted')?.owner;
  if (!owner?.text) return null;
  return (
    <p data-testid="trading-hold-reason">
      {owner.text} {owner.guidance && <Copy k="ownerNext" params={{ guidance: owner.guidance }} />}
    </p>
  );
}
