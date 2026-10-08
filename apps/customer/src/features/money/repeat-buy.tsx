import { t as copyText, Text } from './copy';
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
      title={copyText('repeat-buy.your.automation')}
      description={copyText('repeat-buy.instructions.over.the.same.ledger.rules.hold')}
      actions={
        <Button variant="ghost" onClick={reload}>
          <Text k="repeat-buy.refresh" />
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
                            ? copyText('repeat-buy.repeat.buy', { value1: rule.buyAssetId ?? copyText('repeat-buy.asset.unavailable') })
                            : rule.kind === 'threshold_sweep'
                              ? copyText('repeat-buy.threshold.sweep')
                              : copyText('repeat-buy.card.round.up')}
                        </h3>
                        <p>
                          {rule.status} · {rule.cadence ?? copyText('repeat-buy.event.driven')}
                        </p>
                      </div>
                      <span className="numeric">{funds(rule.amount ?? rule.threshold, rule.assetId)}</span>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="repeat-buy.next.run" />
                        </dt>
                        <dd>{date(rule.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="repeat-buy.rule.reference" />
                        </dt>
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
                                  title: copyText('repeat-buy.resume.automation'),
                                  procedure: 'autoInvest.resume',
                                  notes: [copyText('repeat-buy.the.runner.applies.normal.due.rules.it')],
                                  facts: [
                                    [copyText('repeat-buy.rule'), rule.id],
                                    [copyText('repeat-buy.asset'), rule.assetId],
                                  ],
                                  input: () => ({ ruleId: rule.id }),
                                })
                              }
                            >
                              <Text k="repeat-buy.resume" />
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                open({
                                  title: copyText('repeat-buy.pause.automation'),
                                  procedure: 'autoInvest.pause',
                                  notes: [copyText('repeat-buy.pause.future.runner.activity.funds.already.moved')],
                                  facts: [[copyText('repeat-buy.rule'), rule.id]],
                                  input: () => ({ ruleId: rule.id }),
                                })
                              }
                            >
                              <Text k="repeat-buy.pause" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            onClick={() =>
                              open({
                                title: copyText('repeat-buy.cancel.automation'),
                                procedure: 'autoInvest.cancel',
                                notes: [copyText('repeat-buy.cancel.this.instruction.this.does.not.unwind')],
                                facts: [[copyText('repeat-buy.rule'), rule.id]],
                                input: () => ({ ruleId: rule.id }),
                              })
                            }
                          >
                            <Text k="repeat-buy.cancel" />
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('repeat-buy.no.automation.returned.for.this.asset')}>
                  <Text k="repeat-buy.create.an.instruction.only.when.its.required" />
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
      eyebrow={copyText('repeat-buy.money.holding')}
      title={copyText('repeat-buy.repeat.buy', { value1: asset })}
      description={copyText('repeat-buy.a.recurring.instruction.uses.available.funds.and')}
      actions={
        <a className="button button--secondary" href={`/portfolio/${encodeURIComponent(asset)}`}>
          <Text k="repeat-buy.back.to" />
          {asset}
        </a>
      }
    >
      <Section title={copyText('repeat-buy.create.a.repeat.buy')}>
        <ResourceView resource={resource} reload={reload}>
          {(policy) =>
            policy.enabled && policy.convertWired ? (
              <>
                <p className="muted">
                  <Text k="repeat-buy.choose.the.asset.to.spend.an.exact" />
                </p>
                <Button
                  onClick={() =>
                    open({
                      title: copyText('repeat-buy.repeat.buy.2', { asset: asset }),
                      procedure: 'autoInvest.createDca',
                      fields: [
                        {
                          name: 'spendAssetId',
                          label: copyText('repeat-buy.spend.asset'),
                          hint: copyText('repeat-buy.use.the.exact.asset.code.held.in'),
                          validate: (value) =>
                            value.length <= 16 ? null : copyText('repeat-buy.asset.codes.are.limited.to.16.characters'),
                        },
                        positiveMoney(undefined),
                        cadenceField,
                        startsField,
                      ],
                      facts: [[copyText('repeat-buy.buy.asset'), asset]],
                      notes: [
                        copyText('repeat-buy.each.due.run.uses.the.connected.convert'),
                        copyText('repeat-buy.missing.rates.or.insufficient.available.funds.must'),
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
                  <Text k="repeat-buy.set.up.repeat.buy" />
                </Button>
              </>
            ) : (
              <NoRows
                title={
                  policy.enabled
                    ? copyText('repeat-buy.convert.counterparty.is.not.connected')
                    : copyText('repeat-buy.auto.invest.is.disabled')
                }
              >
                {policy.enabled
                  ? copyText('repeat-buy.a.repeat.buy.requires.an.authoritative.convert')
                  : copyText('repeat-buy.the.current.bank.policy.disables.automated.investing')}
              </NoRows>
            )
          }
        </ResourceView>
      </Section>
      <AutoInvestRules asset={asset} open={open} />
    </Page>
  );
}
