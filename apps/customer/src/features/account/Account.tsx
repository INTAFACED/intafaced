import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Field, Loading, Page } from '../../shared/ui';
import { subaccountCopy as copy } from './subaccount-copy';
import { SubaccountDelete } from './SubaccountDelete';
import { SubaccountFeatures } from './SubaccountFeatures';
import { isDeleteRefusal } from './sub-account-delete';
import {
  KIND_KEYS,
  createRefusalKey,
  finishSubaccount,
  isCreateRefusal,
  readSubaccounts,
  sameSubaccount,
  saveSubaccount,
  subaccountBlocked,
  subaccountKey,
  subaccountLock,
  subaccountsIn,
  type Subaccount,
  type SubaccountJournal,
  type SubaccountKind,
  type SubaccountRecord,
} from './subaccount-guards';
import './subaccount.css';
import { RankPerks } from './RankPerks';
import { Membership } from './Membership';
import { VerifyEmail } from './VerifyEmail';
import { EligibilityStatement } from '../money/Eligibility';
import { CopyButton } from '../../screens/account/CopyButton';
import { useIdentity } from '../../screens/pay/identity-state';
import { featureById } from '../../app/feature-registry';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';

type Original = {
  owner: string;
  client: ApiClient;
  kind: SubaccountKind;
  label: string;
  purpose?: string;
  row?: Subaccount;
  limit: number;
};
type Problem = 'storage' | 'locks' | 'another' | 'changed' | 'rowChanged' | 'preflight' | 'invalidLabel';
type Receipt = {
  original: Original;
  record: SubaccountRecord;
  result: 'created' | 'revoked' | 'noChange' | 'refused';
  answer: ApiResult<unknown>;
  id?: string;
  retained: boolean;
  finalized?: boolean;
};
const emptyJournal: SubaccountJournal = { records: [], failed: false };

/** A known create refusal in this page's words; any other refusal in the service's own words. */
function RefusalSentence({ receipt }: { receipt: Receipt }) {
  const { t } = copy.useCopy();
  const key = receipt.original.kind === 'create' ? createRefusalKey(receipt.answer) : undefined;
  if (key) return <p>{t(key)}</p>;
  return receipt.answer.ok ? null : <p lang="und">{receipt.answer.message}</p>;
}

