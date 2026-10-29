import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { API_KEY_NAME_MAX } from '@intafaced/contracts/api-keys';
import {
  SANDBOX_NAME_MAX,
  type SandboxDetail,
  type SandboxKeyCreateOutput,
  type SandboxList,
} from '@intafaced/contracts/developer-sandboxes';
import { Button } from '@intafaced/ui';
import { DataTable, EmptyState, Failure, Field, Loading, Page } from '../../../shared/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { sandboxCopy, sandboxRefusalKey } from './sandbox-copy';
import { KEY_PRESETS, createSandbox, createSandboxKey, readSandbox, readSandboxes, sandboxRoute, type KeyPreset } from './sandbox-api';
import '../apps/apps.css';

type T = ReturnType<typeof sandboxCopy.useCopy>['t'];
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** A typed refusal in the person's words, with its code kept on the element and shown as the support reference. */
function Refused({ failure, t }: { failure: Refusal; t: T }) {
  const key = sandboxRefusalKey(failure.code);
  if (!key && !failure.code) return <Failure result={failure} />;
  return (
    <div role="alert" className="apps-refused" data-code={failure.code}>
      <strong>{t('refusedHeading')}</strong>
      <p>{key ? t(key) : t('otherRefusal')}</p>
      <p className="muted">
        {t('codeLabel')}: <code lang="und">{failure.code}</code>
      </p>
    </div>
  );
}

function BaseUrl({ baseUrl, t }: { baseUrl: string | null; t: T }) {
  return baseUrl ? (
    <p>
      {t('baseUrlLabel')}:{' '}
      <code lang="und" data-testid="sandbox-base-url">
        {baseUrl}
      </code>
    </p>
  ) : (
    <p className="muted" data-testid="sandbox-base-url-unset">
      {t('baseUrlUnset')}
    </p>
  );
}

const day = (iso: string) => <time dateTime={iso}>{iso.slice(0, 10)}</time>;

