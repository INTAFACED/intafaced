import { Button } from '@intafaced/ui/lit';
import { ReadView } from '../../../shared/read-state';
import { t } from '../repeat-buy-copy';
import { date, funds, type ActionSpec } from '../components';
import { useAutoInvestRules } from '../repeat-buy/repeat-buy';
import { BankSection, Continuation, NoRows } from '../bank-frame/BankFrame';

/**
 * The person's automatic investing rules (threshold sweeps, round-ups, repeat buys), each with its pause, resume and
 * cancel review. Shown in Earn for every rule and on an asset's repeat-buy page for that asset's (repeat-buy.tsx).
 */
export function AutoInvestRules({ asset, open }: { asset?: string; open: (spec: ActionSpec) => void }) {
  const { limit, setLimit, resource, reload, lifecycle } = useAutoInvestRules();
  return (
    <BankSection
      title={asset ? t('buyingRules', { asset }) : t('allRules')}
      description={asset ? t('buyingRulesDetail', { asset }) : t('allRulesDetail')}
      actions={
        <Button tone="quiet" onClick={reload}>
          {t('refresh')}
        </Button>
      }
    >
      <ReadView resource={resource} reload={reload}>
        {(all) => {
          const rows = asset ? all.filter((rule) => rule.kind === 'dca' && rule.buyAssetId === asset) : all;
          return (
            <>
              {rows.length ? (
                rows.map((rule) => (
                  <article key={rule.id}>
                    <header className="lt-title-row">
                      <div>
                        <h3>
                          {rule.kind === 'dca'
                            ? t('pair', { amount: funds(rule.amount, rule.assetId), asset: rule.buyAssetId ?? t('buyUnavailable') })
                            : rule.kind === 'threshold_sweep'
                              ? t('sweep')
                              : t('roundup')}
                        </h3>
                        <p className="lt-hint" data-status={rule.status}>
                          {rule.status} · {rule.cadence ?? t('eventDriven')}
                        </p>
                      </div>
                      {rule.kind === 'dca' ? (
                        <span className="lt-hint">{t('budget')}</span>
                      ) : (
                        <span className="lt-figure">{funds(rule.threshold ?? rule.amount, rule.assetId)}</span>
                      )}
                    </header>
                    <dl className="lt-kv">
                      <div>
                        <dt>{t('nextRun')}</dt>
                        <dd>{date(rule.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>{t('reference')}</dt>
                        <dd>{rule.id}</dd>
                      </div>
                    </dl>
                    {rule.status === 'paused' && <p className="lt-hint">{t('pausedNote')}</p>}
                    {rule.status !== 'cancelled' && (
                      <div className="lt-actions">
                        <Button tone="secondary" onClick={() => open(lifecycle(rule, rule.status === 'paused' ? 'resume' : 'pause'))}>
                          {t(rule.status === 'paused' ? 'resume' : 'pause')}
                        </Button>
                        <Button tone="quiet" onClick={() => open(lifecycle(rule, 'cancel'))}>
                          {t('cancel')}
                        </Button>
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <NoRows title={asset ? t('noRules', { asset }) : t('noAutomation')}>{t('noRulesDetail')}</NoRows>
              )}
              {asset && <p className="lt-hint">{t('matching', { count: String(rows.length), total: String(all.length) })}</p>}
              <Continuation count={all.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
              <p className="lt-hint">{t('historyMissing')}</p>
              {asset && (
                <a className="lt-link" href="/bank/earn">
                  {t('otherAutomation')}
                </a>
              )}
            </>
          );
        }}
      </ReadView>
    </BankSection>
  );
}
