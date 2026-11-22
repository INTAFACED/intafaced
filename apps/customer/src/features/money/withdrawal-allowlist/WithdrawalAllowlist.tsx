import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, EmptyState, Field, Select } from '@intafaced/ui/lit';
import { SettingsTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { useSession } from '../../session';
import { amount, date } from '../components';
import { Failure, Loading, Panel } from '../bank-settings/parts';
import { StepUpSheet } from '../bank-settings/StepUpSheet';
import { allowlistCopy } from '../withdrawal-allowlist-copy';
import { createAllowlistReads, requestedChange, type AllowlistChange, type AllowlistGroup } from '../withdrawal-allowlist-reads';

export type AllowlistReadContext = { current: () => boolean };
const href = (id: string) => `/uc/withdraw/allowlist?changeId=${encodeURIComponent(id)}`;

/** One reference per started action: a retry inside the confirmation is the same request, a new action is a new one. */
const newRef = () => crypto.randomUUID();
const POSITIVE = /^\d+(\.\d{1,18})?$/;
const positive = (value: string) => POSITIVE.test(value) && /[1-9]/.test(value);

function useHandlerCurrent(current: () => boolean) {
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  return () => rendered.current === rendering && current();
}

const failureKeys: Record<string, 'invalidId' | 'invalidWindow' | 'signedOut'> = {
  'allowlist.input_invalid': 'invalidId',
  'allowlist.window_invalid': 'invalidWindow',
  'allowlist.session_required': 'signedOut',
};

function ReadResult<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (value: T) => ReactNode }) {
  const { t } = allowlistCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'ready') return <>{children(resource.data)}</>;
  const result = resource.failure;
  if (result.status === 404 || result.code === 'allowlist.not_found')
    return (
      <div data-testid="failure" className="lt-refusal" data-refusal="refused" role="status">
        <h3 className="lt-refusal-title">{t('notFound')}</h3>
        <p className="lt-refusal-body">{t('notFoundNote')}</p>
        <Button tone="secondary" onClick={retry}>
          {t('refreshRecord')}
        </Button>
      </div>
    );
  const key = result.code ? failureKeys[result.code] : undefined;
  const failure: Extract<ApiResult<T>, { ok: false }> = key ? { ...result, message: t(key), messageCopy: undefined } : result;
  return (
    <div lang={key || result.messageCopy ? undefined : 'und'}>
      <Failure result={failure} retry={retry} />
    </div>
  );
}

function Mode({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource((signal) => createAllowlistReads(api, userId, current).mode(signal), `${userId}:allowlist-mode`);
  const [ask, setAsk] = useState<{ ref: string; enabled: boolean } | null>(null);
  const [sent, setSent] = useState<'sentApplied' | 'sentRequest' | null>(null);
  return (
    <Panel id="allowlist-mode" title={t('modeTitle')} lead={t('modeNote')}>
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(mode) => (
          <>
            <p role="status" data-testid="allowlist-mode">
              <strong>{mode.enabled ? t('modeOn') : t('modeOff')}</strong>{' '}
              <span className="lt-hint">{mode.setAt ? t('modeSince', { when: date(mode.setAt) }) : t('modeNever')}</span>
            </p>
            {sent && <p role="status">{t(sent)}</p>}
            <div className="lt-actions">
              <Button
                tone="primary"
                onClick={() => {
                  if (active()) setAsk({ ref: newRef(), enabled: !mode.enabled });
                }}
              >
                {mode.enabled ? t('turnOff') : t('turnOn')}
              </Button>
            </div>
            {ask && (
              <StepUpSheet
                run={(token) => createAllowlistReads(api, userId, current).setMode(ask.enabled, ask.ref, token)}
                onDone={() => {
                  if (!active()) return;
                  setSent(ask.enabled ? 'sentApplied' : 'sentRequest');
                  setAsk(null);
                  reload();
                }}
                onCancel={() => setAsk(null)}
              />
            )}
          </>
        )}
      </ReadResult>
    </Panel>
  );
}

const GROUPS: readonly AllowlistGroup[] = ['external_wallet', 'internal_wallet', 'contract'];

