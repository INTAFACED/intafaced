import { t as copyText, Text } from './copy';

import { bankLabels, bankRoomHref, bankRooms } from './bank-nav';

import { TransfersRoom } from './transfers/TransfersRoom';

import { RecoveryClaimRoom } from './recovery/RecoveryClaimRoom';

import { LoanApplyRoom } from './loan-apply/LoanApplyRoom';

import { AddMoneyRoom } from './ramps/AddMoneyRoom';

import { CashOutRoom } from './ramps/CashOutRoom';

import { StatementsRoom } from './statements/StatementsRoom';

import { SalaryPage } from './salary/SalaryPage';

import { ComplaintRoom } from './safety/ComplaintRoom';

import {
  BusinessLoanPreviewRoom,
  CreditCardPreviewRoom,
  LoanSchedulePreviewRoom,
  OverdraftPreviewRoom,
  PersonalLoanPreviewRoom,
  RevolvingCreditPreviewRoom,
} from './credit-previews/CreditPreviewRooms';

import { BereavementRoom } from './safety/BereavementRoom';

import { ScamReportRoom } from './safety/ScamReportRoom';

import { LostPhoneRoom } from './lost-phone/LostPhoneRoom';

import { BusinessJoinRoom, BusinessPaymentRoom, BusinessTeamRoom } from './business-team/BusinessTeamRoom';

import { BusinessBillRoom, BusinessBillsRoom } from './business-bills/BusinessBillsRoom';

import { BusinessPayoutsRoom, ContractorJoinRoom } from './business-payouts/BusinessPayoutsRoom';

import { BusinessCardsRoom } from './business-cards/BusinessCardsRoom';

import { BusinessBooksRoom } from './business-books/BusinessBooksRoom';
import { CardOrderRoom } from './card-order/CardOrder';
import { useMemo, useState } from 'react';
import { Button, EmptyState, Failure, Field, Page } from '../../shared/ui';
import { decimalSchema, displayAmount } from '../../shared/money';
import { useSession } from '../session';

import { usePreferences, savePreferences } from '../../shared/preferences';

import { useResource } from '../../shared/resource';

import { createMoneyClient, type MoneyOverview, type Space } from './client';
import {
  amount,
  funds,
  Continuation,
  date,
  iso,
  NoRows,
  ResourceView,
  Section,
  startsField,
  useSpaces,
  type ActionSpec,
  useBankRecord,
} from './components';
import { EarlyUnlock, SpaceLockActions } from './SpaceLock';
import { EarnPoolRoom, EarnRoom } from './earn/EarnRooms';
import { LoansRoom } from './loans/LoansRoom';
import { MoneyActivity } from './activity';

import { OwnerCards } from './Cards';

import { OwnerRailRecords } from './RailRecords';

import { railCopy } from './rail-copy';

import { SelectedSpace } from './SelectedSpace';

import { SpaceInflows } from './SpaceInflows';

import { IncomeSorter } from './IncomeSorter';

import { InstantSavings } from './InstantSavings';

import { SharedPots } from './SharedPots';

import { BillsPotActions } from './BillsPot';

import { AccountHome } from './AccountHome';

import { LinkedAccounts } from './LinkedAccounts';

import { DirectDebits } from './DirectDebits';

import { directDebitsCopy } from './direct-debits-copy';

import { recoveryClaimCopy } from './recovery-claim-copy';

import { MoneyCalendar } from './Calendar';

import { calendarCopy } from './calendar-copy';

import { Rules } from './Rules';

import { rulesCopy } from './rules-copy';

import { LoanDetail } from './LoanDetail';

import { loanDetailCopy } from './loan-detail-copy';

import { linkedAccountsCopy } from './linked-accounts-copy';

import { spaceContext } from './space-context';
import { spaceCopy } from './space-copy';

import { categoryLabel } from './analytics-copy';

import { splitAnalytics } from './analytics-model';

import { AnalyticsBudgets, AnalyticsCompare } from './AnalyticsBudgets';

import { LimitsRoom, limitsCopy } from './LimitsRoom';

