// volt-room: /bank/account
import { useCallback, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { Button, Checkbox, Field, Select, TextArea } from '@intafaced/ui/lit';
import {
  bankAccountClosureSchema as closureSchema,
  bankAccountDataSchema as dataSchema,
  bankAccountOnboardingSchema as onboardingSchema,
  bankAccountRequestsSchema as requestsSchema,
  bankAccountReviewsSchema as reviewsSchema,
} from '@intafaced/contracts/bank-money-room';
import { useSession } from '../../session';
import { defineCopy } from '../../../shared/i18n';
import { useResource } from '../../../shared/resource';
import { BankSettingsRoom } from '../bank-settings/BankSettingsRoom';
import { Panel } from '../bank-settings/parts';
import {
  BANK_BANK_ACCOUNT_ANSWER_REQUEST,
  BANK_BANK_ACCOUNT_ANSWER_REVIEW,
  BANK_BANK_ACCOUNT_REQUEST_CLOSURE,
  BANK_BANK_ACCOUNT_REOPEN,
  BANK_BANK_ACCOUNT_REQUEST_DATA,
} from '@intafaced/contracts/bank-bank-account-procedures';

/**
 * Words for the bank account room (BK-acct-05, BK-acct-06; J-bank-17): onboarding, the partner's information requests
 * and periodic reviews, closing and reopening the account, and a data-rights request. Every step, requirement, deadline,
 * cap and window comes from the bank; none is written here.
 */
export const bankAccountCopy = defineCopy('bank-account', {
  title: 'Your bank account',
  description: 'Onboarding, requests and reviews from the bank partner, closing the account and your data.',
  sectionsLabel: 'Bank account sections',
  explain:
    'Every step, requirement, deadline, cap and window here is the bank partner’s own, read as it stands now. An answer goes to the partner as it is sent; closing restricts the account until the partner pays out what it holds, and a data request is recorded with the partner’s reference.',
  bannerTitle: 'Finish your bank onboarding',
  bannerBody:
    '{partner} needs something from you: {steps} onboarding steps, {requests} information requests and {reviews} reviews are open.',
  bannerOpen: 'Open onboarding',
  onboardingTitle: 'Onboarding',
  onboardingLead: 'The steps and requirements of {partner}, which holds your bank account, with our own.',
  stepDone: 'Done',
  stepOpen: 'Open',
  stepDoneWithCase: 'Done with your INTAFACED verification, which {partner} accepts',
  identityCaseAccepted: 'Your INTAFACED verification (level {tier}) is offered to {partner}, and it accepts it.',
  identityCaseRefused: '{partner} does not accept your INTAFACED verification, so it asks for its own check.',
  verify: 'Verify your identity',
  partnerRequirements: 'Requirements of {partner}',
  ownerRequirements: 'Our requirements',
  ownerRequirementsUnset: 'Our requirements are not published ({code}).',
  onboardingComplete: 'Onboarding is done.',
  requestsTitle: 'Information requests',
  requestsLead: 'What {partner} asks you for. Answer each one with one file before its deadline.',
  requestsNone: 'No information requests.',
  due: 'Deadline: {date}',
  statusOpen: 'Waiting for your answer',
  statusUnderReview: 'Under review since {date}',
  file: 'File',
  uploadCap: 'One {types} file, up to {size} bytes.',
  uploadUnset: 'The size cap for an answer is not published ({code}), so nothing can be sent yet.',
  answer: 'Send answer',
  sent: 'Sent: {name}, {size} bytes',
  reviewsTitle: 'Periodic reviews',
  reviewsLead: '{partner} checks your account details from time to time.',
  reviewsNone: 'No reviews.',
  reviewDue: 'Due: {date}',
  reviewMissed: 'If you miss it: {effect}',
  reviewAccurate: 'My account details are still accurate',
  reviewNote: 'Anything that changed',
  reviewAnswer: 'Answer review',
  reviewAnswered: 'Answered on {date}',
  closureTitle: 'Close your bank account',
  closureLead:
    'Closing asks {partner} to pay out what the account holds to the destination you name. While it is closing, no money moves in or out.',
  closureOpen: 'Your account is open.',
  destinationName: 'Name on the destination account',
  destinationRef: 'Destination account number (IBAN)',
  close: 'Close account',
  closurePending: 'Closing: restricted while {partner} pays out your balance to {name}, {ref}. No money moves in or out until then.',
  closureBalance: 'To be paid out: {amount} {asset}',
  closureClosed: 'Closed on {date}.',
  closurePaidOut: 'Paid out by {partner} on {date}.',
  reopenUntil: 'You can reopen it until {date}.',
  reopenUnset: 'How long a closed account can be reopened is not published ({code}).',
  reopen: 'Reopen account',
  reopened: 'Reopened on {date}.',
  dataTitle: 'Your data',
  dataLead: 'Ask {partner} for a copy of the data it holds about your bank account.',
  dataKind: 'What you ask for',
  dataAccess: 'A copy of my data',
  dataPortability: 'My data in a portable file',
  dataRequest: 'Send request',
  dataNone: 'No data requests yet.',
  dataRecord: '{kind}: received on {date}, reference {ref}',
  signIn: 'Sign in to read your bank account.',
  unread: 'This could not be read from the bank: {message}',
  refused: '{message}',
});

type Failure = { code: string; message: string };
type Read<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed'; failure: Failure };

/** One bank read, re-read whenever `version` changes. */
export function useAccountRead<T>(procedure: string, schema: z.ZodType<T>, version: number): Read<T> {
  const { api, userId, profiles } = useSession();
  // Every bank call carries the profile in view (J-bank-01 #7); a business profile is refused, as it has no bank account here.
  const profile = profiles.active;
  const { resource } = useResource<T>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: bankAccountCopy.t('signIn') };
    return api.query('bank', `bankAccount.${procedure}`, { profile }, schema, { signal });
  }, `${userId}:${profile}:bankAccount.${procedure}:${version}`);
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'ready') return { state: 'ready', data: resource.data };
  return { state: 'failed', failure: { code: resource.failure.code ?? '', message: resource.failure.message } };
}

