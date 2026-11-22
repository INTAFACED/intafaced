// volt-room: /verification
import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Field, Select } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, Sheet, StatusChip } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import type { ApiClient } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { ReadFailure, ReadLoading } from '../../shared/read-state';
import { uiCopy } from '../../shared/ui-copy';
import { verificationCopy as copy } from './verification-copy';
import { VerificationLadder } from './VerificationLadder';
import { VerificationCases } from './VerificationCases';
import { VerificationCapabilities } from './VerificationCapabilities';
import { VerificationCapabilityRefused, VerificationRestrictions } from './VerificationRestrictions';
import { VerificationAttempts } from './VerificationAttempts';
import { VerificationGuided } from './VerificationGuided';
import { VerificationProofOfAddress } from './VerificationProofOfAddress';
import { VerificationSelfie } from './VerificationSelfie';
import { VerificationTradingChecks } from './VerificationTradingChecks';
import { verificationTradingCopy } from './verification-trading-copy';
import { KYC_LADDER_LEVELS } from '@intafaced/contracts/identity-kyc-levels';
import { IDENTITY_KYC_PROFILE_READ } from '@intafaced/contracts/identity-kyc-profile-procedures';
import {
  finishVerification,
  readVerification,
  requestedTier,
  saveVerification,
  bankStepsOpen,
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
  type VerificationStatus,
} from './verification-guards';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { callAs } from '../../shared/api';
import { IDENTITY_KYC_SUBMIT } from '@intafaced/contracts/identity-kyc-procedures';

type Original = { owner: string; client: ApiClient; token: string; tier: RequestedTier; country: string; mount: object; path: string };
type Known = {
  original: Original;
  local: VerificationOriginal;
  row?: VerificationRecord;
  refused: boolean;
  /** Set when the refusal was the attempt limit: the seconds the service said were left. */
  retryAfterSeconds?: number;
  /** Set when the level grants a capability compliance switched off (`kyc.capability_inactive`). */
  capabilityOff?: boolean;
  retained: boolean;
  finalized?: boolean;
};
type Problem = 'storage' | 'locks' | 'another' | 'changed' | 'invalidCountry';
/**
 * Whether the ID and selfie steps show before the person asks for the bank's verification. They do not: trading asks for
 * no ID document or selfie (J-cex-spot-01 #3, OWNER 258 (4)), so /verification leads with the trading checks and the
 * bank's steps open on "Start verification for the bank".
 */
