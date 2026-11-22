import { useRef, useState } from 'react';
import { Button, Field, Select } from '@intafaced/ui/lit';
import { Checkbox, FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { bankLabels, useBankNav } from '../bank-nav';
import { validateTransfer, type Space } from '../client';
import { calendarCopy } from '../calendar-copy';
import {
  amount,
  endsField,
  funds,
  iso,
  positiveMoney,
  scheduleCadenceField,
  scheduleWindowIssue,
  startsField,
  useSpaces,
  type ActionSpec,
} from '../components';
import { t as copyText, Text } from '../copy';
import { directDebitsCopy } from '../direct-debits-copy';
import type { Payee } from '../payees';
import { personSendStepUp, readPersonSendTerms } from '../person-send-terms';
import { rulesCopy } from '../rules-copy';
import { currentSpace, spaceContext } from '../space-context';
import { spaceCopy } from '../space-copy';
import { transferDepthCopy } from '../transfer-depth-copy';
import { cleanText, noteProblem, referenceProblem } from '../transfer-message';
import { BankRailSend } from './BankRailSend';
import { PlanRule, overBalanceProblem, usePlanTerms } from './PlanRule';
import { Continuation, Loaded as ResourceView, NoRows, Part as Section } from './TransferParts';
import { TransferRecipient } from './TransferRecipient';
import { Schedules } from './TransferSchedules';

/**
 * `/bank/transfers` on the flow template: a transfer between the person's own spaces or to another
 * person, the ways into direct debits, the money calendar and money rules, sending to a bank account, the recipient
 * book, the plan's rule for paying more than the balance holds, and standing orders. Copied from `Transfers` in
 * ../rooms.tsx with the same calls, words and ids; the bank's room row and the way back to the overview stay.
 */

function spaceName(space: Space) {
  return copyText('rooms.available', {
    value1: space.name,
    value2: space.assetId,
    value3: funds(space.balance, space.assetId),
    value4: space.lockedUntil && Date.parse(space.lockedUntil) > Date.now() ? copyText('rooms.locked.suffix') : '',
  });
}
/** The customer's other accounts in the same asset, the only places a space-to-space move can go. */
function ownSpaces(spaces: Space[], from: Space | undefined, owner: string): Space[] {
  if (!from) return [];
  return spaces.filter((space) => space.id !== from.id && space.assetId === from.assetId && currentSpace(spaces, space.id, owner));
}
export function TransfersRoom({ open, search }: { open: (spec: ActionSpec) => void; search: string }) {
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
  const nav = useBankNav('Transfers');
  return (
    <FlowTemplate
      title={copyText(bankLabels.Transfers)}
      description={copyText('rooms.move.available.quantities.between.spaces.or.to')}
      roomAction={
        <a className="lt-link" href="/bank">
          {nav.overview}
        </a>
      }
      state={{ kind: 'ready' }}
      step={
        <>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
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
                      <p>
                        <spaceCopy.Copy k="fromInvalid" />
                      </p>
                    )}
                    <div>
                      <Select
                        label={copyText('rooms.from.your.space')}
                        value={from?.id ?? ''}
                        onChange={(event) => setFrom(event.target.value)}
                        options={[
                          ['', copyText('rooms.choose.source')],
                          ...spaces
                            .filter((space) => currentSpace(spaces, space.id, userId ?? ''))
                            .map((space) => [space.id, spaceName(space)] as const),
                        ]}
                      />
                      <Select
                        label={copyText('rooms.destination')}
                        value={destination}
                        onChange={(event) => setDestination(event.target.value as 'space' | 'user')}
                        options={[
                          ['space', depth.t('toYourSpace')],
                          ['user', depth.t('toPerson')],
                        ]}
                      />
                      {destination === 'user' && (
                        <>
                          <TransferRecipient value={recipient} onChange={setRecipient} />
                          <p className="lt-hint">{depth.t('personNote')}</p>
                        </>
                      )}
                      {destination === 'space' && (
                        <p className="lt-hint">
                          {from && ownSpaces(spaces, from, userId ?? '').length === 0 ? depth.t('noOtherSpace') : depth.t('spaceNote')}
                        </p>
                      )}
                      <Field
                        label={depth.t('noteField')}
                        name="note"
                        value={note}
                        disabled={scheduled}
                        autoComplete="off"
                        onChange={(event) => setNote(event.target.value)}
                        aria-invalid={Boolean(noteWords)}
                        hint={scheduled ? depth.t('messageScheduledReason') : (noteWords ?? depth.t('noteHint'))}
                      />
                      <Field
                        label={depth.t('referenceField')}
                        name="reference"
                        value={reference}
                        disabled={scheduled}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        onChange={(event) => setReference(event.target.value)}
                        aria-invalid={Boolean(referenceWords)}
                        hint={scheduled ? depth.t('messageScheduledReason') : (referenceWords ?? depth.t('referenceHint'))}
                      />
                      <Checkbox
                        label={<Text k="rooms.repeat.on.a.schedule" />}
                        checked={scheduled}
                        onChange={(event) => setScheduled(event.target.checked)}
                      />
                      <Button
                        tone="primary"
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
                    {copyText('rooms.create.a.space.or.name.an.existing')}
                  </NoRows>
                );
              }}
            </ResourceView>
            <PlanRule plan={plan} />
          </Section>
          <BankRailSend />
          <Schedules open={open} />
        </>
      }
    />
  );
}

/** The way into the direct debits room from Transfers. */
function DirectDebitsLink() {
  const { t } = directDebitsCopy.useCopy();
  return (
    <p>
      <a className="lt-link" href="/bank/direct-debits">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
  );
}
/** The way into the money calendar from Transfers. */
function CalendarLink() {
  const { t } = calendarCopy.useCopy();
  return (
    <p>
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
    <p>
      <a className="lt-link" href="/bank/rules">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
  );
}
