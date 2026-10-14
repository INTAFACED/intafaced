'use client';
/**
 * One person, opened beside the list (a wide screen) or on its own (a phone). Above the fold: who they are, whose move it is,
 * the action bar, then their answers beside the next action. Below: one timeline, then the records and controls.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, TooltipProvider, cn } from '@intafaced/ui';
import { crmDate, crmJson, workflowUrl } from '@/lib/crm-browser';
import { detailNotices, RETAINED_EDITS_NOTICE, RETENTION_BLOCKED_NOTICE } from '@/lib/crm-notices';
import { signInHref } from '@/lib/crm-return';
import { clearDraft, browserDraftStorage } from '@/lib/crm-drafts';
import type { crmMessagePageSchema } from '@intafaced/contracts';
import { CrmEnquiryTasks } from '../crm-workflows';
import { CrmMessages } from '../crm-messages';
import { CrmPrivacy } from '../crm-privacy';
import { founderName, type FounderOwner } from '../founder-names';
import { answersFor } from './answers';
import { handOverInput, markRepliedInput, nextStepInput, otherFounder, quickDue } from './actions';
import { AnswersColumn, FullAnswers, IdentityBar, NextActionColumn, Timeline } from './person-parts';
import { CommitmentSheet, DeclineSheet, NextStepSheet, ReplySheet, StageSheet } from './person-sheets';
import type { PersonApi } from './use-person';
import { sourceValue } from './use-row-info';
import { buildTimeline, type TimelineMessage } from './timeline';
import { Notice, TextButton } from './ui';
import { REPLY_FOLLOW_UP_DAYS_DEFAULT } from './policy';

type SheetId = 'reply' | 'next' | 'decline' | 'stage' | 'commitment';
type RecordId = 'answers' | 'contact' | 'tasks' | 'messages' | 'privacy';
const RECORD_TITLE: Record<RecordId, string> = {
  answers: 'Full answers',
  contact: 'Original contact and consent',
  tasks: 'Follow-up tasks',
  messages: 'Messages',
  privacy: 'Privacy and contact controls',
};
type MessagePage = (typeof crmMessagePageSchema)['_output'];

/** A short message at the bottom of the screen, with at most one action (Undo, Change). It goes after eight seconds. */
function ToastBar({
  toast,
  onDismiss,
}: {
  toast: { text: string; action?: { label: string; run: () => void } } | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 min-[900px]:bottom-6">
      <div
        role="status"
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border border-line-popup bg-panel px-4 py-3 text-base text-fg shadow-menu"
      >
        <span className="min-w-0">{toast.text}</span>
        {toast.action ? (
          <TextButton
            onClick={() => {
              toast.action?.run();
              onDismiss();
            }}
          >
            {toast.action.label}
          </TextButton>
        ) : null}
      </div>
    </div>
  );
}

function useTimelineMessages(opportunityId: string | undefined, revision: number | undefined): TimelineMessage[] {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  useEffect(() => {
    if (!opportunityId) return;
    let live = true;
    crmJson<MessagePage>(workflowUrl('listMessages', { opportunityId, limit: 50 }))
      .then((page) => {
        if (live) setMessages(page.items);
      })
      .catch(() => {
        // The timeline still shows every activity; only the message texts are missing.
      });
    return () => {
      live = false;
    };
  }, [opportunityId, revision]);
  return opportunityId ? messages : [];
}

