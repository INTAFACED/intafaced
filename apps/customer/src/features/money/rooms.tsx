import { t as copyText, Text } from './copy';
import { ComplaintRoom } from './complaint/ComplaintRoom';
import {
  BusinessLoanPreviewRoom,
  CreditCardPreviewRoom,
  LoanSchedulePreviewRoom,
  OverdraftPreviewRoom,
  PersonalLoanPreviewRoom,
  RevolvingCreditPreviewRoom,
} from './credit-previews/CreditPreviewRooms';
import { BereavementRoom } from './bereavement/BereavementRoom';
import { ScamReportRoom } from './scam/ScamReportRoom';
import { LostPhoneRoom } from './lost-phone/LostPhoneRoom';
import { BusinessJoinRoom, BusinessPaymentRoom, BusinessTeamRoom } from './business-team/BusinessTeamRoom';
import { BusinessBillRoom, BusinessBillsRoom } from './business-bills/BusinessBillsRoom';
import { BusinessPayoutsRoom, ContractorJoinRoom } from './business-payouts/BusinessPayoutsRoom';
import { BusinessCardsRoom } from './business-cards/BusinessCardsRoom';
import { BusinessBooksRoom } from './business-books/BusinessBooksRoom';
import { CardOrderRoom } from './CardOrder';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, EmptyState, Page } from '../../shared/ui';
import { decimalSchema } from '../../shared/money';
import { useSession } from '../session';
import { validateTransfer, type Space } from './client';
import {
  amount,
  funds,
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
  useBankRecord,
  useSpaces,
  usePageLimit,
  type ActionSpec,
} from './components';
import { EarnPoolRoom, EarnRoom } from './earn/EarnRooms';
import { LoansRoom } from './loans/LoansRoom';
import { MoneyActivity } from './activity';
import { ExecutionHistory, StandingFacts, currentInstruction, type StandingInstruction } from './ScheduleHistory';
import { standingCopy } from './standing-copy';
import { useBankView } from './bank-context';
import { CardsRoom } from './cards-room/CardsRoom';
import { BankOverview } from './bank-overview/BankOverviewRoom';
import { SpacesRoom } from './spaces/SpacesRoom';
import { AddMoney } from './AddMoney';
import { WalletProvider } from '../protocol';
import { addMoneyCopy } from './add-money-copy';
import { LinkedAccountsRoom } from './linked-accounts/LinkedAccountsRoom';
import { DirectDebitsRoom } from './direct-debits/DirectDebitsRoom';
import { directDebitsCopy } from './direct-debits-copy';
import { RecoveryClaim } from './RecoveryClaim';
import { recoveryClaimCopy } from './recovery-claim-copy';
import { CalendarRoom } from './calendar/Calendar';
import { calendarCopy } from './calendar-copy';
import { RulesRoom } from './rules-room/RulesRoom';
import { rulesCopy } from './rules-copy';
import { LoanDetailRoom } from './loan-detail/LoanDetailRoom';
import { LoanApply } from './LoanApply';
import { loanApplyCopy } from './loan-apply-copy';
import { cashOutCopy } from './cash-out-copy';
import { CashOut } from './CashOut';
import { BankRailSend } from './BankRailSend';
import { PlanRule, overBalanceProblem, usePlanTerms } from './PlanRule';
import { currentSpace, spaceContext } from './space-context';
import { spaceCopy } from './space-copy';
import { AnalyticsRoom } from './analytics/AnalyticsRoom';
import { LimitsPage } from './limits/LimitsRoom';
import { BankAccountPage } from './bank-account/BankAccountRoom';
import { RecipientPicker } from './RecipientPicker';
import { BusinessBankRoom } from './business-bank/BusinessBankRoom';
import { RampsRoom } from './ramps/RampsRoom';
import type { Payee } from './payees';
import { transferDepthCopy } from './transfer-depth-copy';
import { personSendStepUp, readPersonSendTerms } from './person-send-terms';
import { cleanText, noteProblem, referenceProblem } from './transfer-message';
import { assetSelectField } from './holdings';
import { StatementCentre } from './StatementCentre';
import { SalaryRoom } from './Salary';
import { salaryCopy } from './salary-copy';
import { StatementLetters, TaxStatements } from './StatementExtras';
import { statementCentreCopy } from './statement-centre-copy';
import { bankLabels } from './bank-frame/bank-rooms';
import { BankTabs } from './bank-frame/BankFrame';
import {
  BANK_TRANSFERS_CANCEL,
  BANK_TRANSFERS_LIST_SCHEDULES,
  BANK_TRANSFERS_TO_USER,
  BANK_TRANSFERS_RESUME,
  BANK_TRANSFERS_PAUSE,
} from '@intafaced/contracts/bank-transfers-procedures';
import { BANK_SPACES_ARCHIVE } from '@intafaced/contracts/bank-spaces-procedures';
import { BANK_SPACES_CREATE } from '@intafaced/contracts/bank-spaces-2-procedures';
import {
  BANK_TRANSFERS_CREATE,
  BANK_TRANSFERS_SCHEDULE,
  BANK_TRANSFERS_SCHEDULE_TO_USER,
  BANK_TRANSFERS_UPDATE_SCHEDULE,
} from '@intafaced/contracts/bank-transfers-2-procedures';

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
          <a className="lt-button lt-button-secondary" href="/bank">
            <Text k="rooms.bank.overview" />
          </a>
        ) : undefined
      }
    >
      <BankTabs where={false} />
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
/** The review a named space's archive opens (`/bank/spaces`, spaces/SpacesRoom.tsx). */
export function archiveSpaceSpec(space: Space): ActionSpec {
  return {
    title: copyText('rooms.archive.space'),
    record: BANK_SPACES_ARCHIVE,
    facts: [
      [copyText('rooms.space'), space.name],
      [copyText('rooms.available.quantity'), amount(space.balance, space.assetId)],
    ],
    notes: [copyText('rooms.archiving.removes.the.label.from.active.lists'), copyText('rooms.archived.named.space.funds.are.not.included')],
    input: () => ({ spaceId: space.id }),
    submit: copyText('rooms.archive.label'),
  };
}
/** The review Create space opens (`/bank/spaces`, spaces/SpacesRoom.tsx), with the asset picker of what the person holds. */
export function createSpaceSpec(assetField: ReturnType<typeof assetSelectField>): ActionSpec {
  return {
    title: copyText('rooms.create.space'),
    record: BANK_SPACES_CREATE,
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
  };
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
    <div className="lt-actions">
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
                  record: BANK_TRANSFERS_UPDATE_SCHEDULE,
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
                record: row.status === 'paused' ? BANK_TRANSFERS_RESUME : BANK_TRANSFERS_PAUSE,
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
                record: BANK_TRANSFERS_CANCEL,
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
  const query = useBankRecord(BANK_TRANSFERS_LIST_SCHEDULES, { limit });
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
    <div className="money-standing-orders" lang={languageFor('instructions')} dir={directionFor('instructions')}>
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
            <dl className="money-standing-reference">
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
                        <p className="lt-wrap">
                          <span className="lt-sr">
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
                      <strong className="lt-num" lang="zxx" dir="ltr">
                        {funds(row.amount, row.assetId)}
                      </strong>
                    </header>
                    <div className="lt-actions">
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
              <p className="lt-muted">
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
  const query = useSpaces(limit);
  // The plan's rule for paying more than the balance holds (J-bank-02 #8): shown under the form and in the review.
  const plan = usePlanTerms();
  // Read at review time, not when the dialog opened: terms that arrive or reload later still reach the review.
  const planTerms = useRef(plan.resource);
  planTerms.current = plan.resource;
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
      <div className="lt-stack money-transfer-links">
        <DirectDebitsLink />
        <CalendarLink />
        <RulesLink />
      </div>
      <Section title={copyText('rooms.new.transfer')}>
        <ResourceView resource={query.resource} reload={query.reload}>
          {(spaces) => {
            const from = currentSpace(spaces, fromId, userId ?? '');
            return spaces.length ? (
              <>
                {context.status === 'invalid' && !fromId && (
                  <p className="lt-muted">
                    <spaceCopy.Copy k="fromInvalid" />
                  </p>
                )}
                <div className="money-transfer-setup">
                  <label className="lt-field">
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
                  <label className="lt-field">
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
                      <p className="lt-muted">{depth.t('personNote')}</p>
                    </>
                  )}
                  {destination === 'space' && (
                    <p className="lt-muted">
                      {from && ownSpaces(spaces, from, userId ?? '').length === 0 ? depth.t('noOtherSpace') : depth.t('spaceNote')}
                    </p>
                  )}
                  <label className="lt-field">
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
                  <label className="lt-field">
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
                        ...(scheduled
                          ? destination === 'space'
                            ? { record: BANK_TRANSFERS_SCHEDULE }
                            : { record: BANK_TRANSFERS_SCHEDULE_TO_USER }
                          : destination === 'space'
                            ? { record: BANK_TRANSFERS_CREATE }
                            : { record: BANK_TRANSFERS_TO_USER }),
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
                          validateTransfer(
                            spaces,
                            { ...input, transferId: 'review-reference' } as Parameters<typeof validateTransfer>[1],
                            (space, asked) => overBalanceProblem(planTerms.current, space, asked),
                          ),
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
        <PlanRule plan={plan} />
      </Section>
      <BankRailSend />
      <Schedules open={open} />
    </BankPage>
  );
}
/** `/bank/ramps/new`: add money, inside the Ramps room. */
function AddMoneyRoom() {
  const { t } = addMoneyCopy.useCopy();
  return (
    <BankPage room="Ramps" title={t('title')} description={t('description')}>
      {/* The browser wallet's connection, so a purchase can be delivered straight to it (J-dex-protocol-05 #4). */}
      <WalletProvider>
        <AddMoney />
      </WalletProvider>
    </BankPage>
  );
}
/** The way into the direct debits room from Transfers. */
function DirectDebitsLink() {
  const { t } = directDebitsCopy.useCopy();
  return (
    <p className="lt-muted">
      <a className="lt-link" href="/bank/direct-debits">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
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
/** The way into the money calendar from Transfers. */
function CalendarLink() {
  const { t } = calendarCopy.useCopy();
  return (
    <p className="lt-muted">
      <a className="lt-link" href="/bank/calendar">
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
    <p className="lt-muted">
      <a className="lt-link" href="/bank/rules">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
  );
}
/** `/bank/loans/apply?product=<id>`: choose a loan, work out its collateral, check what applies and open it (J-bank-09). */
function LoanApplyRoom({ search, open }: { search: string; open: (spec: ActionSpec) => void }) {
  const { t } = loanApplyCopy.useCopy();
  const productId = new URLSearchParams(search).get('product');
  return (
    <BankPage room="Loans" title={t('title')} description={t('description')}>
      <LoanApply productId={productId && productId.trim() !== '' ? productId : null} open={open} />
    </BankPage>
  );
}
/** `/bank/loans/detail?loan=<id>`: one loan's payoff quote, projection and statement, inside the Loans room (J-bank-11 #1). */
function LoanDetailPage({ search }: { search: string }) {
  const loanId = new URLSearchParams(search).get('loan');
  return <LoanDetailRoom loanId={loanId && loanId.trim() !== '' ? loanId : null} />;
}
/** `/bank/salary`: salary paid in by direct deposit, inside the Overview room (J-bank-30). */
function SalaryPage({ open }: { open: (spec: ActionSpec) => void }) {
  return (
    <BankPage room="Overview" title={salaryCopy.t('title')} description={salaryCopy.t('description')}>
      <SalaryRoom open={open} />
    </BankPage>
  );
}

/** `/bank/statements`: the statement and export centre, inside the Analytics room (J-portfolio-11, PF-statements-01). */
function StatementsRoom() {
  const { t } = statementCentreCopy.useCopy();
  return (
    <BankPage room="Analytics" title={t('title')} description={t('description')}>
      <StatementCentre />
      <StatementLetters />
      <TaxStatements />
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
export function BankRoutes({ path, search, open }: { path: string; search: string; open: (spec: ActionSpec) => void }) {
  switch (path) {
    case '/bank':
      return <BankOverview />;
    case '/bank/spaces':
      return <SpacesRoom open={open} search={search} />;
    case '/bank/transfers':
      return <Transfers open={open} search={search} />;
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
      return <LoanDetailPage search={search} />;
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
      return <CardsRoom open={open} />;
    case '/bank/cards/new':
      return <CardOrderRoom />;
    case '/bank/ramps':
      return <RampsRoom open={open} />;
    case '/bank/ramps/new':
      return <AddMoneyRoom />;
    case '/bank/ramps/accounts':
      return <LinkedAccountsRoom />;
    case '/bank/ramps/cash-out':
      return <CashOutRoom />;
    case '/bank/analytics':
      return <AnalyticsRoom />;
    case '/bank/statements':
      return <StatementsRoom />;
    case '/bank/limits':
      return <LimitsPage />;
    case '/bank/account':
      return <BankAccountPage />;
    case '/bank/salary':
      return <SalaryPage open={open} />;
    case '/bank/business':
      return <BusinessBankRoom open={open} />;
    case '/uc/record':
      return <MoneyActivity />;
    default:
      return (
        <Page eyebrow={copyText('rooms.money.bank')} title={copyText('rooms.bank.room.unavailable')}>
          <EmptyState
            title={copyText('rooms.this.bank.address.is.not.registered')}
            action={
              <a className="lt-button lt-button-secondary" href="/bank">
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
