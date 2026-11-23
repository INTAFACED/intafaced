// volt-room: /invite
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { FailureNote, Waiting } from '../more';
import { useLocation } from '../../app/location';
import { useSession } from '../session';
import { invitationCopy as copy } from './invitation-copy';
import { ReferrerChange } from './ReferrerChange';
import { useShareVisit } from './share-visit';
import {
  currentReferrerFor,
  finishInvitation,
  invitationKey,
  invitationLock,
  isInvitationRefusal,
  readInvitations,
  referralRefusal,
  saveInvitation,
  type CurrentReferrer,
  type InvitationJournal,
  type InvitationRecord,
  type ReferralRefusal,
} from './invitation-guards';
import { callAs } from '../../shared/api';
import {
  IDENTITY_AFFILIATES_MY_REFERRER,
  IDENTITY_AFFILIATES_ATTACH_WINDOW,
  IDENTITY_AFFILIATES_SHARE_HITS,
} from '@intafaced/contracts/identity-affiliates-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

type Context = { client: ApiClient; owner: string | null; token: string | null; url: string; generation: number };
type Original = Context & { owner: string; capability: string };
type FailureResult = Extract<ApiResult<unknown>, { ok: false }>;
type Problem = 'storage' | 'locks' | 'another' | 'changed' | 'preflight';
type Receipt = {
  original: Original;
  record: InvitationRecord;
  answer: ApiResult<ProcedureOutput<typeof IDENTITY_AFFILIATES_SHARE_HITS>>;
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
/** A share tag's named refusals (RC-campaigns-06); anything else reads as a plain refusal with its code. */
const SHARE_REFUSAL_TITLE: Record<string, 'tagInvalid' | 'tagRevoked' | 'tagUnknown' | 'tagOff' | 'tagBusy'> = {
  'share.tag_invalid': 'tagInvalid',
  'share.revoked': 'tagRevoked',
  'share.unknown': 'tagUnknown',
  'share.profile_gone': 'tagUnknown',
  'share.key_unset': 'tagOff',
  'share.rate_unset': 'tagOff',
  'share.rate_limited': 'tagBusy',
};
/** A link that could not attach for these reasons can still be asked for through a reviewed change (J-campaigns-05 #5). */
const REVIEWABLE = new Set<string>(['referral.attach_window_closed', 'referral.attach_window_unset', 'referral.already_set']);

export function Invitation() {
  useLocation();
  const { api, userId, session } = useSession();
  const { t, languageFor } = copy.useCopy();
  const search = new URLSearchParams(location.search);
  const tag = search.get('token') ? null : search.get('tag');
  // A signed share tag counts its visit first; its link then works as a `?token=` link does (J-campaigns-05 #2).
  const visit = useShareVisit(api, tag);
  const capability = search.get('token') ?? (visit.status === 'ready' ? visit.data.token : null);
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
        const fresh = await callAs(intent.client, IDENTITY_AFFILIATES_MY_REFERRER, undefined, currentReferrerFor(intent.owner), {
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
        const answer = await intent.client.call(
          IDENTITY_AFFILIATES_SHARE_HITS,
          { token: intent.capability },
          {
            signal: controller.signal,
          },
        );
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
    const answer = await callAs(captured.client, IDENTITY_AFFILIATES_MY_REFERRER, undefined, currentReferrerFor(captured.owner), {
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
        <dl className="lt-kv">
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
        <p className="lt-hint">{t('referenceBoundary')}</p>
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
  const meta = (
    <div className="lt-stack">
      <p className="lt-hint">{t(!userId ? 'guestEyebrow' : latestReceipt ? 'knownEyebrow' : 'eyebrow')}</p>
      <p>{t('boundary')}</p>
      <a href="/help" className="lt-link lt-link-alone">
        {t('help')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
      </a>
    </div>
  );
  const body = (
    <div className="lt-stack lt-wrap">
      {tag && visit.status === 'loading' && (
        <section data-testid="invitation__card" className="lt-stack" aria-busy="true">
          <h2>{t('tagChecking')}</h2>
        </section>
      )}
      {tag && visit.status === 'failed' && (
        <section data-testid="invitation__card" className="lt-stack" role="alert">
          <h2>{t(SHARE_REFUSAL_TITLE[visit.failure.code ?? ''] ?? 'tagRefused')}</h2>
          <p className="lt-hint">{t('tagRefusedBody')}</p>
          {visit.failure.code && <p lang="zxx">{visit.failure.code}</p>}
        </section>
      )}
      {tag && visit.status === 'ready' && (
        <p role="status" data-testid="invitation__share-visit">
          {t(visit.data.counted ? 'tagCounted' : 'tagSeen')}
        </p>
      )}
      {!parsed.success && !tag && (
        <section data-testid="invitation__card" className="lt-stack">
          <h2>{t(capability ? 'invalid' : 'missing')}</h2>
          <p className="lt-hint">{t(capability ? 'invalidBody' : 'missingBody')}</p>
          <a data-testid="invitation__primary" className="lt-button lt-button-primary" href="/uc/promotion">
            {t('account')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
          </a>
        </section>
      )}
      {parsed.success && !userId && (
        <section data-testid="invitation__card" className="lt-stack">
          <h2>{t('returnTitle')}</h2>
          <p className="lt-hint">{t('returnBody')}</p>
          <div className="lt-actions">
            <a
              data-testid="invitation__primary"
              className="lt-button lt-button-primary"
              href={`/login?invite=${encodeURIComponent(parsed.data)}`}
            >
              {t('signIn')}
            </a>
            <a className="lt-button lt-button-secondary" href={`/register?invite=${encodeURIComponent(parsed.data)}`}>
              {t('register')}
            </a>
          </div>
        </section>
      )}
      {parsed.success && userId && !visibleReview && !busy && !unknowns.length && !latestReceipt && (
        <section data-testid="invitation__card" className="lt-stack">
          <h2>{t('before')}</h2>
          <p className="lt-hint">{t('consequence')}</p>
          <div ref={reviewButton}>
            <Button tone="primary" data-testid="invitation__primary" disabled={blocked} onClick={open}>
              {t('review')}
            </Button>
          </div>
        </section>
      )}
      {visibleReview && (
        <section data-testid="invitation__card" className="lt-stack" aria-labelledby="invitation-review-title">
          <div>
            <p className="lt-hint">{t('reviewEyebrow')}</p>
            <h2 id="invitation-review-title" ref={reviewHeading} tabIndex={-1}>
              {t('before')}
            </h2>
          </div>
          <div data-testid="invitation__owner" className="lt-stack">
            <span className="lt-hint">{t('owner')}</span>
            <span data-testid="invitation__private" className="lt-mono lt-wrap" lang="zxx">
              {visibleReview.owner}
            </span>
            <p className="lt-hint">{t('held')}</p>
          </div>
          <div>
            <p>{t('consequence')}</p>
            <p className="lt-hint">{t('already')}</p>
            <p className="lt-hint">{t('lost')}</p>
          </div>
          <div className="lt-actions">
            <Button tone="primary" data-testid="invitation__primary" onClick={() => void dispatch(visibleReview)}>
              {t('accept')}
            </Button>
            <Button tone="quiet" onClick={cancel}>
              {t('cancel')}
            </Button>
          </div>
        </section>
      )}
      {busy && !pendingRecord && (
        <section data-testid="invitation__card" className="lt-stack" aria-busy="true">
          <h2>{t('pending')}</h2>
          <p role="status">{t('pendingBody')}</p>
        </section>
      )}
      {unknowns.map((record, index) => {
        const sending = busy && pendingRecord?.localRef === record.localRef;
        return (
          <section
            data-testid="invitation__card"
            className="lt-stack"
            key={record.localRef}
            aria-busy={sending}
            aria-label={t(sending ? 'pending' : 'unknown')}
          >
            <h2 data-testid="invitation__outcome" ref={index === 0 ? outcomeHeading : undefined} tabIndex={-1}>
              {t(sending ? 'pending' : 'unknown')}
            </h2>
            <p role="status">{t(sending ? 'pendingBody' : 'paused')}</p>
            {reference(record)}
            {!sending && (
              <div className="lt-stack">
                <p className="lt-hint">{t('memoryLost')}</p>
                <p className="lt-hint">{t('lookup')}</p>
                <a className="lt-button lt-button-secondary" href="/support">
                  {t('support')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
                </a>
              </div>
            )}
          </section>
        );
      })}
      {privateVisible && unknownFailure && unknowns.length > 0 && !busy && (
        <div lang="und">
          <FailureNote result={unknownFailure} />
          {unknownFailure.code && (
            <p lang="zxx">
              HTTP {unknownFailure.status} · {unknownFailure.code}
            </p>
          )}
        </div>
      )}
      {visibleReceipts.map((receipt) => (
        <section data-testid="invitation__card" className="lt-stack" key={receipt.record.localRef} aria-label={t(knownTitle(receipt))}>
          <h2 data-testid="invitation__outcome" ref={unknowns.length === 0 ? outcomeHeading : undefined} tabIndex={-1}>
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
            <div className="lt-stack">
              <h3>{t('retained')}</h3>
              <p role="status" className="lt-hint">
                {t('retainedBody')}
              </p>
              <Button tone="secondary" disabled={busy} onClick={() => void finalize(receipt)}>
                {t('finish')}
              </Button>
              <p className="lt-hint">{t('finishBody')}</p>
              <a href="/support" className="lt-link lt-link-alone">
                {t('support')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
              </a>
            </div>
          )}
          {receipt.finalized && <p role="status">{t('finished')}</p>}
          <p className="lt-hint">{t('separate')}</p>
        </section>
      ))}
      {userId && (journal.failed || (privateVisible && problem)) && (
        <section data-testid="invitation__card" className="lt-stack">
          <h2 data-testid="invitation__outcome" ref={outcomeHeading} tabIndex={-1}>
            {t(journal.failed ? 'storage' : problem!)}
          </h2>
          {privateVisible && preflightFailure && (
            <div lang="und">
              <FailureNote result={preflightFailure} />
            </div>
          )}
          <a href="/support" className="lt-link lt-link-alone">
            {t('support')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
          </a>
        </section>
      )}
      {userId && !visibleReview && (
        <section data-testid="invitation__current" className="lt-stack" aria-labelledby="invitation-current-title">
          <h2 id="invitation-current-title">{t('current')}</h2>
          <p className="lt-hint">{t('currentBody')}</p>
          <Button tone="primary" disabled={visibleRead?.status === 'loading'} onClick={() => void readCurrent()}>
            {t('read')}
          </Button>
          {visibleRead?.status === 'loading' && <Waiting label={t('reading')} />}
          {visibleRead?.status === 'failed' && (
            <div lang="und">
              <FailureNote result={visibleRead.failure} retry={() => void readCurrent()} />
            </div>
          )}
          {visibleRead?.status === 'ready' && (
            <div>
              <p role="status">{t(visibleRead.data ? 'currentRecorded' : 'currentNone')}</p>
              {visibleRead.data && (
                <dl className="lt-kv">
                  <div>
                    <dt>{t('referrer')}</dt>
                    <dd lang="zxx" data-testid="invitation__private" className="lt-mono lt-wrap">
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
          <a href="/uc/promotion" className="lt-link lt-link-alone">
            {t('account')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
          </a>
        </section>
      )}
    </div>
  );
  return (
    <div data-testid="invitation" data-review={visibleReview ? '' : undefined} lang={languageFor('title')}>
      <ReadingTemplate title={t(title)} description={t(description)} state={{ kind: 'ready' }} meta={meta} body={body} />
    </div>
  );
}

/** How long this account may still attach a referrer through a link, as the service measures it (J-campaigns-05 #4-#5). */
function AttachWindowNote() {
  const { api } = useSession();
  const { t, requestedLocale } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.call(IDENTITY_AFFILIATES_ATTACH_WINDOW, undefined, { signal }),
    'referral-attach-window',
  );
  const when = (value: string) =>
    `${new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
  return (
    <div className="lt-stack" aria-label={t('windowTitle')}>
      <h3>{t('windowTitle')}</h3>
      {resource.status === 'loading' ? (
        <Waiting />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <FailureNote result={resource.failure} retry={reload} />
        </div>
      ) : (
        <>
          <p role="status" data-window={resource.data.state}>
            {resource.data.state === 'unset'
              ? t('windowUnset')
              : t(resource.data.state === 'open' ? 'windowOpen' : 'windowClosed', { closesAt: when(resource.data.closesAt!) })}
          </p>
          <p className="lt-hint">
            {resource.data.reopenedAt
              ? t('windowReopened', { reopenedAt: when(resource.data.reopenedAt) })
              : t('windowCreated', { createdAt: when(resource.data.accountCreatedAt) })}
          </p>
        </>
      )}
    </div>
  );
}