function AddForm({ current, onDone, onCancel }: { current: () => boolean; onDone: () => void; onCancel: () => void }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const [group, setGroup] = useState<AllowlistGroup>('external_wallet');
  const [assetId, setAssetId] = useState('');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [ask, setAsk] = useState<{ ref: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const values = { group, assetId: assetId.trim().toUpperCase(), address: address.trim(), label: label.trim() };
  return (
    <>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!values.assetId || !values.address || !values.label) return setInvalid(true);
          setInvalid(false);
          setAsk((open) => open ?? { ref: newRef() });
        }}
      >
        <Select
          label={t('group')}
          value={group}
          onChange={(value) => setGroup(value as AllowlistGroup)}
          options={GROUPS.map((value) => ({ value, label: t(value) }))}
        />
        <Field
          label={t('asset')}
          name="allowlist-asset"
          maxLength={32}
          value={assetId}
          onChange={(event) => setAssetId(event.target.value)}
        />
        <Field
          label={t('address')}
          name="allowlist-address"
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Field label={t('label')} name="allowlist-label" maxLength={64} value={label} onChange={(event) => setLabel(event.target.value)} />
        {invalid && (
          <p data-testid="failure" role="alert">
            {t('formInvalid')}
          </p>
        )}
        <div className="lt-actions">
          <Button type="submit" tone="primary">
            {t('submitAdd')}
          </Button>
          <Button tone="quiet" onClick={onCancel}>
            {t('formCancel')}
          </Button>
        </div>
      </form>
      {ask && (
        <StepUpSheet
          why={t('addWhy')}
          run={(token) => createAllowlistReads(api, userId, current).proposeAdd({ ...values, clientRef: ask.ref }, token)}
          onDone={() => {
            if (current()) onDone();
          }}
          onCancel={() => setAsk(null)}
        />
      )}
    </>
  );
}

function Entries({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).entries(limit, signal),
    `${userId}:allowlist-entries:${limit}`,
  );
  const [removing, setRemoving] = useState<{ ref: string; entryId: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <Panel
      id="allowlist-entries"
      title={t('entriesTitle')}
      lead={t('entriesWindow', { limit })}
      actions={
        <Button
          tone="secondary"
          onClick={() => {
            if (active()) reload();
          }}
        >
          {t('refresh')}
        </Button>
      }
    >
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(entries) => (
          <>
            {entries.length ? (
              <ul data-testid="allowlist-entries">
                {entries.map((entry) => (
                  <li data-testid="withdrawal-row" key={entry.id}>
                    <div>
                      <strong>{entry.label}</strong>{' '}
                      <span className="lt-mono" lang="und" data-withdrawal-private>
                        {entry.address}
                      </span>
                      <span>
                        {t(entry.group)} · <span lang="und">{entry.assetId}</span>
                      </span>
                      <span className="lt-chip" data-state={entry.state}>
                        {t(entry.state as 'active')}
                      </span>
                      <span>{entry.lastUsedAt ? <time dateTime={entry.lastUsedAt}>{date(entry.lastUsedAt)}</time> : t('never')}</span>
                    </div>
                    {entry.state === 'suspended' && <p className="lt-hint">{t('suspendedNote')}</p>}
                    {entry.state !== 'removed' && (
                      <Button
                        tone="secondary"
                        onClick={() => {
                          if (active()) setRemoving({ ref: newRef(), entryId: entry.id });
                        }}
                      >
                        {t('remove')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t('entriesEmpty')} body={t('entriesEmptyNote')} />
            )}
            {sent && <p role="status">{t('sentRequest')}</p>}
            <div className="lt-actions">
              <Button
                tone="primary"
                onClick={() => {
                  if (active()) setAdding(true);
                }}
              >
                {t('add')}
              </Button>
            </div>
            {adding && (
              <AddForm
                current={current}
                onDone={() => {
                  setAdding(false);
                  setSent(true);
                  reload();
                }}
                onCancel={() => setAdding(false)}
              />
            )}
            {removing && (
              <StepUpSheet
                why={t('removeWhy')}
                run={(token) => createAllowlistReads(api, userId, current).proposeDelete(removing.entryId, removing.ref, token)}
                onDone={() => {
                  if (!active()) return;
                  setRemoving(null);
                  setSent(true);
                  reload();
                }}
                onCancel={() => setRemoving(null)}
              />
            )}
            <div className="lt-toolbar" role="status">
              <p>
                {t('returned', { count: entries.length, limit })} {entries.length >= limit ? t('more') : ''}
              </p>
              {entries.length >= limit && limit < 200 && (
                <Button
                  tone="secondary"
                  onClick={() => {
                    if (active()) setLimit(Math.min(200, limit + 50));
                  }}
                >
                  {t('load', { limit: Math.min(200, limit + 50) })}
                </Button>
              )}
            </div>
          </>
        )}
      </ReadResult>
    </Panel>
  );
}

function OneTime({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).policy(signal),
    `${userId}:allowlist-policy`,
  );
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [assetId, setAssetId] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [ask, setAsk] = useState<{ ref: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <Panel id="allowlist-one-time" title={t('oneTimeTitle')} lead={t('oneTimeNote')}>
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(policy) => (
          <>
            <p role="status" data-testid="allowlist-policy">
              {policy.enabled && policy.maxAmount && policy.assetId
                ? t('oneTimeOn', { max: amount(policy.maxAmount, policy.assetId) })
                : t('oneTimeOff')}
            </p>
            {sent && <p role="status">{t('sentRequest')}</p>}
            <div className="lt-actions">
              <Button
                tone="secondary"
                onClick={() => {
                  if (active()) setEditing(true);
                }}
              >
                {t('oneTimeChange')}
              </Button>
            </div>
            {editing && (
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!assetId.trim() || !positive(maxAmount.trim())) return setInvalid(true);
                  setInvalid(false);
                  setAsk((open) => open ?? { ref: newRef() });
                }}
              >
                <Checkbox checked={enabled} onCheckedChange={setEnabled}>
                  {t('policyOn')}
                </Checkbox>
                <Field
                  label={t('policyAsset')}
                  name="allowlist-policy-asset"
                  maxLength={32}
                  value={assetId}
                  onChange={(event) => setAssetId(event.target.value)}
                />
                <Field
                  label={t('policyMax')}
                  name="allowlist-policy-max"
                  inputMode="decimal"
                  autoComplete="off"
                  value={maxAmount}
                  onChange={(event) => setMaxAmount(event.target.value)}
                />
                {invalid && (
                  <p data-testid="failure" role="alert">
                    {t('policyInvalid')}
                  </p>
                )}
                <div className="lt-actions">
                  <Button type="submit" tone="primary">
                    {t('policySubmit')}
                  </Button>
                  <Button tone="quiet" onClick={() => setEditing(false)}>
                    {t('formCancel')}
                  </Button>
                </div>
              </form>
            )}
            {ask && (
              <StepUpSheet
                run={(token) =>
                  createAllowlistReads(api, userId, current).proposePolicy(
                    { enabled, assetId: assetId.trim().toUpperCase(), maxAmount: maxAmount.trim(), clientRef: ask.ref },
                    token,
                  )
                }
                onDone={() => {
                  if (!active()) return;
                  setAsk(null);
                  setEditing(false);
                  setSent(true);
                  reload();
                }}
                onCancel={() => setAsk(null)}
              />
            )}
          </>
        )}
      </ReadResult>
    </Panel>
  );
}

