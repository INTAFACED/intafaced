'use client';
/** Pieces of the person's page: the identity bar, the two answer columns, the timeline and the closed-enquiry summary. */
import { useState } from 'react';
import { Button, cn } from '@intafaced/ui';
import { crmDate } from '@/lib/crm-browser';
import { describeDue } from '@/lib/crm-due';
import type { CrmActivity } from '@intafaced/contracts';
import { allFacts, keyFacts, messageOf, type Answers } from './answers';
import { TIER_HELP, TIER_LABEL, tierOf } from './actions';
import { audienceLabel, countryName, formatMoney, stageLabel } from './format';
import { DISPOSITION_LABEL, type Disposition } from './policy';
import { waitingState } from './queue';
import { WaitCell } from './inbox-row';
import type { Detail } from './request';
import type { TimelineItem } from './timeline';
import { FieldLabel, OwnerInitial, Tag, TextArea } from './ui';

/** Why a closed enquiry was closed: the reason from the stage change that closed it. */
export function closeReason(activities: ReadonlyArray<Pick<CrmActivity, 'kind' | 'toStage' | 'note' | 'sequence'>>): string | null {
  const stageChanges = activities.filter((activity) => activity.kind === 'stage_changed' && activity.note);
  const closing = stageChanges.filter((activity) => activity.toStage === 'closed');
  const pool = closing.length ? closing : stageChanges;
  const latest = pool.reduce<(typeof pool)[number] | null>(
    (best, activity) => (!best || activity.sequence > best.sequence ? activity : best),
    null,
  );
  return latest?.note ?? null;
}

const emailText = (status: string) => (status === 'verified' ? 'Email verified' : 'Email not verified');

