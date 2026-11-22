import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, EmptyState, Field } from '@intafaced/ui/lit';
import { SettingsTemplate, Sheet } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from './kit-parts';
import { subaccountCopy as copy } from './subaccount-copy';
import { SubaccountDelete } from './SubaccountDelete';
import { SubaccountFeatures } from './SubaccountFeatures';
import { SubaccountUse } from './SubaccountUse';
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
import { RankPerks } from './RankPerks';
import { Membership } from './Membership';
import { VerifyEmail } from './VerifyEmail';
import { AccountStatus } from './AccountStatus';
import { EligibilityStatement } from '../money';
import { accountScreenCopy } from '../../screens/account/copy';
import { accountStatusCopy } from './account-status-copy';
import { rankPerksCopy } from './rank-perks-copy';
import { membershipCopy } from './membership-copy';
import { useIdentity } from '../../screens/pay/identity-state';
import { featureById } from '../../app/feature-registry';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { IDENTITY_SUB_ACCOUNTS_CREATE, IDENTITY_SUB_ACCOUNTS_REVOKE } from '@intafaced/contracts/identity-sub-accounts-procedures';

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

/** Copies `value` to the clipboard and says so for two seconds. The value is shown by the caller, never changed here. */
function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = accountScreenCopy.useCopy();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }
  return (
    <>
      <Button tone="secondary" aria-label={label ?? t('Copy account ID')} onClick={() => void copyValue()}>
        {state === 'done' ? t('Copied') : t('Copy')}
      </Button>
      <span className="lt-sr" role="status">
        {state === 'done' ? t('Copied') : state === 'failed' ? t('Copy failed') : ''}
      </span>
    </>
  );
}

