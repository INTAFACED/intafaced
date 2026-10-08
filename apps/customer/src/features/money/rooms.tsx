import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { Button, DataTable, EmptyState, Failure, Field, Page } from '../../shared/ui';
import { decimalSchema, parseAmount } from '../../shared/money';
import { useSession } from '../session/session';
import { validateTransfer, type Space } from './client';
import {
  amount,
  funds,
  bps,
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
  uuidField,
  type ActionSpec,
} from './components';
import { AutoInvestRules } from './repeat-buy';

const bankRooms = ['Overview', 'Spaces', 'Transfers', 'Earn', 'Loans', 'Cards', 'Ramps', 'Analytics', 'Business'] as const;
const bankLabels = {
  Overview: 'nav.overview',
  Spaces: 'nav.spaces',
  Transfers: 'nav.transfers',
  Earn: 'nav.earn',
  Loans: 'nav.loans',
  Cards: 'nav.cards',
  Ramps: 'nav.ramps',
  Analytics: 'nav.analytics',
  Business: 'nav.business',
} as const;
export function BankNavigation({ current }: { current: string }) {
  return (
    <nav className="money-bank-nav" aria-label={copyText('rooms.bank.rooms')}>
      {bankRooms.map((room) => (
        <a
          key={room}
          href={room === 'Overview' ? '/bank' : `/bank/${room.toLowerCase()}`}
          aria-current={current === room ? 'page' : undefined}
        >
          <Text k={bankLabels[room]} />
        </a>
      ))}
    </nav>
  );
}
function BankPage({ room, description, children }: { room: string; description: string; children: React.ReactNode }) {
  return (
    <Page
      eyebrow={copyText('rooms.money.bank')}
      title={room in bankLabels ? copyText(bankLabels[room as keyof typeof bankLabels]) : room}
      description={description}
      actions={
        <a className="button button--secondary" href="/bank">
          <Text k="rooms.bank.overview" />
        </a>
      }
    >
      <BankNavigation current={room} />
      {children}
    </Page>
  );
}
const assetField = {
  name: 'assetId',
  get label() {
    return copyText('rooms.asset');
  },
  get hint() {
    return copyText('rooms.exact.asset.code.this.does.not.convert');
  },
  validate: (value: string) => (value.length <= 16 ? null : copyText('rooms.asset.codes.are.limited.to.16.characters')),
};
const moneyValue = (value: string) =>
  decimalSchema.safeParse(value).success ? null : copyText('rooms.enter.an.exact.nonnegative.decimal');
