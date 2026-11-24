// volt-room: /developers/sandbox/:sandboxId/keys/new
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { API_KEY_NAME_MAX } from '@intafaced/contracts/api-keys';
import type { SandboxDetail, SandboxKeyCreateOutput } from '@intafaced/contracts/developer-sandboxes';
import { Button, Checkbox, Field, Radio } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { leaveTo } from '../../../app/location';
import { useSession } from '../../session';
import { Failure } from './kit-parts';
import { KEY_PRESETS, createSandboxKey, type KeyPreset } from './sandbox-api';
import { sandboxCopy } from './sandbox-copy';
import { BaseUrl, Refused, type Refusal, type T } from './sandbox-parts';
import { useSandbox } from './SandboxRoom';

type Made = SandboxKeyCreateOutput & { key: string };

function ShownOnce({ made, sandboxId, t }: { made: Made; sandboxId: string; t: T }) {
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  return (
    <section className="lt-stack" aria-labelledby="sandbox-key-shown">
      <h2 id="sandbox-key-shown">{t('shownTitle')}</h2>
      <p>{t('shownOnce')}</p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> · <code lang="und">{made.record.prefix}</code>
      </p>
      <output data-testid="api-keys__key" aria-label={t('shownTitle')}>
        <code lang="und">{made.key}</code>
      </output>
      <BaseUrl baseUrl={made.baseUrl} t={t} />
      <div className="lt-actions">
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
      </div>
      {copied === 'failed' ? (
        <p className="lt-hint" data-part="error" role="alert">
          {t('copyFailed')}
        </p>
      ) : null}
      <Checkbox checked={stored} onCheckedChange={setStored}>
        {t('stored')}
      </Checkbox>
      <div className="lt-actions">
        <Button tone="primary" disabled={!stored} onClick={() => leaveTo(`/developers/sandbox/${sandboxId}`)}>
          {t('done')}
        </Button>
      </div>
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
    <form className="lt-stack" onSubmit={submit} noValidate aria-labelledby="sandbox-key-form">
      <h2 id="sandbox-key-form">{t('keyFormHeading')}</h2>
      <p className="lt-muted">{t('keyFormLead')}</p>
      <Field
        label={t('keyName')}
        value={name}
        maxLength={API_KEY_NAME_MAX}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      <fieldset className="lt-stack">
        <legend>{t('permissions')}</legend>
        {(Object.keys(KEY_PRESETS) as KeyPreset[]).map((choice) => (
          <Radio key={choice} name="preset" checked={preset === choice} onSelect={() => setPreset(choice)}>
            {t(labels[choice])}
          </Radio>
        ))}
        <p className="lt-muted">
          {t(notes[preset])} <code lang="und">{KEY_PRESETS[preset].join(' ')}</code>
        </p>
      </fieldset>
      {refused ? <Refused failure={refused} t={t} /> : null}
      {replayed ? <p role="status">{replayed}</p> : null}
      <div className="lt-actions">
        <Button tone="primary" type="submit" disabled={busy}>
          {busy ? t('working') : t('submitPasskey')}
        </Button>
      </div>
    </form>
  );
}

/** /developers/sandbox/<id>/keys/new: a sandbox key, sandbox-safe permissions only, confirmed with a passkey, on the flow template. */
export function NewSandboxKey({ id }: { id: string }) {
  const { t } = sandboxCopy.useCopy();
  const { userId } = useSession();
  const { resource, reload } = useSandbox(id);
  if (!userId) {
    const back = `/developers/sandbox/${id}/keys/new`;
    return (
      <FlowTemplate
        title={t('title')}
        description={t('lead')}
        state={{
          kind: 'empty',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(back)}` },
        }}
        step={null}
      />
    );
  }
  const backLink = (
    <a className="lt-link" href="/developers/sandbox">
      <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {t('back')}
    </a>
  );
  if (resource.status === 'failed') {
    if (resource.failure.code === 'identity.sandbox_not_found') {
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
    }
    return (
      <FlowTemplate
        title={t('title')}
        description={t('eyebrow')}
        roomAction={backLink}
        state={{ kind: 'ready' }}
        step={<Failure result={resource.failure} retry={reload} />}
      />
    );
  }
  const detail = resource.status === 'ready' ? resource.data : null;
  if (!detail) {
    return <FlowTemplate title={t('title')} description={t('eyebrow')} roomAction={backLink} state={{ kind: 'loading' }} step={null} />;
  }
  return (
    <FlowTemplate
      title={t('keyFormHeading')}
      description={detail.sandbox.name}
      roomAction={
        <a className="lt-link" href={`/developers/sandbox/${detail.sandbox.id}`}>
          <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> <bdi lang="und">{detail.sandbox.name}</bdi>
        </a>
      }
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack" data-testid="developers-sandbox-key">
          <KeyForm detail={detail} t={t} />
        </div>
      }
    />
  );
}
