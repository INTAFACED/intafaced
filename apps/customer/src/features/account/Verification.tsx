import { useEffect, useRef, useState } from 'react';
import { StatusTag } from '@intafaced/ui';
import { useSession } from '../session/session';
import type { ApiClient } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Field, Loading, Page } from '../../shared/ui';
import { verificationCopy as copy } from './verification-copy';
import { VerificationLadder } from './VerificationLadder';
import { VerificationCases } from './VerificationCases';
import { VerificationCapabilities } from './VerificationCapabilities';
import { KYC_LADDER_LEVELS } from '@intafaced/contracts/identity-kyc-levels';
import {
  finishVerification,
  readVerification,
  requestedTier,
  saveVerification,
  verificationBlocked,
  verificationKey,
  verificationLock,
  verificationReply,
  verificationRefused,
  verificationStatus,
  type RequestedTier,
  type VerificationJournal,
  type VerificationOriginal,
  type VerificationRecord,
} from './verification-guards';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import './verification.css';

type Original = { owner: string; client: ApiClient; token: string; tier: RequestedTier; country: string; mount: object; path: string };
type Known = {
  original: Original;
  local: VerificationOriginal;
  row?: VerificationRecord;
  refused: boolean;
  retained: boolean;
  finalized?: boolean;
};
type Problem = 'storage' | 'locks' | 'another' | 'changed' | 'invalidCountry';
const emptyJournal: VerificationJournal = { records: [], failed: false };