const day = (at: string | null) => (at ? at.slice(0, 10) : '');

/** Reads a chosen file as base64, without the data-URL prefix. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsDataURL(file);
  });
}

function Refusal({ failure, unread = false }: { failure: Failure; unread?: boolean }) {
  const { t } = bankAccountCopy.useCopy();
  return (
    <p role="alert" data-code={failure.code}>
      {t(unread ? 'unread' : 'refused', { message: failure.message })}
    </p>
  );
}

function Onboarding({ version }: { version: number }) {
  const { t } = bankAccountCopy.useCopy();
  const read = useAccountRead('onboarding', onboardingSchema, version);
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const now = read.data;
  return (
    <div data-testid="bank-onboarding" data-complete={String(now.complete)} data-partner={now.label}>
      <p className="lt-hint">{t('onboardingLead', { partner: now.label })}</p>
      <ol>
        {now.steps.map((step) => (
          <li key={step.id} data-step={step.id} data-status={step.status} data-done-with={step.doneWith ?? ''}>
            {step.title}:{' '}
            {step.status === 'done'
              ? step.doneWith === 'identity_case'
                ? t('stepDoneWithCase', { partner: now.label })
                : t('stepDone')
              : t('stepOpen')}
          </li>
        ))}
      </ol>
      <p data-testid="bank-identity-case" data-accepted={String(now.identityCase.accepted)} data-tier={now.identityCase.tier}>
        {now.identityCase.accepted
          ? t('identityCaseAccepted', { tier: now.identityCase.tier, partner: now.label })
          : t('identityCaseRefused', { partner: now.label })}
      </p>
      {now.identityCase.tier === 'none' && (
        <a className="lt-link" href="/verification">
          {t('verify')}
        </a>
      )}
      <h4>{t('partnerRequirements', { partner: now.label })}</h4>
      <ul data-testid="bank-partner-requirements">
        {now.requirements.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h4>{t('ownerRequirements')}</h4>
      {now.ownerRequirements.state === 'published' ? (
        <ul data-testid="bank-owner-requirements">
          {now.ownerRequirements.requirements.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p data-testid="bank-owner-requirements" data-code={now.ownerRequirements.code}>
          {t('ownerRequirementsUnset', { code: now.ownerRequirements.code })}
        </p>
      )}
      {now.complete && <p role="status">{t('onboardingComplete')}</p>}
    </div>
  );
}

function InfoRequests({ version, changed }: { version: number; changed: () => void }) {
  const { t } = bankAccountCopy.useCopy();
  const { api, profiles } = useSession();
  const profile = profiles.active;
  const read = useAccountRead('requests', requestsSchema, version);
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const answer = useCallback(
    async (event: FormEvent<HTMLFormElement>, requestId: string) => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem('file') as HTMLInputElement | null;
      const file = input?.files?.[0];
      if (!file) return;
      setBusy(requestId);
      const contentBase64 = await base64Of(file);
      const result = await api.call(BANK_BANK_ACCOUNT_ANSWER_REQUEST, {
        requestId,
        name: file.name,
        type: file.type || 'application/octet-stream',
        contentBase64,
        profile,
      });
      setBusy(null);
      setFailures((now) => {
        const next = { ...now };
        if (result.ok) delete next[requestId];
        else next[requestId] = { code: result.code ?? '', message: result.message };
        return next;
      });
      changed();
    },
    [api, changed, profile],
  );
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const { requests, upload } = read.data;
  if (requests.length === 0) return <p className="lt-hint">{t('requestsNone')}</p>;
  return (
    <ul data-testid="bank-info-requests">
      {requests.map((row) => (
        <li key={row.id} data-request={row.id} data-status={row.status} data-due={row.dueAt}>
          <h4>{row.title}</h4>
          <p>{row.detail}</p>
          <p>{t('due', { date: day(row.dueAt) })}</p>
          <p role="status">{row.status === 'open' ? t('statusOpen') : t('statusUnderReview', { date: day(row.answeredAt) })}</p>
          {row.file && <p data-sha256={row.file.sha256}>{t('sent', { name: row.file.name, size: String(row.file.size) })}</p>}
          {row.status === 'open' && (
            <form onSubmit={(event) => void answer(event, row.id)} aria-label={row.title}>
              {upload.state === 'published' ? (
                <p className="lt-hint" data-max-bytes={upload.maxBytes}>
                  {t('uploadCap', { types: upload.allowedTypes.join(' or '), size: String(upload.maxBytes) })}
                </p>
              ) : (
                <p className="lt-hint" data-code={upload.code}>
                  {t('uploadUnset', { code: upload.code })}
                </p>
              )}
              <Field
                label={t('file')}
                type="file"
                name="file"
                accept={upload.state === 'published' ? upload.allowedTypes.join(',') : undefined}
              />
              <Button type="submit" tone="primary" disabled={busy === row.id}>
                {t('answer')}
              </Button>
            </form>
          )}
          {failures[row.id] && <Refusal failure={failures[row.id]!} />}
        </li>
      ))}
    </ul>
  );
}

function Reviews({ version, changed }: { version: number; changed: () => void }) {
  const { t } = bankAccountCopy.useCopy();
  const { api, profiles } = useSession();
  const profile = profiles.active;
  const read = useAccountRead('reviews', reviewsSchema, version);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const { reviews } = read.data;
  if (reviews.length === 0) return <p className="lt-hint">{t('reviewsNone')}</p>;
  const submit = async (event: FormEvent<HTMLFormElement>, reviewId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const accurate = (form.elements.namedItem('accurate') as HTMLInputElement).checked;
    const note = (form.elements.namedItem('note') as HTMLTextAreaElement).value.trim();
    const result = await api.call(BANK_BANK_ACCOUNT_ANSWER_REVIEW, {
      reviewId,
      stillAccurate: accurate,
      note: note === '' ? null : note,
      profile,
    });
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  return (
    <ul data-testid="bank-reviews">
      {reviews.map((row) => (
        <li key={row.id} data-review={row.id} data-status={row.status} data-due={row.dueAt}>
          <h4>{row.title}</h4>
          <p>{t('reviewDue', { date: day(row.dueAt) })}</p>
          <p data-testid="bank-review-missed">{t('reviewMissed', { effect: row.missedEffect })}</p>
          {row.status === 'answered' ? (
            <p role="status">{t('reviewAnswered', { date: day(row.answeredAt) })}</p>
          ) : (
            <form onSubmit={(event) => void submit(event, row.id)} aria-label={row.title}>
              <Checkbox name="accurate" defaultChecked>
                {t('reviewAccurate')}
              </Checkbox>
              <TextArea label={t('reviewNote')} name="note" maxLength={500} />
              <Button type="submit" tone="primary">
                {t('reviewAnswer')}
              </Button>
            </form>
          )}
        </li>
      ))}
      {failure && <Refusal failure={failure} />}
    </ul>
  );
}

function Closure({ version, changed }: { version: number; changed: () => void }) {
  const { t } = bankAccountCopy.useCopy();
  const { api, profiles } = useSession();
  const profile = profiles.active;
  const read = useAccountRead('closure', closureSchema, version);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const now = read.data;
  const last = now.closures[0] ?? null;
  const close = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = (form.elements.namedItem('destinationName') as HTMLInputElement).value.trim();
    const accountRef = (form.elements.namedItem('destinationRef') as HTMLInputElement).value.trim();
    // The business key: this person's next closure, so a resend of the same ask is the same closure.
    const closureId = `closure-${now.closures.length + 1}`;
    const result = await api.call(BANK_BANK_ACCOUNT_REQUEST_CLOSURE, {
      closureId,
      destination: name === '' && accountRef === '' ? null : { name, accountRef },
      profile,
    });
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  const reopen = async () => {
    const result = await api.call(BANK_BANK_ACCOUNT_REOPEN, { profile });
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  return (
    <div data-testid="bank-closure" data-state={now.state}>
      {now.state === 'open' && (
        <>
          <p role="status">{t('closureOpen')}</p>
          {last?.state === 'reopened' && <p>{t('reopened', { date: day(last.reopenedAt) })}</p>}
          <form onSubmit={(event) => void close(event)} aria-label={t('closureTitle')}>
            <Field label={t('destinationName')} name="destinationName" autoComplete="name" maxLength={140} />
            <Field label={t('destinationRef')} name="destinationRef" maxLength={40} />
            <Button type="submit" tone="secondary">
              {t('close')}
            </Button>
          </form>
        </>
      )}
      {now.state === 'pending' && last && (
        <>
          <p role="status" data-testid="bank-closure-restricted">
            {t('closurePending', { partner: last.label, name: last.destination?.name ?? '', ref: last.destination?.accountRef ?? '' })}
          </p>
          <ul>
            {last.balances.map((row) => (
              <li key={`${row.assetId}|${row.spaceId ?? ''}`} data-asset={row.assetId} data-amount={row.amount}>
                {t('closureBalance', { amount: row.amount, asset: row.assetId })}
              </li>
            ))}
          </ul>
        </>
      )}
      {now.state === 'closed' && last && (
        <>
          <p role="status">{t('closureClosed', { date: day(last.closedAt) })}</p>
          {last.paidOutAt && <p>{t('closurePaidOut', { partner: last.label, date: day(last.paidOutAt) })}</p>}
          {now.reopenWindow.state === 'published' ? (
            <>
              <p data-testid="bank-reopen-until" data-until={now.reopenWindow.until ?? ''} data-days={now.reopenWindow.days}>
                {t('reopenUntil', { date: day(now.reopenWindow.until) })}
              </p>
              <Button tone="primary" onClick={() => void reopen()}>
                {t('reopen')}
              </Button>
            </>
          ) : (
            <p data-code={now.reopenWindow.code}>{t('reopenUnset', { code: now.reopenWindow.code })}</p>
          )}
        </>
      )}
      {failure && <Refusal failure={failure} />}
    </div>
  );
}

function DataRights({ version, changed }: { version: number; changed: () => void }) {
  const { t } = bankAccountCopy.useCopy();
  const { api, profiles } = useSession();
  const profile = profiles.active;
  const read = useAccountRead('dataRequests', dataSchema, version);
  const [kind, setKind] = useState<'access' | 'portability'>('access');
  const [failure, setFailure] = useState<Failure | null>(null);
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const { requests } = read.data;
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The business key: this person's next data request, so a resend of the same ask is recorded once.
    const requestId = `data-request-${requests.length + 1}`;
    const result = await api.call(BANK_BANK_ACCOUNT_REQUEST_DATA, { requestId, kind, profile });
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  return (
    <div data-testid="bank-data-rights">
      <form onSubmit={(event) => void send(event)} aria-label={t('dataTitle')}>
        <Select
          label={t('dataKind')}
          value={kind}
          onChange={(value) => setKind(value as 'access' | 'portability')}
          options={[
            { value: 'access', label: t('dataAccess') },
            { value: 'portability', label: t('dataPortability') },
          ]}
        />
        <Button type="submit" tone="secondary">
          {t('dataRequest')}
        </Button>
      </form>
      {requests.length === 0 ? (
        <p className="lt-hint">{t('dataNone')}</p>
      ) : (
        <ul>
          {requests.map((row) => (
            <li key={row.id} data-request={row.id} data-kind={row.kind} data-status={row.status} data-partner-ref={row.partnerRef}>
              {t('dataRecord', {
                kind: row.kind === 'access' ? t('dataAccess') : t('dataPortability'),
                date: day(row.requestedAt),
                ref: row.partnerRef,
              })}
            </li>
          ))}
        </ul>
      )}
      {failure && <Refusal failure={failure} />}
    </div>
  );
}

/** The room's sections, each a link to its part of the page. */
const SECTIONS = [
  ['bank-account-onboarding', 'onboardingTitle'],
  ['bank-account-requests', 'requestsTitle'],
  ['bank-account-reviews', 'reviewsTitle'],
  ['bank-account-closure', 'closureTitle'],
  ['bank-account-data', 'dataTitle'],
] as const;