import { BankAccountRoom, OnboardingBanner, bankAccountCopy } from './BankAccountRoom';

import { GoalProgress, MovementBars } from './GoalAndMovement';
import { BusinessBank } from './BusinessBank';

import { businessCopy } from './business-copy';

import { RampJourneys } from './RampJourneys';

import { rampDepthCopy } from './ramp-depth-copy';

import { PERIOD_PRESETS, periodRange, type PeriodPreset } from './periods';

import { transferDepthCopy } from './transfer-depth-copy';

import { assetSelectField, spaceTotals, useHoldings } from './holdings';

import { statementCentreCopy } from './statement-centre-copy';
import { BANK_ANALYTICS_SPEND } from '@intafaced/contracts/bank-analytics-procedures';
import { BANK_SPACES_UNNAMED } from '@intafaced/contracts/bank-spaces-procedures';

export function BankNavigation({ current }: { current: string }) {
  return (
    <nav data-testid="money-bank-nav" className="money-bank-nav" aria-label={copyText('rooms.bank.rooms')}>
      {bankRooms.map((room) => (
        <a key={room} href={bankRoomHref(room)} aria-current={current === room ? 'page' : undefined}>
          <Text k={bankLabels[room]} />
        </a>
      ))}
    </nav>
  );
}
function BankPage({
  room,
  title,
  description,
  children,
}: {
  room: string;
  title?: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Page
      eyebrow={copyText('rooms.money.bank')}
      title={title ?? (room in bankLabels ? copyText(bankLabels[room as keyof typeof bankLabels]) : room)}
      description={description}
      actions={
        room !== 'Ramps' ? (
          <a className="button button--secondary" href="/bank">
            <Text k="rooms.bank.overview" />
          </a>
        ) : undefined
      }
    >
      <BankNavigation current={room} />
      {children}
    </Page>
  );
}
const moneyValue = (value: string) =>
  decimalSchema.safeParse(value).success ? null : copyText('rooms.enter.an.exact.nonnegative.decimal');