function spaceName(space: Space) {
  return copyText('rooms.available', {
    value1: space.name,
    value2: space.assetId,
    value3: funds(space.balance, space.assetId),
    value4: space.lockedUntil && Date.parse(space.lockedUntil) > Date.now() ? ' · locked' : '',
  });
}
function Spaces({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const spaces = useBankRead('spaces.list', { limit });
  const unnamed = useBankRead('spaces.unnamed', undefined);
  const create = () =>
    open({
      title: copyText('rooms.create.space'),
      procedure: 'spaces.create',
      fields: [
        assetField,
        {
          name: 'name',
          label: copyText('rooms.space.name'),
          validate: (value) => (value.length <= 64 ? null : copyText('rooms.use.64.characters.or.fewer')),
        },
        {
          name: 'goalTarget',
          label: copyText('rooms.savings.target.asset.units'),
          optional: true,
          hint: copyText('rooms.a.target.is.not.a.balance'),
          validate: moneyValue,
        },
        { ...startsField, name: 'lockedUntil', label: copyText('rooms.lock.until.optional'), optional: true },
      ],
      notes: [copyText('rooms.a.named.space.is.a.ledger.subaccount'), copyText('rooms.a.future.lock.prevents.bank.debits.from')],
      input: (values) => ({
        assetId: values.assetId,
        name: values.name,
        ...(values.goalTarget ? { goalTarget: values.goalTarget } : {}),
        ...(values.lockedUntil ? { lockedUntil: iso(values.lockedUntil) } : {}),
      }),
    });
  return (
    <BankPage room="Spaces" description={copyText('rooms.give.an.asset.a.purpose.inside.the')}>
      <Section
        title={copyText('rooms.your.spaces')}
        actions={
          <>
            <Button variant="ghost" onClick={spaces.reload}>
              <Text k="rooms.refresh" />
            </Button>
            <Button onClick={create}>
              <Text k="rooms.create.space" />
            </Button>
          </>
        }
      >
        <ResourceView resource={spaces.resource} reload={spaces.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((space) => (
                  <article className="money-record" key={space.id}>
                    <header>
                      <div>
                        <h3>{space.name}</h3>
                        <p>
                          {space.assetId} ·{' '}
                          {space.kind === 'primary'
                            ? copyText('rooms.primary.included.in.your.user.ledger.projection')
                            : copyText('rooms.named.ledger.subaccount')}
                        </p>
                      </div>
                      <strong className="numeric">{funds(space.balance, space.assetId)}</strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="rooms.target" />
                        </dt>
                        <dd>{funds(space.goalTarget, space.assetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.bank.lock" />
                        </dt>
                        <dd>{date(space.lockedUntil)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.space.reference" />
                        </dt>
                        <dd>{space.id}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <a className="button button--secondary" href={`/bank/transfers?from=${encodeURIComponent(space.id)}`}>
                        <Text k="rooms.transfer" />
                      </a>
                      {space.kind === 'named' && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            open({
                              title: copyText('rooms.archive.space'),
                              procedure: 'spaces.archive',
                              facts: [
                                [copyText('rooms.space'), space.name],
                                [copyText('rooms.available.quantity'), amount(space.balance, space.assetId)],
                              ],
                              notes: [
                                copyText('rooms.archiving.removes.the.label.from.active.lists'),
                                copyText('rooms.archived.named.space.funds.are.not.included'),
                              ],
                              input: () => ({ spaceId: space.id }),
                              submit: copyText('rooms.archive.label'),
                            })
                          }
                        >
                          <Text k="rooms.archive.label" />
                        </Button>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.spaces.returned')}>
                  <Text k="rooms.create.a.named.space.its.balance.will" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <Section
        title={copyText('rooms.assets.without.a.space')}
        description={copyText('rooms.positive.user.available.accounts.only.these.quantities')}
      >
        <ResourceView resource={unnamed.resource} reload={unnamed.reload}>
          {(rows) =>
            rows.length ? (
              rows.map((row) => (
                <div className="money-space-row" key={row.assetId}>
                  <strong>{row.assetId}</strong>
                  <span className="numeric">{funds(row.balance, row.assetId)}</span>
                </div>
              ))
            ) : (
              <NoRows title={copyText('rooms.no.unnamed.positive.quantities.returned')}>
                <Text k="rooms.this.does.not.establish.that.all.balances" />
              </NoRows>
            )
          }
        </ResourceView>
      </Section>
    </BankPage>
  );
}
function ScheduleExecutions({ id, asset }: { id: string; asset: string }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('transfers.executions', { scheduleId: id, limit });
  return (
    <Section title={copyText('rooms.execution.outcomes')} description={copyText('rooms.each.due.occurrence.has.its.own.status')}>
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              <DataTable
                headers={[
                  copyText('rooms.occurrence'),
                  copyText('rooms.amount'),
                  copyText('rooms.status.refusal'),
                  copyText('rooms.ledger.transaction'),
                ]}
                label={copyText('rooms.schedule.execution.outcomes')}
              >
                {rows.map((row) => (
                  <tr key={row.occurrence}>
                    <td>{row.occurrence}</td>
                    <td className="numeric">{funds(row.amount, asset)}</td>
                    <td>
                      {row.status}
                      {row.rejectionCode && <small className="money-block">{row.rejectionCode}</small>}
                    </td>
                    <td>{row.ledgerTxId ?? copyText('rooms.no.posted.transaction')}</td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <NoRows title={copyText('rooms.no.executions.returned')}>
                <Text k="rooms.the.schedule.has.no.recorded.execution.on" />
              </NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Schedules({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<{ id: string; asset: string } | null>(null);
  const query = useBankRead('transfers.listSchedules', { limit });
  return (
    <>
      <Section
        title={copyText('rooms.standing.orders')}
        actions={
          <Button variant="ghost" onClick={query.reload}>
            <Text k="rooms.refresh" />
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={query.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((row) => (
                  <article className="money-record" key={row.id}>
                    <header>
                      <div>
                        <h3>
                          {row.cadence}
                          <Text k="rooms.transfer.2" />
                        </h3>
                        <p>
                          {row.status}
                          <Text k="rooms.next.run" />
                          {date(row.nextRunAt)}
                        </p>
                      </div>
                      <strong className="numeric">{funds(row.amount, row.assetId)}</strong>
                    </header>
                    <div className="actions">
                      <Button variant="secondary" onClick={() => setSelected({ id: row.id, asset: row.assetId })}>
                        <Text k="rooms.execution.history" />
                      </Button>
                      {row.status !== 'cancelled' && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              open({
                                title:
                                  row.status === 'paused'
                                    ? copyText('rooms.resume.standing.order')
                                    : copyText('rooms.pause.standing.order'),
                                procedure: row.status === 'paused' ? 'transfers.resume' : 'transfers.pause',
                                facts: [
                                  [copyText('rooms.schedule'), row.id],
                                  [copyText('rooms.amount'), amount(row.amount, row.assetId)],
                                ],
                                notes: [
                                  row.status === 'paused'
                                    ? copyText('rooms.occurrences.missed.while.paused.are.skipped.they')
                                    : copyText('rooms.pause.future.scheduled.transfers.past.posted.transfers'),
                                ],
                                input: () => ({ scheduleId: row.id }),
                              })
                            }
                          >
                            {row.status === 'paused' ? copyText('rooms.resume') : copyText('rooms.pause')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              open({
                                title: copyText('rooms.cancel.standing.order'),
                                procedure: 'transfers.cancel',
                                notes: [copyText('rooms.cancel.future.occurrences.this.does.not.reverse')],
                                facts: [[copyText('rooms.schedule'), row.id]],
                                input: () => ({ scheduleId: row.id }),
                              })
                            }
                          >
                            <Text k="rooms.cancel" />
                          </Button>
                        </>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.standing.orders.returned')}>
                  <Text k="rooms.a.scheduled.transfer.appears.here.after.the" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      {selected && <ScheduleExecutions id={selected.id} asset={selected.asset} />}
    </>
  );
}
function Transfers({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('spaces.list', { limit });
  const [fromId, setFrom] = useState(() => new URLSearchParams(location.search).get('from') ?? '');
  const [destination, setDestination] = useState<'space' | 'user'>('space');
  const [scheduled, setScheduled] = useState(false);
  return (
    <BankPage room="Transfers" description={copyText('rooms.move.available.quantities.between.spaces.or.to')}>
      <Section title={copyText('rooms.new.transfer')}>
        <ResourceView resource={query.resource} reload={query.reload}>
          {(spaces) => {
            const from = spaces.find((row) => row.id === fromId);
            return spaces.length ? (
              <>
                <div className="money-transfer-setup">
                  <label className="field">
                    <span>
                      <Text k="rooms.from.your.space" />
                    </span>
                    <select value={fromId} onChange={(event) => setFrom(event.target.value)}>
                      <option value="">
                        <Text k="rooms.choose.source" />
                      </option>
                      {spaces.map((space) => (
                        <option key={space.id} value={space.id}>
                          {spaceName(space)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>
                      <Text k="rooms.destination" />
                    </span>
                    <select value={destination} onChange={(event) => setDestination(event.target.value as 'space' | 'user')}>
                      <option value="space">
                        <Text k="rooms.space.id" />
                      </option>
                      <option value="user">
                        <Text k="rooms.user.id" />
                      </option>
                    </select>
                  </label>
                  <label className="money-check">
                    <input type="checkbox" checked={scheduled} onChange={(event) => setScheduled(event.target.checked)} />
                    <Text k="rooms.repeat.on.a.schedule" />
                  </label>
                  <Button
                    disabled={!from}
                    onClick={() => {
                      if (!from) return;
                      open({
                        title: scheduled ? copyText('rooms.schedule.transfer') : copyText('rooms.transfer'),
                        procedure: scheduled
                          ? destination === 'space'
                            ? 'transfers.schedule'
                            : 'transfers.scheduleToUser'
                          : destination === 'space'
                            ? 'transfers.create'
                            : 'transfers.toUser',
                        initial: { fromSpaceId: from.id },
                        fields: [
                          destination === 'space'
                            ? uuidField('toSpaceId', copyText('rooms.destination.space.id'))
                            : {
                                name: 'toUserId',
                                label: copyText('rooms.recipient.user.id'),
                                validate: (value) => (value.length <= 64 ? null : copyText('rooms.use.64.characters.or.fewer')),
                              },
                          positiveMoney(from.assetId),
                          ...(scheduled ? [cadenceField, startsField] : []),
                        ],
                        facts: [
                          [copyText('rooms.source'), from.name],
                          [copyText('rooms.asset'), from.assetId],
                          [copyText('rooms.available.at.last.read'), amount(from.balance, from.assetId)],
                        ],
                        notes: [
                          copyText('rooms.the.service.checks.ownership.lock.policy.and'),
                          copyText('rooms.use.the.destination.id.supplied.by.your'),
                        ],
                        validate: (input) =>
                          validateTransfer(spaces, { ...input, transferId: 'review-reference' } as Parameters<typeof validateTransfer>[1]),
                        ...(!scheduled ? { transferSpaces: spaces } : {}),
                        input: (values, requestId) => ({
                          fromSpaceId: from.id,
                          ...(destination === 'space' ? { toSpaceId: values.toSpaceId } : { toUserId: values.toUserId }),
                          amount: values.amount,
                          ...(scheduled
                            ? { scheduleId: requestId, cadence: values.cadence, startsAt: iso(values.startsAt!) }
                            : { transferId: requestId }),
                        }),
                      });
                    }}
                  >
                    <Text k="rooms.continue" />
                  </Button>
                </div>
                <Continuation count={spaces.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
              </>
            ) : (
              <NoRows title={copyText('rooms.no.source.spaces.returned')}>
                <Text k="rooms.create.a.space.or.name.an.existing" />
              </NoRows>
            );
          }}
        </ResourceView>
      </Section>
      <Schedules open={open} />
    </BankPage>
  );
}
function Earn({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const pools = useBankRead('earn.pools', { limit });
  const positions = useBankRead('earn.positions', { limit });
  return (
    <BankPage room="Earn" description={copyText('rooms.configured.products.and.ledger.backed.principal.no')}>
      <Section title={copyText('rooms.available.pools')}>
        <ResourceView resource={pools.resource} reload={pools.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((pool) => (
                  <article className="money-record" key={pool.id}>
                    <header>
                      <div>
                        <h3>{pool.name}</h3>
                        <p>
                          {pool.assetId} · {pool.kind} ·{' '}
                          {pool.termDays === null ? copyText('rooms.flexible.term') : copyText('rooms.days', { value1: pool.termDays })}
                        </p>
                      </div>
                      <strong>
                        {bps(pool.aprBps)}
                        <Text k="rooms.apr" />
                      </strong>
                    </header>
                    <p className="money-caption">
                      <Text k="rooms.minimum.deposit" />
                      {funds(pool.minDeposit, pool.assetId)}
                      <Text k="rooms.apr.is.the.configured.simple.annual.rate" />
                    </p>
                    <div className="actions">
                      <Button
                        onClick={() =>
                          open({
                            title: copyText('rooms.deposit.into.earn'),
                            procedure: 'earn.deposit',
                            fields: [positiveMoney(pool.assetId)],
                            facts: [
                              [copyText('rooms.pool'), pool.name],
                              [copyText('rooms.apr.2'), bps(pool.aprBps)],
                              [copyText('rooms.term'), pool.termDays === null ? 'Flexible' : `${pool.termDays} days`],
                              [copyText('rooms.minimum'), amount(pool.minDeposit, pool.assetId)],
                            ],
                            notes: [
                              copyText('rooms.principal.moves.from.your.user.available.account'),
                              copyText('rooms.the.service.verifies.the.pool.is.open'),
                            ],
                            validate: (input) =>
                              parseAmount(String(input.amount)) >= parseAmount(pool.minDeposit)
                                ? null
                                : copyText('rooms.the.amount.is.below.the.configured.minimum'),
                            input: (values, requestId) => ({ poolId: pool.id, positionId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        <Text k="rooms.deposit" />
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open({
                            title: copyText('rooms.create.threshold.sweep'),
                            procedure: 'autoInvest.createThresholdSweep',
                            fields: [
                              { name: 'threshold', label: copyText('rooms.keep.available', { asset: pool.assetId }), validate: moneyValue },
                            ],
                            facts: [
                              [copyText('rooms.pool'), pool.name],
                              [copyText('rooms.asset'), pool.assetId],
                            ],
                            notes: [
                              copyText('rooms.keep.this.exact.quantity.in.the.primary'),
                              copyText('rooms.no.cross.asset.rate.is.assumed.the'),
                            ],
                            input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, threshold: values.threshold }),
                          })
                        }
                      >
                        <Text k="rooms.threshold.sweep" />
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          open({
                            title: copyText('rooms.create.card.round.up'),
                            procedure: 'autoInvest.createRoundUp',
                            fields: [positiveMoney(pool.assetId, 'granularity', copyText('rooms.round.up.increment'))],
                            facts: [
                              [copyText('rooms.pool'), pool.name],
                              [copyText('rooms.asset'), pool.assetId],
                            ],
                            notes: [
                              copyText('rooms.same.asset.spare.change.goes.to.this'),
                              copyText('rooms.this.instruction.does.not.connect.an.issuer'),
                            ],
                            input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, granularity: values.granularity }),
                          })
                        }
                      >
                        <Text k="rooms.card.round.up" />
                      </Button>
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.configured.pools.returned')}>
                  <Text k="rooms.earn.requires.a.published.rate.and.open" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <Section title={copyText('rooms.your.positions')}>
        <ResourceView resource={positions.resource} reload={positions.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((position) => (
                  <article className="money-record" key={position.id}>
                    <header>
                      <div>
                        <h3>
                          {position.assetId}
                          <Text k="rooms.earn.position" />
                        </h3>
                        <p>
                          <Text k="rooms.matures" />
                          {date(position.maturesAt)}
                        </p>
                      </div>
                      <strong className="numeric">
                        {funds(position.principal, position.assetId)}
                        <Text k="rooms.principal" />
                      </strong>
                    </header>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        open({
                          title: copyText('rooms.withdraw.earn.principal'),
                          unit: position.assetId,
                          procedure: 'earn.withdraw',
                          facts: [
                            [copyText('rooms.position'), position.id],
                            [copyText('rooms.principal.2'), amount(position.principal, position.assetId)],
                            [copyText('rooms.matures.2'), date(position.maturesAt)],
                          ],
                          notes: [
                            copyText('rooms.the.service.checks.maturity.and.reconciles.ledger'),
                            copyText('rooms.a.refusal.leaves.the.position.unchanged.no'),
                          ],
                          input: () => ({ positionId: position.id }),
                        })
                      }
                    >
                      <Text k="rooms.review.withdrawal" />
                    </Button>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.active.earn.positions.returned')}>
                  <Text k="rooms.a.position.appears.only.after.the.service" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <AutoInvestRules open={open} />
    </BankPage>
  );
}
function Loans({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const products = useBankRead('loans.products', { limit });
  const loans = useBankRead('loans.list', { limit });
  const health = useBankRead('loans.health', undefined);
  return (
    <BankPage room="Loans" description={copyText('rooms.configured.borrowing.terms.ledger.collateral.and.authoritative')}>
      <Section title={copyText('rooms.loan.health')}>
        <ResourceView resource={health.resource} reload={health.reload}>
          {(risk) => (
            <>
              <div className="money-risk">
                <strong>
                  {bps(risk.portfolioLtvBps)}
                  <Text k="rooms.ltv" />
                </strong>
                <span>
                  {risk.loans.length}
                  <Text k="rooms.loans.in.this.risk.calculation" />
                </span>
              </div>
              <p className="notice">
                <Text k="rooms.this.calculation.values.loans.only.its.response" />
              </p>
            </>
          )}
        </ResourceView>
      </Section>
      <Section title={copyText('rooms.loan.products')}>
        <ResourceView resource={products.resource} reload={products.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((product) => (
                  <article className="money-record" key={product.id}>
                    <header>
                      <div>
                        <h3>{product.name}</h3>
                        <p>
                          <Text k="rooms.borrow" />
                          {product.debtAssetId}
                          <Text k="rooms.secure.with" />
                          {product.collateralAssetId}
                        </p>
                      </div>
                      <strong>
                        {bps(product.aprBps)}
                        <Text k="rooms.apr" />
                      </strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="rooms.minimum.principal" />
                        </dt>
                        <dd>{funds(product.minPrincipal, product.debtAssetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.maximum.ltv" />
                        </dt>
                        <dd>{bps(product.maxLtvBps)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.margin.call.ltv" />
                        </dt>
                        <dd>{bps(product.marginCallLtvBps)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.liquidation.ltv" />
                        </dt>
                        <dd>{bps(product.liquidationLtvBps)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.mark.quote.asset" />
                        </dt>
                        <dd>{product.quoteAssetId}</dd>
                      </div>
                    </dl>
                    <Button
                      onClick={() =>
                        open({
                          title: copyText('rooms.open.loan'),
                          procedure: 'loans.open',
                          fields: [
                            positiveMoney(product.debtAssetId, 'principal', copyText('rooms.principal.to.borrow')),
                            positiveMoney(product.collateralAssetId, 'collateralAmount', copyText('rooms.collateral.to.pledge')),
                          ],
                          facts: [
                            [copyText('rooms.product'), product.name],
                            [copyText('rooms.apr.2'), bps(product.aprBps)],
                            [copyText('rooms.maximum.ltv'), bps(product.maxLtvBps)],
                            [copyText('rooms.margin.call'), bps(product.marginCallLtvBps)],
                            [copyText('rooms.liquidation'), bps(product.liquidationLtvBps)],
                          ],
                          notes: [
                            copyText('rooms.collateral.moves.from.your.user.available.account'),
                            copyText('rooms.the.service.obtains.acceptable.current.marks.and'),
                          ],
                          validate: (input) =>
                            parseAmount(String(input.principal)) >= parseAmount(product.minPrincipal)
                              ? null
                              : copyText('rooms.principal.is.below.the.product.minimum'),
                          input: (values, requestId) => ({
                            loanId: requestId,
                            productId: product.id,
                            principal: values.principal,
                            collateralAmount: values.collateralAmount,
                          }),
                          submit: copyText('rooms.confirm.loan.request'),
                        })
                      }
                    >
                      <Text k="rooms.review.borrowing" />
                    </Button>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.loan.products.returned')}>
                  <Text k="rooms.borrowing.requires.a.configured.open.product.usable" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <Section
        title={copyText('rooms.your.loans')}
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              loans.reload();
              health.reload();
            }}
          >
            <Text k="rooms.refresh.loans.and.health" />
          </Button>
        }
      >
        <ResourceView resource={loans.resource} reload={loans.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((loan) => (
                  <article className="money-record" key={loan.id}>
                    <header>
                      <div>
                        <h3>
                          {loan.debtAssetId}
                          <Text k="rooms.loan" />
                        </h3>
                        <p>
                          {loan.status}
                          {loan.marginCalledAt && copyText('rooms.margin.called', { value1: date(loan.marginCalledAt) })}
                        </p>
                      </div>
                      <strong>
                        {bps(loan.aprBps)}
                        <Text k="rooms.apr" />
                      </strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="rooms.outstanding.principal" />
                        </dt>
                        <dd>{funds(loan.outstandingPrincipal, loan.debtAssetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.outstanding.interest" />
                        </dt>
                        <dd>{funds(loan.outstandingInterest, loan.debtAssetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.ledger.collateral" />
                        </dt>
                        <dd>{funds(loan.collateral, loan.collateralAssetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.loan.reference" />
                        </dt>
                        <dd>{loan.id}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <Button
                        onClick={() =>
                          open({
                            title: copyText('rooms.repay.loan'),
                            procedure: 'loans.repay',
                            fields: [positiveMoney(loan.debtAssetId)],
                            facts: [
                              [copyText('rooms.loan.2'), loan.id],
                              [copyText('rooms.principal.at.last.read'), amount(loan.outstandingPrincipal, loan.debtAssetId)],
                              [copyText('rooms.interest.at.last.read'), amount(loan.outstandingInterest, loan.debtAssetId)],
                            ],
                            notes: [
                              copyText('rooms.repayment.debits.your.user.available.account.the'),
                              copyText('rooms.your.request.reference.remains.stable.an.uncertain'),
                            ],
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        <Text k="rooms.repay" />
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open({
                            title: copyText('rooms.add.collateral'),
                            procedure: 'loans.addCollateral',
                            fields: [positiveMoney(loan.collateralAssetId)],
                            facts: [[copyText('rooms.loan.2'), loan.id]],
                            notes: [copyText('rooms.additional.collateral.is.locked.from.your.user')],
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        <Text k="rooms.add.collateral" />
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          open({
                            title: copyText('rooms.release.excess.collateral'),
                            procedure: 'loans.releaseExcess',
                            fields: [positiveMoney(loan.collateralAssetId)],
                            facts: [
                              [copyText('rooms.loan.2'), loan.id],
                              [copyText('rooms.collateral.at.last.read'), amount(loan.collateral, loan.collateralAssetId)],
                            ],
                            notes: [
                              copyText('rooms.the.service.obtains.current.marks.before.releasing'),
                              copyText('rooms.no.available.amount.is.optimistically.increased.refresh'),
                            ],
                            input: (values) => ({ loanId: loan.id, amount: values.amount }),
                          })
                        }
                      >
                        <Text k="rooms.release.excess" />
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={parseAmount(loan.outstandingPrincipal) !== 0n || parseAmount(loan.outstandingInterest) !== 0n}
                        onClick={() =>
                          open({
                            title: copyText('rooms.release.settled.collateral'),
                            unit: loan.collateralAssetId,
                            procedure: 'loans.close',
                            facts: [
                              [copyText('rooms.loan.2'), loan.id],
                              [copyText('rooms.collateral.at.last.read'), amount(loan.collateral, loan.collateralAssetId)],
                            ],
                            notes: [copyText('rooms.the.service.releases.collateral.only.after.verifying')],
                            input: () => ({ loanId: loan.id }),
                          })
                        }
                      >
                        <Text k="rooms.close.settled.loan" />
                      </Button>
                    </div>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.loans.returned')}>
                  <Text k="rooms.no.loan.balance.is.inferred.from.an" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
    </BankPage>
  );
}
function CardAuthorizations({ id, asset }: { id: string; asset: string }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('cards.authorizations', { cardId: id, limit });
  return (
    <Section title={copyText('rooms.card.decisions')} description={copyText('rooms.approvals.and.declines.remain.visible.including.the')}>
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((row) => (
                <article className="money-record" key={row.id}>
                  <header>
                    <div>
                      <h3>
                        {row.decision} · {row.status}
                      </h3>
                      <p>
                        {date(row.decidedAt)} · {row.merchantCategory ?? copyText('rooms.category.not.supplied')}
                      </p>
                    </div>
                    <strong className="numeric">{funds(row.amount, asset)}</strong>
                  </header>
                  {row.declineCode && (
                    <p className="notice">
                      <Text k="rooms.decline" />
                      {row.declineCode}
                    </p>
                  )}
                  <p className="money-reference">
                    <Text k="rooms.authorization" />
                    {row.authorizationRef}
                  </p>
                  {row.conversion && (
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="rooms.merchant.charge" />
                        </dt>
                        <dd>{funds(row.conversion.settlementAmount, row.conversion.settlementAssetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.conversion.rate" />
                        </dt>
                        <dd>
                          {row.conversion.rate} · {row.conversion.rateQuality}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.rate.time" />
                        </dt>
                        <dd>{date(row.conversion.rateAsOf)}</dd>
                      </div>
                    </dl>
                  )}
                </article>
              ))
            ) : (
              <NoRows title={copyText('rooms.no.card.decisions.returned')}>
                <Text k="rooms.no.purchase.or.decline.is.invented.here" />
              </NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Cards({ open }: { open: (spec: ActionSpec) => void }) {
  const [limit, setLimit] = usePageLimit();
  const programme = useBankRead('cards.programme', undefined);
  const cards = useBankRead('cards.list', { limit });
  const [selected, setSelected] = useState<{ id: string; asset: string } | null>(null);
  const live = programme.resource.status === 'ready' && !programme.resource.data.simulated && programme.resource.data.id !== 'none';
  return (
    <BankPage room="Cards" description={copyText('rooms.issuer.connectivity.and.card.outcomes.are.separate')}>
      <Section title={copyText('rooms.issuer.programme')}>
        <ResourceView resource={programme.resource} reload={programme.reload}>
          {(info) => (
            <div className="money-capability">
              <h3>{info.id === 'none' ? copyText('rooms.card.issuer.is.not.connected') : info.displayName}</h3>
              <p>
                {info.simulated
                  ? copyText('rooms.simulation.programme.it.does.not.issue.a')
                  : info.id === 'none'
                    ? copyText('rooms.a.live.card.requires.a.connected.issuer')
                    : copyText('rooms.issuer.programme.confirmed.by.the.service')}
              </p>
              <p>
                <Text k="rooms.new.card.issuance.is.unavailable.until.live" />
              </p>
            </div>
          )}
        </ResourceView>
      </Section>
      <Section title={copyText('rooms.your.card.records')}>
        <ResourceView resource={cards.resource} reload={cards.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((card) => (
                  <article className="money-record" key={card.id}>
                    <header>
                      <div>
                        <h3>
                          {card.simulated ? copyText('rooms.simulation.record') : copyText('rooms.card')} · {card.panTail}
                        </h3>
                        <p>
                          {card.status} · {card.issuer}
                          {card.simulated && copyText('rooms.not.a.live.card')}
                        </p>
                      </div>
                      <strong>{card.assetId}</strong>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="rooms.funding.asset" />
                        </dt>
                        <dd>{card.assetId}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.merchant.settlement.asset" />
                        </dt>
                        <dd>{card.settlementAssetId}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.authorization.limit" />
                        </dt>
                        <dd>{funds(card.perAuthorizationLimit, card.assetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.configured.cashback" />
                        </dt>
                        <dd>{bps(card.cashbackBps)}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <Button variant="secondary" onClick={() => setSelected({ id: card.id, asset: card.assetId })}>
                        <Text k="rooms.decisions.and.declines" />
                      </Button>
                      {live && !card.simulated && card.status !== 'closed' && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() =>
                              open({
                                title: card.status === 'frozen' ? copyText('rooms.unfreeze.card') : copyText('rooms.freeze.card'),
                                procedure: 'cards.setStatus',
                                facts: [
                                  [copyText('rooms.card'), card.panTail],
                                  [copyText('rooms.funding.asset'), card.assetId],
                                ],
                                notes: [
                                  card.status === 'frozen'
                                    ? copyText('rooms.resume.issuer.use.of.this.existing.card')
                                    : copyText('rooms.ask.the.issuer.to.freeze.this.existing'),
                                ],
                                input: () => ({ cardId: card.id, status: card.status === 'frozen' ? 'active' : 'frozen' }),
                              })
                            }
                          >
                            {card.status === 'frozen' ? copyText('rooms.unfreeze') : copyText('rooms.freeze')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              open({
                                title: copyText('rooms.close.card'),
                                procedure: 'cards.setStatus',
                                facts: [[copyText('rooms.card'), card.panTail]],
                                notes: [copyText('rooms.close.this.card.this.action.does.not')],
                                input: () => ({ cardId: card.id, status: 'closed' }),
                              })
                            }
                          >
                            <Text k="rooms.close.card" />
                          </Button>
                        </>
                      )}
                    </div>
                    {(!live || card.simulated) && (
                      <p className="money-caption">
                        <Text k="rooms.issuer.actions.remain.unavailable.for.this.record" />
                      </p>
                    )}
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.card.records.returned')}>
                  <Text k="rooms.an.empty.list.does.not.establish.issuer" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      {selected && <CardAuthorizations id={selected.id} asset={selected.asset} />}
    </BankPage>
  );
}
function RampRecords({ direction }: { direction: 'in' | 'out' }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead(direction === 'in' ? 'ramps.onramps' : 'ramps.offramps', { limit });
  return (
    <Section title={direction === 'in' ? copyText('rooms.incoming.rail.records') : copyText('rooms.outgoing.rail.records')}>
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((row) => (
                <article className="money-record" key={row.id}>
                  <header>
                    <div>
                      <h3>
                        {row.kind} · {row.status}
                      </h3>
                      <p>
                        {row.rail} · {date(row.createdAt)}
                        {row.simulated && copyText('rooms.simulated.ledger.rail')}
                      </p>
                    </div>
                    <strong className="numeric">{funds(row.amount, row.assetId)}</strong>
                  </header>
                  <dl className="detail-list">
                    <div>
                      <dt>
                        <Text k="rooms.record.reference" />
                      </dt>
                      <dd>{row.id}</dd>
                    </div>
                    {'destinationRef' in row && (
                      <div>
                        <dt>
                          <Text k="rooms.destination.reference" />
                        </dt>
                        <dd>{row.destinationRef}</dd>
                      </div>
                    )}
                    {'clientRef' in row && (
                      <div>
                        <dt>
                          <Text k="rooms.client.reference" />
                        </dt>
                        <dd>{row.clientRef}</dd>
                      </div>
                    )}
                    {'ledgerTxId' in row && (
                      <div>
                        <dt>
                          <Text k="rooms.ledger.transaction" />
                        </dt>
                        <dd>{row.ledgerTxId ?? copyText('rooms.not.posted')}</dd>
                      </div>
                    )}
                    {'holdLedgerTxId' in row && (
                      <>
                        <div>
                          <dt>
                            <Text k="rooms.reservation.transaction" />
                          </dt>
                          <dd>{row.holdLedgerTxId ?? copyText('rooms.none.supplied')}</dd>
                        </div>
                        <div>
                          <dt>
                            <Text k="rooms.settlement.transaction" />
                          </dt>
                          <dd>{row.settleLedgerTxId ?? copyText('rooms.not.supplied')}</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  {row.simulated && (
                    <p className="notice">
                      <Text k="rooms.this.record.does.not.confirm.a.live" />
                    </p>
                  )}
                </article>
              ))
            ) : (
              <NoRows title={copyText('rooms.no.rail.records.returned')}>
                <Text k="rooms.no.completed.deposit.or.withdrawal.is.inferred" />
              </NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Ramps() {
  const programme = useBankRead('ramps.programme', undefined);
  const fiat = useBankRead('ramps.fiatSettle', undefined);
  return (
    <BankPage room="Ramps" description={copyText('rooms.inspect.the.connected.cash.and.crypto.rail')}>
      <div className="money-two-lanes">
        <Section title={copyText('rooms.rail.programme')}>
          <ResourceView resource={programme.resource} reload={programme.reload}>
            {(info) => (
              <div className="money-capability">
                <h3>{info.id === 'none' ? copyText('rooms.ramp.programme.is.not.connected') : info.displayName}</h3>
                <p>
                  {info.simulated
                    ? copyText('rooms.this.programme.is.simulated.ledger.entries.do')
                    : copyText('rooms.the.service.supplied.this.programme.identity')}
                </p>
                <dl className="detail-list">
                  <div>
                    <dt>
                      <Text k="rooms.crypto.rail" />
                    </dt>
                    <dd>{info.cryptoRail ?? copyText('rooms.not.connected')}</dd>
                  </div>
                  <div>
                    <dt>
                      <Text k="rooms.fiat.adapter" />
                    </dt>
                    <dd>{info.fiatVia}</dd>
                  </div>
                </dl>
              </div>
            )}
          </ResourceView>
        </Section>
        <Section title={copyText('rooms.fiat.settlement.capability')}>
          <ResourceView resource={fiat.resource} reload={fiat.reload}>
            {(info) => (
              <>
                <p className="notice">
                  <Text k="rooms.the.adapter.can.settle.using" />
                  {info.onrampRailId}
                  <Text k="rooms.and" />
                  {info.offrampRailId}
                  <Text k="rooms.live.custody.delivery.and.programme.authority.still" />
                </p>
              </>
            )}
          </ResourceView>
        </Section>
      </div>
      <Section title={copyText('rooms.live.deposit.and.withdrawal')}>
        <EmptyState title={copyText('rooms.live.custody.is.not.connected')}>
          <Text k="rooms.no.live.destination.address.funding.instruction.or" />
        </EmptyState>
        <div className="actions">
          <a className="button button--secondary" href="/uc/recharge">
            <Text k="rooms.deposit.capability" />
          </a>
          <a className="button button--secondary" href="/uc/withdraw">
            <Text k="rooms.withdrawal.capability" />
          </a>
        </div>
      </Section>
      <RampRecords direction="in" />
      <RampRecords direction="out" />
    </BankPage>
  );
}
function Analytics() {
  const [values, setValues] = useState({ assetId: '', from: '', to: '' });
  const [range, setRange] = useState<{ assetId: string; from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useBankRead('analytics.spend', range, Boolean(range));
  function load() {
    if (!values.assetId.trim() || values.assetId.trim().length > 16) {
      setError(copyText('rooms.enter.an.asset.code.of.1.to'));
      return;
    }
    if (
      !Number.isFinite(Date.parse(values.from)) ||
      !Number.isFinite(Date.parse(values.to)) ||
      Date.parse(values.from) >= Date.parse(values.to)
    ) {
      setError(copyText('rooms.choose.a.valid.start.before.the.end'));
      return;
    }
    setError(null);
    setRange({ assetId: values.assetId.trim(), from: iso(values.from), to: iso(values.to) });
  }
  return (
    <BankPage room="Analytics" description={copyText('rooms.ledger.movements.by.asset.and.date.movement')}>
      <Section title={copyText('rooms.movement.window')}>
        <form
          className="money-analytics-form"
          onSubmit={(event) => {
            event.preventDefault();
            load();
          }}
        >
          <Field
            label={copyText('rooms.asset')}
            value={values.assetId}
            maxLength={16}
            required
            onChange={(event) => setValues({ ...values, assetId: event.target.value })}
          />
          <Field
            label={copyText('rooms.from')}
            type="datetime-local"
            value={values.from}
            required
            onChange={(event) => setValues({ ...values, from: event.target.value })}
          />
          <Field
            label={copyText('rooms.to')}
            type="datetime-local"
            value={values.to}
            required
            onChange={(event) => setValues({ ...values, to: event.target.value })}
          />
          <Button type="submit">
            <Text k="rooms.read.movements" />
          </Button>
        </form>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </Section>
      {range ? (
        <ResourceView resource={query.resource} reload={query.reload}>
          {(summary) => (
            <>
              <Section
                title={copyText('rooms.movement', { value1: summary.assetId })}
                description={copyText('rooms.to.2', { value1: date(summary.from), value2: date(summary.to) })}
              >
                <div className="money-movement-stats">
                  <div>
                    <span>
                      <Text k="rooms.inflow" />
                    </span>
                    <strong className="numeric">{funds(summary.totalInflow, summary.assetId)}</strong>
                  </div>
                  <div>
                    <span>
                      <Text k="rooms.outflow" />
                    </span>
                    <strong className="numeric">{funds(summary.totalOutflow, summary.assetId)}</strong>
                  </div>
                  <div>
                    <span>
                      <Text k="rooms.net.movement" />
                    </span>
                    <strong className="numeric">{funds(summary.net, summary.assetId)}</strong>
                  </div>
                </div>
                <p className="money-caption">
                  {summary.movements}
                  <Text k="rooms.ledger.movements.transfers.between.your.spaces.may" />
                </p>
              </Section>
              <Section title={copyText('rooms.outflow.categories')}>
                {Object.entries(summary.outflowByCategory).length ? (
                  Object.entries(summary.outflowByCategory).map(([category, quantity]) => (
                    <div className="money-space-row" key={category}>
                      <span>{category}</span>
                      <strong className="numeric">{funds(quantity, summary.assetId)}</strong>
                    </div>
                  ))
                ) : (
                  <NoRows title={copyText('rooms.no.outflow.categories.returned')}>
                    <Text k="rooms.the.service.returned.no.categorized.outflow.for" />
                  </NoRows>
                )}
              </Section>
            </>
          )}
        </ResourceView>
      ) : (
        <NoRows title={copyText('rooms.choose.an.asset.and.time.window')}>
          <Text k="rooms.this.view.does.not.invent.a.default" />
        </NoRows>
      )}
    </BankPage>
  );
}
function BusinessApprovals({ accountId }: { accountId: string }) {
  const [limit, setLimit] = usePageLimit();
  const query = useBankRead('business.pending', { accountId, limit });
  return (
    <Section
      title={copyText('rooms.pending.maker.checker.approvals')}
      description={copyText('rooms.the.service.verifies.membership.for.this.bank')}
    >
      <ResourceView resource={query.resource} reload={query.reload}>
        {(rows) => (
          <>
            {rows.length ? (
              rows.map((approval) => (
                <article className="money-record" key={approval.id}>
                  <header>
                    <div>
                      <h3>
                        {approval.status}
                        <Text k="rooms.transfer.proposal" />
                      </h3>
                      <p>{date(approval.createdAt)}</p>
                    </div>
                    <strong className="numeric">{funds(approval.amount, approval.assetId)}</strong>
                  </header>
                  <dl className="detail-list">
                    <div>
                      <dt>
                        <Text k="rooms.maker" />
                      </dt>
                      <dd>{approval.makerUserId}</dd>
                    </div>
                    <div>
                      <dt>
                        <Text k="rooms.checker" />
                      </dt>
                      <dd>{approval.checkerUserId ?? copyText('rooms.not.yet.checked')}</dd>
                    </div>
                    <div>
                      <dt>
                        <Text k="rooms.debit.space" />
                      </dt>
                      <dd>{approval.fromSpaceId}</dd>
                    </div>
                    <div>
                      <dt>
                        <Text k="rooms.credit.space" />
                      </dt>
                      <dd>{approval.toSpaceId}</dd>
                    </div>
                    <div>
                      <dt>
                        <Text k="rooms.reservation.transaction" />
                      </dt>
                      <dd>{approval.holdLedgerTxId ?? copyText('rooms.no.reservation.supplied')}</dd>
                    </div>
                    <div>
                      <dt>
                        <Text k="rooms.posted.transaction" />
                      </dt>
                      <dd>{approval.ledgerTxId ?? copyText('rooms.not.posted')}</dd>
                    </div>
                    <div>
                      <dt>
                        <Text k="rooms.approval.reference" />
                      </dt>
                      <dd>{approval.id}</dd>
                    </div>
                  </dl>
                  <p className="notice">
                    <Text k="rooms.approval.rejection.and.cancellation.require.verified.company" />
                  </p>
                </article>
              ))
            ) : (
              <NoRows title={copyText('rooms.no.pending.approvals.returned')}>
                <Text k="rooms.an.empty.pending.list.does.not.imply" />
              </NoRows>
            )}
            <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
function Business() {
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useBankRead('business.list', { limit });
  const { mode } = useSession();
  return (
    <BankPage room="Business" description={copyText('rooms.bank.membership.and.maker.checker.policy.records')}>
      <Section title={copyText('rooms.company.money')}>
        <div className="money-capability">
          <h3>
            <Text k="rooms.company.balance.and.write.authority.are.unavailable" />
          </h3>
          <p>
            <Text k="rooms.the.connected.bank.contract.does.not.supply" />
          </p>
          <p>
            <Text k="rooms.creating.a.company.bank.record.adding.members" />
          </p>
          <a className="text-link" href="/uc/account">
            <Text k="rooms.account.identity.and.verification" />
          </a>
        </div>
      </Section>
      <Section
        title={copyText('rooms.bank.policy.records')}
        description={copyText('rooms.current.product.account.context.membership.does.not', { value1: mode })}
        actions={
          <Button variant="ghost" onClick={query.reload}>
            <Text k="rooms.refresh" />
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={query.reload}>
          {(rows) => (
            <>
              {rows.length ? (
                rows.map((record) => (
                  <article className="money-record" key={record.id}>
                    <header>
                      <div>
                        <h3>{record.name}</h3>
                        <p>
                          {record.assetId} · {record.status}
                        </p>
                      </div>
                      <span className="badge">
                        <Text k="rooms.policy.record" />
                      </span>
                    </header>
                    <dl className="detail-list">
                      <div>
                        <dt>
                          <Text k="rooms.checker.threshold" />
                        </dt>
                        <dd>{funds(record.spendThreshold, record.assetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.created" />
                        </dt>
                        <dd>{date(record.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.record.reference" />
                        </dt>
                        <dd>{record.id}</dd>
                      </div>
                    </dl>
                    <p className="money-caption">
                      <Text k="rooms.amounts.over.the.configured.threshold.require.separate" />
                    </p>
                    <Button variant="secondary" onClick={() => setSelected(record.id)}>
                      <Text k="rooms.read.pending.approvals" />
                    </Button>
                  </article>
                ))
              ) : (
                <NoRows title={copyText('rooms.no.bank.policy.memberships.returned')}>
                  <Text k="rooms.verified.company.ownership.and.company.balances.remain" />
                </NoRows>
              )}
              <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      {selected && <BusinessApprovals accountId={selected} />}
    </BankPage>
  );
}
function Activity({ open }: { open: (spec: ActionSpec) => void }) {
  const asset = new URLSearchParams(location.search).get('asset');
  return (
    <Page
      eyebrow={copyText('rooms.money')}
      title={asset ? copyText('rooms.activity', { value1: asset }) : copyText('rooms.money.activity')}
      description={copyText('rooms.supported.bank.operation.records.retain.their.actual')}
      actions={
        <a className="button button--secondary" href={asset ? `/portfolio/${encodeURIComponent(asset)}` : '/portfolio'}>
          <Text k="rooms.back.to.holdings" />
        </a>
      }
    >
      <p className="notice">
        <Text k="rooms.whole.account.ledger.history.is.not.exposed" />
        {asset && copyText('rooms.the.asset.context.is.each.record.keeps', { value1: asset })}
      </p>
      <Schedules open={open} />
      <RampRecords direction="in" />
      <RampRecords direction="out" />
      <a className="link-row" href="/bank/cards">
        <span>
          <Text k="rooms.card.decisions.and.declines" />
          <small>
            <Text k="rooms.inspect.the.actual.card.authorization.history" />
          </small>
        </span>
        <span>↗</span>
      </a>
      <a className="link-row" href="/bank/analytics">
        <span>
          <Text k="rooms.movement.analysis" />
          <small>
            <Text k="rooms.choose.this.asset.and.a.time.window" />
          </small>
        </span>
        <span>↗</span>
      </a>
    </Page>
  );
}
export function BankRoutes({ path, open }: { path: string; open: (spec: ActionSpec) => void }) {
  switch (path) {
    case '/bank/spaces':
      return <Spaces open={open} />;
    case '/bank/transfers':
      return <Transfers open={open} />;
    case '/bank/earn':
      return <Earn open={open} />;
    case '/bank/loans':
      return <Loans open={open} />;
    case '/bank/cards':
      return <Cards open={open} />;
    case '/bank/ramps':
      return <Ramps />;
    case '/bank/analytics':
      return <Analytics />;
    case '/bank/business':
      return <Business />;
    case '/uc/record':
      return <Activity open={open} />;
    default:
      return (
        <Page eyebrow={copyText('rooms.money.bank')} title={copyText('rooms.bank.room.unavailable')}>
          <EmptyState
            title={copyText('rooms.this.bank.address.is.not.registered')}
            action={
              <a className="button button--secondary" href="/bank">
                <Text k="rooms.bank.overview" />
              </a>
            }
          >
            <Text k="rooms.choose.a.registered.bank.room" />
          </EmptyState>
        </Page>
      );
  }
}
