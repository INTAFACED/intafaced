import { t as copyText, Text } from './copy';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Button, DataTable, EmptyState, Failure, Field, Page } from '../../shared/ui';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { dec } from '../../data/decimal';
import { useSession } from '../session/session';
import { usePreferences, savePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { createMoneyClient, validateTransfer, type MoneyOverview, type Space } from './client';
import {
  amount,
  funds,
  bps,
  endsField,
  scheduleCadenceField,
  Continuation,
  date,
  iso,
  NoRows,
  positiveMoney,
  ResourceView,
  Section,
  scheduleWindowIssue,
  startsField,
  useBankRead,
  usePageLimit,
  type ActionSpec,
} from './components';
import { AutoInvestRules } from './repeat-buy';
import { EarlyUnlock, SpaceLockActions } from './SpaceLock';
import { bankReads, bankWrites, type poolSchema, type positionSchema } from './contracts';
import type { ApiResult } from '../../shared/api';
import { earnCopy } from './earn-copy';
import { earnPoolCopy } from './earn-pool-copy';
import { EarnCompare, poolHref } from './EarnCompare';
import { EarnPool } from './EarnPool';
import { LoanHealth, currentLoanPreflight, loanActionAllowed, loanStatusNote, readReleasable } from './LoanHealth';
import { loanCopy, loanStatusLabel } from './loan-copy';
import { MoneyActivity } from './activity';
import { ExecutionHistory, StandingFacts, currentInstruction, type StandingInstruction } from './ScheduleHistory';
import { standingCopy } from './standing-copy';
import { useBankView } from './bank-context';
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
import { AddMoney } from './AddMoney';
import { addMoneyCopy } from './add-money-copy';
import { LinkedAccounts } from './LinkedAccounts';
import { DirectDebits } from './DirectDebits';
import { directDebitsCopy } from './direct-debits-copy';
import { RecoveryClaim } from './RecoveryClaim';
import { recoveryClaimCopy } from './recovery-claim-copy';
import { MoneyCalendar } from './Calendar';
import { calendarCopy } from './calendar-copy';
import { Rules } from './Rules';
import { rulesCopy } from './rules-copy';
import { LoanDetail } from './LoanDetail';
import { loanDetailCopy } from './loan-detail-copy';
import { linkedAccountsCopy } from './linked-accounts-copy';
import { cashOutCopy } from './cash-out-copy';
import { CashOut } from './CashOut';
import { BankRailSend } from './BankRailSend';
import { PlanRule } from './PlanRule';
import { currentSpace, spaceContext } from './space-context';
import { spaceCopy } from './space-copy';
import { categoryLabel } from './analytics-copy';
import { splitAnalytics } from './analytics-model';
import { GoalProgress, MovementBars } from './GoalAndMovement';
import { availableRow, earnFormFacts, earnLiveRows, loanFormFacts, loanLiveRows } from './form-preview';
import { RecipientPicker } from './RecipientPicker';
import { BusinessBank } from './BusinessBank';
import { businessCopy } from './business-copy';
import { RampJourneys } from './RampJourneys';
import { rampDepthCopy } from './ramp-depth-copy';
import { PERIOD_PRESETS, periodRange, type PeriodPreset } from './periods';
import type { Payee } from './payees';
import { transferDepthCopy } from './transfer-depth-copy';
import { personSendStepUp, readPersonSendTerms } from './person-send-terms';
import { cleanText, noteProblem, referenceProblem } from './transfer-message';
import { assetSelectField, spaceTotals, useHoldings } from './holdings';

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
    <nav data-testid="money-bank-nav" className="money-bank-nav" aria-label={copyText('rooms.bank.rooms')}>
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
function spaceName(space: Space) {
  return copyText('rooms.available', {
    value1: space.name,
    value2: space.assetId,
    value3: funds(space.balance, space.assetId),
    value4: space.lockedUntil && Date.parse(space.lockedUntil) > Date.now() ? copyText('rooms.locked.suffix') : '',
  });
}
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
  const spaces = useBankRead('spaces.list', { limit });
  const unnamed = useBankRead('spaces.unnamed', undefined);
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
/** An ISO instant as the local `datetime-local` value the form shows. */
function localInput(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ScheduleActions({
  row,
  open,
  disabled = false,
}: {
  row: StandingInstruction;
  open: (spec: ActionSpec) => void;
  disabled?: boolean;
}) {
  const current = useBankView();
  const protectedOpen = (spec: ActionSpec) => {
    if (!disabled && current()) open(spec);
  };
  return (
    <div className="actions">
      {' '}
      {row.status !== 'cancelled' && (
        <>
          {(row.status === 'active' || row.status === 'paused') && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                protectedOpen({
                  title: copyText('rooms.edit.standing.order'),
                  procedure: 'transfers.updateSchedule',
                  fields: [positiveMoney(row.assetId), ...(row.cadence === 'once' ? [] : [endsField])],
                  initial: { amount: row.amount, ...(row.endsAt ? { endsAt: localInput(row.endsAt) } : {}) },
                  formFacts: [[copyText('rooms.revision'), String(row.revision)]],
                  facts: [
                    [copyText('rooms.schedule'), row.id],
                    [copyText('rooms.revision'), String(row.revision)],
                    [copyText('rooms.current.amount'), amount(row.amount, row.assetId)],
                  ],
                  notes: [copyText('rooms.edit.changes.future.runs'), copyText('rooms.edit.revision.note')],
                  validate: (input) =>
                    typeof input.endsAt === 'string' && Date.parse(input.endsAt) <= Math.max(Date.now(), Date.parse(row.startsAt))
                      ? copyText('components.choose.an.end.after.first.run')
                      : null,
                  input: (values) => ({
                    scheduleId: row.id,
                    revision: row.revision,
                    amount: values.amount,
                    // The form shows minutes: an end left as it was keeps the stored instant, seconds included.
                    endsAt: !values.endsAt
                      ? null
                      : row.endsAt && values.endsAt === localInput(row.endsAt)
                        ? row.endsAt
                        : iso(values.endsAt),
                  }),
                })
              }
            >
              <Text k="rooms.edit" />
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() =>
              protectedOpen({
                title: row.status === 'paused' ? copyText('rooms.resume.standing.order') : copyText('rooms.pause.standing.order'),
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
            disabled={disabled}
            onClick={() =>
              protectedOpen({
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
  );
}
function Schedules({ open }: { open: (spec: ActionSpec) => void }) {
  const { Copy, t, languageFor, directionFor } = standingCopy.useCopy();
  const current = useBankView();
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<{ id: string; serial: number } | null>(null);
  const serial = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLSpanElement>(null);
  const query = useBankRead('transfers.listSchedules', { limit });
  const rows = query.resource.status === 'ready' ? query.resource.data : [];
  const instruction = selected ? currentInstruction(rows, selected.id) : undefined;
  const other = instruction ? rows.filter((row) => row.id !== instruction.id) : rows;
  const refresh = () => {
    if (current()) query.reload();
  };
  const arrive = (element: HTMLElement | null) => {
    if (!current() || document.querySelector('[role="dialog"]')) return;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'start' });
  };
  useLayoutEffect(() => {
    if (selected) arrive(heading.current);
  }, [selected?.serial]);
  return (
    <div
      data-testid="money-standing-orders"
      className="money-standing-orders"
      lang={languageFor('instructions')}
      dir={directionFor('instructions')}
    >
      {selected && (
        <section
          data-testid="money-selected-instruction"
          className="money-selected-instruction"
          aria-labelledby="money-selected-instruction-heading"
        >
          <header>
            <h2 id="money-selected-instruction-heading" ref={heading} tabIndex={-1}>
              <Copy k="outcomes" />
            </h2>
            <dl data-testid="money-standing-reference" className="money-standing-reference">
              <dt>
                <Copy k="instruction" />
              </dt>
              <dd lang="zxx" dir="ltr">
                {instruction?.id ?? selected.id}
              </dd>
            </dl>
          </header>
          <ResourceView resource={query.resource} reload={refresh}>
            {() =>
              instruction ? (
                <>
                  <StandingFacts instruction={instruction} />
                  <ScheduleActions row={instruction} open={open} />
                  <ExecutionHistory id={instruction.id} asset={instruction.assetId} refreshInstructions={refresh} />
                </>
              ) : (
                <div className="money-instruction-missing" role="status">
                  <h3>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflict' : 'missing'} />
                  </h3>
                  <p>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflictNote' : 'missingNote'} />
                  </p>
                  <Button variant="secondary" onClick={refresh}>
                    <Copy k="refresh" />
                  </Button>
                </div>
              )
            }
          </ResourceView>
          <Button variant="ghost" onClick={() => arrive(listHeading.current)}>
            <Copy k="return" />
          </Button>
        </section>
      )}
      <Section
        title={
          <span id="money-standing-list-heading" ref={listHeading} tabIndex={-1}>
            <Copy k={instruction ? 'other' : 'instructions'} />
          </span>
        }
        actions={
          <Button variant="ghost" onClick={refresh}>
            <Copy k="refresh" />
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={refresh}>
          {() => (
            <>
              {other.length ? (
                other.map((row, index) => (
                  <article data-testid="money-standing-record" className="money-record money-standing-record" key={`${row.id}:${index}`}>
                    <header>
                      <div>
                        <h3 lang="und" dir="auto">
                          {row.cadence} · {row.status}
                        </h3>
                        <p className="money-standing-row-reference">
                          <span className="money-visually-hidden">
                            <Copy k="reference" />
                          </span>
                          <bdi lang="zxx" dir="ltr">
                            {row.id}
                          </bdi>
                        </p>
                        <p>
                          <Copy k="nextRun" /> ·{' '}
                          <span lang="und" dir="auto">
                            {date(row.nextRunAt)}
                          </span>
                        </p>
                      </div>
                      <strong className="numeric" lang="zxx" dir="ltr">
                        {funds(row.amount, row.assetId)}
                      </strong>
                    </header>
                    <div className="actions">
                      <Button
                        variant="secondary"
                        aria-label={t('inspect', { reference: row.id })}
                        lang={languageFor('inspect')}
                        dir={directionFor('inspect')}
                        disabled={!currentInstruction(rows, row.id)}
                        aria-controls="money-selected-instruction-heading"
                        onClick={() => {
                          if (current() && currentInstruction(rows, row.id) === row && !document.querySelector('[role="dialog"]'))
                            setSelected({ id: row.id, serial: ++serial.current });
                        }}
                      >
                        <Text k="rooms.execution.history" />
                      </Button>
                      <ScheduleActions row={row} open={open} disabled={!currentInstruction(rows, row.id)} />
                    </div>
                  </article>
                ))
              ) : (
                <div className="money-instruction-missing" role="status">
                  <h3>
                    <Copy k={instruction ? 'noOther' : 'noInstructions'} />
                  </h3>
                  <p>
                    <Copy k="listWindow" />
                  </p>
                </div>
              )}
              <Continuation
                count={rows.length}
                limit={limit}
                onMore={() => {
                  if (current()) setLimit(Math.min(200, limit + 50));
                }}
              />
              <p className="money-caption">
                <Copy k="listWindow" />
              </p>
            </>
          )}
        </ResourceView>
      </Section>
    </div>
  );
}
/** The customer's other accounts in the same asset, the only places a space-to-space move can go. */
function ownSpaces(spaces: Space[], from: Space | undefined, owner: string): Space[] {
  if (!from) return [];
  return spaces.filter((space) => space.id !== from.id && space.assetId === from.assetId && currentSpace(spaces, space.id, owner));
}
function Transfers({ open, search }: { open: (spec: ActionSpec) => void; search: string }) {
  const { api, userId } = useSession();
  const context = spaceContext(search, 'from');
  const [limit, setLimit] = useState(context.status === 'valid' ? 200 : 50);
  const query = useBankRead('spaces.list', { limit });
  const [fromId, setFrom] = useState(context.status === 'valid' ? context.id : '');
  const [destination, setDestination] = useState<'space' | 'user'>('space');
  const [scheduled, setScheduled] = useState(false);
  const [recipient, setRecipient] = useState<Payee | null>(null);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const depth = transferDepthCopy.useCopy();
  const noteIssue = noteProblem(note);
  const referenceIssue = referenceProblem(reference);
  const noteWords = noteIssue ? depth.t(noteIssue === 'tooLong' ? 'noteTooLong' : 'noteControl') : null;
  const referenceWords = referenceIssue ? depth.t(referenceIssue === 'tooLong' ? 'referenceTooLong' : 'referenceCharacters') : null;
  return (
    <BankPage room="Transfers" description={copyText('rooms.move.available.quantities.between.spaces.or.to')}>
      <DirectDebitsLink />
      <CalendarLink />
      <RulesLink />
      <Section title={copyText('rooms.new.transfer')}>
        <ResourceView resource={query.resource} reload={query.reload}>
          {(spaces) => {
            const from = currentSpace(spaces, fromId, userId ?? '');
            return spaces.length ? (
              <>
                {context.status === 'invalid' && !fromId && (
                  <p className="money-caption">
                    <spaceCopy.Copy k="fromInvalid" />
                  </p>
                )}
                <div className="money-transfer-setup">
                  <label className="field">
                    <span id="bank-transfer-source-label">
                      <Text k="rooms.from.your.space" />
                    </span>
                    <select
                      aria-labelledby="bank-transfer-source-label"
                      value={from?.id ?? ''}
                      onChange={(event) => setFrom(event.target.value)}
                    >
                      <option value="">
                        <Text k="rooms.choose.source" />
                      </option>
                      {spaces
                        .filter((space) => currentSpace(spaces, space.id, userId ?? ''))
                        .map((space) => (
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
                      <option value="space">{depth.t('toYourSpace')}</option>
                      <option value="user">{depth.t('toPerson')}</option>
                    </select>
                  </label>
                  {destination === 'user' && (
                    <>
                      <RecipientPicker value={recipient} onChange={setRecipient} />
                      <p className="money-caption">{depth.t('personNote')}</p>
                    </>
                  )}
                  {destination === 'space' && (
                    <p className="money-caption">
                      {from && ownSpaces(spaces, from, userId ?? '').length === 0 ? depth.t('noOtherSpace') : depth.t('spaceNote')}
                    </p>
                  )}
                  <label className="field">
                    <span>{depth.t('noteField')}</span>
                    <input
                      name="note"
                      value={note}
                      disabled={scheduled}
                      autoComplete="off"
                      onChange={(event) => setNote(event.target.value)}
                      aria-invalid={Boolean(noteWords)}
                      aria-describedby="transfer-note-help"
                    />
                    <small id="transfer-note-help" className={noteWords ? 'error-text' : ''}>
                      {scheduled ? depth.t('messageScheduledReason') : (noteWords ?? depth.t('noteHint'))}
                    </small>
                  </label>
                  <label className="field">
                    <span>{depth.t('referenceField')}</span>
                    <input
                      name="reference"
                      value={reference}
                      disabled={scheduled}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) => setReference(event.target.value)}
                      aria-invalid={Boolean(referenceWords)}
                      aria-describedby="transfer-reference-help"
                    />
                    <small id="transfer-reference-help" className={referenceWords ? 'error-text' : ''}>
                      {scheduled ? depth.t('messageScheduledReason') : (referenceWords ?? depth.t('referenceHint'))}
                    </small>
                  </label>
                  <label className="money-check">
                    <input type="checkbox" checked={scheduled} onChange={(event) => setScheduled(event.target.checked)} />
                    <Text k="rooms.repeat.on.a.schedule" />
                  </label>
                  <Button
                    disabled={
                      !from ||
                      (!scheduled && (noteIssue !== null || referenceIssue !== null)) ||
                      (destination === 'user' && !recipient) ||
                      (destination === 'space' && ownSpaces(spaces, from, userId ?? '').length === 0)
                    }
                    onClick={() => {
                      if (!from) return;
                      if (destination === 'user' && !recipient) return;
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
                          ...(destination === 'space'
                            ? [
                                {
                                  name: 'toSpaceId',
                                  label: depth.t('whichSpace'),
                                  options: ownSpaces(spaces, from, userId ?? '').map((space) => ({
                                    value: space.id,
                                    label: `${space.name} · ${funds(space.balance, space.assetId)}`,
                                  })),
                                },
                              ]
                            : []),
                          positiveMoney(from.assetId),
                          ...(scheduled ? [scheduleCadenceField, startsField, endsField] : []),
                        ],
                        facts: [
                          [depth.t('from'), from.name],
                          ...(destination === 'user' && recipient
                            ? [[depth.t('recipient'), `@${recipient.handle}`] as [string, string]]
                            : []),
                          [copyText('rooms.asset'), from.assetId],
                          [copyText('rooms.available.at.last.read'), amount(from.balance, from.assetId)],
                          ...(scheduled
                            ? []
                            : [
                                [depth.t('factNote'), cleanText(note) ?? depth.t('factNone')] as [string, string],
                                [depth.t('factReference'), cleanText(reference) ?? depth.t('factNone')] as [string, string],
                              ]),
                        ],
                        notes: [
                          destination === 'user' ? depth.t('personNote') : depth.t('spaceNote'),
                          ...(!scheduled && (cleanText(note) || cleanText(reference)) ? [depth.t('messageSaved')] : []),
                        ],
                        validate: (input) =>
                          scheduleWindowIssue(input) ??
                          validateTransfer(spaces, { ...input, transferId: 'review-reference' } as Parameters<typeof validateTransfer>[1]),
                        ...(!scheduled ? { transferSpaces: spaces } : {}),
                        ...(!scheduled && destination === 'user'
                          ? {
                              reviewTerms: {
                                checking: depth.t('reviewChecking'),
                                read: (input, signal) => readPersonSendTerms(api, from.assetId, String(input.amount), signal),
                              },
                              stepUp: {
                                request: (input) => personSendStepUp(from.assetId, input),
                                words: {
                                  why: depth.t('stepUpWhy'),
                                  code: depth.t('stepUpCode'),
                                  codeHint: depth.t('stepUpCodeHint'),
                                  codeShort: depth.t('stepUpCodeShort'),
                                  noFactor: depth.t('stepUpNoFactor'),
                                  sendWithout: depth.t('stepUpSendWithout'),
                                },
                              },
                            }
                          : {}),
                        input: (values, requestId) => ({
                          fromSpaceId: from.id,
                          ...(destination === 'space' ? { toSpaceId: values.toSpaceId } : { toUserId: recipient!.userId }),
                          amount: values.amount,
                          ...(scheduled
                            ? {
                                scheduleId: requestId,
                                cadence: values.cadence,
                                startsAt: iso(values.startsAt!),
                                ...(values.endsAt ? { endsAt: iso(values.endsAt) } : {}),
                              }
                            : {
                                transferId: requestId,
                                ...(cleanText(note) ? { note: cleanText(note) } : {}),
                                ...(cleanText(reference) ? { reference: cleanText(reference) } : {}),
                              }),
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
        <PlanRule />
      </Section>
      <BankRailSend />
      <Schedules open={open} />
    </BankPage>
  );
}
function Earn({ open }: { open: (spec: ActionSpec) => void }) {
  const { api } = useSession();
  const [limit, setLimit] = usePageLimit();
  const fail = (subject: string): ApiResult<null> => ({
    ok: false,
    reason: 'error',
    code: 'money.review_read_unavailable',
    message: earnCopy.t('readFailed', { subject }),
  });
  const changed = (): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message: earnCopy.t('changed') });
  const validMaturity = (at: string) => z.string().datetime({ offset: true }).safeParse(at).success;
  const maturityAllowsReview = (at: string | null) => at === null || (validMaturity(at) && Date.parse(at) <= Date.now());
  async function checkPool(pool: z.infer<typeof poolSchema>, automation = false): Promise<ApiResult<null>> {
    const fresh = await api.query('bank', 'earn.pools', { limit }, bankReads['earn.pools']);
    if (!fresh.ok) return fail(earnCopy.t('subjectPool'));
    const current = fresh.data.find((row) => row.id === pool.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(pool)) return changed();
    if (automation) {
      const policy = await api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']);
      if (!policy.ok) return fail(earnCopy.t('subjectPolicy'));
      if (!policy.data.enabled) return changed();
    }
    return { ok: true, data: null };
  }
  async function checkPosition(position: z.infer<typeof positionSchema>): Promise<ApiResult<null>> {
    const fresh = await api.query('bank', 'earn.positions', { limit }, bankReads['earn.positions']);
    if (!fresh.ok) return fail(earnCopy.t('subjectPosition'));
    const current = fresh.data.find((row) => row.id === position.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(position) || !maturityAllowsReview(current.maturesAt)) return changed();
    return { ok: true, data: null };
  }
  const pools = useBankRead('earn.pools', { limit });
  const positions = useBankRead('earn.positions', { limit });
  const held = useHoldings();
  const heldRows = held.resource.status === 'ready' ? held.resource.data.holdings : null;
  const automation = useBankRead('autoInvest.policy', undefined);
  return (
    <BankPage room="Earn" description={earnCopy.t('description')}>
      {pools.resource.status === 'ready' && <EarnCompare pools={pools.resource.data} />}
      <div data-testid="money-earn-lanes" className="money-earn-lanes">
        <Section
          title={copyText('rooms.your.positions')}
          actions={
            <Button variant="ghost" onClick={positions.reload}>
              {earnCopy.t('refresh')}
            </Button>
          }
        >
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
                            {position.maturesAt === null ? (
                              earnCopy.t('noFixed')
                            ) : (
                              <>
                                <Text k="rooms.matures" />
                                {validMaturity(position.maturesAt) ? date(position.maturesAt) : copyText('components.date.unavailable')}
                              </>
                            )}
                          </p>
                        </div>
                        <strong className="numeric">
                          {funds(position.principal, position.assetId)}
                          <Text k="rooms.principal" />
                        </strong>
                      </header>
                      <p className="money-caption">
                        {earnCopy.t('position')} · {position.id}
                      </p>
                      {maturityAllowsReview(position.maturesAt) ? (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            open({
                              title: copyText('rooms.withdraw.earn.principal'),
                              unit: position.assetId,
                              procedure: 'earn.withdraw',

                              preflight: () => checkPosition(position),
                              verifyOutcome: (data) => {
                                const returned = data as z.infer<(typeof bankWrites)['earn.withdraw']>;
                                return (
                                  returned.positionId === position.id && parseAmount(returned.principal) === parseAmount(position.principal)
                                );
                              },
                              facts: [
                                [copyText('rooms.position'), position.id],
                                [copyText('rooms.principal.2'), amount(position.principal, position.assetId)],
                                [copyText('rooms.matures.2'), date(position.maturesAt)],
                              ],
                              notes: [copyText('rooms.the.service.checks.maturity.and.reconciles.ledger'), earnCopy.t('withdrawalOutcome')],
                              input: () => ({ positionId: position.id }),
                            })
                          }
                        >
                          <Text k="rooms.review.withdrawal" />
                        </Button>
                      ) : (
                        <p className="money-earn-lock">{earnCopy.t(validMaturity(position.maturesAt!) ? 'locked' : 'maturityMissing')}</p>
                      )}
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
        <Section
          title={copyText('rooms.available.pools')}
          actions={
            <Button
              variant="ghost"
              onClick={() => {
                pools.reload();
                automation.reload();
              }}
            >
              {earnCopy.t('refresh')}
            </Button>
          }
        >
          <ResourceView resource={automation.resource} reload={automation.reload}>
            {(policy) => !policy.enabled && <p className="notice">{earnCopy.t('automationDisabled')}</p>}
          </ResourceView>
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
                      <p className="money-caption">
                        <a className="text-link" href={poolHref(pool.id)} data-testid="earn-pool-link" data-pool={pool.id}>
                          {earnPoolCopy.t('details')}
                        </a>
                      </p>
                      <div className="actions">
                        <Button
                          onClick={() =>
                            open({
                              title: copyText('rooms.deposit.into.earn'),
                              procedure: 'earn.deposit',

                              preflight: () => checkPool(pool),
                              verifyOutcome: (data, input) => {
                                const returned = data as z.infer<(typeof bankWrites)['earn.deposit']>;
                                const fixed = pool.kind === 'fixed' && pool.termDays !== null;
                                return (
                                  returned.positionId === input.positionId &&
                                  (fixed
                                    ? z.string().datetime({ offset: true }).safeParse(returned.maturesAt).success
                                    : returned.maturesAt === null)
                                );
                              },
                              fields: [positiveMoney(pool.assetId)],
                              formFacts: earnFormFacts(pool, availableRow(pool.assetId, heldRows, funds), new Date(), bps),
                              liveRows: (values) => earnLiveRows(pool, values, funds),
                              facts: [
                                [copyText('rooms.pool'), pool.name],
                                [copyText('rooms.apr.2'), bps(pool.aprBps)],
                                [
                                  copyText('rooms.term'),
                                  pool.termDays === null
                                    ? copyText('rooms.flexible.term')
                                    : copyText('rooms.days', { value1: pool.termDays }),
                                ],
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
                          disabled={automation.resource.status !== 'ready' || !automation.resource.data.enabled}
                          onClick={() =>
                            open({
                              title: copyText('rooms.create.threshold.sweep'),
                              procedure: 'autoInvest.createThresholdSweep',
                              unit: pool.assetId,
                              preflight: () => checkPool(pool, true),
                              fields: [
                                {
                                  ...positiveMoney(pool.assetId, 'threshold', earnCopy.t('keepAvailable')),
                                  hint: earnCopy.t('thresholdHint'),
                                },
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
                          disabled={automation.resource.status !== 'ready' || !automation.resource.data.enabled}
                          onClick={() =>
                            open({
                              title: copyText('rooms.create.card.round.up'),
                              procedure: 'autoInvest.createRoundUp',
                              unit: pool.assetId,
                              preflight: () => checkPool(pool, true),
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
      </div>
      <p className="muted money-caption">{earnCopy.t('unavailableHistory')}</p>
      <AutoInvestRules open={open} />
    </BankPage>
  );
}
function Loans({ open }: { open: (spec: ActionSpec) => void }) {
  const { api } = useSession();
  const [limit, setLimit] = usePageLimit();
  const products = useBankRead('loans.products', { limit });
  const loans = useBankRead('loans.list', { limit });
  const health = useBankRead('loans.health', undefined);
  const held = useHoldings();
  const heldRows = held.resource.status === 'ready' ? held.resource.data.holdings : null;
  return (
    <BankPage room="Loans" description={copyText('rooms.configured.borrowing.terms.ledger.collateral.and.authoritative')}>
      <Section title={copyText('rooms.loan.health')}>
        <ResourceView resource={health.resource} reload={health.reload}>
          {(risk) => (
            <>
              <div data-testid="money-risk" className="money-risk">
                <strong>
                  {risk.portfolioLtvBps === Number.MAX_SAFE_INTEGER ? loanCopy.t('portfolioRange') : bps(risk.portfolioLtvBps)}
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
                        <dd>
                          {dec(product.minPrincipal) === 0n
                            ? copyText('rooms.no.minimum')
                            : funds(product.minPrincipal, product.debtAssetId)}
                        </dd>
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
                          formFacts: loanFormFacts(product, availableRow(product.collateralAssetId, heldRows, funds), bps),
                          liveRows: (values) => loanLiveRows(product, values, funds),
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
                  <article data-testid="money-loan-record" className="money-record money-loan-record" key={loan.id} data-loan-id={loan.id}>
                    <header>
                      <div>
                        <h3>
                          {loan.debtAssetId}
                          <Text k="rooms.loan" />
                        </h3>
                        <p>
                          {loanStatusLabel(loan.status)}
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
                        <dt>{loan.status === 'pending' ? loanCopy.t('pendingPrincipal') : <Text k="rooms.outstanding.principal" />}</dt>
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
                    <LoanHealth loan={loan} resource={health.resource} reload={health.reload} />
                    <LoanDetailLink loanId={loan.id} />
                    {loanStatusNote(loan.status) && <p className="muted money-loan-status">{loanStatusNote(loan.status)}</p>}
                    <div className="actions">
                      <Button
                        disabled={!loanActionAllowed(loan, 'repay')}
                        onClick={() =>
                          open({
                            title: copyText('rooms.repay.loan'),
                            procedure: 'loans.repay',
                            preflight: currentLoanPreflight(api, loan, 'repay', limit),
                            fields: [positiveMoney(loan.debtAssetId)],
                            facts: [
                              [loanCopy.t('loan'), loan.id],
                              [loanCopy.t('status'), loanStatusLabel(loan.status)],
                              [loanCopy.t('debtAsset'), loan.debtAssetId],
                              [loanCopy.t('collateralAsset'), loan.collateralAssetId],
                              [copyText('rooms.principal.at.last.read'), amount(loan.outstandingPrincipal, loan.debtAssetId)],
                              [copyText('rooms.interest.at.last.read'), amount(loan.outstandingInterest, loan.debtAssetId)],
                            ],
                            notes: [loanCopy.t('repaymentOffer'), copyText('rooms.your.request.reference.remains.stable.an.uncertain')],
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                            // svc-bank `loans.repay` answers a repeated eventId with the first repayment, never a second one.
                            resendSame: true,
                          })
                        }
                      >
                        <Text k="rooms.repay" />
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={!loanActionAllowed(loan, 'addCollateral')}
                        onClick={() =>
                          open({
                            title: copyText('rooms.add.collateral'),
                            procedure: 'loans.addCollateral',
                            preflight: currentLoanPreflight(api, loan, 'addCollateral', limit),
                            fields: [positiveMoney(loan.collateralAssetId)],
                            facts: [
                              [loanCopy.t('loan'), loan.id],
                              [loanCopy.t('status'), loanStatusLabel(loan.status)],
                              [loanCopy.t('debtAsset'), loan.debtAssetId],
                              [loanCopy.t('collateralAsset'), loan.collateralAssetId],
                            ],
                            notes: [copyText('rooms.additional.collateral.is.locked.from.your.user')],
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        <Text k="rooms.add.collateral" />
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={!loanActionAllowed(loan, 'releaseExcess')}
                        onClick={() =>
                          open({
                            title: copyText('rooms.release.excess.collateral'),
                            procedure: 'loans.releaseExcess',
                            preflight: currentLoanPreflight(api, loan, 'releaseExcess', limit),
                            validate: (input) =>
                              typeof input.amount === 'string' && parseAmount(input.amount) <= parseAmount(loan.collateral)
                                ? null
                                : loanCopy.t('releaseTooLarge'),
                            fields: [positiveMoney(loan.collateralAssetId)],
                            facts: [
                              [loanCopy.t('loan'), loan.id],
                              [loanCopy.t('status'), loanStatusLabel(loan.status)],
                              [loanCopy.t('debtAsset'), loan.debtAssetId],
                              [loanCopy.t('collateralAsset'), loan.collateralAssetId],
                              [copyText('rooms.collateral.at.last.read'), amount(loan.collateral, loan.collateralAssetId)],
                            ],
                            notes: [
                              copyText('rooms.the.service.obtains.current.marks.before.releasing'),
                              copyText('rooms.no.available.amount.is.optimistically.increased.refresh'),
                            ],
                            reviewTerms: {
                              checking: loanCopy.t('releasableChecking'),
                              read: (input, signal) => readReleasable(api, loan.id, loan.collateralAssetId, input.amount, signal),
                            },
                            // svc-bank `loans.releaseExcess` keys the release by this eventId, so a retry never releases twice.
                            input: (values, requestId) => ({ loanId: loan.id, eventId: requestId, amount: values.amount }),
                          })
                        }
                      >
                        <Text k="rooms.release.excess" />
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!loanActionAllowed(loan, 'close')}
                        onClick={() =>
                          open({
                            title: copyText('rooms.release.settled.collateral'),
                            unit: loan.collateralAssetId,
                            procedure: 'loans.close',
                            preflight: currentLoanPreflight(api, loan, 'close', limit),
                            facts: [
                              [loanCopy.t('loan'), loan.id],
                              [loanCopy.t('status'), loanStatusLabel(loan.status)],
                              [loanCopy.t('debtAsset'), loan.debtAssetId],
                              [loanCopy.t('collateralAsset'), loan.collateralAssetId],
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
              <p className="muted money-loan-status">{loanCopy.t('unavailableHistory')}</p>
            </>
          )}
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
/** `/bank/ramps/new`: add money, inside the Ramps room. */
function AddMoneyRoom() {
  const { t } = addMoneyCopy.useCopy();
  return (
    <BankPage room="Ramps" title={t('title')} description={t('description')}>
      <AddMoney />
    </BankPage>
  );
}
/** The way into the direct debits room from Transfers. */
function DirectDebitsLink() {
  const { t } = directDebitsCopy.useCopy();
  return (
    <p className="money-caption">
      <a className="text-link" href="/bank/direct-debits">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
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
/** `/bank/recovery` (RC-identity-08): where a person named to receive someone's account claims it with their keys. */
function RecoveryClaimRoom() {
  const { t } = recoveryClaimCopy.useCopy();
  return (
    <BankPage room="Recovery" title={t('title')} description={t('description')}>
      <RecoveryClaim />
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
/** The way into the money calendar from Transfers. */
function CalendarLink() {
  const { t } = calendarCopy.useCopy();
  return (
    <p className="money-caption">
      <a className="text-link" href="/bank/calendar">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
  );
}
/** The way into reminders, failure notices and notification choices from Transfers. */
function RulesLink() {
  const { t } = rulesCopy.useCopy();
  return (
    <p className="money-caption">
      <a className="text-link" href="/bank/rules">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
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
/** Each loan's way to its details page: the payoff quote, the projection and the statement (J-bank-11 #1). */
function LoanDetailLink({ loanId }: { loanId: string }) {
  const { t } = loanDetailCopy.useCopy();
  return (
    <p className="money-caption">
      <a className="text-link" href={`/bank/loans/detail?loan=${encodeURIComponent(loanId)}`}>
        {t('open')}
      </a>
    </p>
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
/** `/bank/earn/pool?id=<pool>`: one pool's terms, rate history and the person's savings in it, inside the Earn room (J-bank-08 #1, #2). */
function EarnPoolRoom({ search, open }: { search: string; open: (spec: ActionSpec) => void }) {
  const { t } = earnPoolCopy.useCopy();
  const poolId = new URLSearchParams(search).get('id');
  return (
    <BankPage room="Earn" title={t('poolTitle')} description={t('poolDescription')}>
      <EarnPool poolId={poolId && poolId.trim() !== '' ? poolId : null} open={open} />
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
/** `/bank/ramps/accounts`: linked bank accounts, inside the Ramps room. */
function LinkedAccountsRoom() {
  const { t } = linkedAccountsCopy.useCopy();
  return (
    <BankPage room="Ramps" title={t('title')} description={t('description')}>
      <LinkedAccounts />
    </BankPage>
  );
}
/** `/bank/ramps/cash-out`: cash out to a linked bank account, inside the Ramps room. */
function CashOutRoom() {
  const { t } = cashOutCopy.useCopy();
  return (
    <BankPage room="Ramps" title={t('title')} description={t('description')}>
      <CashOut />
    </BankPage>
  );
}
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
  const query = useBankRead('analytics.spend', range, Boolean(range));
  const presetLabel = (value: PeriodPreset) =>
    depth.t(value === '7d' ? 'period7d' : value === '30d' ? 'period30d' : value === 'month' ? 'periodMonth' : 'periodLastMonth');
  return (
    <BankPage room="Analytics" description={copyText('rooms.ledger.movements.by.asset.and.date.movement')}>
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
      <div data-testid="money-overview-lane" className="money-overview-lane">
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
                      <span data-testid="money-holding-values" className="money-holding-values">
                        <strong className="numeric" dir="ltr">
                          <span data-testid="money-quantity-value" className="money-quantity-value">
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
      return <Transfers open={open} search={search} />;
    case '/bank/direct-debits':
      return <DirectDebitsRoom />;
    case '/bank/calendar':
      return <CalendarRoom />;
    case '/bank/recovery':
      return <RecoveryClaimRoom />;
    case '/bank/rules':
      return <RulesRoom />;
    case '/bank/earn':
      return <Earn open={open} />;
    case '/bank/earn/pool':
      return <EarnPoolRoom search={search} open={open} />;
    case '/bank/loans':
      return <Loans open={open} />;
    case '/bank/loans/detail':
      return <LoanDetailRoom search={search} />;
    case '/bank/cards':
      return <Cards open={open} />;
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
