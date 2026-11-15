import { useCallback, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { defineCopy } from '../../shared/i18n';
import { useResource } from '../../shared/resource';
import { DepthPanel } from './DepthParts';
import './bank-depth.css';

/**
 * Words for the bank account room (BK-acct-05, BK-acct-06; J-bank-17): onboarding, the partner's information requests
 * and periodic reviews, closing and reopening the account, and a data-rights request. Every step, requirement, deadline,
 * cap and window comes from the bank; none is written here.
 */
export const bankAccountCopy = defineCopy('bank-account', {
  title: 'Your bank account',
  description: 'Onboarding, requests and reviews from the bank partner, closing the account and your data.',
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

const iso = z.string();
// hand-declared-ok: svc-bank's bankAccount router has no browser-safe schema in packages/contracts yet
const onboardingSchema = z.object({
  label: z.string(),
  steps: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['done', 'open']), doneWith: z.string().nullable() })),
  requirements: z.array(z.string()),
  ownerRequirements: z.union([
    z.object({ state: z.literal('published'), requirements: z.array(z.string()) }),
    z.object({ state: z.literal('unset'), code: z.string() }),
  ]),
  identityCase: z.object({ tier: z.string(), accepted: z.boolean() }),
  complete: z.boolean(),
  openRequests: z.number(),
  openReviews: z.number(),
});
const requestSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  openedAt: iso,
  dueAt: iso,
  status: z.enum(['open', 'under_review']),
  answeredAt: iso.nullable(),
  file: z.object({ name: z.string(), type: z.string(), size: z.number(), sha256: z.string() }).nullable(),
  label: z.string(),
});
const requestsSchema = z.object({
  requests: z.array(requestSchema),
  upload: z.union([
    z.object({ state: z.literal('published'), allowedTypes: z.array(z.string()), maxBytes: z.number() }),
    z.object({ state: z.literal('unset'), code: z.string() }),
  ]),
});
const reviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueAt: iso,
  missedEffect: z.string(),
  status: z.enum(['open', 'answered']),
  answeredAt: iso.nullable(),
  label: z.string(),
});
const closureRowSchema = z.object({
  id: z.string(),
  state: z.enum(['pending', 'closed', 'reopened']),
  requestedAt: iso,
  balances: z.array(z.object({ assetId: z.string(), spaceId: z.string().nullable(), amount: z.string() })),
  destination: z.object({ name: z.string(), accountRef: z.string() }).nullable(),
  payoutMoveIds: z.array(z.string()),
  paidOutAt: iso.nullable(),
  closedAt: iso.nullable(),
  reopenedAt: iso.nullable(),
  label: z.string(),
});
const closureSchema = z.object({
  state: z.enum(['open', 'pending', 'closed']),
  closures: z.array(closureRowSchema),
  reopenWindow: z.union([
    z.object({ state: z.literal('published'), days: z.number(), until: iso.nullable() }),
    z.object({ state: z.literal('unset'), code: z.string() }),
  ]),
});
const dataRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['access', 'portability']),
  requestedAt: iso,
  status: z.literal('received'),
  partnerRef: z.string(),
  label: z.string(),
});
const dataSchema = z.object({ requests: z.array(dataRowSchema) });
const reviewsSchema = z.object({ reviews: z.array(reviewSchema) });

type Failure = { code: string; message: string };
type Read<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed'; failure: Failure };

/** One bank read, re-read whenever `version` changes. */
function useAccountRead<T>(procedure: string, schema: z.ZodType<T>, version: number): Read<T> {
  const { api, userId } = useSession();
  const { resource } = useResource<T>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: bankAccountCopy.t('signIn') };
    return api.query('bank', `bankAccount.${procedure}`, undefined, schema, { signal });
  }, `${userId}:bankAccount.${procedure}:${version}`);
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'ready') return { state: 'ready', data: resource.data };
  return { state: 'failed', failure: { code: resource.failure.code ?? '', message: resource.failure.message } };
}

const day = (at: string | null) => (at ? at.slice(0, 10) : '');

