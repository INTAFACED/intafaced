import { Tag, StateBlock } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { Loadable } from '../../../data/types';
import { accessCopy } from './access-copy';
import type { GatedList } from './api';
import { useGatedList } from './data';
import { futuresRefusal } from './refusals';

const note = 'lt-note';

/**
 * Who may open on this contract (D-ops-01, D-account-07): the account's gated list for the contract and every reason it
 * is blocked. No agreement, quiz or notice is asked for here (owner decision 2026-10-27). The open path runs its own
 * gates; this panel only reads them.
 */
export function AccessPanel({ symbol }: { symbol: string }) {
  const gated = useGatedList();
  return (
    <section aria-label={accessCopy.useCopy().t('Access')} className="lt-panel" data-testid="futures-access">
      <GateLine gated={gated} symbol={symbol} />
    </section>
  );
}

function GateLine({ gated, symbol }: { gated: Loadable<GatedList>; symbol: string }) {
  const { t } = accessCopy.useCopy();
  if (gated.status === 'loading') return <Skeleton shape="text" count={1} />;
  if (gated.status === 'error')
    return <StateBlock kind="error" title={t('Access')} thing={t('Access thing')} onRetry={gated.retry} retryLabel={t('Try again')} />;
  if (gated.status !== 'ready') {
    const words = futuresRefusal({ code: gated.status === 'refused' ? gated.code : undefined });
    return <p className={note}>{words.title}</p>;
  }
  const contract = gated.data.contracts.find((c) => c.symbol === symbol);
  if (!contract) return <p className={note}>{t('Access not listed')}</p>;
  return (
    <div className="lt-stack-tight" data-testid="futures-gate">
      <div className="lt-row lt-row-between">
        <h3 className="lt-panel-title">{t('Access')}</h3>
        <Tag tone={contract.open ? 'accent' : 'warn'}>{contract.open ? t('Access open') : t('Access blocked')}</Tag>
      </div>
      {contract.blockers.length > 0 ? (
        <ul aria-label={t('Access reasons')} className="lt-list">
          {contract.blockers.map((blocker) => {
            const words = futuresRefusal({ code: blocker.code, message: blocker.message });
            return (
              <li key={blocker.code} className={note} data-code={blocker.code}>
                <span className="lt-strong">{words.title}.</span> {words.body}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