function subjectOf(change: AllowlistChange): ReactNode {
  const s = change.subject as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  if (change.op === 'add' || change.op === 'delete')
    return (
      <span lang="und" data-withdrawal-private>
        {text(s.label)} · {text(s.address)} · {text(s.assetId)}
      </span>
    );
  if (change.op === 'onetime_policy')
    return (
      <span lang="und">
        {s.enabled === true ? 'on' : 'off'} · {text(s.maxAmount)} {text(s.assetId)}
      </span>
    );
  return null;
}

function Changes({ current }: { current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).changes(limit, signal),
    `${userId}:allowlist-changes:${limit}`,
  );
  return (
    <Panel id="allowlist-changes" title={t('changesTitle')} lead={t('entriesWindow', { limit })}>
      <ReadResult
        resource={resource}
        retry={() => {
          if (active()) reload();
        }}
      >
        {(changes) =>
          changes.length ? (
            <ul data-testid="allowlist-changes">
              {changes.map((change) => (
                <li data-testid="withdrawal-row" key={change.id}>
                  <div>
                    <strong>{t(`${change.op}_op` as 'add_op')}</strong> {subjectOf(change)}{' '}
                    <span className="lt-chip" data-state={change.status}>
                      {t(change.status)}
                    </span>{' '}
                    <span>{t('tally', { count: change.approvalCount, required: change.requiredApprovals })}</span>
                  </div>
                  <a
                    className="lt-button lt-button-secondary"
                    href={href(change.id)}
                    aria-label={t('openChange', { id: change.id })}
                    onClick={(event) => {
                      if (!active()) event.preventDefault();
                    }}
                  >
                    <span aria-hidden="true">↗</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t('changesEmpty')} body={t('changesEmptyNote')} />
          )
        }
      </ReadResult>
    </Panel>
  );
}

function Detail({ id, current }: { id: string; current: () => boolean }) {
  const { api, userId } = useSession();
  const { t } = allowlistCopy.useCopy();
  const active = useHandlerCurrent(current);
  const { resource, reload } = useResource(
    (signal) => createAllowlistReads(api, userId, current).get(id, signal),
    `${userId}:allowlist-change:${id}`,
  );
  const [canceling, setCanceling] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const refresh = () => {
    if (active()) reload();
  };
  async function cancel(change: AllowlistChange) {
    if (!active() || canceling) return;
    setCanceling(true);
    setFailure(null);
    const result = await createAllowlistReads(api, userId, current).cancel(change.id);
    if (!active()) return;
    setCanceling(false);
    if (result.ok) {
      setCancelled(true);
      reload();
    } else setFailure(result);
  }
  return (
    <Panel id="allowlist-record" title={t('record')}>
      <ReadResult resource={resource} retry={refresh}>
        {(change) => {
          const own = change.userId === userId;
          const facts: [string, ReactNode][] = [
            [t('id'), <span lang="und">{change.id}</span>],
            [
              t('subject'),
              <>
                {t(`${change.op}_op` as 'add_op')} {subjectOf(change)}
              </>,
            ],
            [t('hash'), <span lang="und">{change.requestHash}</span>],
            [t('submitted'), <time dateTime={change.createdAt}>{date(change.createdAt)}</time>],
            [t('decided'), change.decidedAt === null ? t('none') : <time dateTime={change.decidedAt}>{date(change.decidedAt)}</time>],
            [t('failureCode'), change.failureCode === null ? t('none') : <span lang="und">{change.failureCode}</span>],
          ];
          return (
            <div>
              <p>
                <span className="lt-chip" data-state={change.status}>
                  {t(change.status)}
                </span>{' '}
                <span>{t('tally', { count: change.approvalCount, required: change.requiredApprovals })}</span>
              </p>
              <p className="lt-hint">{t('hashNote')}</p>
              <dl data-testid="withdrawal-facts" className="lt-kv">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {cancelled && <p role="status">{t('cancelled2')}</p>}
              {failure && <Failure result={failure} retry={() => setFailure(null)} />}
              <div className="lt-actions">
                <Button tone="secondary" onClick={refresh}>
                  {t('refreshRecord')}
                </Button>
                {own && (
                  <Button tone="secondary" disabled={change.status !== 'waiting' || canceling} onClick={() => void cancel(change)}>
                    {canceling ? t('canceling') : t('cancel')}
                  </Button>
                )}
              </div>
              {own && <p className="lt-hint">{t('cancelHint')}</p>}
            </div>
          );
        }}
      </ReadResult>
      <a
        className="lt-button lt-button-secondary"
        href="/uc/withdraw/allowlist"
        onClick={(event) => {
          if (!active()) event.preventDefault();
        }}
      >
        {t('viewAll')}
      </a>
    </Panel>
  );
}

/** The room's sections, each a link to its part of the page. */
const SECTIONS = [
  ['allowlist-mode', 'modeTitle'],
  ['allowlist-entries', 'entriesTitle'],
  ['allowlist-one-time', 'oneTimeTitle'],
  ['allowlist-changes', 'changesTitle'],
] as const;

/**
 * `/uc/withdraw/allowlist`: the caller's address list, its mode, the one-time setting and its changes; one change when
 * `?changeId=` names it. On its settings template; a link that names no valid change is the room's refusal.
 */
export function WithdrawalAllowlist({ context, search }: { context: AllowlistReadContext; search: string }) {
  const { t } = allowlistCopy.useCopy();
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && context.current();
  const requested = requestedChange(search);
  if (!context.current()) return <p role="status">{t('changed')}</p>;
  const state: RoomState = requested.ok
    ? { kind: 'ready' }
    : { kind: 'refused', refusal: { variant: 'refused', title: t('invalidTitle'), body: t('invalidId') } };
  const sections: readonly (readonly [string, string])[] = !requested.ok
    ? []
    : requested.id
      ? [['allowlist-record', t('record')]]
      : SECTIONS.map(([id, key]) => [id, t(key)] as const);
  return (
    <SettingsTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      index={
        <>
          {sections.length > 0 ? (
            <nav aria-label={t('sectionsLabel')}>
              <ul>
                {sections.map(([id, name]) => (
                  <li key={id}>
                    <a className="lt-link" href={`#${id}`}>
                      {name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <a className="lt-link" href="/uc/withdraw">
            {t('viewWithdrawals')} ↗
          </a>
        </>
      }
      sections={
        !requested.ok ? null : requested.id ? (
          <Detail id={requested.id} current={current} />
        ) : (
          <>
            <Mode current={current} />
            <Entries current={current} />
            <OneTime current={current} />
            <Changes current={current} />
          </>
        )
      }
      explain={<p>{t('explain')}</p>}
    />
  );
}