export function Account() {
  const { api, userId } = useSession();
  const { t, Copy, languageFor, requestedLocale } = copy.useCopy();
  const identity = useIdentity(api, userId);
  const { timeZone } = usePreferences();
  // Strategy subaccounts are a blocked feature (feature-registry.ts): the cards show and refuse honestly; only a row marked hidden would drop them.
  const showSubaccounts = featureById('strategy-subaccounts')?.status !== 'hidden';
  const [limit, setLimit] = useState(50),
    [label, setLabel] = useState(''),
    [purpose, setPurpose] = useState('');
  const [review, setReview] = useState<Original | null>(null),
    [active, setActive] = useState<Original | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [intents, setIntents] = useState<Record<string, Original>>({});
  const [stored, setStored] = useState<{ owner: string | null; value: SubaccountJournal }>(() => ({
    owner: userId,
    value: userId ? readSubaccounts(userId) : emptyJournal,
  }));
  const mounted = useRef(true),
    original = useRef<Original | null>(null),
    running = useRef<Original | null>(null);
  const abort = useRef<AbortController | null>(null),
    form = useRef<HTMLFormElement | null>(null);
  const current = useRef({ api, userId });
  const privateContext = useRef({ api, userId });
  const privateVisible = privateContext.current.api === api && privateContext.current.userId === userId;
  current.current = { api, userId };
  const clientVersion = useRef({ api, value: 0 });
  if (clientVersion.current.api !== api) clientVersion.current = { api, value: clientVersion.current.value + 1 };
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'subAccounts.list', { limit }, subaccountsIn(limit), { signal })
        : Promise.resolve({ ok: true as const, data: [] }),
    `account-subaccounts:${userId}:${clientVersion.current.value}:${limit}`,
  );
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === subaccountKey(userId) || event.key === null))
        setStored({ owner: userId, value: readSubaccounts(userId) });
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
    setLabel('');
    setPurpose('');
    setReceipts([]);
    setIntents({});
    setProblem(null);
    setPreflightFailure(null);
    setStored({ owner: userId, value: userId ? readSubaccounts(userId) : emptyJournal });
  }, [api, userId]);
  const sameActor = (intent: Original) =>
    mounted.current && current.current.userId === intent.owner && current.current.api === intent.client && intent.client.canWrite();
  const same = (intent: Original) => sameActor(intent) && original.current === intent;
  const journal = stored.owner === userId ? stored.value : userId ? readSubaccounts(userId) : emptyJournal;
  const busy = Boolean(active && sameActor(active));
  const blocked = (kind: SubaccountKind, target?: string) => !userId || busy || !api.canWrite() || subaccountBlocked(journal, kind, target);
  const visibleReceipts = receipts.filter((receipt) => sameActor(receipt.original));
  function sync(owner: string) {
    if (mounted.current && current.current.userId === owner) setStored({ owner, value: readSubaccounts(owner) });
  }
  function open(kind: SubaccountKind, row?: Subaccount) {
    if (!userId || blocked(kind, row?.id) || (running.current && sameActor(running.current))) return;
    const latest = readSubaccounts(userId);
    setStored({ owner: userId, value: latest });
    if (subaccountBlocked(latest, kind, row?.id)) return;
    const normalizedLabel = label.trim(),
      normalizedPurpose = purpose.trim();
    if (kind === 'create' && (!normalizedLabel || normalizedLabel.length > 64)) {
      setProblem('invalidLabel');
      return;
    }
    if (row?.revoked) return;
    const intent: Original = {
      owner: userId,
      client: api,
      kind,
      label: kind === 'create' ? normalizedLabel : row!.label,
      ...(kind === 'create'
        ? normalizedPurpose
          ? { purpose: normalizedPurpose }
          : {}
        : row?.purpose === null
          ? {}
          : { purpose: row?.purpose }),
      ...(row ? { row: { ...row } } : {}),
      limit,
    };
    original.current = intent;
    setReview(intent);
    setProblem(null);
    setPreflightFailure(null);
  }
  function close() {
    if (!busy) {
      original.current = null;
      setReview(null);
    }
  }
  function jump() {
    if (blocked('create')) return;
    const input = form.current?.querySelector<HTMLInputElement>('input[name="subaccount-label"]');
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  async function dispatch(intent: Original) {
    if (!same(intent) || (running.current && sameActor(running.current))) return;
    running.current = intent;
    setActive(intent);
    setReview(null);
    setProblem(null);
    setPreflightFailure(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (!navigator.locks) {
        if (same(intent)) setProblem('locks');
        return;
      }
      await navigator.locks.request(subaccountLock(intent.owner), { ifAvailable: true }, async (lock) => {
        if (!same(intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readSubaccounts(intent.owner);
        sync(intent.owner);
        if (subaccountBlocked(latest, intent.kind, intent.row?.id)) {
          if (latest.failed) setProblem('storage');
          return;
        }
        const fresh = await intent.client.query('identity', 'subAccounts.list', { limit: intent.limit }, subaccountsIn(intent.limit), {
          signal: controller.signal,
        });
        if (!same(intent)) return;
        if (!fresh.ok) {
          setProblem('preflight');
          setPreflightFailure(fresh);
          return;
        }
        if (intent.kind === 'revoke') {
          const row = fresh.data.find((item) => item.id === intent.row?.id);
          if (!row || !intent.row || row.revoked || !sameSubaccount(row, intent.row)) {
            setProblem('rowChanged');
            reload();
            return;
          }
        }
        if (!same(intent)) return;
        const record: SubaccountRecord = {
          owner: intent.owner,
          kind: intent.kind,
          requestId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ...(intent.row ? { target: intent.row.id } : {}),
        };
        if (!saveSubaccount(record)) {
          sync(intent.owner);
          setProblem('storage');
          return;
        }
        sync(intent.owner);
        setIntents((previous) => ({ ...previous, [record.requestId]: intent }));
        if (!same(intent)) return;
        const answer =
          intent.kind === 'create'
            ? await intent.client.mutate(
                'identity',
                'subAccounts.create',
                { label: intent.label, ...(intent.purpose ? { purpose: intent.purpose } : {}) },
                z.object({ id: z.string().guid() }),
                { signal: controller.signal },
              )
            : await intent.client.mutate(
                'identity',
                'subAccounts.revoke',
                { subAccountId: intent.row!.id },
                z.object({ revoked: z.boolean() }),
                { signal: controller.signal },
              );
        if (!same(intent)) return;
        const known =
          answer.ok || (intent.kind === 'create' && isCreateRefusal(answer)) || (intent.kind === 'revoke' && isDeleteRefusal(answer));
        if (known) {
          const retained = !finishSubaccount(record);
          const createdId = answer.ok && 'id' in answer.data ? answer.data.id : undefined;
          const result: Receipt['result'] = !answer.ok
            ? 'refused'
            : intent.kind === 'create'
              ? 'created'
              : 'revoked' in answer.data && answer.data.revoked
                ? 'revoked'
                : 'noChange';
          setReceipts((previous) => [
            ...previous,
            { original: intent, record, answer, result, retained, ...(createdId ? { id: createdId } : {}) },
          ]);
          if (answer.ok) {
            if (intent.kind === 'create') {
              setLabel('');
              setPurpose('');
            }
            reload();
          }
        }
        sync(intent.owner);
      });
    } catch {
      if (same(intent)) {
        setProblem('storage');
        sync(intent.owner);
      }
    } finally {
      if (running.current === intent) running.current = null;
      if (sameActor(intent)) setActive(null);
    }
  }
  async function finalize(receipt: Receipt) {
    if (!sameActor(receipt.original) || busy || !receipt.retained || !navigator.locks) return;
    try {
      await navigator.locks.request(subaccountLock(receipt.record.owner), { ifAvailable: true }, (lock) => {
        if (!sameActor(receipt.original)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        if (!finishSubaccount(receipt.record)) {
          setProblem('storage');
          sync(receipt.record.owner);
          return;
        }
        sync(receipt.record.owner);
        setReceipts((previous) => previous.map((item) => (item === receipt ? { ...item, retained: false, finalized: true } : item)));
        setProblem(null);
      });
    } catch {
      if (sameActor(receipt.original)) setProblem('storage');
    }
  }
  function reviewCreate(event: FormEvent) {
    event.preventDefault();
    open('create');
  }
  const unknowns = journal.records.filter((record) => !visibleReceipts.some((receipt) => receipt.record.requestId === record.requestId));
  const visibleReview = review && same(review) ? review : null;
  return (
    <div className="subaccounts" lang={languageFor('title')}>
      <Page title={t('title')} description={t('description')}>
        <VerifyEmail />
        {identity.status === 'handles' && (
          <section className="subaccounts__identity" aria-label={t('handle')}>
            <div>
              <span className="muted">{t('handle')}</span>
              <p data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                @{identity.handle}
              </p>
            </div>
            <CopyButton value={`@${identity.handle}`} label={t('copyHandle')} />
          </section>
        )}
        <section className="subaccounts__identity" aria-label={t('owner')}>
          <div>
            <span className="muted">{t('owner')}</span>
            <p data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
              {userId}
            </p>
          </div>
          {userId && <CopyButton value={userId} label={t('copyId')} />}
        </section>
        <RankPerks />
        <Membership />
        <EligibilityStatement />
        {showSubaccounts && (
          <>
            <div className="subaccounts__columns">
              <section data-testid="subaccounts__list" className="subaccounts__list" aria-labelledby="subaccount-list-heading">
                <header className="subaccounts__heading">
                  <h2 id="subaccount-list-heading">{t('list')}</h2>
                  <Button className="subaccounts__jump" disabled={blocked('create')} onClick={jump}>
                    {t('new')}
                  </Button>
                  <Button className="subaccounts__refresh" variant="secondary" onClick={reload}>
                    {t('refresh')}
                  </Button>
                </header>
                <div className="subaccounts__boundary">
                  <Copy k="boundary" />
                  <Copy k="window" params={{ limit }} />
                </div>
                {resource.status === 'loading' ? (
                  <Loading />
                ) : resource.status === 'failed' ? (
                  <div lang="und">
                    <Failure result={resource.failure} retry={reload} />
                  </div>
                ) : resource.data.length === 0 ? (
                  <EmptyState title={t('empty')}>{t('emptyBody')}</EmptyState>
                ) : (
                  <>
                    <ul className="subaccounts__rows" aria-label={t('list')}>
                      {resource.data.map((row) => (
                        <li className="subaccounts__row" key={row.id}>
                          <div className="subaccounts__details">
                            <strong lang="und">{row.label}</strong>
                            {row.nickname !== null && (
                              <span data-testid="subaccounts__ref" className="subaccounts__ref muted" lang="und">
                                {t('nickname', { name: row.nickname })}
                              </span>
                            )}
                            {row.purpose !== null && (
                              <p className="muted" lang="und">
                                {row.purpose}
                              </p>
                            )}
                            <span data-testid="subaccounts__ref" className="subaccounts__ref muted">
                              {t(KIND_KEYS[row.kind] as 'kindStandard')}
                              {row.frozen ? ` · ${t('frozen')}` : ''}
                            </span>
                            <span data-testid="subaccounts__ref" className="subaccounts__ref muted" lang="zxx">
                              {row.id}
                            </span>
                            <time
                              data-testid="subaccounts__ref"
                              className="subaccounts__ref muted"
                              dateTime={row.createdAt}
                              lang={requestedLocale}
                            >
                              {t('created', { time: stamp(row.createdAt, timeZone) })}
                            </time>
                          </div>
                          <span className={`subaccounts__status${row.revoked ? '' : ' subaccounts__status--active'}`}>
                            {t(row.revoked ? 'revoked' : 'active')}
                          </span>
                          {row.revoked ? (
                            <span className="subaccounts__status">{t('noAction')}</span>
                          ) : (
                            <Button
                              variant="secondary"
                              aria-label={t('reviewTarget', { id: row.id })}
                              disabled={blocked('revoke', row.id)}
                              onClick={() => open('revoke', row)}
                            >
                              {t('reviewRevoke')}
                            </Button>
                          )}
                          {!row.revoked && <SubaccountFeatures subAccountId={row.id} />}
                          {!row.revoked && <SubaccountDelete subAccountId={row.id} onDeleted={reload} />}
                        </li>
                      ))}
                    </ul>
                    {resource.data.length === limit && (
                      <div className="stack">
                        {limit < 200 ? (
                          <Button variant="secondary" onClick={() => setLimit(200)}>
                            {t('expand')}
                          </Button>
                        ) : (
                          <p className="muted">{t('maximum')}</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
              <section data-testid="subaccounts__create" className="subaccounts__create" aria-labelledby="subaccount-create-heading">
                <header>
                  <h2 id="subaccount-create-heading">{t('createTitle')}</h2>
                  <p className="muted">{t('createBody')}</p>
                </header>
                <form ref={form} onSubmit={reviewCreate}>
                  <Field
                    label={t('label')}
                    name="subaccount-label"
                    required
                    maxLength={64}
                    value={privateVisible ? label : ''}
                    lang="und"
                    autoComplete="off"
                    onChange={(event) => setLabel(event.target.value)}
                  />
                  <Field
                    label={t('purpose')}
                    name="subaccount-purpose"
                    maxLength={200}
                    value={privateVisible ? purpose : ''}
                    lang="und"
                    autoComplete="off"
                    onChange={(event) => setPurpose(event.target.value)}
                  />
                  <Button type="submit" disabled={blocked('create')}>
                    {t('reviewCreate')}
                  </Button>
                  <p className="muted">{t('reviewHint')}</p>
                </form>
              </section>
            </div>
            {(problem || journal.failed) && (
              <p className="notice" role="status">
                {t(problem ?? 'storage')}
              </p>
            )}
            {preflightFailure && (
              <div lang="und">
                <Failure result={preflightFailure} retry={reload} />
              </div>
            )}
            <p className="subaccounts__announcement" role="status" aria-live="polite" aria-atomic="true">
              {busy
                ? t('sending')
                : visibleReceipts.length
                  ? t(
                      visibleReceipts.at(-1)!.finalized
                        ? 'finalized'
                        : visibleReceipts.at(-1)!.retained
                          ? 'retained'
                          : visibleReceipts.at(-1)!.result === 'created'
                            ? 'createdReceipt'
                            : visibleReceipts.at(-1)!.result === 'revoked'
                              ? 'revokedReceipt'
                              : visibleReceipts.at(-1)!.result === 'noChange'
                                ? 'noChangeBody'
                                : 'refusedBody',
                    )
                  : unknowns.length
                    ? t(unknowns.at(-1)!.kind === 'create' ? 'unknownCreate' : 'unknownRevoke')
                    : ''}
            </p>
            {(unknowns.length > 0 || visibleReceipts.length > 0) && (
              <section className="subaccounts__requests" aria-label={t('originalRequests')}>
                <h2>{t('originalRequests')}</h2>
                {unknowns.map((record) => {
                  const intent = intents[record.requestId],
                    ownIntent = intent && sameActor(intent) ? intent : null;
                  const sending = busy && ownIntent === active;
                  return (
                    <article data-testid="subaccounts__request" className="subaccounts__request" key={record.requestId}>
                      <h2>{t(sending ? 'sending' : record.kind === 'create' ? 'unknownCreate' : 'unknownRevoke')}</h2>
                      {!sending && (
                        <p role="status" className="muted">
                          {t(record.kind === 'create' ? 'unknownCreateBody' : 'unknownRevokeBody')}
                        </p>
                      )}
                      {ownIntent ? (
                        <div>
                          <strong lang="und">{ownIntent.label}</strong>
                          {ownIntent.purpose && (
                            <p className="muted" lang="und">
                              {ownIntent.purpose}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="muted">{t('memoryLost')}</p>
                      )}
                      <dl>
                        {record.target && (
                          <div>
                            <dt>{t('target')}</dt>
                            <dd data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                              {record.target}
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>{t('request')}</dt>
                          <dd data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                            {record.requestId}
                          </dd>
                        </div>
                      </dl>
                      <p className="muted">{t('referenceBoundary')}</p>
                      <p className="muted">{t('lookup')}</p>
                      <div className="actions">
                        <Button variant="secondary" onClick={reload}>
                          {t('records')}
                        </Button>
                        <a className="text-link subaccounts__support" href="/support">
                          {t('support')}
                        </a>
                      </div>
                    </article>
                  );
                })}
                {visibleReceipts.map((receipt) => (
                  <article data-testid="subaccounts__request" className="subaccounts__request" key={receipt.record.requestId}>
                    <h2>
                      {t(
                        receipt.result === 'noChange'
                          ? 'noChangeTitle'
                          : receipt.result === 'refused'
                            ? receipt.original.kind === 'revoke'
                              ? 'revokeRefused'
                              : 'refused'
                            : receipt.result === 'created'
                              ? 'createdReceipt'
                              : 'revokedReceipt',
                      )}
                    </h2>
                    <p role="status">
                      {t(
                        receipt.result === 'noChange'
                          ? 'noChangeBody'
                          : receipt.result === 'refused'
                            ? receipt.original.kind === 'revoke'
                              ? 'revokeRefusedBody'
                              : 'refusedBody'
                            : receipt.result === 'created'
                              ? 'createdReceipt'
                              : 'revokedReceipt',
                      )}
                    </p>
                    <strong lang="und">{receipt.original.label}</strong>
                    {receipt.original.purpose && (
                      <p lang="und" className="muted">
                        {receipt.original.purpose}
                      </p>
                    )}
                    <dl>
                      {(receipt.id || receipt.record.target) && (
                        <div>
                          <dt>{t('target')}</dt>
                          <dd data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                            {receipt.id ?? receipt.record.target}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt>{t('request')}</dt>
                        <dd data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                          {receipt.record.requestId}
                        </dd>
                      </div>
                    </dl>
                    {!receipt.answer.ok && (
                      <div className="stack">
                        <RefusalSentence receipt={receipt} />
                        <p data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                          HTTP {receipt.answer.status} · {receipt.answer.code}
                        </p>
                      </div>
                    )}
                    <p className="muted">{t('separate')}</p>
                    {receipt.retained && (
                      <>
                        <p role="status">{t('retained')}</p>
                        <p className="muted">{t('retainedBody')}</p>
                        <div className="actions">
                          <Button variant="secondary" disabled={busy} onClick={() => void finalize(receipt)}>
                            {t('finalize')}
                          </Button>
                          <a className="text-link subaccounts__support" href="/support">
                            {t('support')}
                          </a>
                        </div>
                      </>
                    )}
                    {receipt.finalized && <p role="status">{t('finalized')}</p>}
                  </article>
                ))}
              </section>
            )}
            {visibleReview && (
              <Dialog title={t(visibleReview.kind === 'create' ? 'createReview' : 'revokeReview')} onClose={close}>
                <div className="stack subaccounts__review" lang={languageFor('title')}>
                  <strong lang="und">{visibleReview.label}</strong>
                  {visibleReview.purpose && (
                    <p className="muted" lang="und">
                      {visibleReview.purpose}
                    </p>
                  )}
                  <dl>
                    <div>
                      <dt>{t('owner')}</dt>
                      <dd data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                        {visibleReview.owner}
                      </dd>
                    </div>
                    {visibleReview.row && (
                      <div>
                        <dt>{t('target')}</dt>
                        <dd data-testid="subaccounts__ref" className="subaccounts__ref" lang="zxx">
                          {visibleReview.row.id}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <p className="muted">{t(visibleReview.kind === 'create' ? 'createConsequence' : 'revokeConsequence')}</p>
                  <p className="muted">{t(visibleReview.kind === 'create' ? 'createUnknownConsequence' : 'revokeUnknownConsequence')}</p>
                  <Button disabled={busy} onClick={() => void dispatch(visibleReview)}>
                    {t(visibleReview.kind === 'create' ? 'create' : 'revoke')}
                  </Button>
                </div>
              </Dialog>
            )}
          </>
        )}
      </Page>
    </div>
  );
}