function Refusal({ failure, unread = false }: { failure: Failure; unread?: boolean }) {
  const { t } = bankAccountCopy.useCopy();
  return (
    <p role="alert" className="error-text" data-code={failure.code}>
      {t(unread ? 'unread' : 'refused', { message: failure.message })}
    </p>
  );
}

/** Reads a chosen file as base64, without the data-URL prefix. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * The onboarding banner on the Bank's first page (J-bank-17 #1): shown while the partner's onboarding has an open step,
 * request or review. A person whose bank account the partner does not hold sees nothing.
 */
export function OnboardingBanner() {
  const { t } = bankAccountCopy.useCopy();
  const read = useAccountRead('onboarding', onboardingSchema, 0);
  if (read.state !== 'ready') return null;
  const now = read.data;
  const openSteps = now.steps.filter((step) => step.status === 'open').length;
  if (now.complete && now.openRequests === 0 && now.openReviews === 0) return null;
  return (
    <section className="money-card" data-testid="bank-onboarding-banner" aria-label={t('bannerTitle')} role="region">
      <h3>{t('bannerTitle')}</h3>
      <p>
        {t('bannerBody', {
          partner: now.label,
          steps: String(openSteps),
          requests: String(now.openRequests),
          reviews: String(now.openReviews),
        })}
      </p>
      <a className="button button--primary" href="/bank/account">
        {t('bannerOpen')}
      </a>
    </section>
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
      <p className="money-caption">{t('onboardingLead', { partner: now.label })}</p>
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
        <a className="text-link" href="/verification">
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
  const { api } = useSession();
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
      const result = await api.mutate(
        'bank',
        'bankAccount.answerRequest',
        { requestId, name: file.name, type: file.type || 'application/octet-stream', contentBase64 },
        requestSchema,
      );
      setBusy(null);
      setFailures((now) => {
        const next = { ...now };
        if (result.ok) delete next[requestId];
        else next[requestId] = { code: result.code ?? '', message: result.message };
        return next;
      });
      changed();
    },
    [api, changed],
  );
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const { requests, upload } = read.data;
  if (requests.length === 0) return <p className="money-caption">{t('requestsNone')}</p>;
  return (
    <ul className="bd-stack" data-testid="bank-info-requests">
      {requests.map((row) => (
        <li key={row.id} className="money-card" data-request={row.id} data-status={row.status} data-due={row.dueAt}>
          <h4>{row.title}</h4>
          <p>{row.detail}</p>
          <p>{t('due', { date: day(row.dueAt) })}</p>
          <p role="status">{row.status === 'open' ? t('statusOpen') : t('statusUnderReview', { date: day(row.answeredAt) })}</p>
          {row.file && <p data-sha256={row.file.sha256}>{t('sent', { name: row.file.name, size: String(row.file.size) })}</p>}
          {row.status === 'open' && (
            <form onSubmit={(event) => void answer(event, row.id)} aria-label={row.title}>
              {upload.state === 'published' ? (
                <p className="money-caption" data-max-bytes={upload.maxBytes}>
                  {t('uploadCap', { types: upload.allowedTypes.join(' or '), size: String(upload.maxBytes) })}
                </p>
              ) : (
                <p className="money-caption" data-code={upload.code}>
                  {t('uploadUnset', { code: upload.code })}
                </p>
              )}
              <label className="field">
                <span>{t('file')}</span>
                <input type="file" name="file" accept={upload.state === 'published' ? upload.allowedTypes.join(',') : undefined} />
              </label>
              <button type="submit" className="button button--primary" disabled={busy === row.id}>
                {t('answer')}
              </button>
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
  const { api } = useSession();
  const read = useAccountRead('reviews', reviewsSchema, version);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (read.state === 'loading') return null;
  if (read.state === 'failed') return <Refusal failure={read.failure} unread />;
  const { reviews } = read.data;
  if (reviews.length === 0) return <p className="money-caption">{t('reviewsNone')}</p>;
  const submit = async (event: FormEvent<HTMLFormElement>, reviewId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const accurate = (form.elements.namedItem('accurate') as HTMLInputElement).checked;
    const note = (form.elements.namedItem('note') as HTMLTextAreaElement).value.trim();
    const result = await api.mutate(
      'bank',
      'bankAccount.answerReview',
      { reviewId, stillAccurate: accurate, note: note === '' ? null : note },
      reviewSchema,
    );
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  return (
    <ul className="bd-stack" data-testid="bank-reviews">
      {reviews.map((row) => (
        <li key={row.id} className="money-card" data-review={row.id} data-status={row.status} data-due={row.dueAt}>
          <h4>{row.title}</h4>
          <p>{t('reviewDue', { date: day(row.dueAt) })}</p>
          <p data-testid="bank-review-missed">{t('reviewMissed', { effect: row.missedEffect })}</p>
          {row.status === 'answered' ? (
            <p role="status">{t('reviewAnswered', { date: day(row.answeredAt) })}</p>
          ) : (
            <form onSubmit={(event) => void submit(event, row.id)} aria-label={row.title}>
              <label className="field">
                <input type="checkbox" name="accurate" defaultChecked />
                <span>{t('reviewAccurate')}</span>
              </label>
              <label className="field">
                <span>{t('reviewNote')}</span>
                <textarea name="note" maxLength={500} />
              </label>
              <button type="submit" className="button button--primary">
                {t('reviewAnswer')}
              </button>
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
  const { api } = useSession();
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
    const result = await api.mutate(
      'bank',
      'bankAccount.requestClosure',
      { closureId, destination: name === '' && accountRef === '' ? null : { name, accountRef } },
      closureRowSchema,
    );
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  const reopen = async () => {
    const result = await api.mutate('bank', 'bankAccount.reopen', undefined, closureRowSchema);
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
            <label className="field">
              <span>{t('destinationName')}</span>
              <input name="destinationName" autoComplete="name" maxLength={140} />
            </label>
            <label className="field">
              <span>{t('destinationRef')}</span>
              <input name="destinationRef" maxLength={40} />
            </label>
            <button type="submit" className="button button--secondary">
              {t('close')}
            </button>
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
              <button type="button" className="button button--primary" onClick={() => void reopen()}>
                {t('reopen')}
              </button>
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
  const { api } = useSession();
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
    const result = await api.mutate('bank', 'bankAccount.requestData', { requestId, kind }, dataRowSchema);
    setFailure(result.ok ? null : { code: result.code ?? '', message: result.message });
    changed();
  };
  return (
    <div data-testid="bank-data-rights">
      <form onSubmit={(event) => void send(event)} aria-label={t('dataTitle')}>
        <label className="field">
          <span>{t('dataKind')}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as 'access' | 'portability')}>
            <option value="access">{t('dataAccess')}</option>
            <option value="portability">{t('dataPortability')}</option>
          </select>
        </label>
        <button type="submit" className="button button--secondary">
          {t('dataRequest')}
        </button>
      </form>
      {requests.length === 0 ? (
        <p className="money-caption">{t('dataNone')}</p>
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

/** `/bank/account`: the person's bank account at the partner: onboarding, requests, reviews, closure and data (J-bank-17). */
export function BankAccountRoom() {
  const { t } = bankAccountCopy.useCopy();
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const partner = useAccountRead('onboarding', onboardingSchema, version);
  const name = partner.state === 'ready' ? partner.data.label : '';
  return (
    <div className="bd-stack" data-testid="bank-account">
      <DepthPanel title={t('onboardingTitle')}>
        <Onboarding version={version} />
      </DepthPanel>
      <DepthPanel title={t('requestsTitle')} lead={t('requestsLead', { partner: name })}>
        <InfoRequests version={version} changed={changed} />
      </DepthPanel>
      <DepthPanel title={t('reviewsTitle')} lead={t('reviewsLead', { partner: name })}>
        <Reviews version={version} changed={changed} />
      </DepthPanel>
      <DepthPanel title={t('closureTitle')} lead={t('closureLead', { partner: name })}>
        <Closure version={version} changed={changed} />
      </DepthPanel>
      <DepthPanel title={t('dataTitle')} lead={t('dataLead', { partner: name })}>
        <DataRights version={version} changed={changed} />
      </DepthPanel>
    </div>
  );
}