function SignedOut({ t, back }: { t: T; back: string }) {
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
      <EmptyState
        title={t('signedOutTitle')}
        action={
          <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(back)}`}>
            {t('signIn')}
          </a>
        }
      >
        {t('signedOutBody')}
      </EmptyState>
    </Page>
  );
}

function CreateForm({ listed, onMade, t }: { listed: SandboxList['sandboxes']; onMade: () => void; t: T }) {
  const { api, userId } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !userId) return;
    setBusy(true);
    setRefused(null);
    setSaid(null);
    const result = await createSandbox(api, userId, listed, name.trim());
    setBusy(false);
    if (!result.ok) return setRefused(result);
    setSaid(t(result.data.replayed ? 'replayed' : 'created', { name: result.data.sandbox.name }));
    setName('');
    onMade();
  }
  return (
    <form className="apps-form" onSubmit={submit} noValidate aria-labelledby="sandbox-create">
      <h2 id="sandbox-create">{t('formHeading')}</h2>
      <Field
        label={t('name')}
        hint={t('nameHint')}
        value={name}
        maxLength={SANDBOX_NAME_MAX}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      {refused ? <Refused failure={refused} t={t} /> : null}
      {said ? <p role="status">{said}</p> : null}
      <Button type="submit" disabled={busy}>
        {busy ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

/** /developers/sandbox: the account's named sandboxes, the owner's cap on how many, and the create form. */
function SandboxList() {
  const { t } = sandboxCopy.useCopy();
  const { api, userId } = useSession();
  const list = useResource(
    (signal) => (userId ? readSandboxes(api, signal) : Promise.resolve({ ok: true as const, data: null })),
    `developer-sandboxes:${userId ?? 'out'}`,
  );
  if (!userId) return <SignedOut t={t} back="/developers/sandbox" />;
  const resource = list.resource;
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
      <div className="apps-room" data-testid="developers-sandbox">
        {resource.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : resource.status === 'failed' ? (
          <div role="alert">
            <p>{t('readFailed')}</p>
            <Failure result={resource.failure} retry={list.reload} />
          </div>
        ) : resource.data ? (
          <>
            <section aria-labelledby="sandbox-list">
              <h2 id="sandbox-list">{t('listHeading')}</h2>
              <p data-testid="sandbox-cap" data-limit={resource.data.cap.limit ?? 'unset'} data-held={resource.data.cap.held}>
                {resource.data.cap.limit === null
                  ? t('capUnset')
                  : t('capSet', { held: String(resource.data.cap.held), limit: String(resource.data.cap.limit) })}
              </p>
              <BaseUrl baseUrl={resource.data.baseUrl} t={t} />
              {resource.data.sandboxes.length === 0 ? (
                <p>{t('empty')}</p>
              ) : (
                <DataTable label={t('listHeading')} headers={[t('colName'), t('colCreated')]}>
                  {resource.data.sandboxes.map((sandbox) => (
                    <tr key={sandbox.id} data-sandbox-id={sandbox.id}>
                      <td>
                        <a className="text-link" href={`/developers/sandbox/${sandbox.id}`}>
                          <bdi lang="und">{sandbox.name}</bdi>
                        </a>
                      </td>
                      <td>{day(sandbox.createdAt)}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </section>
            <CreateForm listed={resource.data.sandboxes} onMade={list.reload} t={t} />
          </>
        ) : null}
      </div>
    </Page>
  );
}

function useSandbox(id: string) {
  const { api, userId } = useSession();
  return useResource(
    (signal) => (userId ? readSandbox(api, id, signal) : Promise.resolve({ ok: true as const, data: null })),
    `developer-sandbox:${userId ?? 'out'}:${id}`,
  );
}

function SandboxRead({ id, children }: { id: string; children: (detail: SandboxDetail, reload: () => void) => JSX.Element }) {
  const { t } = sandboxCopy.useCopy();
  const { userId } = useSession();
  const { resource, reload } = useSandbox(id);
  if (!userId) return <SignedOut t={t} back={`/developers/sandbox/${id}`} />;
  if (resource.status === 'loading') return <Loading label={t('loading')} />;
  if (resource.status === 'failed') {
    if (resource.failure.code === 'identity.sandbox_not_found') {
      return (
        <Page eyebrow={t('eyebrow')} title={t('notFoundTitle')}>
          <EmptyState
            title={t('notFoundTitle')}
            action={
              <a className="text-link" href="/developers/sandbox">
                {t('back')}
              </a>
            }
          >
            {t('notFoundBody')}
          </EmptyState>
        </Page>
      );
    }
    return <Failure result={resource.failure} retry={reload} />;
  }
  return resource.data ? children(resource.data, reload) : <Loading label={t('loading')} />;
}

/** /developers/sandbox/<id>: one sandbox, its address and its keys. */
function SandboxPage({ id }: { id: string }) {
  const { t } = sandboxCopy.useCopy();
  return (
    <SandboxRead id={id}>
      {(detail) => (
        <Page
          eyebrow={t('title')}
          title={<bdi lang="und">{detail.sandbox.name}</bdi>}
          actions={
            <a className="button button--primary" href={`/developers/sandbox/${detail.sandbox.id}/keys/new`}>
              {t('newKey')}
            </a>
          }
        >
          <div className="apps-room" data-testid="developers-sandbox-detail">
            <a className="text-link" href="/developers/sandbox">
              ← {t('back')}
            </a>
            <BaseUrl baseUrl={detail.baseUrl} t={t} />
            <section aria-labelledby="sandbox-keys">
              <h2 id="sandbox-keys">{t('keysHeading')}</h2>
              {detail.keys.length === 0 ? (
                <p>{t('noKeys')}</p>
              ) : (
                <DataTable label={t('keysHeading')} headers={[t('colKey'), t('colPrefix'), t('colScopes'), t('colState')]}>
                  {detail.keys.map((key) => (
                    <tr key={key.id} data-key-id={key.id} data-mode={key.mode}>
                      <td>
                        <bdi lang="und">{key.name}</bdi>
                      </td>
                      <td>
                        <code lang="und">{key.prefix}</code>
                      </td>
                      <td>
                        <code lang="und">{key.scopes.join(' ')}</code>
                      </td>
                      <td>{t(key.revoked ? 'stateRevoked' : 'stateActive')}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </section>
          </div>
        </Page>
      )}
    </SandboxRead>
  );
}

type Made = SandboxKeyCreateOutput & { key: string };

function ShownOnce({ made, sandboxId, t }: { made: Made; sandboxId: string; t: T }) {
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  return (
    <section className="apps-secret" aria-labelledby="sandbox-key-shown">
      <h2 id="sandbox-key-shown">{t('shownTitle')}</h2>
      <p>{t('shownOnce')}</p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> · <code lang="und">{made.record.prefix}</code>
      </p>
      <output data-testid="api-keys__key" aria-label={t('shownTitle')}>
        <code lang="und">{made.key}</code>
      </output>
      <BaseUrl baseUrl={made.baseUrl} t={t} />
      <Button
        variant="secondary"
        onClick={() => {
          const write = navigator.clipboard?.writeText(made.key) ?? Promise.reject(new Error('no clipboard'));
          write.then(
            () => setCopied('yes'),
            () => setCopied('failed'),
          );
        }}
      >
        {copied === 'yes' ? t('copied') : t('copy')}
      </Button>
      {copied === 'failed' ? <p className="error-text">{t('copyFailed')}</p> : null}
      <label>
        <input type="checkbox" checked={stored} onChange={(event) => setStored(event.currentTarget.checked)} /> {t('stored')}
      </label>
      <Button disabled={!stored} onClick={() => window.location.assign(`/developers/sandbox/${sandboxId}`)}>
        {t('done')}
      </Button>
    </section>
  );
}

function KeyForm({ detail, t }: { detail: SandboxDetail; t: T }) {
  const { api, userId } = useSession();
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<KeyPreset>('payments');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [replayed, setReplayed] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  // Keys answered as replays since the page loaded: the next request id counts them, so a new try is a new request.
  const [answered, setAnswered] = useState<SandboxDetail['keys']>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (made) return <ShownOnce made={made} sandboxId={detail.sandbox.id} t={t} />;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !userId) return;
    setBusy(true);
    setRefused(null);
    setReplayed(null);
    const known = { ...detail, keys: [...detail.keys, ...answered] };
    const result = await createSandboxKey(api, userId, known, { name: name.trim(), scopes: [...KEY_PRESETS[preset]] });
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) return setRefused(result);
    if (result.data.key === null) {
      const record = result.data.record;
      setAnswered((before) => (before.some((key) => key.id === record.id) ? before : [...before, record]));
      return setReplayed(t('keyReplayed', { name: record.name }));
    }
    setMade({ ...result.data, key: result.data.key });
  }
  const notes = { payments: 'presetPaymentsNote', read: 'presetReadNote', trade: 'presetTradeNote' } as const;
  const labels = { payments: 'presetPayments', read: 'presetRead', trade: 'presetTrade' } as const;
  return (
    <form className="apps-form" onSubmit={submit} noValidate aria-labelledby="sandbox-key-form">
      <h2 id="sandbox-key-form">{t('keyFormHeading')}</h2>
      <p className="muted">{t('keyFormLead')}</p>
      <Field
        label={t('keyName')}
        value={name}
        maxLength={API_KEY_NAME_MAX}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      <fieldset className="apps-kind">
        <legend>{t('permissions')}</legend>
        {(Object.keys(KEY_PRESETS) as KeyPreset[]).map((choice) => (
          <label key={choice}>
            <input type="radio" name="preset" checked={preset === choice} onChange={() => setPreset(choice)} /> {t(labels[choice])}
          </label>
        ))}
        <p className="muted">
          {t(notes[preset])} <code lang="und">{KEY_PRESETS[preset].join(' ')}</code>
        </p>
      </fieldset>
      {refused ? <Refused failure={refused} t={t} /> : null}
      {replayed ? <p role="status">{replayed}</p> : null}
      <Button type="submit" disabled={busy}>
        {busy ? t('working') : t('submitPasskey')}
      </Button>
    </form>
  );
}

/** /developers/sandbox/<id>/keys/new: a sandbox key, sandbox-safe permissions only, confirmed with a passkey. */
function NewSandboxKey({ id }: { id: string }) {
  const { t } = sandboxCopy.useCopy();
  return (
    <SandboxRead id={id}>
      {(detail) => (
        <Page eyebrow={<bdi lang="und">{detail.sandbox.name}</bdi>} title={t('keyFormHeading')}>
          <div className="apps-room" data-testid="developers-sandbox-key">
            <a className="text-link" href={`/developers/sandbox/${detail.sandbox.id}`}>
              ← <bdi lang="und">{detail.sandbox.name}</bdi>
            </a>
            <KeyForm detail={detail} t={t} />
          </div>
        </Page>
      )}
    </SandboxRead>
  );
}

function Unknown() {
  const { t } = sandboxCopy.useCopy();
  return (
    <Page eyebrow={t('eyebrow')} title={t('notFoundTitle')}>
      <EmptyState
        title={t('notFoundTitle')}
        action={
          <a className="text-link" href="/developers/sandbox">
            {t('back')}
          </a>
        }
      >
        {t('notFoundBody')}
      </EmptyState>
    </Page>
  );
}

/** Every room under /developers/sandbox (DV-sandbox-01). Signed in: a sandbox belongs to an account. */
export function SandboxRoutes({ path }: { path: string }) {
  const route = sandboxRoute(path);
  if (route.kind === 'list') return <SandboxList />;
  if (route.kind === 'sandbox') return <SandboxPage id={route.id} />;
  if (route.kind === 'new-key') return <NewSandboxKey id={route.id} />;
  return <Unknown />;
}
