import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useLocation } from '../../app/location';
import { useSession } from '../session/session';
import { invitationCopy as copy } from './invitation-copy';
import { ReferrerChange } from './ReferrerChange';
import {
  attachWindowSchema,
  currentReferrerFor,
  finishInvitation,
  invitationKey,
  invitationLock,
  invitationReply,
  isInvitationRefusal,
  readInvitations,
  referralRefusal,
  saveInvitation,
  type CurrentReferrer,
  type InvitationJournal,
  type InvitationRecord,
  type ReferralRefusal,
} from './invitation-guards';
import './invitation.css';

type Context = { client: ApiClient; owner: string | null; token: string | null; url: string; generation: number };
type Original = Context & { owner: string; capability: string };
type FailureResult = Extract<ApiResult<unknown>, { ok: false }>;
type Problem = 'storage' | 'locks' | 'another' | 'changed' | 'preflight';
type Receipt = {
  original: Original;
  record: InvitationRecord;
  answer: ApiResult<z.infer<typeof invitationReply>>;
  retained: boolean;
  finalized?: boolean;
};
type CurrentRead = { context: Context } & (
  { status: 'loading' } | { status: 'ready'; data: CurrentReferrer } | { status: 'failed'; failure: FailureResult }
);
const emptyJournal: InvitationJournal = { records: [], failed: false };
const REFUSAL_COPY = {
  'referral.self': 'refusalSelf',
  'referral.already_set': 'refusalAlreadySet',
  'referral.cycle': 'refusalCycle',
  'referral.depth': 'refusalDepth',
  'referral.attach_window_closed': 'refusalWindowClosed',
  'referral.attach_window_unset': 'refusalWindowNotSet',
} as const satisfies Record<ReferralRefusal, string>;
/** A link that could not attach for these reasons can still be asked for through a reviewed change (J-campaigns-05 #5). */
const REVIEWABLE = new Set<string>(['referral.attach_window_closed', 'referral.attach_window_unset', 'referral.already_set']);

