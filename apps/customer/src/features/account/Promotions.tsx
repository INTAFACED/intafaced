import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSession } from '../session/session';
import type { ApiClient } from '../../shared/api';
import { Button, Dialog, EmptyState, Page } from '../../shared/ui';
import { ReferralCode } from './ReferralCode';
import { ReferralRecords } from './ReferralRecords';
import { RewardsHub } from './RewardsHub';
import { promotionsCopy as copy } from './promotions-copy';
import {
  currentLinkReply,
  currentRevocationReply,
  finishShare,
  readShares,
  sameShareOriginal,
  saveShare,
  shareKey,
  shareLock,
  shareRefused,
  sharesBlocked,
  type RevokedLink,
  type ShareJournal,
  type ShareKind,
  type ShareLink,
  type ShareOriginal,
} from './promotions-guards';
import './promotions.css';

type Intent = {
  owner: string;
  client: ApiClient;
  token: string;
  mount: object;
  path: string;
  generation: object;
  kind: ShareKind;
  snapshot?: ShareLink;
  trigger?: HTMLElement;
};
type Known = {
  intent: Intent;
  local: ShareOriginal;
  returned?: ShareLink | RevokedLink;
  refusal?: string;
  retained: boolean;
  finalized?: boolean;
};
type Problem = 'storage' | 'locks' | 'another';
const empty: ShareJournal = { records: [], failed: false };

export type PromotionsView = 'overview' | 'link' | 'records';
/** Each promotion address opens its own section; the bare address and the invitations address show both. */
export function promotionsViewFor(path: string): PromotionsView {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  return clean === '/uc/promotion/mycards' ? 'link' : clean === '/uc/promotion/mypromotion' ? 'records' : 'overview';
}
const promotionTabs: ReadonlyArray<{ view: PromotionsView; href: string; label: 'tabOverview' | 'tabLink' | 'tabRecords' }> = [
  { view: 'overview', href: '/uc/promotion', label: 'tabOverview' },
  { view: 'link', href: '/uc/promotion/mycards', label: 'tabLink' },
  { view: 'records', href: '/uc/promotion/mypromotion', label: 'tabRecords' },
];
export function PromotionTabs({ view }: { view: PromotionsView }) {
  const { t } = copy.useCopy();
  return (
    <nav className="promotions__tabs" aria-label={t('tabsLabel')}>
      {promotionTabs.map((tab) => (
        <a key={tab.view} href={tab.href} aria-current={tab.view === view ? 'page' : undefined}>
          {t(tab.label)}
        </a>
      ))}
    </nav>
  );
}

