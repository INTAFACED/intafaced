import { useEffect, useRef, useState, type FormEvent } from 'react';
import { API_KEY_NAME_MAX } from '@intafaced/contracts/api-keys';
import type { SandboxDetail, SandboxKeyCreateOutput } from '@intafaced/contracts/developer-sandboxes';
import { Button, Choice, ChoiceGroup, EmptyState, Field, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useFailureView } from '../../../shared/failure-view';
import { useSession } from '../../session';
import { sandboxCopy, sandboxRefusalKey } from './sandbox-copy';
import { KEY_PRESETS, createSandboxKey, type KeyPreset } from './sandbox-api';
import { useSandbox } from './sandbox-read';

type T = ReturnType<typeof sandboxCopy.useCopy>['t'];
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Made = SandboxKeyCreateOutput & { key: string };

/**
 * /developers/sandbox/<id>/keys/new (DV-sandbox-01), on the flow template: a sandbox key, sandbox-safe permissions only,
 * confirmed with a passkey. Signed out it asks for sign-in and reads nothing; the key is shown once.
 */
export function SandboxKeyNew({ id }: { id: string }) {
  const { t } = sandboxCopy.useCopy();
  const { userId } = useSession();
  const { resource, reload } = useSandbox(id);
  const back = (
    <p>
      <a className="lt-link" href="/developers/sandbox">
        ← {t('back')}
      </a>
    </p>
  );
  if (!userId)
    return (
      <FlowTemplate
        title={t('title')}
        description={t('eyebrow')}
        state={{ kind: 'ready' }}
        step={
          <>
            <p>{t('lead')}</p>
            <EmptyState
              title={t('signedOutTitle')}
              body={t('signedOutBody')}
              action={
                <a className="lt-link" href={`/login?redirect=${encodeURIComponent(`/developers/sandbox/${id}`)}`}>
                  {t('signIn')}
                </a>
              }
            />
          </>
        }
      />
    );
  if (resource.status === 'failed' && resource.failure.code === 'identity.sandbox_not_found')
    return (
      <FlowTemplate
        title={t('notFoundTitle')}
        description={t('eyebrow')}
        state={{
          kind: 'empty',
          title: t('notFoundTitle'),
          body: t('notFoundBody'),
          action: { label: t('back'), href: '/developers/sandbox' },
        }}
        step={null}
      />
    );
  // Loading or refused, the room keeps its heading and its way back.
  if (resource.status === 'failed')
    return (
      <FlowTemplate
        title={t('title')}
        description={t('eyebrow')}
        state={{ kind: 'ready' }}
        step={<ReadFailed failure={resource.failure} retry={reload} />}
        help={back}
      />
    );
  if (resource.status === 'loading' || !resource.data)
    return (
      <FlowTemplate
        title={t('title')}
        description={t('eyebrow')}
        state={{ kind: 'ready' }}
        step={<p role="status">{t('loading')}</p>}
        help={back}
      />
    );
  const detail = resource.data;
  return (
    <div data-testid="developers-sandbox-key">
      <FlowTemplate
        title={t('keyFormHeading')}
        description={detail.sandbox.name}
        state={{ kind: 'ready' }}
        step={<KeyForm detail={detail} t={t} />}
        help={
          <p>
            <a className="lt-link" href={`/developers/sandbox/${detail.sandbox.id}`}>
              ← <bdi lang="und">{detail.sandbox.name}</bdi>
            </a>
          </p>
        }
      />
    </div>
  );
}

/** A failed read, in the words shared/ui's `Failure` says, with Try again where it can clear by itself. */
function ReadFailed({ failure, retry }: { failure: Refusal; retry?: () => void }) {
  const view = useFailureView(failure);
  return (
    <RefusalBox refusal={view.refusal} role={view.role} bodyLang={view.bodyLang} data-testid="failure">
      {retry && view.retryable ? (
        <Button tone="secondary" onClick={retry}>
          {view.retryLabel}
        </Button>
      ) : null}
    </RefusalBox>
  );
}

/** A typed refusal in the person's words, with its code kept on the element and shown as the support reference. */
function Refused({ failure, t }: { failure: Refusal; t: T }) {
  const key = sandboxRefusalKey(failure.code);
  if (!key && !failure.code) return <ReadFailed failure={failure} />;
  return (
    <RefusalBox
      refusal={{ variant: 'refused', title: t('refusedHeading'), body: key ? t(key) : t('otherRefusal') }}
      role="alert"
      data-code={failure.code}
    >
      <p>
        {t('codeLabel')}: <code lang="und">{failure.code}</code>
      </p>
    </RefusalBox>
  );
}

function BaseUrl({ baseUrl, t }: { baseUrl: string | null; t: T }) {
  return (
    <>
      {baseUrl ? (
        <p>
          {t('baseUrlLabel')}:{' '}
          <code lang="und" data-testid="sandbox-base-url">
            {baseUrl}
          </code>
        </p>
      ) : (
        <p data-testid="sandbox-base-url-unset">{t('baseUrlUnset')}</p>
      )}
      <p>
        <a className="lt-link" href="/developers/sandbox/test-values">
          {t('testValuesLink')}
        </a>
      </p>
    </>
  );
}

function ShownOnce({ made, sandboxId, t }: { made: Made; sandboxId: string; t: T }) {
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  return (
    <section aria-labelledby="sandbox-key-shown">
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
        tone="secondary"
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
      {copied === 'failed' ? <p>{t('copyFailed')}</p> : null}
      <Choice type="checkbox" checked={stored} onChange={(event) => setStored(event.currentTarget.checked)} label={t('stored')} />
      <Button tone="primary" disabled={!stored} onClick={() => window.location.assign(`/developers/sandbox/${sandboxId}`)}>
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
    <form onSubmit={submit} noValidate aria-labelledby="sandbox-key-form">
      <h2 id="sandbox-key-form" className="lt-sr">
        {t('keyFormHeading')}
      </h2>
      <p>{t('keyFormLead')}</p>
      <Field
        label={t('keyName')}
        value={name}
        maxLength={API_KEY_NAME_MAX}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      <ChoiceGroup
        legend={t('permissions')}
        hint={
          <>
            {t(notes[preset])} <code lang="und">{KEY_PRESETS[preset].join(' ')}</code>
          </>
        }
      >
        {(Object.keys(KEY_PRESETS) as KeyPreset[]).map((choice) => (
          <Choice
            key={choice}
            type="radio"
            name="preset"
            checked={preset === choice}
            onChange={() => setPreset(choice)}
            label={t(labels[choice])}
          />
        ))}
      </ChoiceGroup>
      {refused ? <Refused failure={refused} t={t} /> : null}
      {replayed ? <p role="status">{replayed}</p> : null}
      <Button tone="primary" type="submit" disabled={busy}>
        {busy ? t('working') : t('submitPasskey')}
      </Button>
    </form>
  );
}