export function Invitation() {
  useLocation();
  const { api, userId, session } = useSession();
  const { t, languageFor } = copy.useCopy();
  const capability = new URLSearchParams(location.search).get('token');
  const parsed = z.string().guid().safeParse(capability);
  const token = session?.accessToken ?? null,
    url = location.href;
  const version = useRef({ client: api, owner: userId, token, url, generation: 0 });
  if (version.current.client !== api || version.current.owner !== userId || version.current.token !== token || version.current.url !== url)
    version.current = { client: api, owner: userId, token, url, generation: version.current.generation + 1 };
  const context = version.current;
  const current = useRef(context),
    privateContext = useRef(context),
    mounted = useRef(true);
  current.current = context;
  const privateVisible = privateContext.current === context;
  const original = useRef<Original | null>(null),
    running = useRef<Original | null>(null);
  const sendAbort = useRef<AbortController | null>(null),
    readAbort = useRef<AbortController | null>(null),
    readSequence = useRef(0);
  const reviewButton = useRef<HTMLDivElement | null>(null),
    reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const outcomeHeading = useRef<HTMLHeadingElement | null>(null);
  const [review, setReview] = useState<Original | null>(null),
    [active, setActive] = useState<Original | null>(null);
  const [pendingRecord, setPendingRecord] = useState<InvitationRecord | null>(null),
    [receipts, setReceipts] = useState<Receipt[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null),
    [preflightFailure, setPreflightFailure] = useState<FailureResult | null>(null);
  const [unknownFailure, setUnknownFailure] = useState<FailureResult | null>(null),
    [read, setRead] = useState<CurrentRead | null>(null);
  const [, invalidateNavigation] = useState(0);
  const [stored, setStored] = useState<{ owner: string | null; value: InvitationJournal }>(() => ({
    owner: userId,
    value: userId ? readInvitations(userId) : emptyJournal,
  }));
  const sameContext = (captured: Context) =>
    mounted.current && current.current === captured && location.href === captured.url && captured.client.canWrite();
  const sameActor = (intent: Original) =>
    mounted.current &&
    current.current.client === intent.client &&
    current.current.owner === intent.owner &&
    current.current.token === intent.token &&
    current.current.generation === intent.generation &&
    location.href === intent.url &&
    intent.client.canWrite();
  const same = (intent: Original) => sameActor(intent) && original.current === intent;
  const journal = stored.owner === userId ? stored.value : userId ? readInvitations(userId) : emptyJournal;
  const visibleReceipts = privateVisible ? receipts.filter((receipt) => sameActor(receipt.original)) : [];
  const busy = Boolean(active && sameActor(active));
  const blocked =
    !userId ||
    busy ||
    !api.canWrite() ||
    journal.failed ||
    journal.records.length > 0 ||
    visibleReceipts.some((receipt) => receipt.retained);
  const visibleReview = privateVisible && review && same(review) ? review : null;
  const unknowns = journal.records.filter((record) => !visibleReceipts.some((receipt) => receipt.record.localRef === record.localRef));
  const visibleRead = privateVisible && read && sameContext(read.context) ? read : null;
  const latestReceipt = visibleReceipts.at(-1);
  const knownTitle = (receipt: Receipt) =>
    !receipt.answer.ok
      ? referralRefusal(receipt.answer.code)
        ? 'referralRefused'
        : 'refused'
      : receipt.answer.data.attributed
        ? 'attributed'
        : 'checked';
  const knownBody = (receipt: Receipt) => {
    if (receipt.answer.ok) return receipt.answer.data.attributed ? 'attributedBody' : 'checkedBody';
    const refusal = referralRefusal(receipt.answer.code);
    return refusal ? REFUSAL_COPY[refusal] : 'refusedBody';
  };

  function discardPrivate() {
    original.current = null;
    sendAbort.current?.abort();
    readAbort.current?.abort();
    readSequence.current++;
    setReview(null);
    setActive(null);
    setPendingRecord(null);
    setReceipts([]);
    setProblem(null);
    setPreflightFailure(null);
    setUnknownFailure(null);
    setRead(null);
    const owner = current.current.owner;
    setStored({ owner, value: owner ? readInvitations(owner) : emptyJournal });
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const departed = () => {
      const previous = version.current;
      if (previous.url === location.href) return;
      // Observe each departure before React can batch an A→B→A URL into A.
      const next = { ...previous, url: location.href, generation: previous.generation + 1 };
      version.current = next;
      current.current = next;
      discardPrivate();
      invalidateNavigation((value) => value + 1);
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      mounted.current = false;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
      sendAbort.current?.abort();
      readAbort.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    privateContext.current = context;
    discardPrivate();
  }, [context]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === invitationKey(userId) || event.key === null))
        setStored({ owner: userId, value: readInvitations(userId) });
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [userId]);
  useEffect(() => {
    if (visibleReview) reviewHeading.current?.focus();
  }, [visibleReview]);
  useEffect(() => {
    if (!busy && (visibleReceipts.length || unknowns.length || problem)) outcomeHeading.current?.focus();
  }, [busy, receipts, problem, stored]);

  function sync(owner: string) {
    if (mounted.current && current.current.owner === owner) setStored({ owner, value: readInvitations(owner) });
  }
  function open() {
    if (!sameContext(context) || !parsed.success || blocked || (running.current && sameActor(running.current))) return;
    const latest = readInvitations(userId!);
    setStored({ owner: userId, value: latest });
    if (latest.failed || latest.records.length) return;
    const intent: Original = { ...current.current, owner: userId!, capability: parsed.data };
    original.current = intent;
    setReview(intent);
    setProblem(null);
    setPreflightFailure(null);
    setUnknownFailure(null);
  }
  function cancel() {
    if (!sameContext(context) || busy) return;
    original.current = null;
    setReview(null);
    requestAnimationFrame(() => {
      if (sameContext(context)) reviewButton.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
  }
  async function dispatch(intent: Original) {
    if (!same(intent) || (running.current && sameActor(running.current))) return;
    running.current = intent;
    setActive(intent);
    setReview(null);
    setProblem(null);
    setPreflightFailure(null);
    setUnknownFailure(null);
    const controller = new AbortController();
    sendAbort.current = controller;
    try {
      if (!navigator.locks) {
        if (same(intent)) setProblem('locks');
        return;
      }
      await navigator.locks.request(invitationLock(intent.owner), { ifAvailable: true }, async (lock) => {
        if (!same(intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readInvitations(intent.owner);
        sync(intent.owner);
        if (latest.failed || latest.records.length) {
          if (latest.failed) setProblem('storage');
          return;
        }
        const fresh = await intent.client.query('identity', 'affiliates.myReferrer', undefined, currentReferrerFor(intent.owner), {
          signal: controller.signal,
        });
        if (!same(intent)) return;
        if (!fresh.ok) {
          setProblem('preflight');
          setPreflightFailure(fresh);
          return;
        }
        const record: InvitationRecord = {
          owner: intent.owner,
          kind: 'invitation-accept',
          localRef: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        if (!saveInvitation(record)) {
          sync(intent.owner);
          setProblem('storage');
          return;
        }
        sync(intent.owner);
        setPendingRecord(record);
        if (!same(intent)) {
          finishInvitation(record);
          return;
        }
        const answer = await intent.client.mutate('identity', 'affiliates.shareHits', { token: intent.capability }, invitationReply, {
          signal: controller.signal,
        });
        if (!same(intent)) return;
        if (answer.ok || isInvitationRefusal(answer)) {
          const retained = !finishInvitation(record);
          if (!same(intent)) return;
          setReceipts((previous) => [...previous, { original: intent, record, answer, retained }]);
        } else setUnknownFailure(answer);
        sync(intent.owner);
      });
    } catch {
      if (same(intent)) {
        setProblem('locks');
        sync(intent.owner);
      }
    } finally {
      if (running.current === intent) running.current = null;
      if (same(intent)) {
        setActive(null);
        setPendingRecord(null);
      }
    }
  }
  async function finalize(receipt: Receipt) {
    if (!sameActor(receipt.original) || busy || !receipt.retained || !navigator.locks) {
      if (sameActor(receipt.original) && !navigator.locks) setProblem('locks');
      return;
    }
    await navigator.locks
      .request(invitationLock(receipt.record.owner), { ifAvailable: true }, (lock) => {
        if (!sameActor(receipt.original)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const finished = finishInvitation(receipt.record);
        sync(receipt.record.owner);
        if (!sameActor(receipt.original)) return;
        if (finished)
          setReceipts((previous) => previous.map((item) => (item === receipt ? { ...item, retained: false, finalized: true } : item)));
        else setProblem('storage');
      })
      .catch(() => {
        if (sameActor(receipt.original)) setProblem('locks');
      });
  }
  async function readCurrent() {
    const captured = context;
    if (!captured.owner || !sameContext(captured)) return;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    const sequence = ++readSequence.current;
    setRead({ context: captured, status: 'loading' });
    const answer = await captured.client.query('identity', 'affiliates.myReferrer', undefined, currentReferrerFor(captured.owner), {
      signal: controller.signal,
    });
    if (!sameContext(captured) || sequence !== readSequence.current) return;
    setRead(
      answer.ok ? { context: captured, status: 'ready', data: answer.data } : { context: captured, status: 'failed', failure: answer },
    );
  }
  function reference(record: InvitationRecord) {
    return (
      <>
        <dl>
          <div>
            <dt>{t('started')}</dt>
            <dd lang="zxx">
              <time dateTime={record.createdAt}>{record.createdAt}</time>
            </dd>
          </div>
          <div>
            <dt>{t('reference')}</dt>
            <dd lang="zxx">{record.localRef}</dd>
          </div>
        </dl>
        <p className="muted">{t('referenceBoundary')}</p>
      </>
    );
  }
  const title = !userId
    ? 'guestTitle'
    : busy
      ? 'pending'
      : unknowns.length
        ? 'unknownTitle'
        : latestReceipt
          ? knownTitle(latestReceipt)
          : 'title';
  const description = !userId
    ? 'guestDescription'
    : busy
      ? 'pendingBody'
      : unknowns.length
        ? 'unknownDescription'
        : latestReceipt
          ? knownBody(latestReceipt)
          : 'description';
  return (
    <div className={`invitation${visibleReview ? ' invitation--review' : ''}`} lang={languageFor('title')}>
      <section className="invitation__intro">
        <div>
          <p className="eyebrow">{t(!userId ? 'guestEyebrow' : latestReceipt ? 'knownEyebrow' : 'eyebrow')}</p>
          <h1>{t(title)}</h1>
        </div>
        <div>
          <p className="muted">{t(description)}</p>
          <p>{t('boundary')}</p>
          <a href="/help" className="invitation__link text-link">
            {t('help')}
          </a>
        </div>
      </section>
      <div className="invitation__content">
        {!parsed.success && (
          <section data-testid="invitation__card" className="invitation__card">
            <h2>{t(capability ? 'invalid' : 'missing')}</h2>
            <p className="muted">{t(capability ? 'invalidBody' : 'missingBody')}</p>
            <a className="button button--primary" href="/uc/promotion">
              {t('account')}
            </a>
          </section>
        )}
        {parsed.success && !userId && (
          <section data-testid="invitation__card" className="invitation__card">
            <h2>{t('returnTitle')}</h2>
            <p className="muted">{t('returnBody')}</p>
            <a className="button button--primary" href={`/login?invite=${encodeURIComponent(parsed.data)}`}>
              {t('signIn')}
            </a>
            <a className="button button--secondary" href={`/register?invite=${encodeURIComponent(parsed.data)}`}>
              {t('register')}
            </a>
          </section>
        )}
        {parsed.success && userId && !visibleReview && !busy && !unknowns.length && !latestReceipt && (
          <section data-testid="invitation__card" className="invitation__card">
            <h2>{t('before')}</h2>
            <p className="muted">{t('consequence')}</p>
            <div ref={reviewButton}>
              <Button disabled={blocked} onClick={open}>
                {t('review')}
              </Button>
            </div>
          </section>
        )}
        {visibleReview && (
          <section data-testid="invitation__card" className="invitation__card" aria-labelledby="invitation-review-title">
            <div>
              <p className="eyebrow">{t('reviewEyebrow')}</p>
              <h2 id="invitation-review-title" ref={reviewHeading} tabIndex={-1}>
                {t('before')}
              </h2>
            </div>
            <div className="invitation__owner">
              <span className="muted">{t('owner')}</span>
              <span data-testid="invitation__private" className="invitation__private" lang="zxx">
                {visibleReview.owner}
              </span>
              <p className="muted">{t('held')}</p>
            </div>
            <div>
              <p>{t('consequence')}</p>
              <p className="muted">{t('already')}</p>
              <p className="muted">{t('lost')}</p>
            </div>
            <Button onClick={() => void dispatch(visibleReview)}>{t('accept')}</Button>
            <Button variant="ghost" onClick={cancel}>
              {t('cancel')}
            </Button>
          </section>
        )}
        {busy && !pendingRecord && (
          <section data-testid="invitation__card" className="invitation__card" aria-busy="true">
            <h2>{t('pending')}</h2>
            <p role="status">{t('pendingBody')}</p>
          </section>
        )}
        {unknowns.map((record, index) => {
          const sending = busy && pendingRecord?.localRef === record.localRef;
          return (
            <section
              data-testid="invitation__card"
              className="invitation__card"
              key={record.localRef}
              aria-busy={sending}
              aria-label={t(sending ? 'pending' : 'unknown')}
            >
              <h2
                data-testid="invitation__outcome"
                className="invitation__outcome"
                ref={index === 0 ? outcomeHeading : undefined}
                tabIndex={-1}
              >
                {t(sending ? 'pending' : 'unknown')}
              </h2>
              <p role="status">{t(sending ? 'pendingBody' : 'paused')}</p>
              {reference(record)}
              {!sending && (
                <div className="invitation__boundary">
                  <p className="muted">{t('memoryLost')}</p>
                  <p className="muted">{t('lookup')}</p>
                  <a className="button button--secondary" href="/support">
                    {t('support')}
                  </a>
                </div>
              )}
            </section>
          );
        })}
        {privateVisible && unknownFailure && unknowns.length > 0 && !busy && (
          <div lang="und">
            <Failure result={unknownFailure} />
            {unknownFailure.code && (
              <p lang="zxx">
                HTTP {unknownFailure.status} · {unknownFailure.code}
              </p>
            )}
          </div>
        )}
        {visibleReceipts.map((receipt) => (
          <section
            data-testid="invitation__card"
            className="invitation__card"
            key={receipt.record.localRef}
            aria-label={t(knownTitle(receipt))}
          >
            <h2
              data-testid="invitation__outcome"
              className="invitation__outcome"
              ref={unknowns.length === 0 ? outcomeHeading : undefined}
              tabIndex={-1}
            >
              {t(knownTitle(receipt))}
            </h2>
            <p role="status">{t(knownBody(receipt))}</p>
            {reference(receipt.record)}
            {!receipt.answer.ok && (
              <div>
                <p lang="und">{receipt.answer.message}</p>
                <p lang="zxx">
                  HTTP {receipt.answer.status} · {receipt.answer.code}
                </p>
              </div>
            )}
            {receipt.retained && (
              <div className="invitation__boundary">
                <h3>{t('retained')}</h3>
                <p role="status" className="muted">
                  {t('retainedBody')}
                </p>
                <Button variant="secondary" disabled={busy} onClick={() => void finalize(receipt)}>
                  {t('finish')}
                </Button>
                <p className="muted">{t('finishBody')}</p>
                <a href="/support" className="invitation__link text-link">
                  {t('support')}
                </a>
              </div>
            )}
            {receipt.finalized && <p role="status">{t('finished')}</p>}
            <p className="muted">{t('separate')}</p>
          </section>
        ))}
        {userId && (journal.failed || (privateVisible && problem)) && (
          <section data-testid="invitation__card" className="invitation__card">
            <h2 data-testid="invitation__outcome" className="invitation__outcome" ref={outcomeHeading} tabIndex={-1}>
              {t(journal.failed ? 'storage' : problem!)}
            </h2>
            {privateVisible && preflightFailure && (
              <div lang="und">
                <Failure result={preflightFailure} />
              </div>
            )}
            <a href="/support" className="invitation__link text-link">
              {t('support')}
            </a>
          </section>
        )}
        {userId && !visibleReview && (
          <section data-testid="invitation__current" className="invitation__current" aria-labelledby="invitation-current-title">
            <h2 id="invitation-current-title">{t('current')}</h2>
            <p className="muted">{t('currentBody')}</p>
            <Button disabled={visibleRead?.status === 'loading'} onClick={() => void readCurrent()}>
              {t('read')}
            </Button>
            {visibleRead?.status === 'loading' && <Loading label={t('reading')} />}
            {visibleRead?.status === 'failed' && (
              <div lang="und">
                <Failure result={visibleRead.failure} retry={() => void readCurrent()} />
              </div>
            )}
            {visibleRead?.status === 'ready' && (
              <div>
                <p role="status">{t(visibleRead.data ? 'currentRecorded' : 'currentNone')}</p>
                {visibleRead.data && (
                  <dl>
                    <div>
                      <dt>{t('referrer')}</dt>
                      <dd lang="zxx" data-testid="invitation__private" className="invitation__private">
                        {visibleRead.data.referrerId}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('attributedAt')}</dt>
                      <dd lang="zxx">
                        <time dateTime={visibleRead.data.attributedAt}>{visibleRead.data.attributedAt}</time>
                      </dd>
                    </div>
                  </dl>
                )}
                <p>{t('readBoundary')}</p>
              </div>
            )}
            <AttachWindowNote key={userId} />
            <ReferrerChange
              key={`${userId}:${latestReceipt?.record.localRef ?? ''}`}
              offerToken={
                parsed.success && latestReceipt && !latestReceipt.answer.ok && REVIEWABLE.has(latestReceipt.answer.code ?? '')
                  ? parsed.data
                  : null
              }
            />
            <a href="/uc/promotion" className="invitation__link text-link">
              {t('account')}
            </a>
          </section>
        )}
      </div>
    </div>
  );
}

/** How long this account may still attach a referrer through a link, as the service measures it (J-campaigns-05 #4-#5). */
function AttachWindowNote() {
  const { api } = useSession();
  const { t, requestedLocale } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'affiliates.attachWindow', undefined, attachWindowSchema, { signal }),
    'referral-attach-window',
  );
  const when = (value: string) =>
    `${new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
  return (
    <div className="invitation__window" aria-label={t('windowTitle')}>
      <h3>{t('windowTitle')}</h3>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <Failure result={resource.failure} retry={reload} />
        </div>
      ) : (
        <>
          <p role="status" data-window={resource.data.state}>
            {resource.data.state === 'unset'
              ? t('windowUnset')
              : t(resource.data.state === 'open' ? 'windowOpen' : 'windowClosed', { closesAt: when(resource.data.closesAt!) })}
          </p>
          <p className="muted">
            {resource.data.reopenedAt
              ? t('windowReopened', { reopenedAt: when(resource.data.reopenedAt) })
              : t('windowCreated', { createdAt: when(resource.data.accountCreatedAt) })}
          </p>
        </>
      )}
    </div>
  );
}