/** Name, organisation, country, an audience tag for each interest, then whose move it is, the owner, the stage and the tier. */
export function IdentityBar({
  detail,
  founder,
  now,
  headingRef,
}: {
  detail: Detail;
  founder: string;
  now: number;
  headingRef: React.RefObject<HTMLElement | null>;
}) {
  const { opportunity, contact, submission } = detail;
  const organisation = detail.organisation?.name ?? submission.contact.organisationName ?? null;
  const country = (submission.contact.country ? [submission.contact.country] : (detail.organisation?.countries ?? [])).map(countryName);
  const state = waitingState(opportunity, now);
  const tier = opportunity.audience === 'investor' ? tierOf(opportunity) : null;
  const disposition = opportunity.closedDisposition;
  return (
    <div className="flex flex-col gap-2.5">
      <div
        id="crm-detail-heading"
        ref={headingRef as React.RefObject<HTMLDivElement>}
        tabIndex={-1}
        role="region"
        aria-label="Selected enquiry"
        className="flex min-w-0 flex-col gap-1 outline-none"
      >
        <h2 className="text-xl font-semibold break-words text-fg">{contact.name}</h2>
        <p className="text-base text-fg-2">
          {organisation ? <span className="text-fg">{organisation}</span> : 'No organisation given'}
          {' · '}
          {country.length ? country.join(', ') : 'No country given'}
          {' · '}
          {emailText(contact.emailEvidence.status)}
        </p>
        <div className="flex flex-wrap gap-1.5" aria-label="Interested in">
          {contact.interests.map((interest) => (
            <Tag key={interest}>{audienceLabel(interest)}</Tag>
          ))}
          {opportunity.audience && contact.interests.length > 1 ? (
            <span className="self-center text-xs text-fg-3">This enquiry: {audienceLabel(opportunity.audience)}</span>
          ) : null}
        </div>
      </div>
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <dt className="text-fg-3">{state.kind === 'closed' ? 'State' : 'Waiting'}</dt>
          <dd className="flex items-center gap-2 text-fg">
            {state.kind === 'us' ? <WaitCell since={opportunity.waitingSince} audience={opportunity.audience} now={now} /> : null}
            <span>
              {state.kind === 'closed'
                ? `Closed${disposition ? `: ${DISPOSITION_LABEL[disposition as Disposition] ?? disposition}` : ''}`
                : state.headline}
            </span>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-fg-3">Owner</dt>
          <dd className="flex items-center gap-1.5 text-fg">
            <OwnerInitial name={founder} />
            {founder}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-fg-3">Stage</dt>
          <dd>
            <Tag dot>{stageLabel(opportunity.stage)}</Tag>
          </dd>
        </div>
        {tier ? (
          <div className="flex items-center gap-2">
            <dt className="text-fg-3">Tier</dt>
            <dd>
              <Tag title={TIER_HELP[tier]}>{TIER_LABEL[tier]}</Tag>
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/** Their answers: the key facts for the audience, then their own message, quoted. */
export function AnswersColumn({ detail, answers, source }: { detail: Detail; answers: Answers | null; source: string | null }) {
  const audience = detail.opportunity.audience;
  const facts = keyFacts(audience, answers);
  const message = messageOf(answers);
  return (
    <section aria-labelledby="crm-answers-heading" className="min-w-0">
      <h3 id="crm-answers-heading" className="mb-2 text-md font-semibold text-fg">
        Their answers
      </h3>
      {facts.length === 0 && !source && !message ? (
        <p className="text-sm text-fg-2">They have not answered the questions yet.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-base">
          {facts.map((fact) => (
            <div key={fact.key} className="contents">
              <dt className="text-fg-2">{fact.label}</dt>
              <dd className={cn('min-w-0 break-words tabular-nums', fact.selfReported ? 'text-fg-2' : 'text-fg')}>
                {fact.value}
                {fact.selfReported ? <span className="ml-1.5 text-xs text-fg-3">self-reported</span> : null}
              </dd>
            </div>
          ))}
          {source ? (
            <div className="contents">
              <dt className="text-fg-2">Source</dt>
              <dd className="min-w-0 break-words text-fg">{source}</dd>
            </div>
          ) : null}
        </dl>
      )}
      {message ? (
        <blockquote className="m-0 mt-3 border-l-2 border-line-strong pl-3 text-base whitespace-pre-wrap text-fg">{message}</blockquote>
      ) : null}
    </section>
  );
}

/** Everything they answered, in plain words (the "Full answers" record). */
export function FullAnswers({ detail }: { detail: Detail }) {
  return (
    <div className="flex flex-col gap-4">
      {detail.submission.questionnaires.length === 0 ? <p className="text-sm text-fg-2">No questionnaire answered yet.</p> : null}
      {detail.submission.questionnaires.map((questionnaire) => {
        const answers = questionnaire.answers as Answers;
        const facts = allFacts(answers);
        const message = messageOf(answers);
        return (
          <section key={questionnaire.audience}>
            <h4 className="mb-1.5 text-base font-semibold">{audienceLabel(questionnaire.audience)}</h4>
            <dl className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              {facts.map((fact) => (
                <div key={fact.key} className="contents">
                  <dt className="text-fg-2">{fact.label}</dt>
                  <dd className="min-w-0 break-words text-fg">{fact.value}</dd>
                </div>
              ))}
              {message ? (
                <div className="contents">
                  <dt className="text-fg-2">Message</dt>
                  <dd className="min-w-0 break-words whitespace-pre-wrap text-fg">{message}</dd>
                </div>
              ) : null}
            </dl>
          </section>
        );
      })}
      <p className="text-xs text-fg-3">
        {detail.submission.completedAt
          ? `Finished ${crmDate(detail.submission.completedAt)}.`
          : 'Partly answered: questionnaires not finished.'}
      </p>
    </div>
  );
}

/** The next action and its due wording. The closed outcome, the reason and the evidence take its place on a closed enquiry (G10). */
export function NextActionColumn({
  detail,
  now,
  owners,
  founder,
  otherName,
  busy,
  onChange,
  onHandOver,
  onCommitment,
}: {
  detail: Detail;
  now: number;
  owners: ReadonlyArray<{ userId: string; displayName: string }>;
  founder: string;
  otherName: string | null;
  busy: boolean;
  onChange: () => void;
  onHandOver: () => void;
  onCommitment: () => void;
}) {
  void owners;
  const { opportunity } = detail;
  const next = opportunity.nextAction;
  const due = next ? describeDue(next.dueAt, now) : null;
  const investor = opportunity.audience === 'investor';
  const commitment = investor ? opportunity.commitment : null;
  const stated = investor && opportunity.indicativeContribution.status === 'stated' ? opportunity.indicativeContribution : null;
  const reason = closeReason(detail.activities);
  return (
    <section aria-labelledby="crm-next-heading" className="flex min-w-0 flex-col gap-5">
      <div>
        <h3 id="crm-next-heading" className="mb-2 text-md font-semibold text-fg">
          {next ? 'Next action' : 'Outcome'}
        </h3>
        {next && due ? (
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-fg">{next.description}</p>
            <p className="text-sm text-fg-2">
              <span className={cn(due.overdue && 'font-medium text-lime')}>{due.overdue ?? due.when}</span>
              <span> · {crmDate(next.dueAt)}</span>
            </p>
            <div className="mt-1">
              <Button variant="secondary" size={32} disabled={busy} onClick={onChange}>
                Change
              </Button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-[minmax(0,90px)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-base">
            <dt className="text-fg-2">Closed as</dt>
            <dd className="text-fg">
              {opportunity.closedDisposition ? DISPOSITION_LABEL[opportunity.closedDisposition as Disposition] : 'Closed'}
            </dd>
            {reason ? (
              <>
                <dt className="text-fg-2">Reason</dt>
                <dd className="min-w-0 break-words text-fg">{reason}</dd>
              </>
            ) : null}
            {opportunity.closingEvidenceRef ? (
              <>
                <dt className="text-fg-2">Evidence</dt>
                <dd className="min-w-0 break-words text-fg">{opportunity.closingEvidenceRef}</dd>
              </>
            ) : null}
          </dl>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-md font-semibold text-fg">Owner</h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-base text-fg">
            <OwnerInitial name={founder} />
            {founder}
          </span>
          {otherName ? (
            <Button variant="ghost" size={32} disabled={busy} onClick={onHandOver}>
              Hand to {otherName}
            </Button>
          ) : null}
        </div>
      </div>
      {investor ? (
        <div>
          <h3 className="mb-2 text-md font-semibold text-fg">Commitment</h3>
          {commitment ? (
            <div className="flex flex-col gap-1">
              <p className="text-base font-medium text-fg tabular-nums">
                {TIER_LABEL[commitment.tier]} {formatMoney(commitment.amount, commitment.currency)}
              </p>
              <p className="text-sm text-fg-2">
                {TIER_HELP[commitment.tier]} Recorded {crmDate(commitment.recordedAt)}.
              </p>
              {commitment.evidenceRef ? <p className="text-sm text-fg-2">Note: {commitment.evidenceRef}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-fg-2">
              Indicated only{stated ? <> ({formatMoney(stated.amount, stated.currency)}, self-reported)</> : null}. No founder has confirmed
              an amount yet.
            </p>
          )}
          <div className="mt-2">
            <Button variant="secondary" size={32} disabled={busy} onClick={onCommitment}>
              {commitment ? 'Change commitment' : 'Record commitment'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const MARKER: Record<string, string> = {
  stage_changed: 'bg-fg-3',
  reply_sent: 'bg-fg',
  commitment_changed: 'bg-fg',
};

/** One chronological list. A note composer sits at the top. */
export function Timeline({
  items,
  note,
  onNote,
  onAddNote,
  busy,
  composerRef,
}: {
  items: TimelineItem[];
  note: string;
  onNote: (value: string) => void;
  onAddNote: () => void;
  busy: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 12);
  return (
    <section aria-labelledby="crm-timeline-heading" className="min-w-0">
      <h3 id="crm-timeline-heading" className="mb-3 text-md font-semibold text-fg">
        Timeline
      </h3>
      <form
        className="mb-4 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onAddNote();
        }}
      >
        <FieldLabel className="sr-only">Add a note</FieldLabel>
        <TextArea
          ref={composerRef}
          aria-label="Add a note"
          placeholder="Add a note for yourselves"
          rows={2}
          maxLength={2000}
          className="min-h-16"
          value={note}
          onChange={(event) => onNote(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" size={32} disabled={busy || !note.trim()}>
            Add note
          </Button>
        </div>
      </form>
      <ol className="flex flex-col">
        {shown.map((item) => (
          <li key={item.id} className="relative grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
            <span aria-hidden="true" className="relative flex justify-center">
              <span className="absolute top-2 bottom-[-16px] w-px bg-line" />
              <span className={cn('relative mt-1.5 size-2 rounded-full', MARKER[item.kind] ?? 'bg-fg-3')} />
            </span>
            <div className="min-w-0">
              <p className="text-base font-medium text-fg">{item.title}</p>
              <p className="text-xs text-fg-2">
                {crmDate(item.at)} · {item.who}
              </p>
              {item.detail ? <p className="mt-0.5 text-sm break-words whitespace-pre-wrap text-fg-2">{item.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {items.length > 12 && !all ? (
        <div className="mt-3">
          <Button variant="ghost" size={32} onClick={() => setAll(true)}>
            Show {items.length - 12} earlier
          </Button>
        </div>
      ) : null}
    </section>
  );
}