export function Verification() {
  const { api, userId, session } = useSession();
  const { t, Copy, requestedLocale, languageFor } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [limit, setLimit] = useState(50),
    [tier, setTier] = useState<RequestedTier>('basic'),
    [country, setCountry] = useState('');
  const [review, setReview] = useState<Original | null>(null),
    [active, setActive] = useState<Original | null>(null),
    [known, setKnown] = useState<Known[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null),
    [selected, setSelected] = useState<VerificationRecord | null>(null);
  const [stored, setStored] = useState<{ owner: string | null; value: VerificationJournal }>(() => ({
    owner: userId,
    value: userId ? readVerification(userId) : emptyJournal,
  }));
  const mounted = useRef(true),
    mount = useRef({}),
    original = useRef<Original | null>(null),
    running = useRef<Original | null>(null);
  const abort = useRef<AbortController | null>(null),
    form = useRef<HTMLFormElement | null>(null);
  const current = useRef({ api, userId, token: session?.accessToken });
  current.current = { api, userId, token: session?.accessToken };
  const privateContext = useRef({ api, userId });
  const privateVisible = privateContext.current.api === api && privateContext.current.userId === userId;
  const clientVersion = useRef({ api, value: 0 });
  if (clientVersion.current.api !== api) clientVersion.current = { api, value: clientVersion.current.value + 1 };
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'kyc.status', { limit }, verificationStatus(userId, limit), { signal })
        : Promise.resolve({ ok: true as const, data: { tier: 'none' as const, records: [] } }),
    `verification:${userId}:${clientVersion.current.value}:${limit}`,
  );
  // Only levels above the current one are worth asking for; the first of them is the default.
  const heldLevel = resource.status === 'ready' ? resource.data.tier : 'none';
  const offeredTiers = KYC_LADDER_LEVELS.slice(KYC_LADDER_LEVELS.indexOf(heldLevel) + 1) as RequestedTier[];
  const chosenTier = offeredTiers.includes(tier) ? tier : (offeredTiers[0] ?? tier);
  // Case history reads again when a request is sent or decided. It waits for the first status read, and the key holds
  // while the status re-reads, so the history neither reads twice nor blinks back to loading.
  const lastCasesKey = useRef<string | null>(null);
  if (resource.status === 'ready') lastCasesKey.current = resource.data.records.map((row) => `${row.id}.${row.status}`).join(',');
  // A status read that failed still lets the history read on its own.
  const casesKey = lastCasesKey.current ?? (resource.status === 'failed' ? 'status-unread' : null);
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === verificationKey(userId) || event.key === null))
        setStored({ owner: userId, value: readVerification(userId) });
    };
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      abort.current?.abort();
      window.removeEventListener('storage', changed);
    };
  }, [userId]);
  useEffect(() => {
    privateContext.current = { api, userId };
    original.current = null;
    abort.current?.abort();
    setReview(null);
    setActive(null);
    setKnown([]);
    setSelected(null);
    setCountry('');
    setTier('basic');
    setProblem(null);
    setLimit(50);
    setStored({ owner: userId, value: userId ? readVerification(userId) : emptyJournal });
  }, [api, userId]);
  const sameActor = (intent: Original) =>
    mounted.current &&
    intent.mount === mount.current &&
    current.current.userId === intent.owner &&
    current.current.api === intent.client &&
    current.current.token === intent.token &&
    location.pathname === intent.path &&
    intent.client.canWrite();
  const same = (intent: Original) => sameActor(intent) && original.current === intent;
  const journal = stored.owner === userId ? stored.value : userId ? readVerification(userId) : emptyJournal;
  const busy = Boolean(active && sameActor(active));
  const blocked = !userId || busy || !api.canWrite() || verificationBlocked(journal);
  const visibleKnown = known.filter((receipt) => sameActor(receipt.original));
  function sync(owner: string) {
    if (mounted.current && current.current.userId === owner) setStored({ owner, value: readVerification(owner) });
  }
  function open() {
    if (blocked || !userId || !session || (running.current && sameActor(running.current))) return;
    const latest = readVerification(userId);
    setStored({ owner: userId, value: latest });
    if (verificationBlocked(latest)) {
      if (latest.failed) setProblem('storage');
      return;
    }
    const normalized = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) {
      setProblem('invalidCountry');
      return;
    }
    const intent: Original = {
      owner: userId,
      client: api,
      token: session.accessToken,
      tier: chosenTier,
      country: normalized,
      mount: mount.current,
      path: location.pathname,
    };
    original.current = intent;
    setReview(intent);
    setProblem(null);
  }
  function close() {
    if (!busy) {
      original.current = null;
      setReview(null);
    }
  }
  function jump() {
    const input = form.current?.querySelector<HTMLInputElement>('input');
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  async function dispatch(intent: Original) {
    if (!same(intent) || (running.current && sameActor(running.current))) return;
    running.current = intent;
    setActive(intent);
    setReview(null);
    setProblem(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (!navigator.locks) {
        if (same(intent)) setProblem('locks');
        return;
      }
      await navigator.locks.request(verificationLock(intent.owner), { ifAvailable: true }, async (lock) => {
        if (!same(intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readVerification(intent.owner);
        sync(intent.owner);
        if (verificationBlocked(latest)) {
          if (latest.failed) setProblem('storage');
          return;
        }
        // Current-status reads are independent. The API accepts static reviewed terms;
        // lock acquisition is the awaited boundary before this fresh actor check.
        if (!same(intent)) return;
        const local: VerificationOriginal = {
          owner: intent.owner,
          kind: 'submit',
          requestId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        if (!saveVerification(local)) {
          sync(intent.owner);
          if (same(intent)) setProblem('storage');
          return;
        }
        sync(intent.owner);
        if (!same(intent)) return;
        const answer = await intent.client.mutate(
          'identity',
          'kyc.submit',
          { tier: intent.tier, jurisdiction: intent.country },
          verificationReply(intent.owner, intent.tier),
          { signal: controller.signal },
        );
        if (!same(intent)) return;
        if (answer.ok || verificationRefused(answer)) {
          const retained = !finishVerification(local);
          setKnown((previous) => [
            ...previous,
            { original: intent, local, ...(answer.ok ? { row: { ...answer.data } } : {}), refused: !answer.ok, retained },
          ]);
        }
        // Every unqualified failure remains unknown. No current list match releases it.
        sync(intent.owner);
      });
    } catch {
      if (same(intent)) setProblem('storage');
    } finally {
      if (running.current === intent) running.current = null;
      if (same(intent)) {
        original.current = null;
        setActive(null);
      }
    }
  }
  async function finalize(receipt: Known) {
    if (!sameActor(receipt.original) || busy || !receipt.retained) return;
    if (!navigator.locks) {
      setProblem('locks');
      return;
    }
    try {
      await navigator.locks.request(verificationLock(receipt.local.owner), { ifAvailable: true }, (lock) => {
        if (!sameActor(receipt.original)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        if (finishVerification(receipt.local)) {
          setKnown((previous) => previous.map((entry) => (entry === receipt ? { ...entry, retained: false, finalized: true } : entry)));
          setProblem(null);
        } else setProblem('storage');
        sync(receipt.local.owner);
      });
    } catch {
      if (sameActor(receipt.original)) setProblem('storage');
    }
  }
  function time(value: string | null) {
    return value ? (
      <time dateTime={value} lang={requestedLocale}>
        {stamp(value, timeZone)}
      </time>
    ) : (
      <Copy k="noneRecorded" />
    );
  }
  function record(row: VerificationRecord) {
    return (
      <div className="verification__record-detail">
        <h3>
          <Copy k={row.tier} /> · <span lang="zxx">{row.jurisdiction}</span>
        </h3>
        <p className="verification__ref" lang="zxx">
          {row.id}
        </p>
        <dl>
          <div>
            <dt>
              <Copy k="status" />
            </dt>
            <dd>
              <Copy k={row.status} />
            </dd>
          </div>
          <div>
            <dt>
              <Copy k="created" />
            </dt>
            <dd>{time(row.createdAt)}</dd>
          </div>
          <div>
            <dt>
              <Copy k="reviewed" />
            </dt>
            <dd>{time(row.reviewedAt)}</dd>
          </div>
          <div>
            <dt>
              <Copy k="expiry" />
            </dt>
            <dd>{time(row.expiresAt)}</dd>
          </div>
        </dl>
      </div>
    );
  }
  if (!userId)
    return (
      <Page title={t('title')}>
        <EmptyState
          title={t('signIn')}
          action={
            <a className="text-link" href="/login?redirect=%2Fverification">
              <Copy k="signIn" />
            </a>
          }
        >
          <Copy k="guest" />
        </EmptyState>
      </Page>
    );
  return (
    <div className="verification" lang={languageFor('title')}>
      <Page title={t('title')} description={t('description')}>
        <p className="verification__identity">
          <Copy k="owner" /> ·{' '}
          <span className="verification__ref" lang="zxx">
            {userId}
          </span>
        </p>
        {privateVisible && (journal.records.length > 0 || visibleKnown.length > 0) && (
          <section className="verification__originals" aria-label={t('originals')}>
            {journal.records
              .filter(
                (local) =>
                  !visibleKnown.some(
                    (receipt) =>
                      receipt.local.requestId === local.requestId &&
                      receipt.local.owner === local.owner &&
                      receipt.local.kind === local.kind &&
                      receipt.local.createdAt === local.createdAt,
                  ),
              )
              .map((local) => (
                <article key={local.requestId} className="verification__original" role="status">
                  <h2>
                    <Copy k={busy ? 'sending' : 'unknown'} />
                  </h2>
                  <p>
                    <Copy k="unknownBody" />
                  </p>
                  <p>
                    <Copy k="started" /> {time(local.createdAt)}
                  </p>
                  <p>
                    <Copy k="reference" />
                  </p>
                  <p className="verification__ref" lang="zxx">
                    {local.requestId}
                  </p>
                  <p>
                    <Copy k="paused" />
                  </p>
                  <p className="muted">
                    <Copy k="privacy" />
                  </p>
                  <a className="button button--secondary" href="/support">
                    <Copy k="support" /> →
                  </a>
                </article>
              ))}
            {visibleKnown.map((receipt) => (
              <article key={receipt.local.requestId} className="verification__original" role="status">
                <h2>
                  <Copy k={receipt.refused ? 'refused' : 'known'} />
                </h2>
                <p>
                  <Copy k="requested" /> · <Copy k={receipt.original.tier} /> · <span lang="zxx">{receipt.original.country}</span>
                </p>
                {receipt.row ? (
                  <>
                    <h3>
                      <Copy k="returned" />
                    </h3>
                    {record(receipt.row)}
                    <p className="muted">
                      <Copy k="replyBoundary" />
                    </p>
                  </>
                ) : (
                  <p>
                    <Copy k="refusedBody" />
                  </p>
                )}
                {receipt.retained && (
                  <div className="verification__cleanup">
                    <h3>
                      <Copy k="retained" />
                    </h3>
                    <p>
                      <Copy k="retainedBody" />
                    </p>
                    <p>
                      <Copy k="reference" />
                    </p>
                    <p className="verification__ref" lang="zxx">
                      {receipt.local.requestId}
                    </p>
                    <Button variant="secondary" disabled={busy} onClick={() => void finalize(receipt)}>
                      <Copy k="finish" />
                    </Button>
                    <p className="muted">
                      <Copy k="finishBody" />
                    </p>
                  </div>
                )}
                {receipt.finalized && (
                  <p>
                    <Copy k="finalized" />
                  </p>
                )}
              </article>
            ))}
          </section>
        )}
        {privateVisible && (problem || journal.failed) && (
          <p className="notice" role="status">
            <Copy k={problem ?? 'storage'} />
          </p>
        )}
        <div className="verification__columns">
          <section className="verification__list" aria-label={t('records')}>
            {resource.status === 'loading' ? (
              <Loading />
            ) : resource.status === 'failed' ? (
              <>
                <div lang="und">
                  <Failure result={resource.failure} retry={reload} />
                </div>
                <p className="muted">
                  <Copy k="readBoundary" />
                </p>
              </>
            ) : (
              <>
                <div className="verification__tier">
                  <span className="eyebrow">
                    <Copy k="current" />
                  </span>
                  <h2 className="verification__level">
                    <StatusTag
                      className="verification__level-tag h-10 rounded-sm px-5 text-lg font-semibold"
                      status={resource.data.tier === 'none' ? 'working' : 'filled'}
                      label={t(resource.data.tier)}
                    />
                  </h2>
                  <p className="muted">
                    <Copy k="currentBody" />
                  </p>
                </div>
                <div className="verification__records">
                  <div className="verification__heading">
                    <h2>
                      <Copy k="records" />
                    </h2>
                    <Button variant="secondary" onClick={reload}>
                      <Copy k="refresh" />
                    </Button>
                  </div>
                  <p className="muted">
                    <Copy k="window" params={{ limit }} />
                  </p>
                  {offeredTiers.length > 0 && (
                    <Button className="verification__jump" variant="secondary" disabled={blocked} onClick={jump}>
                      <Copy k="jump" />
                    </Button>
                  )}
                  {resource.data.records.length ? (
                    <ul className="verification__rows">
                      {resource.data.records.map((row) => (
                        <li key={row.id}>
                          <div className="verification__row">
                            <strong>
                              <Copy k={row.tier} />
                            </strong>
                            <span lang="zxx">{row.jurisdiction}</span>
                            <span className={row.status === 'approved' ? 'verification__approved' : 'muted'}>
                              <Copy k={row.status} />
                            </span>
                            {time(row.createdAt)}
                            <Button variant="ghost" aria-label={t('inspectId', { id: row.id })} onClick={() => setSelected({ ...row })}>
                              <Copy k="inspect" /> →
                            </Button>
                          </div>
                          <p className="verification__ref muted" lang="zxx">
                            {row.id}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title={t('empty')}>
                      <Copy k="emptyBody" />
                    </EmptyState>
                  )}
                  {limit < 200 && resource.data.records.length === limit && (
                    <Button variant="secondary" onClick={() => setLimit((value) => Math.min(200, value + 50))}>
                      <Copy k="expand" params={{ limit: limit + 50 }} />
                    </Button>
                  )}
                  {limit === 200 && (
                    <p className="muted">
                      <Copy k="maximum" />
                    </p>
                  )}
                  {privateVisible && selected && (
                    <section className="verification__selection" aria-label={t('selected')}>
                      <h2>
                        <Copy k="selected" />
                      </h2>
                      {!resource.data.records.some((row) => row.id === selected.id) && (
                        <p>
                          <Copy k="selectionMissing" />
                        </p>
                      )}
                      {record(selected)}
                      <p className="muted">
                        <Copy k="recordBoundary" />
                      </p>
                    </section>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="verification__request" aria-label={t('requestTitle')}>
            <h2>
              <Copy k="requestTitle" />
            </h2>
            <p className="muted">
              <Copy k="requestBody" />
            </p>
            {offeredTiers.length > 0 ? (
              <form
                ref={form}
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  open();
                }}
              >
                <label className="field">
                  <span>
                    <Copy k="tier" />
                  </span>
                  <select
                    value={privateVisible ? chosenTier : (offeredTiers[0] ?? 'basic')}
                    disabled={blocked}
                    onChange={(event) => {
                      const parsed = requestedTier.safeParse(event.target.value);
                      if (parsed.success) setTier(parsed.data);
                    }}
                  >
                    {offeredTiers.map((level) => (
                      <option key={level} value={level}>
                        {t(level)}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  label={t('country')}
                  name="kyc-country"
                  required
                  minLength={2}
                  maxLength={2}
                  pattern="[a-zA-Z]{2}"
                  value={privateVisible ? country : ''}
                  disabled={blocked}
                  onChange={(event) => setCountry(event.target.value)}
                  hint={t('countryHint')}
                />
                <Button type="submit" disabled={blocked}>
                  <Copy k="review" />
                </Button>
              </form>
            ) : (
              <p>
                <Copy k="topLevel" />
              </p>
            )}
            <p className="muted">
              <Copy k="documentBoundary" />
            </p>
            <a className="text-link" href="/support">
              <Copy k="help" /> →
            </a>
          </section>
        </div>
        <VerificationLadder
          statusTier={resource.status === 'ready' ? resource.data.tier : null}
          offered={offeredTiers}
          verifyDisabled={blocked}
          onVerify={(level) => {
            const parsed = requestedTier.safeParse(level);
            if (!parsed.success) return;
            setTier(parsed.data);
            jump();
          }}
        />
        {casesKey === null ? (
          <Loading />
        ) : (
          <>
            <VerificationCapabilities recordsKey={casesKey} />
            <VerificationCases
              recordsKey={casesKey}
              offered={offeredTiers}
              resubmitDisabled={blocked}
              onResubmit={(level) => {
                const parsed = requestedTier.safeParse(level);
                if (!parsed.success) return;
                setTier(parsed.data);
                jump();
              }}
            />
          </>
        )}
        {privateVisible && review && same(review) && (
          <Dialog title={t('reviewTitle')} onClose={close}>
            <div className="verification__review stack">
              <p>
                <Copy k="owner" />
              </p>
              <p className="verification__ref" lang="zxx">
                {review.owner}
              </p>
              <h3>
                <Copy k={review.tier} /> · <span lang="zxx">{review.country}</span>
              </h3>
              <p>
                <Copy k="consequence" />
              </p>
              <p className="muted">
                <Copy k="permissionBoundary" />
              </p>
              <Button disabled={busy} onClick={() => void dispatch(review)}>
                <Copy k="submit" />
              </Button>
              <Button variant="ghost" disabled={busy} onClick={close}>
                <Copy k="cancel" />
              </Button>
            </div>
          </Dialog>
        )}
      </Page>
    </div>
  );
}
