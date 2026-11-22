import { Button } from '../../shared/ui';
import { t } from './repeat-buy-copy';
import { Continuation, date, funds, NoRows, ResourceView, Section, type ActionSpec } from './components';
import { useAutoInvestRules } from './repeat-buy/repeat-buy';

/**
 * Every automation rule, on the Earn room, drawn as that room is drawn until it moves to Volt. Repeat buy draws the
 * same rules in Volt (`AutoInvestRules`); both read them, and review pause, resume and cancel, through `useAutoInvestRules`.
 */
export function EarnRules({ open }: { open: (spec: ActionSpec) => void }) {
  const { limit, setLimit, resource, reload, lifecycle } = useAutoInvestRules();
  return (
    <Section
      title={t('allRules')}
      description={t('allRulesDetail')}
      actions={
        <Button variant="ghost" onClick={reload}>
          {t('refresh')}
        </Button>
      }
    >
      <ResourceView resource={resource} reload={reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((rule) => (
                <article className="money-record money-repeat-rule" key={rule.id}>
                  <header>
                    <div>
                      <h3>
                        {rule.kind === 'dca'
                          ? t('pair', { amount: funds(rule.amount, rule.assetId), asset: rule.buyAssetId ?? t('buyUnavailable') })
                          : rule.kind === 'threshold_sweep'
                            ? t('sweep')
                            : t('roundup')}
                      </h3>
                      <p className={rule.status === 'active' ? 'money-repeat-active' : undefined}>
                        {rule.status} · {rule.cadence ?? t('eventDriven')}
                      </p>
                    </div>
                    {rule.kind === 'dca' ? (
                      <span className="muted">{t('budget')}</span>
                    ) : (
                      <span className="numeric">{funds(rule.threshold ?? rule.amount, rule.assetId)}</span>
                    )}
                  </header>
                  <dl className="detail-list">
                    <div>
                      <dt>{t('nextRun')}</dt>
                      <dd>{date(rule.nextRunAt)}</dd>
                    </div>
                    <div>
                      <dt>{t('reference')}</dt>
                      <dd>{rule.id}</dd>
                    </div>
                  </dl>
                  {rule.status === 'paused' && <p className="muted">{t('pausedNote')}</p>}
                  {rule.status !== 'cancelled' && (
                    <div className="actions">
                      <Button variant="secondary" onClick={() => open(lifecycle(rule, rule.status === 'paused' ? 'resume' : 'pause'))}>
                        {t(rule.status === 'paused' ? 'resume' : 'pause')}
                      </Button>
                      <Button variant="ghost" onClick={() => open(lifecycle(rule, 'cancel'))}>
                        {t('cancel')}
                      </Button>
                    </div>
                  )}
                </article>
              ))
            ) : (
              <NoRows title={t('noAutomation')}>{t('noRulesDetail')}</NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            <p className="muted money-repeat-coverage">{t('historyMissing')}</p>
          </>
        )}
      </ResourceView>
    </Section>
  );
}