/** `/bank/account` (BK-acct-05, BK-acct-06, J-bank-17), inside the Overview room, on its settings template. */
export function BankAccountPage() {
  const { t } = bankAccountCopy.useCopy();
  return (
    <BankSettingsRoom
      room="Overview"
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      sectionsLabel={t('sectionsLabel')}
      sections={SECTIONS.map(([id, key]) => [id, t(key)] as const)}
      explain={t('explain')}
    >
      <BankAccountRoom />
    </BankSettingsRoom>
  );
}

/** `/bank/account`: the person's bank account at the partner: onboarding, requests, reviews, closure and data (J-bank-17). */
function BankAccountRoom() {
  const { t } = bankAccountCopy.useCopy();
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const partner = useAccountRead('onboarding', onboardingSchema, version);
  const name = partner.state === 'ready' ? partner.data.label : '';
  return (
    <div data-testid="bank-account">
      <Panel id="bank-account-onboarding" title={t('onboardingTitle')}>
        <Onboarding version={version} />
      </Panel>
      <Panel id="bank-account-requests" title={t('requestsTitle')} lead={t('requestsLead', { partner: name })}>
        <InfoRequests version={version} changed={changed} />
      </Panel>
      <Panel id="bank-account-reviews" title={t('reviewsTitle')} lead={t('reviewsLead', { partner: name })}>
        <Reviews version={version} changed={changed} />
      </Panel>
      <Panel id="bank-account-closure" title={t('closureTitle')} lead={t('closureLead', { partner: name })}>
        <Closure version={version} changed={changed} />
      </Panel>
      <Panel id="bank-account-data" title={t('dataTitle')} lead={t('dataLead', { partner: name })}>
        <DataRights version={version} changed={changed} />
      </Panel>
    </div>
  );
}