const BANK_ROUTE_OPEN = false;
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
  // The ID and selfie steps are for the bank, never for trading (OWNER 258 (4)).
  const [bankRoute, setBankRoute] = useState(BANK_ROUTE_OPEN);
  const trading = verificationTradingCopy.useCopy();
  // A guided draft the person left (J-identity-08 #2): its steps open on their own when they return.
  const guidedDraft = useResource(
    (signal) => (userId ? api.call(IDENTITY_KYC_PROFILE_READ, undefined, { signal }) : Promise.resolve({ ok: true as const, data: null })),
    `verification-bank-draft:${userId}`,
  );
  const [openedSearch] = useState(() => window.location.search);
  const bankOpen = bankStepsOpen(bankRoute, openedSearch, guidedDraft.resource.status === 'ready' ? guidedDraft.resource.data : null);
  const [problem, setProblem] = useState<Problem | null>(null),
    [selected, setSelected] = useState<VerificationRecord | null>(null);
  // At the owner's limit on rejected requests the form holds until the lockout ends (I-kyc-compliance-10).
  const [locked, setLocked] = useState(false),
    [lockRefusals, setLockRefusals] = useState(0);
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
  const { resource, reload } = useResource<VerificationStatus>(
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
    setBankRoute(BANK_ROUTE_OPEN);
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
  const blocked = !userId || busy || locked || !api.canWrite() || verificationBlocked(journal);
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
        const answer = await callAs(
          intent.client,
          IDENTITY_KYC_SUBMIT,
          { tier: intent.tier, jurisdiction: intent.country },
          verificationReply(intent.owner, intent.tier),
          { signal: controller.signal },
        );
        if (!same(intent)) return;
        if (answer.ok || verificationRefused(answer)) {
          const retained = !finishVerification(local);
          const lockout = !answer.ok && answer.code === 'kyc.attempts_exhausted';
          setKnown((previous) => [
            ...previous,
            {
              original: intent,
              local,
              ...(answer.ok ? { row: { ...answer.data } } : {}),
              ...(lockout && answer.retryAfterSeconds ? { retryAfterSeconds: answer.retryAfterSeconds } : {}),
              ...(!answer.ok && answer.status === 409 && answer.code === 'kyc.capability_inactive' ? { capabilityOff: true } : {}),
              refused: !answer.ok,
              retained,
            },
          ]);
          // The attempt limit refused it: read the standing again, so the countdown and the held form show.
          if (lockout) setLockRefusals((n) => n + 1);
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
      <div>
        <h3>
          <Copy k={row.tier} /> · <span lang="zxx">{row.jurisdiction}</span>
        </h3>
        <p className="lt-ref" lang="zxx">
          {row.id}
        </p>
        <KeyValue
          rows={[
            { label: t('status'), value: <Copy k={row.status} /> },
            { label: t('created'), value: time(row.createdAt) },
            { label: t('reviewed'), value: time(row.reviewedAt) },
            { label: t('expiry'), value: time(row.expiresAt) },
          ]}
        />
      </div>
    );
  }
  if (!userId)
    return (
      <FlowTemplate
        title={t('title')}
        state={{ kind: 'ready' }}
        step={
          <EmptyState
            title={t('signIn')}
            body={t('guest')}
            action={
              <a data-testid="text-link" className="lt-link" href="/login?redirect=%2Fverification">
                <Copy k="signIn" />
              </a>
            }
          />
        }
      />
    );
  const request = (
    <section data-testid="verification__request" aria-label={t('requestTitle')}>
      <h2>
        <Copy k="requestTitle" />
      </h2>
      <p className="lt-hint">
        <Copy k="requestBody" />
      </p>
      {casesKey !== null && <VerificationAttempts recordsKey={`${casesKey}:${lockRefusals}`} onLocked={setLocked} />}
      {offeredTiers.length > 0 ? (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          <Select
            label={t('tier')}
            value={privateVisible ? chosenTier : (offeredTiers[0] ?? 'basic')}
            disabled={blocked}
            onChange={(value) => {
              const parsed = requestedTier.safeParse(value);
              if (parsed.success) setTier(parsed.data);
            }}
          >
            {offeredTiers.map((level) => (
              <option key={level} value={level}>
                {t(level)}
              </option>
            ))}
          </Select>
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
          <Button type="submit" tone="primary" disabled={blocked}>
            <Copy k="review" />
          </Button>
        </form>
      ) : (
        <p>
          <Copy k="topLevel" />
        </p>
      )}
      <p className="lt-hint">
        <Copy k="documentBoundary" />
      </p>
      <a data-testid="text-link" className="lt-link" href="/support">
        <Copy k="help" />
      </a>
    </section>
  );
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      step={
        <div data-testid="verification" lang={languageFor('title')}>
          <p>
            <Copy k="owner" /> ·{' '}
            <span className="lt-ref" lang="zxx">
              {userId}
            </span>
          </p>
          {privateVisible && (journal.records.length > 0 || visibleKnown.length > 0) && (
            <section aria-label={t('originals')}>
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
                  <article key={local.requestId} data-testid="verification__original" role="status">
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
                    <p className="lt-ref" lang="zxx">
                      {local.requestId}
                    </p>
                    <p>
                      <Copy k="paused" />
                    </p>
                    <p className="lt-hint">
                      <Copy k="privacy" />
                    </p>
                    <a className="lt-button lt-button-secondary" href="/support">
                      <Copy k="support" />
                    </a>
                  </article>
                ))}
              {visibleKnown.map((receipt) => (
                <article key={receipt.local.requestId} data-testid="verification__original" role="status">
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
                      <p className="lt-hint">
                        <Copy k="replyBoundary" />
                      </p>
                    </>
                  ) : receipt.capabilityOff ? (
                    <VerificationCapabilityRefused recordsKey={receipt.local.requestId} />
                  ) : receipt.retryAfterSeconds ? (
                    <p>
                      <Copy k="refusedLocked" params={{ seconds: String(receipt.retryAfterSeconds) }} />
                    </p>
                  ) : (
                    <p>
                      <Copy k="refusedBody" />
                    </p>
                  )}
                  {receipt.retained && (
                    <div>
                      <h3>
                        <Copy k="retained" />
                      </h3>
                      <p>
                        <Copy k="retainedBody" />
                      </p>
                      <p>
                        <Copy k="reference" />
                      </p>
                      <p className="lt-ref" lang="zxx">
                        {receipt.local.requestId}
                      </p>
                      <Button tone="secondary" disabled={busy} onClick={() => void finalize(receipt)}>
                        <Copy k="finish" />
                      </Button>
                      <p className="lt-hint">
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
            <p data-testid="verification__problem" role="status">
              <Copy k={problem ?? 'storage'} />
            </p>
          )}
          <VerificationTradingChecks disabled={!userId || !api.canWrite()} onDone={reload} />
          {/* The level, then the request form, then the requests (the order the old two columns read in). */}
          {resource.status === 'ready' && (
            <div data-testid="verification__tier">
              <p className="lt-hint">
                <Copy k="current" />
              </p>
              <h2>
                <span data-testid="verification__level-tag" data-status={resource.data.tier === 'none' ? 'working' : 'filled'}>
                  <StatusChip status={resource.data.tier === 'none' ? 'pending' : 'done'} label={t(resource.data.tier)} />
                </span>
              </h2>
              <p className="lt-hint">
                <Copy k="currentBody" />
              </p>
            </div>
          )}
          {request}
          <section data-testid="verification__list" aria-label={t('records')}>
            {resource.status === 'loading' ? (
              <ReadLoading />
            ) : resource.status === 'failed' ? (
              <>
                <div lang="und">
                  <ReadFailure result={resource.failure} retry={reload} />
                </div>
                <p className="lt-hint">
                  <Copy k="readBoundary" />
                </p>
              </>
            ) : (
              <>
                <div data-testid="verification__records">
                  <div className="lt-actions">
                    <h2>
                      <Copy k="records" />
                    </h2>
                    <Button tone="secondary" onClick={reload}>
                      <Copy k="refresh" />
                    </Button>
                  </div>
                  <p className="lt-hint">
                    <Copy k="window" params={{ limit }} />
                  </p>
                  {offeredTiers.length > 0 && (
                    <Button tone="secondary" disabled={blocked} onClick={jump}>
                      <Copy k="jump" />
                    </Button>
                  )}
                  {resource.data.records.length ? (
                    <ul data-testid="verification__rows">
                      {resource.data.records.map((row) => (
                        <li key={row.id}>
                          <div>
                            <strong>
                              <Copy k={row.tier} />
                            </strong>{' '}
                            <span lang="zxx">{row.jurisdiction}</span>{' '}
                            {row.status === 'approved' ? (
                              <span>
                                <Copy k={row.status} />
                              </span>
                            ) : (
                              <span className="lt-hint">
                                <Copy k={row.status} />
                              </span>
                            )}{' '}
                            {time(row.createdAt)}
                            <Button tone="quiet" aria-label={t('inspectId', { id: row.id })} onClick={() => setSelected({ ...row })}>
                              <Copy k="inspect" />
                            </Button>
                          </div>
                          <p className="lt-ref" lang="zxx">
                            {row.id}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title={t('empty')} body={t('emptyBody')} />
                  )}
                  {limit < 200 && resource.data.records.length === limit && (
                    <Button tone="secondary" onClick={() => setLimit((value) => Math.min(200, value + 50))}>
                      <Copy k="expand" params={{ limit: limit + 50 }} />
                    </Button>
                  )}
                  {limit === 200 && (
                    <p className="lt-hint">
                      <Copy k="maximum" />
                    </p>
                  )}
                  {privateVisible && selected && (
                    <section aria-label={t('selected')}>
                      <h2>
                        <Copy k="selected" />
                      </h2>
                      {!resource.data.records.some((row) => row.id === selected.id) && (
                        <p>
                          <Copy k="selectionMissing" />
                        </p>
                      )}
                      {record(selected)}
                      <p className="lt-hint">
                        <Copy k="recordBoundary" />
                      </p>
                    </section>
                  )}
                </div>
              </>
            )}
          </section>
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
            <ReadLoading />
          ) : (
            <>
              {bankOpen ? (
                <>
                  {offeredTiers.length > 0 && <VerificationGuided tier={chosenTier} disabled={blocked} onSent={reload} />}
                  {/* Not the request form's hold either: a selfie is part of the request, so a lockout does not stop it. */}
                  <VerificationSelfie recordsKey={casesKey} disabled={!userId || !api.canWrite()} />
                </>
              ) : (
                <section aria-label={trading.t('bankTitle')} data-testid="verification__bank">
                  <h2>
                    <trading.Copy k="bankTitle" />
                  </h2>
                  <p className="lt-hint">
                    <trading.Copy k="bankBody" />
                  </p>
                  <Button tone="secondary" onClick={() => setBankRoute(true)}>
                    <trading.Copy k="bankOpen" />
                  </Button>
                </section>
              )}
              {/* Not the request form's hold: an attempts lockout or a pending request does not stop proof of address. */}
              <VerificationProofOfAddress recordsKey={casesKey} disabled={!userId || !api.canWrite()} />
              <VerificationCapabilities recordsKey={casesKey} />
              <VerificationRestrictions recordsKey={casesKey} />
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
            <Sheet open title={t('reviewTitle')} onClose={close} dismissible={!busy} closeLabel={uiCopy.t('closeDialog')}>
              <div>
                <p>
                  <Copy k="owner" />
                </p>
                <p className="lt-ref" lang="zxx">
                  {review.owner}
                </p>
                <h3>
                  <Copy k={review.tier} /> · <span lang="zxx">{review.country}</span>
                </h3>
                <p>
                  <Copy k="consequence" />
                </p>
                <p className="lt-hint">
                  <Copy k="permissionBoundary" />
                </p>
                <div className="lt-actions">
                  <Button tone="primary" disabled={busy} onClick={() => void dispatch(review)}>
                    <Copy k="submit" />
                  </Button>
                  <Button tone="quiet" disabled={busy} onClick={close}>
                    <Copy k="cancel" />
                  </Button>
                </div>
              </div>
            </Sheet>
          )}
        </div>
      }
    />
  );
}