function SpaceActions({ space, open }: { space: Space; open: (spec: ActionSpec) => void }) {
  return (
    <div className="actions">
      <a className="button button--secondary" href={`/bank/transfers?from=${encodeURIComponent(space.id)}`}>
        <Text k="rooms.transfer" />
      </a>
      <SpaceLockActions space={space} open={open} />
      <BillsPotActions space={space} open={open} />
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
  );
}
function Spaces({ open, search }: { open: (spec: ActionSpec) => void; search: string }) {
  const { userId } = useSession();
  const context = spaceContext(search, 'space');
  const [limit, setLimit] = useState(context.status === 'valid' ? 200 : 50);
  const spaces = useSpaces(limit);
  const unnamed = useBankRecord(BANK_SPACES_UNNAMED, undefined);
  const held = useHoldings();
  const heldAssets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const depthCopy = transferDepthCopy.useCopy();
  const create = () =>
    open({
      title: copyText('rooms.create.space'),
      procedure: 'spaces.create',
      fields: [
        assetSelectField(depthCopy.t('assetPicker'), depthCopy.t('assetPickerHint'), heldAssets),
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
      <SelectedSpace
        context={context}
        resource={spaces.resource}
        owner={userId ?? ''}
        reload={spaces.reload}
        actions={(space) => <SpaceActions space={space} open={open} />}
        below={(space, all) => space.kind === 'named' && <SpaceInflows key={space.id} space={space} spaces={all} open={open} />}
      />
      <Section
        title={context.status === 'none' ? copyText('rooms.your.spaces') : <spaceCopy.Copy k="other" />}
        actions={
          <>
            <Button variant="ghost" onClick={spaces.reload}>
              <Text k="rooms.refresh" />
            </Button>
            <Button
              onClick={create}
              disabled={heldAssets.length === 0}
              aria-describedby={heldAssets.length === 0 ? 'spaces-create-why' : undefined}
            >
              <Text k="rooms.create.space" />
            </Button>
          </>
        }
      >
        {heldAssets.length === 0 && held.resource.status === 'ready' && (
          <p id="spaces-create-why" className="money-caption">
            {depthCopy.t('noAssets')}
          </p>
        )}
        {(context.status === 'none' || spaces.resource.status === 'ready') && (
          <ResourceView resource={spaces.resource} reload={spaces.reload}>
            {(returned) => {
              const rows = context.status === 'valid' ? returned.filter((row) => row.id !== context.id) : returned;
              return (
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
                            <dd>{space.goalTarget === null ? <spaceCopy.Copy k="noGoal" /> : funds(space.goalTarget, space.assetId)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.bank.lock" />
                            </dt>
                            <dd>{date(space.lockedUntil)}</dd>
                          </div>
                          <EarlyUnlock space={space} />
                          <div>
                            <dt>
                              <Text k="rooms.space.reference" />
                            </dt>
                            <dd>
                              <details>
                                <summary>{spaceCopy.t('details')}</summary>
                                <span lang="zxx">{space.id}</span>
                              </details>
                            </dd>
                          </div>
                        </dl>
                        <GoalProgress balance={space.balance} target={space.goalTarget} assetId={space.assetId} />
                        <SpaceActions space={space} open={open} />
                      </article>
                    ))
                  ) : context.status === 'none' ? (
                    <NoRows title={copyText('rooms.no.spaces.returned')}>
                      <Text k="rooms.create.a.named.space.its.balance.will" />
                    </NoRows>
                  ) : (
                    <p className="money-caption">
                      <spaceCopy.Copy k="noOther" />
                    </p>
                  )}
                  <Continuation count={returned.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                </>
              );
            }}
          </ResourceView>
        )}
      </Section>
      {spaces.resource.status === 'ready' && <IncomeSorter spaces={spaces.resource.data} open={open} />}
      <InstantSavings open={open} />
      {spaces.resource.status === 'ready' && <SharedPots spaces={spaces.resource.data} open={open} />}
      <Section
        title={copyText('rooms.assets.without.a.space')}
        description={copyText('rooms.positive.user.available.accounts.only.these.quantities')}
      >
        <ResourceView resource={unnamed.resource} reload={unnamed.reload}>
          {(rows) =>
            rows.length ? (
              rows.map((row) => (
                <div data-testid="money-space-row" className="money-space-row" key={row.assetId}>
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
function Cards({ open }: { open: (spec: ActionSpec) => void }) {
  return (
    <BankPage room="Cards" description={copyText('rooms.issuer.connectivity.and.card.outcomes.are.separate')}>
      <OwnerCards open={open} />
    </BankPage>
  );
}
function Ramps({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = railCopy.useCopy();
  const depth = rampDepthCopy.useCopy();
  return (
    <BankPage room="Ramps" description={t('description')}>
      <RampJourneys open={open} />
      <Section title={depth.t('historyTitle')} description={depth.t('historyLead')}>
        <OwnerRailRecords />
      </Section>
    </BankPage>
  );
}
/** `/bank/direct-debits`: Direct Debit mandates and collections, inside the Transfers room (J-bank-06 #4). */
function DirectDebitsRoom() {
  const { t } = directDebitsCopy.useCopy();
  return (
    <BankPage room="Transfers" title={t('title')} description={t('description')}>
      <DirectDebits />
    </BankPage>
  );
}
/** The way into the recovery claim room from the bank's services. */
function RecoveryClaimLink() {
  const { t } = recoveryClaimCopy.useCopy();
  return (
    <a className="link-row" href="/bank/recovery">
      <span>
        <strong>{t('open')}</strong>
        <small>{t('openHint')}</small>
      </span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}
/** `/bank/rules`: payment reminders, failure notices, notification choices and money rules, inside Transfers (J-bank-06 #6). */
function RulesRoom() {
  const { t } = rulesCopy.useCopy();
  return (
    <BankPage room="Transfers" title={t('title')} description={t('description')}>
      <Rules />
    </BankPage>
  );
}
/** `/bank/loans/detail?loan=<id>`: one loan's payoff quote, projection and statement, inside the Loans room (J-bank-11 #1). */
function LoanDetailRoom({ search }: { search: string }) {
  const { t } = loanDetailCopy.useCopy();
  const loanId = new URLSearchParams(search).get('loan');
  return (
    <BankPage room="Loans" title={t('title')} description={t('description')}>
      <LoanDetail loanId={loanId && loanId.trim() !== '' ? loanId : null} />
    </BankPage>
  );
}
/** `/bank/calendar`: everything dated, inside the Transfers room (J-bank-06 #5). */
function CalendarRoom() {
  const { t } = calendarCopy.useCopy();
  return (
    <BankPage room="Transfers" title={t('title')} description={t('description')}>
      <MoneyCalendar />
    </BankPage>
  );
}
/** `/bank/limits`: sending limits from the bank's quote, the fee schedules and the plan (BK-acct-04, J-bank-16 #6). */
function LimitsPage() {
  return (
    <BankPage room="Overview" title={limitsCopy.t('title')} description={limitsCopy.t('description')}>
      <LimitsRoom />
    </BankPage>
  );
}

/** `/bank/account`: onboarding, requests, reviews, closure and data rights at the partner bank (BK-acct-05, BK-acct-06, J-bank-17). */
function BankAccountPage() {
  return (
    <BankPage room="Overview" title={bankAccountCopy.t('title')} description={bankAccountCopy.t('description')}>
      <BankAccountRoom />
    </BankPage>
  );
}

/** The way into the statement and export centre from Analytics. */
function StatementsLink() {
  const { t } = statementCentreCopy.useCopy();
  return (
    <p className="money-caption">
      <a className="text-link" href="/bank/statements">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
  );
}
/** `/bank/ramps/accounts`: linked bank accounts, inside the Ramps room. */
function LinkedAccountsRoom() {
  const { t } = linkedAccountsCopy.useCopy();
  return (
    <BankPage room="Ramps" title={t('title')} description={t('description')}>
      <LinkedAccounts />
    </BankPage>
  );
}
/** A range is sent only while the read is on; this stands in for it while the read is off, and is never sent. */
const NO_RANGE = { assetId: '', from: '', to: '' };
function Analytics() {
  const depth = transferDepthCopy.useCopy();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const [chosen, setChosen] = useState('');
  const [preset, setPreset] = useState<PeriodPreset>('30d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [useCustom, setUseCustom] = useState(false);
  const assetId = chosen || assets[0]?.assetId || '';
  const range = useMemo(() => {
    if (!assetId) return null;
    if (useCustom) {
      if (!Number.isFinite(Date.parse(custom.from)) || !Number.isFinite(Date.parse(custom.to))) return null;
      if (Date.parse(custom.from) >= Date.parse(custom.to)) return null;
      return { assetId, from: iso(custom.from), to: iso(custom.to) };
    }
    return { assetId, ...periodRange(preset, new Date(Math.floor(Date.now() / 60_000) * 60_000)) };
  }, [assetId, preset, useCustom, custom.from, custom.to]);
  const query = useBankRecord(BANK_ANALYTICS_SPEND, range ?? NO_RANGE, range !== null);
  const presetLabel = (value: PeriodPreset) =>
    depth.t(value === '7d' ? 'period7d' : value === '30d' ? 'period30d' : value === 'month' ? 'periodMonth' : 'periodLastMonth');
  return (
    <BankPage room="Analytics" description={copyText('rooms.ledger.movements.by.asset.and.date.movement')}>
      <StatementsLink />
      {assetId && (
        <>
          <AnalyticsBudgets assetId={assetId} />
          <AnalyticsCompare assetId={assetId} />
        </>
      )}
      <Section title={copyText('rooms.movement.window')}>
        <div className="money-analytics-form">
          <label className="field">
            <span>{depth.t('assetPicker')}</span>
            <select value={assetId} onChange={(event) => setChosen(event.target.value)} disabled={assets.length === 0}>
              {assets.length === 0 && <option value="">—</option>}
              {assets.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.assetId}
                </option>
              ))}
            </select>
            <small>{assets.length === 0 && held.resource.status === 'ready' ? depth.t('noAssets') : depth.t('assetPickerHint')}</small>
          </label>
          <div className="bd-periods" role="group" aria-label={depth.t('period')}>
            {PERIOD_PRESETS.map((value) => (
              <button
                key={value}
                type="button"
                className="bd-chip"
                aria-pressed={!useCustom && preset === value}
                onClick={() => {
                  setUseCustom(false);
                  setPreset(value);
                }}
              >
                {presetLabel(value)}
              </button>
            ))}
            <button type="button" className="bd-chip" aria-pressed={useCustom} onClick={() => setUseCustom(true)}>
              {depth.t('periodCustom')}
            </button>
          </div>
          {useCustom && (
            <>
              <Field
                label={copyText('rooms.from')}
                type="datetime-local"
                value={custom.from}
                onChange={(event) => setCustom({ ...custom, from: event.target.value })}
              />
              <Field
                label={copyText('rooms.to')}
                type="datetime-local"
                value={custom.to}
                onChange={(event) => setCustom({ ...custom, to: event.target.value })}
              />
              {!range && custom.from && custom.to && (
                <p className="error-text" role="alert">
                  {copyText('rooms.choose.a.valid.start.before.the.end')}
                </p>
              )}
            </>
          )}
        </div>
      </Section>
      {range ? (
        <ResourceView resource={query.resource} reload={query.reload}>
          {(summary) => (
            <>
              <Section
                title={copyText('rooms.movement', { value1: summary.assetId })}
                description={copyText('rooms.to.2', { value1: date(summary.from), value2: date(summary.to) })}
              >
                <div data-testid="money-movement-stats" className="money-movement-stats">
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
                <MovementBars inflow={summary.totalInflow} outflow={summary.totalOutflow} net={summary.net} assetId={summary.assetId} />
                <p className="money-caption">
                  {summary.movements}
                  <Text k="rooms.ledger.movements.transfers.between.your.spaces.may" />
                </p>
              </Section>
              {(() => {
                const split = splitAnalytics(summary);
                return (
                  <>
                    <Section title={copyText('rooms.outflow.categories')}>
                      {split.outflow.length ? (
                        split.outflow.map((row) => (
                          <div data-testid="money-space-row" className="money-space-row" key={row.category}>
                            <span>{row.category === 'deposits' ? copyText('rooms.deposit.outflow') : categoryLabel(row.category)}</span>
                            <strong className="numeric">{funds(row.amount, summary.assetId)}</strong>
                          </div>
                        ))
                      ) : (
                        <NoRows title={copyText('rooms.no.outflow.categories.returned')}>
                          <Text k="rooms.the.service.returned.no.categorized.outflow.for" />
                        </NoRows>
                      )}
                    </Section>
                    {split.moneyInDeposits !== null && (
                      <Section title={copyText('rooms.money.in.deposits')}>
                        <div data-testid="money-space-row" className="money-space-row">
                          <span>{categoryLabel('deposits')}</span>
                          <strong className="numeric">{funds(split.moneyInDeposits, summary.assetId)}</strong>
                        </div>
                        <p className="money-caption">{copyText(split.exact ? 'rooms.money.in.note' : 'rooms.money.in.inexact')}</p>
                      </Section>
                    )}
                  </>
                );
              })()}
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
function Business({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  return (
    <BankPage room="Business" title={t('pageTitle')} description={t('lead')}>
      <BusinessBank open={open} />
    </BankPage>
  );
}
const bankServices = [
  { href: '/bank/spaces', label: 'nav.spaces', note: 'overview.spaces.note' },
  { href: '/bank/transfers', label: 'nav.transfers', note: 'overview.transfers.note' },
  { href: '/bank/earn', label: 'nav.earn', note: 'overview.earn.note' },
  { href: '/bank/loans', label: 'nav.loans', note: 'overview.loans.note' },
  { href: '/bank/cards', label: 'nav.cards', note: 'overview.cards.note' },
  { href: '/bank/ramps', label: 'nav.ramps', note: 'overview.ramps.note' },
  { href: '/bank/analytics', label: 'nav.analytics', note: 'overview.analytics.note' },
  { href: '/bank/business', label: 'nav.business', note: 'overview.business.note' },
  { href: '/uc/record', label: 'index.money.activity', note: 'overview.activity.note' },
  { href: '/bank/account', label: 'nav.bank.account', note: 'overview.bank.account.note' },
  { href: '/bank/salary', label: 'nav.salary', note: 'overview.salary.note' },
  { href: '/bank/safety/scam', label: 'nav.scam', note: 'overview.scam.note' },
  { href: '/bank/safety/lost-phone', label: 'nav.lostPhone', note: 'overview.lostPhone.note' },
  { href: '/bank/safety/complaint', label: 'nav.complaint', note: 'overview.complaint.note' },
  { href: '/bank/safety/bereavement', label: 'nav.bereavement', note: 'overview.bereavement.note' },
] as const;
/**
 * `/bank`: the first page of the neo-bank. It shows only what the bank answers (balances and spaces, each with its own
 * loading, failed or empty state) and opens every bank service, so a bank that is not set up yet still reads as a place.
 */
function BankOverview() {
  const { api, userId, mode } = useSession();
  const { hideBalances } = usePreferences();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource<MoneyOverview>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: copyText('index.sign.in.to.see.your.money') };
    if (mode === 'Business')
      return { ok: false, reason: 'not_supported', message: copyText('index.a.verified.company.ledger.owner.and.company') };
    return { ok: true, data: await createMoneyClient(api).overview(userId, limit, signal) };
  }, `${userId}:${mode}:bank-overview:${limit}`);
  return (
    <Page
      eyebrow={copyText('rooms.money.bank')}
      title={copyText('index.bank')}
      description={copyText('overview.description')}
      actions={
        <>
          <a className="button button--primary" href="/bank/spaces">
            <Text k="index.create.space" />
          </a>
          <a className="button button--secondary" href="/bank/transfers">
            <Text k="index.transfer" />
          </a>
          <a className="button button--secondary" href="/uc/withdraw">
            <Text k="custody.withdraw" />
          </a>
        </>
      }
    >
      <BankNavigation current="Overview" />
      <OnboardingBanner />
      <div className="money-overview-lane">
        <Section
          title={copyText('index.holdings')}
          actions={
            <>
              <Button variant="ghost" onClick={() => savePreferences({ hideBalances: !hideBalances })} aria-pressed={hideBalances}>
                <Text k={hideBalances ? 'index.show.amounts' : 'index.hide.amounts'} />
              </Button>
              <Button variant="ghost" onClick={reload}>
                <Text k="rooms.refresh" />
              </Button>
            </>
          }
        >
          <ResourceView resource={resource} reload={reload}>
            {(overview) => (
              <>
                {overview.balances.ok && (
                  <p className="money-response-time">
                    {Number.isFinite(Date.parse(overview.balances.data.datetime)) ? (
                      <time dateTime={overview.balances.data.datetime} dir="auto">
                        {copyText('overview.reported', { time: date(overview.balances.data.datetime) })}
                      </time>
                    ) : (
                      <Text k="overview.time.unavailable" />
                    )}
                  </p>
                )}
                {!overview.balances.ok && <Failure result={overview.balances} retry={reload} />}
                {overview.conflicts.length > 0 && (
                  <p className="notice" role="status">
                    <Text k="index.separate.reads.disagree.for" />
                    {overview.conflicts.join(', ')}
                    <Text k="index.their.available.projection.is.omitted.refresh.to" />
                  </p>
                )}
                {overview.holdings.length ? (
                  overview.holdings.map((holding) => (
                    <a
                      data-testid="money-holding"
                      className="money-holding"
                      href={`/portfolio/${encodeURIComponent(holding.assetId)}`}
                      key={holding.assetId}
                    >
                      <span className="money-asset-mark" aria-hidden="true">
                        {holding.assetId.slice(0, 1)}
                      </span>
                      <span className="money-holding-name">
                        <strong lang="und">{holding.assetId}</strong>
                        <small>
                          {holding.quantity === null ? (
                            <Text k="index.available.projection.only" />
                          ) : (
                            <Text k="index.user.ledger.quantity" />
                          )}
                        </small>
                      </span>
                      <span className="money-holding-values">
                        <strong className="numeric" dir="ltr">
                          <span className="money-quantity-value">
                            {hideBalances ? '••••' : displayAmount(holding.quantity ?? holding.available)}
                          </span>
                          {!hideBalances && (
                            <span className="money-quantity-unit" lang="und">
                              {' '}
                              {holding.assetId}
                            </span>
                          )}
                        </strong>
                        <dl className="money-quantity-restrictions">
                          <div>
                            <dt>
                              <Text k="index.available" />
                            </dt>
                            <dd className="numeric" dir="ltr">
                              {hideBalances ? '••••' : amount(holding.available, holding.assetId)}
                            </dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="index.held.restricted" />
                            </dt>
                            <dd className="numeric" dir="ltr">
                              {hideBalances ? '••••' : amount(holding.held, holding.assetId)}
                            </dd>
                          </div>
                        </dl>
                      </span>
                      <span className="money-chevron" aria-hidden="true">
                        ↗
                      </span>
                    </a>
                  ))
                ) : overview.balances.ok ? (
                  <NoRows title={copyText('index.no.user.ledger.accounts.returned')}>
                    <Text k="index.an.empty.projection.is.not.a.complete" />
                  </NoRows>
                ) : (
                  <div className="notice" role="status">
                    <h3>
                      <Text k="availability.holdings.unavailable" />
                    </h3>
                    <p>
                      <Text k="availability.refresh.balances" />
                    </p>
                  </div>
                )}
                {overview.spaces.ok &&
                  (() => {
                    const totals = spaceTotals(overview.spaces.data, overview.holdings);
                    if (!totals.length) return null;
                    return (
                      <section className="money-spaces-total" aria-label={copyText('index.spaces.heading')}>
                        {totals.map((row) => (
                          <p key={row.assetId}>
                            <span className="numeric" dir="ltr">
                              {hideBalances
                                ? `•••• ${row.assetId}`
                                : copyText(row.total === null ? 'index.spaces.plus' : 'index.spaces.total', {
                                    amount: amount(row.total ?? row.inSpaces, row.assetId),
                                  })}
                            </span>
                            {row.total !== null && (
                              <small>
                                {hideBalances ? '' : copyText('index.spaces.plus', { amount: amount(row.inSpaces, row.assetId) })}
                              </small>
                            )}
                          </p>
                        ))}
                        <small>
                          <Text k="index.spaces.note" />
                        </small>
                      </section>
                    );
                  })()}
              </>
            )}
          </ResourceView>
        </Section>
        <Section
          title={copyText('index.your.spaces')}
          actions={
            <a className="text-link" href="/bank/spaces">
              <Text k="index.manage.spaces" />
            </a>
          }
        >
          <ResourceView resource={resource} reload={reload}>
            {(overview) =>
              overview.spaces.ok ? (
                <>
                  {overview.spaces.data.length ? (
                    overview.spaces.data.map((space) => (
                      <a
                        data-testid="money-space-row"
                        className="money-space-row"
                        href={`/bank/spaces?space=${encodeURIComponent(space.id)}`}
                        key={space.id}
                      >
                        <div>
                          <strong lang="und">{space.name}</strong>
                          <small>
                            {space.kind === 'primary' ? (
                              <Text k="index.primary.already.in.the.user.ledger.projection" />
                            ) : (
                              <Text k="index.named.separate.ledger.subaccount" />
                            )}
                          </small>
                        </div>
                        <div className="numeric" dir="ltr">
                          {funds(space.balance, space.assetId)}
                        </div>
                      </a>
                    ))
                  ) : (
                    <NoRows title={copyText('rooms.no.spaces.returned')}>
                      <Text k="rooms.create.a.named.space.its.balance.will" />
                    </NoRows>
                  )}
                  <Continuation count={overview.spaces.data.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                </>
              ) : (
                <Failure result={overview.spaces} retry={reload} />
              )
            }
          </ResourceView>
        </Section>
      </div>
      <AccountHome />
      <Section title={copyText('overview.services')}>
        <nav className="money-destinations" aria-label={copyText('overview.services')}>
          {bankServices.map((service) => (
            <a className="link-row" href={service.href} key={service.href}>
              <span>
                <strong>
                  <Text k={service.label} />
                </strong>
                <small>
                  <Text k={service.note} />
                </small>
              </span>
              <span aria-hidden="true">↗</span>
            </a>
          ))}
          <RecoveryClaimLink />
        </nav>
      </Section>
    </Page>
  );
}
export function BankRoutes({ path, search, open }: { path: string; search: string; open: (spec: ActionSpec) => void }) {
  switch (path) {
    case '/bank':
      return <BankOverview />;
    case '/bank/spaces':
      return <Spaces open={open} search={search} />;
    case '/bank/transfers':
      return <TransfersRoom open={open} search={search} />;
    case '/bank/direct-debits':
      return <DirectDebitsRoom />;
    case '/bank/calendar':
      return <CalendarRoom />;
    case '/bank/safety/complaint':
      return <ComplaintRoom />;
    case '/bank/safety/scam':
      return <ScamReportRoom />;
    case '/bank/safety/lost-phone':
      return <LostPhoneRoom />;
    case '/bank/business/team':
      return <BusinessTeamRoom part="team" />;
    case '/bank/business/spend':
      return <BusinessTeamRoom part="spend" />;
    case '/bank/business/payment':
      return <BusinessPaymentRoom search={search} />;
    case '/bank/business/join':
      return <BusinessJoinRoom />;
    case '/bank/business/bills':
      return <BusinessBillsRoom />;
    case '/bank/business/bill':
      return <BusinessBillRoom search={search} />;
    case '/bank/business/payouts':
      return <BusinessPayoutsRoom />;
    case '/bank/business/cards':
      return <BusinessCardsRoom />;
    case '/bank/business/books':
      return <BusinessBooksRoom />;
    case '/bank/business/contractor-join':
      return <ContractorJoinRoom search={search} />;
    case '/bank/safety/bereavement':
      return <BereavementRoom />;
    case '/bank/recovery':
      return <RecoveryClaimRoom />;
    case '/bank/rules':
      return <RulesRoom />;
    case '/bank/earn':
      return <EarnRoom open={open} />;
    case '/bank/earn/pool':
      return <EarnPoolRoom search={search} open={open} />;
    case '/bank/loans':
      return <LoansRoom open={open} />;
    case '/bank/loans/detail':
      return <LoanDetailRoom search={search} />;
    case '/bank/loans/apply':
      return <LoanApplyRoom search={search} open={open} />;
    case '/bank/loans/overdraft':
      return <OverdraftPreviewRoom />;
    case '/bank/loans/personal':
      return <PersonalLoanPreviewRoom />;
    case '/bank/loans/schedule':
      return <LoanSchedulePreviewRoom />;
    case '/bank/cards/credit-card':
      return <CreditCardPreviewRoom />;
    case '/bank/cards/credit':
      return <RevolvingCreditPreviewRoom />;
    case '/bank/business/loan':
      return <BusinessLoanPreviewRoom />;
    case '/bank/cards':
      return <Cards open={open} />;
    case '/bank/cards/new':
      return <CardOrderRoom />;
    case '/bank/ramps':
      return <Ramps open={open} />;
    case '/bank/ramps/new':
      return <AddMoneyRoom />;
    case '/bank/ramps/accounts':
      return <LinkedAccountsRoom />;
    case '/bank/ramps/cash-out':
      return <CashOutRoom />;
    case '/bank/analytics':
      return <Analytics />;
    case '/bank/statements':
      return <StatementsRoom />;
    case '/bank/limits':
      return <LimitsPage />;
    case '/bank/account':
      return <BankAccountPage />;
    case '/bank/salary':
      return <SalaryPage open={open} />;
    case '/bank/business':
      return <Business open={open} />;
    case '/uc/record':
      return <MoneyActivity />;
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