export function Account() {
  const { api, userId } = useSession();
  const { t, Copy, languageFor, requestedLocale } = copy.useCopy();
  const identity = useIdentity(api, userId);
  const statusCopy = accountStatusCopy.useCopy();
  const rankCopy = rankPerksCopy.useCopy();
  const memberCopy = membershipCopy.useCopy();
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
            ? await intent.client.call(
                IDENTITY_SUB_ACCOUNTS_CREATE,
                { label: intent.label, ...(intent.purpose ? { purpose: intent.purpose } : {}) },
                { signal: controller.signal },
              )
            : await intent.client.call(IDENTITY_SUB_ACCOUNTS_REVOKE, { subAccountId: intent.row!.id }, { signal: controller.signal });
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
  const sectionLinks: readonly (readonly [string, string])[] = [
    ['#account-id', t('owner')],
    ['#account-status', statusCopy.t('title')],
    ['#rank-perks', rankCopy.t('title')],
    ['#membership', memberCopy.t('title')],
    ...(showSubaccounts ? ([['#subaccounts', t('list')]] as const) : []),
  ];
  return (
    <div lang={languageFor('title')}>
      <SettingsTemplate
        title={t('title')}
        description={t('description')}
        state={{ kind: 'ready' }}
        index={
          <nav aria-label={t('sectionsLabel')}>
            <ul>
              {sectionLinks.map(([href, label]) => (
                <li key={href}>
                  <a className="lt-link" href={href}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        }
        explain={<p>{t('explain')}</p>}
        sections={
          <>
            <VerifyEmail />
            <AccountStatus />
            {identity.status === 'handles' && (
              <section className="lt-title-row" aria-label={t('handle')}>
                <div>
                  <span className="lt-hint">{t('handle')}</span>
                  <p data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                    @{identity.handle}
                  </p>
                </div>
                <CopyButton value={`@${identity.handle}`} label={t('copyHandle')} />
              </section>
            )}
            <section id="account-id" className="lt-title-row" aria-label={t('owner')}>
              <div>
                <span className="lt-hint">{t('owner')}</span>
                <p data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
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
                <div>
                  <section id="subaccounts" data-testid="subaccounts__list" aria-labelledby="subaccount-list-heading">
                    <header>
                      <h2 id="subaccount-list-heading">{t('list')}</h2>
                      {/* Its own row that wraps: beside the title, a phone squeezed the buttons until their words spilled. */}
                      <div className="lt-actions">
                        <Button tone="primary" disabled={blocked('create')} onClick={jump}>
                          {t('new')}
                        </Button>
                        <Button tone="secondary" onClick={reload}>
                          {t('refresh')}
                        </Button>
                      </div>
                    </header>
                    <div className="lt-hint">
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
                      <EmptyState title={t('empty')} body={t('emptyBody')} />
                    ) : (
                      <>
                        {/* J-copy-bots-otc-01 finds a subaccount by `li.subaccounts__row`. */}
                        <ul aria-label={t('list')}>
                          {resource.data.map((row) => (
                            <li className="subaccounts__row" key={row.id}>
                              <div>
                                <strong lang="und">{row.label}</strong>
                                {row.nickname !== null && (
                                  <span data-testid="subaccounts__ref" className="lt-mono lt-hint" lang="und">
                                    {t('nickname', { name: row.nickname })}
                                  </span>
                                )}
                                {row.purpose !== null && (
                                  <p className="lt-hint" lang="und">
                                    {row.purpose}
                                  </p>
                                )}
                                <span data-testid="subaccounts__ref" className="lt-mono lt-hint">
                                  {t(KIND_KEYS[row.kind] as 'kindStandard')}
                                  {row.frozen ? ` · ${t('frozen')}` : ''}
                                </span>
                                <span data-testid="subaccounts__ref" className="lt-mono lt-hint" lang="zxx">
                                  {row.id}
                                </span>
                                <time
                                  data-testid="subaccounts__ref"
                                  className="lt-mono lt-hint"
                                  dateTime={row.createdAt}
                                  lang={requestedLocale}
                                >
                                  {t('created', { time: stamp(row.createdAt, timeZone) })}
                                </time>
                              </div>
                              <span data-state={row.revoked ? 'revoked' : 'active'}>{t(row.revoked ? 'revoked' : 'active')}</span>
                              {row.revoked ? (
                                <span>{t('noAction')}</span>
                              ) : (
                                <Button
                                  tone="secondary"
                                  aria-label={t('reviewTarget', { id: row.id })}
                                  disabled={blocked('revoke', row.id)}
                                  onClick={() => open('revoke', row)}
                                >
                                  {t('reviewRevoke')}
                                </Button>
                              )}
                              {!row.revoked && !row.frozen && <SubaccountUse subAccountId={row.id} />}
                              {!row.revoked && <SubaccountFeatures subAccountId={row.id} />}
                              {!row.revoked && <SubaccountDelete subAccountId={row.id} onDeleted={reload} />}
                            </li>
                          ))}
                        </ul>
                        {resource.data.length === limit && (
                          <div className="lt-actions">
                            {limit < 200 ? (
                              <Button tone="secondary" onClick={() => setLimit(200)}>
                                {t('expand')}
                              </Button>
                            ) : (
                              <p className="lt-hint">{t('maximum')}</p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </section>
                  <section data-testid="subaccounts__create" aria-labelledby="subaccount-create-heading">
                    <header>
                      <h2 id="subaccount-create-heading">{t('createTitle')}</h2>
                      <p className="lt-hint">{t('createBody')}</p>
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
                      <Button tone="primary" type="submit" disabled={blocked('create')}>
                        {t('reviewCreate')}
                      </Button>
                      <p className="lt-hint">{t('reviewHint')}</p>
                    </form>
                  </section>
                </div>
                {(problem || journal.failed) && <p role="status">{t(problem ?? 'storage')}</p>}
                {preflightFailure && (
                  <div lang="und">
                    <Failure result={preflightFailure} retry={reload} />
                  </div>
                )}
                <p role="status" aria-live="polite" aria-atomic="true">
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
                  <section aria-label={t('originalRequests')}>
                    <h2>{t('originalRequests')}</h2>
                    {unknowns.map((record) => {
                      const intent = intents[record.requestId],
                        ownIntent = intent && sameActor(intent) ? intent : null;
                      const sending = busy && ownIntent === active;
                      return (
                        <article data-testid="subaccounts__request" key={record.requestId}>
                          <h2>{t(sending ? 'sending' : record.kind === 'create' ? 'unknownCreate' : 'unknownRevoke')}</h2>
                          {!sending && (
                            <p role="status" className="lt-hint">
                              {t(record.kind === 'create' ? 'unknownCreateBody' : 'unknownRevokeBody')}
                            </p>
                          )}
                          {ownIntent ? (
                            <div>
                              <strong lang="und">{ownIntent.label}</strong>
                              {ownIntent.purpose && (
                                <p className="lt-hint" lang="und">
                                  {ownIntent.purpose}
                                </p>
                              )}
                            </div>
                          ) : (
                            <p className="lt-hint">{t('memoryLost')}</p>
                          )}
                          <dl>
                            {record.target && (
                              <div>
                                <dt>{t('target')}</dt>
                                <dd data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                                  {record.target}
                                </dd>
                              </div>
                            )}
                            <div>
                              <dt>{t('request')}</dt>
                              <dd data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                                {record.requestId}
                              </dd>
                            </div>
                          </dl>
                          <p className="lt-hint">{t('referenceBoundary')}</p>
                          <p className="lt-hint">{t('lookup')}</p>
                          <div className="lt-actions">
                            <Button tone="secondary" onClick={reload}>
                              {t('records')}
                            </Button>
                            <a className="lt-link" href="/support">
                              {t('support')}
                            </a>
                          </div>
                        </article>
                      );
                    })}
                    {visibleReceipts.map((receipt) => (
                      <article data-testid="subaccounts__request" key={receipt.record.requestId}>
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
                          <p lang="und" className="lt-hint">
                            {receipt.original.purpose}
                          </p>
                        )}
                        <dl>
                          {(receipt.id || receipt.record.target) && (
                            <div>
                              <dt>{t('target')}</dt>
                              <dd data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                                {receipt.id ?? receipt.record.target}
                              </dd>
                            </div>
                          )}
                          <div>
                            <dt>{t('request')}</dt>
                            <dd data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                              {receipt.record.requestId}
                            </dd>
                          </div>
                        </dl>
                        {!receipt.answer.ok && (
                          <div>
                            <RefusalSentence receipt={receipt} />
                            <p data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                              HTTP {receipt.answer.status} · {receipt.answer.code}
                            </p>
                          </div>
                        )}
                        <p className="lt-hint">{t('separate')}</p>
                        {receipt.retained && (
                          <>
                            <p role="status">{t('retained')}</p>
                            <p className="lt-hint">{t('retainedBody')}</p>
                            <div className="lt-actions">
                              <Button tone="secondary" disabled={busy} onClick={() => void finalize(receipt)}>
                                {t('finalize')}
                              </Button>
                              <a className="lt-link" href="/support">
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
                  <Sheet open title={t(visibleReview.kind === 'create' ? 'createReview' : 'revokeReview')} onClose={close}>
                    <div lang={languageFor('title')}>
                      <strong lang="und">{visibleReview.label}</strong>
                      {visibleReview.purpose && (
                        <p className="lt-hint" lang="und">
                          {visibleReview.purpose}
                        </p>
                      )}
                      <dl>
                        <div>
                          <dt>{t('owner')}</dt>
                          <dd data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                            {visibleReview.owner}
                          </dd>
                        </div>
                        {visibleReview.row && (
                          <div>
                            <dt>{t('target')}</dt>
                            <dd data-testid="subaccounts__ref" className="lt-mono" lang="zxx">
                              {visibleReview.row.id}
                            </dd>
                          </div>
                        )}
                      </dl>
                      <p className="lt-hint">{t(visibleReview.kind === 'create' ? 'createConsequence' : 'revokeConsequence')}</p>
                      <p className="lt-hint">
                        {t(visibleReview.kind === 'create' ? 'createUnknownConsequence' : 'revokeUnknownConsequence')}
                      </p>
                      <Button tone="primary" disabled={busy} onClick={() => void dispatch(visibleReview)}>
                        {t(visibleReview.kind === 'create' ? 'create' : 'revoke')}
                      </Button>
                    </div>
                  </Sheet>
                )}
              </>
            )}
          </>
        }
      />
    </div>
  );
}