export function Promotions({ path = '/uc/promotion' }: { path?: string }) {
  const view = promotionsViewFor(path);
  const { api, userId, session } = useSession();
  const { t, Copy, requestedLocale, languageFor } = copy.useCopy();
  const [review, setReview] = useState<Intent | null>(null);
  const [active, setActive] = useState<{ intent: Intent; local?: ShareOriginal } | null>(null);
  const [known, setKnown] = useState<Known[]>([]);
  const [link, setLink] = useState<{ intent: Intent; value: ShareLink } | null>(null);
  const [copied, setCopied] = useState<'copied' | 'copyUnavailable' | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [stored, setStored] = useState<{ owner: string | null; value: ShareJournal }>(() => ({
    owner: userId,
    value: userId ? readShares(userId) : empty,
  }));
  const mounted = useRef(true),
    mount = useRef({}),
    original = useRef<Intent | null>(null),
    running = useRef<Intent | null>(null);
  const abort = useRef<AbortController | null>(null);
  const routeContext = useRef({ path: location.pathname + location.search, generation: {} });
  const renderGeneration = routeContext.current.generation;
  const current = useRef({ api, userId, token: session?.accessToken });
  current.current = { api, userId, token: session?.accessToken };
  const privateContext = useRef({ api, userId });
  const privateVisible = privateContext.current.api === api && privateContext.current.userId === userId;
  const readyHeading = useRef<HTMLHeadingElement | null>(null);
  const readyFocus = useRef<{ intent: Intent; moved: boolean } | null>(null);
  const heldLink = useRef<ShareLink | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    const departed = () => {
      const path = location.pathname + location.search;
      if (path === routeContext.current.path) return;
      // Invalidate synchronously for every observed departure, even if React
      // batches departure and return into one render with the original URL.
      routeContext.current = { path, generation: {} };
      original.current = null;
      running.current = null;
      abort.current?.abort();
      abort.current = null;
      readyFocus.current = null;
      heldLink.current = null;
      setReview(null);
      setActive(null);
      setKnown([]);
      setLink(null);
      setCopied(null);
      setProblem(null);
      // Durable originals remain; departure cannot establish their outcome.
    };
    window.addEventListener('popstate', departed);
    return () => {
      mounted.current = false;
      routeContext.current = { path: location.pathname + location.search, generation: {} };
      original.current = null;
      readyFocus.current = null;
      heldLink.current = null;
      abort.current?.abort();
      window.removeEventListener('popstate', departed);
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === shareKey(userId) || event.key === null)) setStored({ owner: userId, value: readShares(userId) });
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
    readyFocus.current = null;
    setReview(null);
    setActive(null);
    setKnown([]);
    setLink(null);
    setCopied(null);
    setProblem(null);
    setStored({ owner: userId, value: userId ? readShares(userId) : empty });
  }, [api, userId]);
  const sameActor = (intent: Intent) =>
    mounted.current &&
    intent.mount === mount.current &&
    intent.generation === routeContext.current.generation &&
    current.current.userId === intent.owner &&
    current.current.api === intent.client &&
    current.current.token === intent.token &&
    location.pathname + location.search === intent.path &&
    intent.client.canWrite();
  const same = (intent: Intent) => sameActor(intent) && original.current === intent;
  useEffect(() => {
    const pending = readyFocus.current;
    if (!link || !pending) return;
    readyFocus.current = null;
    if (!pending.moved && sameActor(pending.intent)) {
      readyHeading.current?.focus({ preventScroll: true });
      readyHeading.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [link]);
  const journal = stored.owner === userId ? stored.value : userId ? readShares(userId) : empty;
  const busy = Boolean(active && sameActor(active.intent));
  const blocked = !userId || busy || !api.canWrite() || sharesBlocked(journal);
  const visibleKnown = known.filter((receipt) => sameActor(receipt.intent));
  const visibleLink = privateVisible && link && sameActor(link.intent) ? link.value : null;
  heldLink.current = visibleLink;
  const href = (value: ShareLink) => location.origin + '/invite?token=' + encodeURIComponent(value.token);
  function sync(owner: string) {
    if (mounted.current && current.current.userId === owner) setStored({ owner, value: readShares(owner) });
  }
  function open(kind: ShareKind) {
    if (renderGeneration !== routeContext.current.generation || heldLink.current !== visibleLink) return;
    if (blocked || !userId || !session || (running.current && sameActor(running.current))) return;
    const latest = readShares(userId);
    setStored({ owner: userId, value: latest });
    if (sharesBlocked(latest)) {
      if (latest.failed) setProblem('storage');
      return;
    }
    const intent: Intent = {
      owner: userId,
      client: api,
      token: session.accessToken,
      mount: mount.current,
      path: location.pathname + location.search,
      generation: routeContext.current.generation,
      kind,
      ...(document.activeElement instanceof HTMLElement ? { trigger: document.activeElement } : {}),
      ...(visibleLink ? { snapshot: { ...visibleLink } } : {}),
    };
    original.current = intent;
    setReview(intent);
    setProblem(null);
    setCopied(null);
  }
  function close() {
    if (!busy) {
      original.current = null;
      setReview(null);
    }
  }
  async function dispatch(intent: Intent) {
    if (!same(intent) || (running.current && sameActor(running.current))) return;
    running.current = intent;
    setActive({ intent });
    setReview(null);
    setProblem(null);
    setCopied(null);
    const controller = new AbortController();
    abort.current = controller;
    const handoff = { intent, moved: false };
    const moved = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== document.body && target !== intent.trigger && !target.closest('dialog'))
        handoff.moved = true;
    };
    document.addEventListener('focusin', moved);
    try {
      if (!navigator.locks) {
        if (same(intent)) setProblem('locks');
        return;
      }
      await navigator.locks.request(shareLock(intent.owner), { ifAvailable: true }, async (lock) => {
        if (!same(intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readShares(intent.owner);
        sync(intent.owner);
        if (sharesBlocked(latest)) {
          if (latest.failed) setProblem('storage');
          return;
        }
        if (!same(intent)) return;
        const local: ShareOriginal = {
          owner: intent.owner,
          kind: intent.kind,
          requestId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        if (!saveShare(local)) {
          sync(intent.owner);
          if (same(intent)) setProblem('storage');
          return;
        }
        sync(intent.owner);
        if (!same(intent)) return;
        setActive({ intent, local });
        // Both published procedures accept {}. Owner-current revocation deliberately
        // has no particular-token/CAS input; the frozen snapshot is separate.
        const answer =
          intent.kind === 'create'
            ? await intent.client.mutate('identity', 'affiliates.createShare', {}, currentLinkReply(intent.owner), {
                signal: controller.signal,
              })
            : await intent.client.mutate('identity', 'affiliates.revokeShare', {}, currentRevocationReply(intent.owner), {
                signal: controller.signal,
              });
        if (!same(intent)) return;
        if (answer.ok || shareRefused(intent.kind, answer)) {
          const retained = !finishShare(local);
          setKnown((previous) => [
            ...previous,
            { intent, local, ...(answer.ok ? { returned: answer.data } : { refusal: answer.code }), retained },
          ]);
          if (answer.ok) {
            if (intent.kind === 'create') readyFocus.current = handoff;
            setLink(intent.kind === 'create' ? { intent, value: answer.data } : null);
          }
        }
        sync(intent.owner);
      });
    } catch {
      if (same(intent)) setProblem('storage');
    } finally {
      document.removeEventListener('focusin', moved);
      if (running.current === intent) running.current = null;
      if (same(intent)) {
        original.current = null;
        setActive(null);
      }
    }
  }
  async function finalize(receipt: Known) {
    if (!sameActor(receipt.intent) || busy || !receipt.retained) return;
    if (!navigator.locks) {
      setProblem('locks');
      return;
    }
    try {
      await navigator.locks.request(shareLock(receipt.local.owner), { ifAvailable: true }, (lock) => {
        if (!sameActor(receipt.intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        if (finishShare(receipt.local)) {
          setKnown((previous) => previous.map((item) => (item === receipt ? { ...item, retained: false, finalized: true } : item)));
          setProblem(null);
        } else setProblem('storage');
        sync(receipt.local.owner);
      });
    } catch {
      if (sameActor(receipt.intent)) setProblem('storage');
    }
  }
  async function copyLink(value: ShareLink) {
    if (renderGeneration !== routeContext.current.generation || heldLink.current !== value) return;
    if (!userId || !session || busy || !privateVisible) return;
    const intent: Intent = {
      owner: userId,
      client: api,
      token: session.accessToken,
      mount: mount.current,
      path: location.pathname + location.search,
      generation: routeContext.current.generation,
      kind: 'create',
    };
    if (!sameActor(intent) || heldLink.current !== value) return;
    try {
      await navigator.clipboard.writeText(href(value));
      if (sameActor(intent) && heldLink.current === value) setCopied('copied');
    } catch {
      if (sameActor(intent) && heldLink.current === value) setCopied('copyUnavailable');
    }
  }
  function time(value: string) {
    return (
      <time dateTime={value} lang={requestedLocale}>
        {new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC
      </time>
    );
  }
  function privateField(value: ShareLink, label: string) {
    return (
      <label className="field promotions__private">
        <span>{label}</span>
        <input readOnly value={href(value)} lang="zxx" aria-label={label} data-private-capability="true" />
      </label>
    );
  }
  if (!userId)
    return (
      <Page title={t('title')}>
        <EmptyState
          title={t('signIn')}
          action={
            <a className="text-link" href="/login?redirect=%2Fuc%2Fpromotion">
              <Copy k="signIn" />
            </a>
          }
        >
          <Copy k="guest" />
        </EmptyState>
      </Page>
    );
  return (
    <div data-testid="promotions" className="promotions" lang={languageFor('title')}>
      <Page title={t('title')} description={t('description')}>
        <p className="promotions__owner">
          <Copy k="owner" /> · <span lang="zxx">{userId}</span>
        </p>
        {privateVisible && (journal.records.length > 0 || visibleKnown.length > 0) && (
          <section className="promotions__originals" aria-label={t('originals')}>
            {journal.records
              .filter((local) => !visibleKnown.some((receipt) => sameShareOriginal(receipt.local, local)))
              .map((local) => {
                const sending = active?.local && sameActor(active.intent) && sameShareOriginal(active.local, local);
                return (
                  <article key={local.requestId} className="promotions__original">
                    <h2 role="status">
                      <Copy k={sending ? 'sending' : 'unknown'} />
                    </h2>
                    <h3>
                      <Copy k={local.kind === 'create' ? 'createKind' : 'revokeKind'} />
                    </h3>
                    {!sending && (
                      <p>
                        <Copy k={local.kind === 'create' ? 'unknownCreate' : 'unknownRevoke'} />
                      </p>
                    )}
                    <p className="muted">
                      <Copy k="originalOwner" />
                    </p>
                    <p className="promotions__ref" lang="zxx">
                      {local.owner}
                    </p>
                    <p className="muted">
                      <Copy k="reference" />
                    </p>
                    <p className="promotions__ref" lang="zxx">
                      {local.requestId}
                    </p>
                    <p>
                      <Copy k="started" /> {time(local.createdAt)}
                    </p>
                    <p>
                      <Copy k="paused" />
                    </p>
                    <p className="muted">
                      <Copy k="privateOriginal" />
                    </p>
                    <a className="button button--secondary" href="/support">
                      <Copy k="support" /> →
                    </a>
                  </article>
                );
              })}
            {visibleKnown
              .filter((receipt) => receipt.intent.kind === 'revoke-current' || receipt.retained || receipt.refusal || receipt.finalized)
              .map((receipt) => (
                <article key={receipt.local.requestId} className="promotions__original">
                  <h2 role="status">
                    <Copy k={receipt.refusal ? 'refused' : receipt.intent.kind === 'create' ? 'knownCreate' : 'knownRevoke'} />
                  </h2>
                  <p>
                    <Copy k="reviewed" /> · <Copy k={receipt.intent.kind === 'create' ? 'createKind' : 'revokeKind'} />
                  </p>
                  {receipt.refusal ? (
                    <>
                      <p>
                        <Copy k="refusedBody" />
                      </p>
                      <p lang="zxx">{receipt.refusal}</p>
                    </>
                  ) : (
                    receipt.returned &&
                    receipt.intent.kind === 'revoke-current' && (
                      <>
                        {receipt.intent.snapshot && receipt.intent.snapshot.token !== receipt.returned.token && (
                          <>
                            <h3>
                              <Copy k="different" />
                            </h3>
                            <p>
                              <Copy k="differentBody" />
                            </p>
                          </>
                        )}
                        {receipt.intent.snapshot && privateField(receipt.intent.snapshot, t('shown'))}
                        {privateField(receipt.returned, t('returned'))}
                        {'revokedAt' in receipt.returned && (
                          <p>
                            <Copy k="revocationTime" /> · {time(receipt.returned.revokedAt)}
                          </p>
                        )}
                        <p className="muted">
                          <Copy k="revokeBoundary" />
                        </p>
                      </>
                    )
                  )}
                  {receipt.retained && (
                    <div className="promotions__cleanup">
                      <h3>
                        <Copy k="retained" />
                      </h3>
                      <p>
                        <Copy k="retainedBody" />
                      </p>
                      <p className="muted">
                        <Copy k="reference" />
                      </p>
                      <p className="promotions__ref" lang="zxx">
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
                    <p role="status">
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
        <PromotionTabs view={view} />
        {view === 'overview' && <RewardsHub />}
        <div className={view === 'overview' ? 'promotions__columns' : 'promotions__columns promotions__columns--single'}>
          {view !== 'records' && (
            <section data-testid="promotions__link" className="promotions__link" aria-label={t('linkTitle')}>
              <h2 ref={readyHeading} tabIndex={-1}>
                <Copy k="linkTitle" />
              </h2>
              {visibleLink ? (
                <>
                  <p className="muted" role="status">
                    <Copy k="snapshot" />
                  </p>
                  {privateField(visibleLink, t('link'))}
                  <div data-testid="promotions__visits" className="promotions__visits">
                    <span>
                      <Copy k="visits" />
                    </span>
                    <strong lang="zxx">{visibleLink.hits}</strong>
                  </div>
                  <div className="promotions__actions">
                    <Button disabled={busy} onClick={() => void copyLink(visibleLink)}>
                      <Copy k="copy" />
                    </Button>
                    <Button variant="secondary" disabled={blocked} onClick={() => open('revoke-current')}>
                      <Copy k="reviewRevoke" />
                    </Button>
                  </div>
                  {copied && (
                    <p role="status">
                      <Copy k={copied} />
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3>
                    <Copy k="noLink" />
                  </h3>
                  <p className="muted">
                    <Copy k="noLinkBody" />
                  </p>
                  <Button disabled={blocked} onClick={() => open('create')}>
                    <Copy k="reviewCreate" />
                  </Button>
                </>
              )}
              <p className="promotions__caption">
                <Copy k="lifetime" />
              </p>
            </section>
          )}
          {view !== 'records' && <ReferralCode />}
          {view !== 'link' && (
            <div id="promotion-referrals">
              <ReferralRecords />
            </div>
          )}
        </div>
        <div className="actions">
          {view !== 'records' && (
            <a className="text-link" href={view === 'overview' ? '#promotion-referrals' : '/uc/promotion/mypromotion'}>
              <Copy k="referrals" /> {view === 'overview' ? '↓' : '→'}
            </a>
          )}
          <a className="text-link" href="/uc/account">
            <Copy k="account" /> →
          </a>
        </div>
        {privateVisible && review && same(review) && (
          <Dialog title={t(review.kind === 'create' ? 'createTitle' : 'revokeTitle')} onClose={close}>
            <div className="promotions__review">
              <p className="muted">
                <Copy k="owner" />
              </p>
              <p className="promotions__ref" lang="zxx">
                {review.owner}
              </p>
              {review.kind === 'create' ? (
                <>
                  <p>
                    <Copy k="createBody" />
                  </p>
                  <p className="muted">
                    <Copy k="createBoundary" />
                  </p>
                  <p className="muted">
                    <Copy k="createPrivacy" />
                  </p>
                </>
              ) : (
                <>
                  {review.snapshot && privateField(review.snapshot, t('shown'))}
                  <div className="promotions__consequence">
                    <p>
                      <Copy k="revokeScope" />
                    </p>
                    <p className="muted">
                      <Copy k="replacementRisk" />
                    </p>
                  </div>
                  <p className="muted">
                    <Copy k="revokeEffect" />
                  </p>
                </>
              )}
              <Button disabled={busy} onClick={() => void dispatch(review)}>
                <Copy k={review.kind === 'create' ? 'create' : 'revoke'} />
              </Button>
              <Button variant="secondary" disabled={busy} onClick={close}>
                <Copy k="cancel" />
              </Button>
            </div>
          </Dialog>
        )}
      </Page>
    </div>
  );
}
