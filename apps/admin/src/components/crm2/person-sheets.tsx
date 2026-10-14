'use client';
/**
 * The sheets behind the person's actions: Reply, Next step, Decline, Stage and Commitment. Each picks from chips, shows what it
 * will record before it records it, and sends nothing until its one main button is pressed. Lime marks that button, once per sheet.
 */
import { useMemo, useState } from 'react';
import { Button, buttonVariants } from '@intafaced/ui';
import { answersFor } from './answers';
import {
  commitmentInput,
  declineEvidence,
  declineInput,
  dispositionOf,
  nextStepInput,
  dueIso,
  pastDueWarning,
  quickDue,
  stageInput,
  TIER_HELP,
  TIER_LABEL,
  type Tier,
} from './actions';
import { formatMoney, stageLabel, stagesFor } from './format';
import {
  CLOSE_EVIDENCE_CHIPS,
  COMMITMENT_EVIDENCE_MAX,
  COMMITMENT_REASON_CHIPS,
  COMMON_CURRENCIES,
  DECLINE_REASONS,
  DEFAULT_COMMITMENT_CURRENCY,
  DISPOSITIONS,
  DISPOSITION_LABEL,
  DUE_CHIPS,
  LIMITS,
  NEXT_STEP_CHIPS,
  OTHER_REASON,
  REPLY_DUE_CHIPS,
  REPLY_FOLLOW_UP_DAYS_DEFAULT,
  REPLY_NEXT_ACTION_DEFAULT,
  REPLY_REASON_CHIPS,
  REPLY_REASON_DEFAULT,
  STAGE_REASON_CHIPS,
  type DeclineReason,
  type Disposition,
} from './policy';
import { DRAFT_HEADER, declineDraft, mailtoHref, replyDraft, type Draft } from './templates';
import { ChipRow, ChoiceChip, FieldLabel, Notice, Sheet, TextArea, TextField } from './ui';
import type { Detail } from './request';

const dayWords = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));