export function PersonView({
  person,
  csrf,
  userId,
  owners,
  origin,
  now,
  onBack,
  onExport,
  onWritten,
}: {
  person: PersonApi;
  csrf: string;
  userId: string;
  owners: FounderOwner[];
  /** Where "← " goes back to: Inbox, Raise or People. */
  origin: string;
  now: number;
  onBack: () => void;
  onExport: () => void;
  onWritten: () => Promise<void> | void;
}) {
  const detail = person.detail;
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [openRecords, setOpenRecords] = useState<ReadonlySet<RecordId>>(new Set());
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const dismiss = () => setToast(null);
  const messages = useTimelineMessages(detail?.opportunity.id, detail?.opportunity.revision);

  const hint = person.sheetHint;
  useEffect(() => {
    if (!hint) return;
    if (hint === 'note') composer.current?.focus({ preventScroll: false });
    else setSheet(hint);
    person.clearSheetHint();
  }, [hint, person]);

  if (!detail) return null;
  const { opportunity } = detail;
  const id = opportunity.id;
  const closed = opportunity.stage === 'closed';
  const investor = opportunity.audience === 'investor';
  const founder = founderName(owners, opportunity.ownerUserId);
  const me = founderName(owners, userId);
  const meKnown = owners.some((owner) => owner.userId === userId);
  const other = otherFounder(owners, opportunity.ownerUserId);
  const answers = answersFor(detail.submission, opportunity.audience);
  const source = sourceValue(detail.provenance.firstKnownSource?.campaign?.name, detail.provenance.latestKnownSource?.campaign?.name);
  const timeline = buildTimeline({ activities: detail.activities, messages, owners });
  const staleDraft = person.staleDraft;

  const kinds = detailNotices({
    error: person.error?.message ?? '',
    errorKind: person.error?.kind ?? 'other',
    notice: person.notice,
    stale: staleDraft,
    dirty: person.dirty,
    blocked: person.leaveBlocked,
  });

  const afterWorkflowSave = async () => {
    const refreshed = await person.open(id, false, false, false, true, true);
    await onWritten();
    return refreshed;
  };

  /* ---- actions ---- */
  async function markReplied(options: { reason?: string; description?: string; days?: number } = {}) {
    const checked = markRepliedInput({ opportunityId: id, expectedRevision: person.expectedRevision, ...options });
    if (!checked.ok) {
      person.setError({ message: checked.error, kind: 'other' });
      return;
    }
    const days = options.days ?? REPLY_FOLLOW_UP_DAYS_DEFAULT;
    const ok = await person.write('workflows', 'recordInteraction', checked.input, { notice: '' });
    if (!ok) return;
    setSheet(null);
    setToast({
      text: `Marked replied. Next: ${checked.input.nextAction.description}, due in ${days} days.`,
      action: { label: 'Change', run: () => setSheet('next') },
    });
  }
  async function handOver() {
    if (!other) return;
    const previous = opportunity.ownerUserId;
    const ok = await person.write(
      'crm',
      'assign',
      handOverInput({ opportunityId: id, expectedRevision: person.expectedRevision, ownerUserId: other.userId }),
      {
        notice: '',
      },
    );
    if (!ok) return;
    setToast({
      text: `Handed to ${other.displayName}.`,
      action: {
        label: 'Undo',
        run: () => {
          const latest = person.detail;
          if (!latest) return;
          void person.write(
            'crm',
            'assign',
            handOverInput({ opportunityId: latest.opportunity.id, expectedRevision: latest.opportunity.revision, ownerUserId: previous }),
            {
              notice: `Handed back to ${founderName(owners, previous)}.`,
            },
          );
        },
      },
    });
  }
  function openRecord(record: RecordId) {
    setOpenRecords((current) => new Set([...current, record]));
    requestAnimationFrame(() => {
      const element = document.getElementById(`crm-record-${record}`);
      element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      element?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    });
  }
  function recordDetails(record: RecordId, body: ReactNode) {
    return (
      <details
        key={record}
        id={`crm-record-${record}`}
        open={openRecords.has(record)}
        onToggle={(event) => {
          const isOpen = event.currentTarget.open;
          setOpenRecords((current) => {
            if (current.has(record) === isOpen) return current;
            const next = new Set(current);
            if (isOpen) next.add(record);
            else next.delete(record);
            return next;
          });
        }}
        className="group border-b border-line last:border-b-0"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-base font-medium text-fg outline-none marker:hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime [&::-webkit-details-marker]:hidden">
          {RECORD_TITLE[record]}
          <span aria-hidden="true" className="text-fg-3 transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="pb-4">{body}</div>
      </details>
    );
  }

  /* ---- pieces ---- */
  const notices = (
    <div className="flex flex-col gap-2">
      {person.discardQuestion ? (
        <Notice
          tone="warn"
          role="alertdialog"
          aria-label="Discard unsaved edits"
          data-testid="discard-bar"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              person.answerDiscard(false);
            }
          }}
          actions={
            <>
              <Button variant="secondary" size={32} autoFocus onClick={() => person.answerDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="secondary" size={32} onClick={() => person.answerDiscard(true)}>
                Discard
              </Button>
            </>
          }
        >
          {person.discardQuestion.prompt}
        </Notice>
      ) : null}
      {person.remoteChange ? (
        <Notice
          tone={person.remoteChange.applied ? 'info' : 'warn'}
          role={person.remoteChange.applied ? 'status' : 'alert'}
          data-testid="remote-change"
          actions={
            person.remoteChange.applied ? undefined : (
              <Button variant="secondary" size={32} disabled={person.busy} onClick={() => void person.refresh()}>
                Reload
              </Button>
            )
          }
        >
          {person.remoteChange.by} changed this enquiry. {person.remoteChange.applied ? 'It has been updated here.' : 'Reload to see it.'}
        </Notice>
      ) : null}
      {kinds.map((kind) => {
        if (kind === 'error' && person.error)
          return (
            <Notice
              key={kind}
              tone="danger"
              role="alert"
              actions={
                person.error.kind === 'session' ? (
                  <a
                    className="inline-flex min-h-8 items-center text-sm font-medium text-fg underline underline-offset-4"
                    href={signInHref(id)}
                  >
                    Sign in
                  </a>
                ) : person.error.kind === 'conflict' ? (
                  <Button variant="secondary" size={32} disabled={person.busy} onClick={() => void person.refresh()}>
                    Reload this enquiry
                  </Button>
                ) : undefined
              }
            >
              {person.error.message}
            </Notice>
          );
        if (kind === 'blocked')
          return (
            <Notice key={kind} tone="warn" role="alert">
              {RETENTION_BLOCKED_NOTICE}
            </Notice>
          );
        if (kind === 'stale' || kind === 'stale_refused')
          return (
            <Notice
              key={kind}
              tone="warn"
              role="alert"
              data-testid="stale-draft-warning"
              actions={
                <Button variant="secondary" size={32} disabled={person.busy} onClick={() => void person.refresh()}>
                  Discard my edits and reload
                </Button>
              }
            >
              {kind === 'stale_refused' ? <strong className="font-semibold">Your save was refused. </strong> : null}
              <strong className="font-semibold">This enquiry has changed since you wrote these edits.</strong> Saving will be refused, so
              nothing newer is overwritten. Copy anything you want to keep, then discard the edits to load the latest version.
            </Notice>
          );
        if (kind === 'notice')
          return (
            <Notice key={kind} tone="ok" role="status">
              {person.notice}
            </Notice>
          );
        return (
          <Notice
            key={kind}
            role="status"
            actions={
              <Button variant="secondary" size={32} disabled={person.busy} onClick={() => person.resetDraft()}>
                Discard my edits
              </Button>
            }
          >
            {RETAINED_EDITS_NOTICE}
          </Notice>
        );
      })}
    </div>
  );

  const replyButtonLabel = 'Reply';
  const actionButton =
    'max-[899px]:h-auto max-[899px]:min-h-11 max-[899px]:flex-1 max-[899px]:px-2 max-[899px]:py-1 max-[899px]:whitespace-normal max-[899px]:text-xs max-[899px]:leading-tight';
  const actionBar = (
    <div
      role="toolbar"
      aria-label="Actions for this person"
      className={cn(
        'flex flex-wrap items-center gap-2',
        'max-[899px]:fixed max-[899px]:inset-x-0 max-[899px]:bottom-0 max-[899px]:z-40 max-[899px]:flex-nowrap max-[899px]:gap-1.5 max-[899px]:border-t max-[899px]:border-line max-[899px]:bg-panel max-[899px]:px-3 max-[899px]:pt-2 max-[899px]:pb-[max(8px,env(safe-area-inset-bottom))]',
      )}
    >
      <Button variant="primary" size={40} className={actionButton} onClick={() => setSheet('reply')}>
        {replyButtonLabel}
      </Button>
      <Button variant="secondary" size={40} className={actionButton} disabled={closed || person.busy} onClick={() => void markReplied()}>
        Mark replied
      </Button>
      {other ? (
        <Button variant="secondary" size={40} className={actionButton} disabled={person.busy} onClick={() => void handOver()}>
          Hand to {other.displayName}
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="secondary"
              size={40}
              aria-label="More actions"
              className={cn(actionButton, 'max-[899px]:flex-none max-[899px]:px-4')}
            />
          }
        >
          ⋯
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem disabled={closed} onClick={() => setSheet('next')}>
            Next step
          </MenuItem>
          <MenuItem disabled={closed} onClick={() => setSheet('decline')}>
            Decline
          </MenuItem>
          <MenuItem onClick={() => setSheet('stage')}>Stage</MenuItem>
          {investor ? <MenuItem onClick={() => setSheet('commitment')}>Commitment</MenuItem> : null}
          <MenuItem onClick={() => composer.current?.focus()}>Add a note</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => openRecord('answers')}>Full answers</MenuItem>
          <MenuItem onClick={() => openRecord('contact')}>Original contact and consent</MenuItem>
          <MenuItem onClick={() => openRecord('tasks')}>Tasks</MenuItem>
          <MenuItem onClick={() => openRecord('messages')}>Messages</MenuItem>
          <MenuItem onClick={() => openRecord('privacy')}>Privacy</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={onExport}>Export</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );

  return (
    <TooltipProvider>
      <article aria-label="Enquiry" className="flex min-w-0 flex-col gap-4 max-[899px]:pb-24">
        <div>
          <Button variant="ghost" size={32} className="-ml-3 max-[600px]:min-h-11" onClick={onBack}>
            ← {origin}
          </Button>
        </div>
        {notices}
        <IdentityBar detail={detail} founder={founder} now={now} headingRef={person.headingRef} />
        {actionBar}
        <div className="grid gap-6 border-t border-line pt-4 min-[900px]:grid-cols-2">
          <AnswersColumn detail={detail} answers={answers} source={source} />
          <NextActionColumn
            detail={detail}
            now={now}
            owners={owners}
            founder={founder}
            otherName={other?.displayName ?? null}
            busy={person.busy || closed}
            onChange={() => setSheet('next')}
            onHandOver={() => void handOver()}
            onCommitment={() => setSheet('commitment')}
          />
        </div>
        <div className="border-t border-line pt-4">
          <Timeline
            items={timeline}
            note={person.fields.note}
            onNote={person.fields.setNote}
            onAddNote={() => void person.write('crm', 'addNote', { opportunityId: id, note: person.fields.note }, { savedWithBase: false })}
            busy={person.busy}
            composerRef={composer}
          />
        </div>
        <div className="border-t border-line pt-2">
          {recordDetails('answers', <FullAnswers detail={detail} />)}
          {recordDetails(
            'contact',
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-base font-medium text-fg">{detail.submission.contact.name}</p>
              <p className="break-all text-fg">{detail.submission.contact.email}</p>
              <p className="text-fg-2">
                Interested in:{' '}
                {detail.submission.contact.interests.map((interest) => interest.charAt(0).toUpperCase() + interest.slice(1)).join(', ')} ·
                news emails: {detail.submission.contact.marketingOptIn ? 'agreed' : 'not agreed'}
              </p>
              {detail.provenance.originalContact.id !== detail.provenance.canonicalContact.id ? (
                <p className="text-fg-2">
                  This enquiry is linked to {detail.provenance.canonicalContact.name} (the main contact). The original contact details and
                  answers are kept.
                </p>
              ) : null}
              <p className="text-fg-2">We have not confirmed who owns this email address.</p>
              <p className="text-fg-3">Received {crmDate(detail.submission.capturedAt)}.</p>
            </div>,
          )}
          {recordDetails(
            'tasks',
            <div className="adm-workspace">
              <CrmEnquiryTasks
                key={`tasks:${id}`}
                csrf={csrf}
                opportunity={opportunity}
                expectedRevision={person.expectedRevision}
                staleDraft={staleDraft}
                owners={owners}
                onSaved={afterWorkflowSave}
              />
            </div>,
          )}
          {recordDetails(
            'messages',
            <div className="adm-workspace">
              <CrmMessages
                key={`messages:${id}:${person.messagesResetVersion}`}
                csrf={csrf}
                opportunity={opportunity}
                expectedRevision={person.expectedRevision}
                staleDraft={staleDraft}
                originalRecipient={detail.submission.contact}
                owners={owners}
                onDraftChange={person.setMessageDraftDirty}
                initialDraft={person.messageValues}
                onDraftValues={person.setMessageValues}
                onSaved={afterWorkflowSave}
              />
              {detail.deliveries && detail.deliveries.length > 0 ? (
                <section className="mt-4 text-sm">
                  <h4 className="font-semibold">Confirmation email</h4>
                  {detail.deliveries.map((delivery, index) => (
                    <p key={index} className="text-fg-2">
                      {deliveryWords(delivery)}
                    </p>
                  ))}
                </section>
              ) : null}
            </div>,
          )}
          {recordDetails(
            'privacy',
            <div className="adm-workspace">
              <CrmPrivacy
                key={`privacy:${detail.provenance.canonicalContact.id}:${person.privacyResetVersion}`}
                csrf={csrf}
                canonicalContact={detail.provenance.canonicalContact}
                canonicalRevision={detail.provenance.canonicalRevision}
                owners={owners}
                onDraftState={person.onRetentionDraftState}
                onComplete={async () => {
                  clearDraft(browserDraftStorage(), id);
                  person.forget();
                  person.setNotice('Linked contact records deleted from outreach.');
                  await onWritten();
                }}
              />
            </div>,
          )}
        </div>
      </article>

      <ReplySheet
        key={`reply:${id}`}
        open={sheet === 'reply'}
        onOpenChange={(open) => setSheet(open ? 'reply' : null)}
        detail={detail}
        founder={meKnown ? me : null}
        busy={person.busy}
        onMarkReplied={(options) => void markReplied(options)}
      />
      <NextStepSheet
        open={sheet === 'next'}
        onOpenChange={(open) => {
          setSheet(open ? 'next' : null);
          if (!open) person.resetNextStepForm();
        }}
        detail={detail}
        busy={person.busy}
        stale={staleDraft}
        description={person.fields.editDescription}
        due={person.fields.editDue}
        onDescription={person.fields.setEditDescription}
        onDue={person.fields.setEditDue}
        onSave={async ({ description, due }) => {
          const checked = nextStepInput({ opportunityId: id, expectedRevision: person.expectedRevision, description, due });
          if (!checked.ok) return;
          if (await person.write('crm', 'updateNextAction', checked.input)) setSheet(null);
        }}
      />
      <DeclineSheet
        key={`decline:${id}`}
        open={sheet === 'decline'}
        onOpenChange={(open) => setSheet(open ? 'decline' : null)}
        detail={detail}
        founder={meKnown ? me : null}
        busy={person.busy}
        onClose={async (checked) => {
          const input = { ...checked.input, expectedRevision: person.expectedRevision };
          if (await person.write('crm', 'changeStage', input, { notice: 'Enquiry closed.' })) setSheet(null);
        }}
      />
      <StageSheet
        open={sheet === 'stage'}
        onOpenChange={(open) => {
          setSheet(open ? 'stage' : null);
          if (!open) person.resetStageForm();
        }}
        detail={detail}
        busy={person.busy}
        stale={staleDraft}
        fields={person.fields}
        onSave={async (checked) => {
          const input = { ...checked.input, expectedRevision: person.expectedRevision };
          if (await person.write('crm', 'changeStage', input)) setSheet(null);
        }}
      />
      {investor ? (
        <CommitmentSheet
          key={`commitment:${id}:${opportunity.revision}`}
          open={sheet === 'commitment'}
          onOpenChange={(open) => setSheet(open ? 'commitment' : null)}
          detail={detail}
          busy={person.busy}
          onSave={async (checked) => {
            const input = { ...checked.input, expectedRevision: person.expectedRevision };
            if (
              await person.write('workflows', 'setCommitment', input, {
                notice: input.commitment ? 'Commitment saved.' : 'Commitment cleared.',
              })
            )
              setSheet(null);
          }}
        />
      ) : null}
      <ToastBar toast={toast} onDismiss={dismiss} />
    </TooltipProvider>
  );
}

function deliveryWords(delivery: { status: string; errorCode: string | null }): string {
  if (delivery.status === 'unconfigured' || /unconfigured/.test(delivery.errorCode ?? '')) return 'Not set up yet';
  switch (delivery.status) {
    case 'pending':
      return 'Saved, not emailed yet';
    case 'accepted':
      return 'Handed to the email service';
    case 'delivered':
      return 'Delivered';
    case 'failed':
      return 'Sending failed';
    case 'unresolved':
      return 'Unclear whether it was sent';
    default:
      return delivery.status;
  }
}
