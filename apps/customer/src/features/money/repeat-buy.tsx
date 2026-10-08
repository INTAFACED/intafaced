import { Button, Page } from '../../shared/ui';
import {
  amount,
  funds,
  cadenceField,
  Continuation,
  date,
  iso,
  NoRows,
  positiveMoney,
  ResourceView,
  Section,
  startsField,
  useBankRead,
  usePageLimit,
  type ActionSpec,
} from './components';

export function AutoInvestRules({ asset, open }: { asset?: string; open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const { resource, reload } = useBankRead('autoInvest.list', { limit });
  return (
    <Section
      title="Your automation"
      description="Instructions over the same ledger. Rules hold no independent balance."
      actions={
        <Button variant="ghost" onClick={reload}>
          Refresh
        </Button>
      }
    >
      <ResourceView resource={resource} reload={reload}>
        {(all) => {
          const rows = asset ? all.filter((rule) => rule.buyAssetId === asset || rule.assetId === asset) : all;
          return (
            <>
              {rows.length ? (
                rows.map((rule) => (
                  <article className="money-record" key={rule.id}>
                    <header>
                      <div>
                        <h3>
                          {rule.kind === 'dca'
                            ? `Repeat buy ${rule.buyAssetId ?? 'asset unavailable'}`
                            : rule.kind === 'threshold_sweep'
                              ? 'Threshold sweep'
                              : 'Card round-up'}
                        </h3>
                        <p>
                          {rule.status} · {rule.cadence ?? 'Event driven'}
                        </p>
                      </div>
                      <span className="numeric">{funds(rule.amount ?? rule.threshold, rule.assetId)}</span>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>Next run</dt>
                        <dd>{date(rule.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>Rule reference</dt>
                        <dd>{rule.id}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      {rule.status !== 'cancelled' && (
                        <>
                          {rule.status === 'paused' ? (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                open({
                                  title: 'Resume automation',
                                  procedure: 'autoInvest.resume',
                                  notes: ['The runner applies normal due rules. It does not invent a catch-up batch.'],
                                  facts: [
                                    ['Rule', rule.id],
                                    ['Asset', rule.assetId],
                                  ],
                                  input: () => ({ ruleId: rule.id }),
                                })
                              }
                            >
                              Resume
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                open({
                                  title: 'Pause automation',
                                  procedure: 'autoInvest.pause',
                                  notes: ['Pause future runner activity. Funds already moved remain in their ledger accounts.'],
                                  facts: [['Rule', rule.id]],
                                  input: () => ({ ruleId: rule.id }),
                                })
                              }
                            >
                              Pause
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            onClick={() =>
                              open({
                                title: 'Cancel automation',
                                procedure: 'autoInvest.cancel',
                                notes: ['Cancel this instruction. This does not unwind past purchases or deposits.'],
                                facts: [['Rule', rule.id]],
                                input: () => ({ ruleId: rule.id }),
                              })
                            }
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title="No automation returned for this asset">
                  Create an instruction only when its required capability is connected.
                </NoRows>
              )}
              <Continuation count={all.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}
export function RepeatBuy({ asset, open }: { asset: string; open: (spec: ActionSpec) => void }) {
  const { resource, reload } = useBankRead('autoInvest.policy', undefined);
  return (
    <Page
      eyebrow="Money / Holding"
      title={`Repeat buy ${asset}`}
      description="A recurring instruction uses available funds and the connected convert counterparty."
      actions={
        <a className="button button--secondary" href={`/portfolio/${encodeURIComponent(asset)}`}>
          Back to {asset}
        </a>
      }
    >
      <Section title="Create a repeat buy">
        <ResourceView resource={resource} reload={reload}>
          {(policy) =>
            policy.enabled && policy.convertWired ? (
              <>
                <p className="muted">
                  Choose the asset to spend, an exact quantity in that asset, and when to start. No rate or purchase outcome is guaranteed.
                </p>
                <Button
                  onClick={() =>
                    open({
                      title: `Repeat buy ${asset}`,
                      procedure: 'autoInvest.createDca',
                      fields: [
                        {
                          name: 'spendAssetId',
                          label: 'Spend asset',
                          hint: 'Use the exact asset code held in your user available account.',
                          validate: (value) => (value.length <= 16 ? null : 'Asset codes are limited to 16 characters.'),
                        },
                        positiveMoney('spend asset'),
                        cadenceField,
                        startsField,
                      ],
                      facts: [['Buy asset', asset]],
                      notes: [
                        'Each due run uses the connected convert counterparty. Rates are obtained when the runner executes.',
                        'Missing rates or insufficient available funds must refuse. No pending-deposit buying credit is assumed.',
                      ],
                      input: (values) => ({
                        spendAssetId: values.spendAssetId,
                        buyAssetId: asset,
                        amount: values.amount,
                        cadence: values.cadence,
                        startsAt: iso(values.startsAt!),
                      }),
                    })
                  }
                >
                  Set up repeat buy
                </Button>
              </>
            ) : (
              <NoRows title={policy.enabled ? 'Convert counterparty is not connected' : 'Auto-invest is disabled'}>
                {policy.enabled
                  ? 'A repeat buy requires an authoritative convert route. No schedule is enabled from this screen.'
                  : 'The current Bank policy disables automated investing.'}
              </NoRows>
            )
          }
        </ResourceView>
      </Section>
      <AutoInvestRules asset={asset} open={open} />
    </Page>
  );
}