/** A message to copy or open in the founder's own email app. The wording is a draft until Nitro approves it. */
export function DraftBlock({ draft, email, onDraft }: { draft: Draft; email: string; onDraft: (draft: Draft) => void }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="warn" role="note">
        <strong className="font-semibold">{DRAFT_HEADER}</strong>
      </Notice>
      <div>
        <FieldLabel>To (the address they gave)</FieldLabel>
        <p className="text-base break-all text-fg">{email}</p>
      </div>
      <div>
        <FieldLabel>Subject</FieldLabel>
        <TextField aria-label="Subject" value={draft.subject} onChange={(event) => onDraft({ ...draft, subject: event.target.value })} />
      </div>
      <div>
        <FieldLabel>Text</FieldLabel>
        <TextArea
          aria-label="Reply text"
          rows={12}
          className="min-h-56 text-sm"
          value={draft.body}
          onChange={(event) => onDraft({ ...draft, body: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <a className={buttonVariants({ variant: 'secondary', size: 40 })} href={mailtoHref(email, draft)}>
          Open in my email app
        </a>
        <Button
          variant="secondary"
          size={40}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
              setCopied('yes');
            } catch {
              setCopied('no');
            }
          }}
        >
          Copy text
        </Button>
        <span role="status" className="self-center text-sm text-fg-2">
          {copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Copying is blocked here. Select the text and copy it by hand.' : ''}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ reply */

export function ReplySheet({
  open,
  onOpenChange,
  detail,
  founder,
  busy,
  onMarkReplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: Detail;
  founder: string | null;
  busy: boolean;
  onMarkReplied: (input: { reason: string; description: string; days: number }) => void;
}) {
  const audience = detail.opportunity.audience;
  const initial = useMemo(
    () =>
      replyDraft({
        audience,
        name: detail.submission.contact.name,
        founder,
        answers: answersFor(detail.submission, audience),
      }),
    [audience, detail.submission, founder],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reason, setReason] = useState<string>(REPLY_REASON_DEFAULT);
  const [description, setDescription] = useState<string>(REPLY_NEXT_ACTION_DEFAULT);
  const [days, setDays] = useState<number>(REPLY_FOLLOW_UP_DAYS_DEFAULT);
  const shown = draft ?? initial;
  const dueText = dayWords(dueIso(days));
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Reply"
      description="Send this from your own email app, then press Mark replied. Nothing is sent from here."
      wide
    >
      <DraftBlock draft={shown} email={detail.submission.contact.email} onDraft={setDraft} />
      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <p className="text-md font-medium">After you have sent it</p>
        <div>
          <FieldLabel>How you replied</FieldLabel>
          <ChipRow label="How you replied">
            {REPLY_REASON_CHIPS.map((chip) => (
              <ChoiceChip key={chip} selected={reason === chip} onClick={() => setReason(chip)}>
                {chip}
              </ChoiceChip>
            ))}
          </ChipRow>
        </div>
        <div>
          <FieldLabel>What happens next</FieldLabel>
          <ChipRow label="What happens next">
            {NEXT_STEP_CHIPS.map((chip) => (
              <ChoiceChip key={chip} selected={description === chip} onClick={() => setDescription(chip)}>
                {chip}
              </ChoiceChip>
            ))}
          </ChipRow>
        </div>
        <div>
          <FieldLabel>When</FieldLabel>
          <ChipRow label="When">
            {REPLY_DUE_CHIPS.map((chip) => (
              <ChoiceChip key={chip.label} selected={days === chip.days} onClick={() => setDays(chip.days)}>
                {chip.label}
              </ChoiceChip>
            ))}
          </ChipRow>
        </div>
        <p className="text-sm text-fg-2">
          This will record: {reason}, now. Next: {description}, due {dueText}.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" size={40} loading={busy} onClick={() => onMarkReplied({ reason, description, days })}>
            Mark replied
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ next step */

/** What happens next and when, from chips. Used by Next step and, for an open stage, by Stage. */
export function NextStepFields({
  description,
  due,
  onDescription,
  onDue,
  idPrefix,
}: {
  description: string;
  due: string;
  onDescription: (value: string) => void;
  onDue: (value: string) => void;
  idPrefix: string;
}) {
  const warning = pastDueWarning(due);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <FieldLabel>What happens next</FieldLabel>
        <ChipRow label="What happens next">
          {NEXT_STEP_CHIPS.map((chip) => (
            <ChoiceChip key={chip} selected={description === chip} onClick={() => onDescription(chip)}>
              {chip}
            </ChoiceChip>
          ))}
        </ChipRow>
        <TextField
          id={`${idPrefix}-description`}
          aria-label="Next step, in your own words"
          className="mt-2"
          maxLength={LIMITS.nextActionDescription}
          placeholder="Or write your own"
          value={description}
          onChange={(event) => onDescription(event.target.value)}
        />
      </div>
      <div>
        <FieldLabel>When (your local time)</FieldLabel>
        <ChipRow label="Quick due dates">
          {DUE_CHIPS.map((chip) => (
            <ChoiceChip key={chip.label} selected={due === quickDue(chip.days)} onClick={() => onDue(quickDue(chip.days))}>
              {chip.label}
            </ChoiceChip>
          ))}
        </ChipRow>
        <TextField
          id={`${idPrefix}-due`}
          aria-label="Due (your local time)"
          type="datetime-local"
          className="mt-2 max-w-64"
          value={due}
          onChange={(event) => onDue(event.target.value)}
        />
        {warning ? (
          <p role="status" className="mt-1 text-sm text-warn-text">
            {warning}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function NextStepSheet({
  open,
  onOpenChange,
  detail,
  busy,
  stale,
  description,
  due,
  onDescription,
  onDue,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: Detail;
  busy: boolean;
  stale: boolean;
  description: string;
  due: string;
  onDescription: (value: string) => void;
  onDue: (value: string) => void;
  onSave: (input: { description: string; due: string }) => void;
}) {
  const record = detail.opportunity.nextAction;
  const check = nextStepInput({ opportunityId: detail.opportunity.id, expectedRevision: detail.opportunity.revision, description, due });
  const unchanged = record && description.trim() === record.description && Date.parse(due) === Date.parse(record.dueAt);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Next step" description="Every open enquiry has one next step with a date.">
      <NextStepFields description={description} due={due} onDescription={onDescription} onDue={onDue} idPrefix="next" />
      {!check.ok && description.trim() === '' ? <p className="text-sm text-fg-2">{check.error}</p> : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size={40}
          loading={busy}
          disabled={!check.ok || Boolean(unchanged)}
          onClick={() => onSave({ description, due })}
        >
          {stale ? 'Save next step (will be refused)' : 'Save next step'}
        </Button>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ decline */

export function DeclineSheet({
  open,
  onOpenChange,
  detail,
  founder,
  busy,
  onClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: Detail;
  founder: string | null;
  busy: boolean;
  onClose: (input: ReturnType<typeof declineInput> & { ok: true }) => void;
}) {
  const [reason, setReason] = useState<DeclineReason>('Not a fit now');
  const [sent, setSent] = useState(true);
  const [drafts, setDrafts] = useState<Partial<Record<DeclineReason, Draft>>>({});
  const base = declineDraft(reason, { name: detail.submission.contact.name, founder });
  const draft = drafts[reason] ?? base;
  const disposition = dispositionOf(reason);
  const checked = declineInput({
    opportunityId: detail.opportunity.id,
    expectedRevision: detail.opportunity.revision,
    reason,
    founder,
    sentByEmail: sent,
  });
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Decline"
      description="Pick the reason, send the polite reply from your own email app, then close the enquiry."
      wide
    >
      <div>
        <FieldLabel>Reason</FieldLabel>
        <ChipRow label="Reason">
          {DECLINE_REASONS.map((entry) => (
            <ChoiceChip key={entry.label} selected={reason === entry.label} onClick={() => setReason(entry.label)}>
              {entry.label}
            </ChoiceChip>
          ))}
        </ChipRow>
      </div>
      <DraftBlock
        draft={draft}
        email={detail.submission.contact.email}
        onDraft={(next) => setDrafts((current) => ({ ...current, [reason]: next }))}
      />
      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <div>
          <FieldLabel>What to record</FieldLabel>
          <ChipRow label="What to record">
            <ChoiceChip selected={sent} onClick={() => setSent(true)}>
              I sent the reply by email
            </ChoiceChip>
            <ChoiceChip selected={!sent} onClick={() => setSent(false)}>
              Close without a reply
            </ChoiceChip>
          </ChipRow>
        </div>
        <p className="text-sm text-fg-2">
          This will record: {DISPOSITION_LABEL[disposition]} ({reason}). Evidence: {declineEvidence({ founder, sentByEmail: sent })}.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" size={40} loading={busy} disabled={!checked.ok} onClick={() => checked.ok && onClose(checked)}>
            Close as {DISPOSITION_LABEL[disposition].toLowerCase()}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ stage */

export function StageSheet({
  open,
  onOpenChange,
  detail,
  busy,
  stale,
  fields,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: Detail;
  busy: boolean;
  stale: boolean;
  fields: {
    newStage: string;
    setNewStage: (value: string) => void;
    reason: string;
    setReason: (value: string) => void;
    evidence: string;
    setEvidence: (value: string) => void;
    actionDescription: string;
    setActionDescription: (value: string) => void;
    actionDue: string;
    setActionDue: (value: string) => void;
    disposition: Disposition;
    setDisposition: (value: Disposition) => void;
  };
  onSave: (input: ReturnType<typeof stageInput> & { ok: true }) => void;
}) {
  const [other, setOther] = useState(false);
  const closing = fields.newStage === 'closed';
  const checked = stageInput({
    opportunityId: detail.opportunity.id,
    expectedRevision: detail.opportunity.revision,
    stage: fields.newStage,
    reason: fields.reason,
    actionDescription: fields.actionDescription,
    actionDue: fields.actionDue,
    disposition: fields.disposition,
    evidence: fields.evidence,
  });
  const changed = fields.newStage !== detail.opportunity.stage;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Stage"
      description={`Now: ${stageLabel(detail.opportunity.stage)}. Pick a stage and why.`}
    >
      <div>
        <FieldLabel>Move to</FieldLabel>
        <ChipRow label="Stage">
          {stagesFor(detail.opportunity.audience).map((stage) => (
            <ChoiceChip key={stage} selected={fields.newStage === stage} onClick={() => fields.setNewStage(stage)}>
              {stageLabel(stage)}
              {stage === detail.opportunity.stage ? <span className="text-2xs text-fg-3">now</span> : null}
            </ChoiceChip>
          ))}
        </ChipRow>
      </div>
      <div>
        <FieldLabel>Why</FieldLabel>
        <ChipRow label="Why">
          {STAGE_REASON_CHIPS.map((chip) => (
            <ChoiceChip
              key={chip}
              selected={!other && fields.reason === chip}
              onClick={() => {
                setOther(false);
                fields.setReason(chip);
              }}
            >
              {chip}
            </ChoiceChip>
          ))}
          <ChoiceChip
            selected={other}
            onClick={() => {
              setOther(true);
              fields.setReason('');
            }}
          >
            {OTHER_REASON}
          </ChoiceChip>
        </ChipRow>
        {other ? (
          <TextField
            aria-label="Reason, in your own words"
            className="mt-2"
            maxLength={LIMITS.reason}
            value={fields.reason}
            autoFocus
            onChange={(event) => fields.setReason(event.target.value)}
          />
        ) : null}
      </div>
      {closing ? (
        <>
          <div>
            <FieldLabel>Outcome</FieldLabel>
            <ChipRow label="Outcome">
              {DISPOSITIONS.map((value) => (
                <ChoiceChip key={value} selected={fields.disposition === value} onClick={() => fields.setDisposition(value)}>
                  {DISPOSITION_LABEL[value]}
                </ChoiceChip>
              ))}
            </ChipRow>
          </div>
          <div>
            <FieldLabel>Evidence</FieldLabel>
            <ChipRow label="Evidence">
              {CLOSE_EVIDENCE_CHIPS.map((chip) => (
                <ChoiceChip key={chip} selected={fields.evidence === chip} onClick={() => fields.setEvidence(chip)}>
                  {chip}
                </ChoiceChip>
              ))}
            </ChipRow>
            <TextField
              aria-label="Evidence, in your own words"
              className="mt-2"
              maxLength={LIMITS.closingEvidence}
              placeholder="Or write your own"
              value={fields.evidence}
              onChange={(event) => fields.setEvidence(event.target.value)}
            />
          </div>
        </>
      ) : (
        <NextStepFields
          description={fields.actionDescription}
          due={fields.actionDue}
          onDescription={fields.setActionDescription}
          onDue={fields.setActionDue}
          idPrefix="stage"
        />
      )}
      {!checked.ok && fields.reason.trim() ? <p className="text-sm text-fg-2">{checked.error}</p> : null}
      <div className="flex justify-end">
        <Button variant="primary" size={40} loading={busy} disabled={!checked.ok || !changed} onClick={() => checked.ok && onSave(checked)}>
          {changed ? `Move to ${stageLabel(fields.newStage)}` : 'Pick a different stage'}
          {stale ? ' (will be refused)' : ''}
        </Button>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ commitment */

export function CommitmentSheet({
  open,
  onOpenChange,
  detail,
  busy,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: Detail;
  busy: boolean;
  onSave: (input: ReturnType<typeof commitmentInput> & { ok: true }) => void;
}) {
  const current = detail.opportunity.audience === 'investor' ? detail.opportunity.commitment : null;
  const stated =
    detail.opportunity.audience === 'investor' && detail.opportunity.indicativeContribution.status === 'stated'
      ? detail.opportunity.indicativeContribution
      : null;
  const [tier, setTier] = useState<Tier>(current?.tier ?? 'soft_circled');
  const [amount, setAmount] = useState(current?.amount ?? '');
  const [currency, setCurrency] = useState(current?.currency ?? stated?.currency ?? DEFAULT_COMMITMENT_CURRENCY);
  const [evidence, setEvidence] = useState(current?.evidenceRef ?? '');
  const [reason, setReason] = useState('');
  const [other, setOther] = useState(false);
  const checked = commitmentInput({
    opportunityId: detail.opportunity.id,
    expectedRevision: detail.opportunity.revision,
    tier,
    amount,
    currency,
    evidence,
    reason,
  });
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Commitment"
      description="What a founder has confirmed. It is not the same as what they told us, and it is never money received."
    >
      <div>
        <FieldLabel>Level</FieldLabel>
        <ChipRow label="Level">
          {(['soft_circled', 'committed', 'indicated'] as const).map((value) => (
            <ChoiceChip key={value} selected={tier === value} onClick={() => setTier(value)}>
              {value === 'indicated' ? 'Clear (back to Indicated)' : TIER_LABEL[value]}
            </ChoiceChip>
          ))}
        </ChipRow>
        <p className="mt-1.5 text-sm text-fg-2">{TIER_HELP[tier]}</p>
      </div>
      {tier !== 'indicated' ? (
        <>
          <div>
            <FieldLabel>Amount</FieldLabel>
            <TextField
              aria-label="Amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="For example 250000"
              className="max-w-64 tabular-nums"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {stated && amount.trim() === '' ? (
              <div className="mt-2">
                <ChoiceChip
                  onClick={() => {
                    setAmount(stated.amount);
                    setCurrency(stated.currency);
                  }}
                >
                  Use their indicated {formatMoney(stated.amount, stated.currency)}
                </ChoiceChip>
              </div>
            ) : null}
          </div>
          <div>
            <FieldLabel>Currency</FieldLabel>
            <ChipRow label="Currency">
              {COMMON_CURRENCIES.map((code) => (
                <ChoiceChip key={code} selected={currency === code} onClick={() => setCurrency(code)}>
                  {code}
                </ChoiceChip>
              ))}
            </ChipRow>
            <TextField
              aria-label="Currency code"
              className="mt-2 max-w-32 uppercase"
              maxLength={3}
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
            <p className="mt-1 text-xs text-fg-3">Each currency is kept on its own. Nothing is converted.</p>
          </div>
          <div>
            <FieldLabel>Evidence note (optional)</FieldLabel>
            <TextField
              aria-label="Evidence note"
              maxLength={COMMITMENT_EVIDENCE_MAX}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </div>
        </>
      ) : null}
      <div>
        <FieldLabel>Why</FieldLabel>
        <ChipRow label="Why">
          {COMMITMENT_REASON_CHIPS.map((chip) => (
            <ChoiceChip
              key={chip}
              selected={!other && reason === chip}
              onClick={() => {
                setOther(false);
                setReason(chip);
              }}
            >
              {chip}
            </ChoiceChip>
          ))}
          <ChoiceChip
            selected={other}
            onClick={() => {
              setOther(true);
              setReason('');
            }}
          >
            {OTHER_REASON}
          </ChoiceChip>
        </ChipRow>
        {other ? (
          <TextField
            aria-label="Reason, in your own words"
            className="mt-2"
            maxLength={500}
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}
      </div>
      {!checked.ok && reason.trim() ? <p className="text-sm text-fg-2">{checked.error}</p> : null}
      <div className="flex justify-end">
        <Button variant="primary" size={40} loading={busy} disabled={!checked.ok} onClick={() => checked.ok && onSave(checked)}>
          {tier === 'indicated' ? 'Clear commitment' : 'Save commitment'}
        </Button>
      </div>
    </Sheet>
  );
}
