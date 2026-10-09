import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Dialog, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { notificationTargetsCopy as copy } from './notification-targets-copy';
import './notification-targets.css';

const channel = z.enum(['email', 'sms', 'push']);
type Channel = z.infer<typeof channel>;
const date = z.string().datetime({ offset: true });
const target = z.object({ channel, address: z.string().min(1), locale: z.string(), verifiedAt: date.nullable() });
const targets = z
  .array(target)
  .max(3)
  .refine((rows) => new Set(rows.map((row) => row.channel)).size === rows.length, 'Duplicate targets');
type Target = z.infer<typeof target>;
const signature = (row: Target | undefined) => JSON.stringify(row ? [row.channel, row.address, row.locale, row.verifiedAt] : null);
const refusal = z
  .string()
  .min(1)
  .refine((value) => !/^\d{6}$/.test(value), 'A refusal is not a verification code')
  .nullable();
const registration = z
  .object({ status: z.enum(['sent', 'refused', 'failed']), channel, code: refusal, expiresAt: date })
  .refine((row) => (row.status === 'refused' ? row.code !== null : row.code === null), 'Invalid registration outcome');
const verification = z
  .object({ verified: z.boolean(), code: refusal })
  .refine((row) => !row.verified || row.code === null, 'Invalid verification outcome');
type Action = { kind: 'register'; address: string; locale: string } | { kind: 'verify'; code: string } | { kind: 'remove' };
type Note = {
  key:
    | 'sent'
    | 'refused'
    | 'failed'
    | 'acceptedCode'
    | 'rejectedCode'
    | 'refusedCode'
    | 'removed'
    | 'notRemoved'
    | 'changed'
    | 'unknown'
    | 'requestRefused';
  channel: Channel;
  address?: string;
  code?: string | null;
  expiresAt?: string;
};
type FailureResult = Extract<ApiResult<unknown>, { ok: false }>;
function ServiceFailure({ result, retry }: { result: FailureResult; retry?: () => void }) {
  return (
    <div lang="">
      <Failure result={result} retry={retry} />
    </div>
  );
}

type OwnerProps = { userId: string; revision: number; onChanged: () => void };
export function NotificationTargets({ userId, revision, onChanged }: OwnerProps) {
  const { userId: actor } = useSession();
  return actor === userId ? <OwnerTargets key={userId} userId={userId} revision={revision} onChanged={onChanged} /> : null;
}
function OwnerTargets({ userId, revision, onChanged }: OwnerProps) {
  const { api } = useSession();
  const { t, Copy, languageFor } = copy.useCopy();
  const read = useResource(
    (signal) => api.query('notify', 'notify.targets', undefined, targets, { signal }),
    'target-controls:' + userId + ':' + revision,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [failure, setFailure] = useState<FailureResult | null>(null);
  const [readFailure, setReadFailure] = useState<FailureResult | null>(null);
  const running = useRef(false),
    alive = useRef(true),
    preflight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      preflight.current?.abort();
    };
  }, []);
  function refresh() {
    if (running.current) return;
    setReadFailure(null);
    read.reload();
    onChanged();
  }
  async function perform(id: Channel, baseline: Target | undefined, action: Action) {
    if (running.current || readFailure || read.resource.status !== 'ready') return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    setNote(null);
    const controller = new AbortController();
    preflight.current = controller;
    try {
      const fresh = await api.query('notify', 'notify.targets', undefined, targets, { signal: controller.signal });
      if (!alive.current) return;
      if (!fresh.ok) {
        setReadFailure(fresh);
        return;
      }
      if (signature(fresh.data.find((row) => row.channel === id)) !== signature(baseline)) {
        setNote({ key: 'changed', channel: id });
        read.reload();
        onChanged();
        return;
      }
      // The mounted writes have no version/address precondition. This fresh
      // owner read narrows the race; it cannot provide atomic compare-and-set.
      let outcome: ApiResult<unknown>;
      if (action.kind === 'register') {
        const result = await api.mutate(
          'notify',
          'notify.registerTarget',
          { channel: id, address: action.address, locale: action.locale },
          registration.refine((row) => row.channel === id, 'Wrong registration channel'),
        );
        outcome = result;
        if (alive.current && result.ok)
          setNote({
            key: result.data.status,
            channel: id,
            address: action.address,
            code: result.data.code,
            expiresAt: result.data.expiresAt,
          });
      } else if (action.kind === 'verify') {
        const result = await api.mutate('notify', 'notify.verifyTarget', { channel: id, code: action.code }, verification);
        outcome = result;
        if (alive.current && result.ok)
          setNote({
            key: result.data.verified ? 'acceptedCode' : result.data.code ? 'refusedCode' : 'rejectedCode',
            channel: id,
            address: id === 'push' ? undefined : baseline?.address,
            code: result.data.code,
          });
      } else {
        const result = await api.mutate('notify', 'notify.removeTarget', { channel: id }, z.object({ removed: z.boolean() }));
        outcome = result;
        if (alive.current && result.ok)
          setNote({
            key: result.data.removed ? 'removed' : 'notRemoved',
            channel: id,
            address: id === 'push' ? undefined : baseline?.address,
          });
      }
      if (!alive.current) return;
      if (!outcome.ok) {
        setFailure(outcome);
        setNote({ key: outcome.reason === 'uncertain' ? 'unknown' : 'requestRefused', channel: id });
      }
      // A response is historical evidence, never the current target projection.
      read.reload();
      onChanged();
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="notification-targets" aria-label={t('title')} lang={languageFor('title')}>
      <header>
        <h2>
          <Copy k="title" />
        </h2>
        <Button variant="ghost" disabled={busy} onClick={refresh}>
          <Copy k="recheck" />
        </Button>
      </header>
      {busy && <Loading label={<Copy k="busy" />} />}
      {note && (
        <div className="notification-targets-note" role="status">
          <p>
            <Copy k={note.channel} />
          </p>
          <h3>
            <Copy k={note.key} />
          </h3>
          {note.key === 'unknown' && (
            <p>
              <Copy k="unknownBody" />
            </p>
          )}
          {(note.key === 'refused' || note.key === 'failed') && (
            <p>
              <Copy k="storedBoundary" />
            </p>
          )}
          {note.address && (
            <p>
              <Copy k="request" />: <span lang="">{note.address}</span>
            </p>
          )}
          {note.code && (
            <p>
              <Copy k="serviceCode" />: <span lang="">{note.code}</span>
            </p>
          )}
          {note.expiresAt && (
            <p>
              <Copy k="expiry" />:{' '}
              <time lang="" dateTime={note.expiresAt}>
                {note.expiresAt}
              </time>
            </p>
          )}
        </div>
      )}
      {failure && (
        <>
          {failure.code === 'notify.verify_ttl_unset' && (
            <p>
              <Copy k="ttlUnset" />
            </p>
          )}
          <ServiceFailure result={failure} />
          {failure.code && (
            <p>
              <Copy k="serviceCode" />: <span lang="">{failure.code}</span>
            </p>
          )}
        </>
      )}
      {readFailure ? (
        <ServiceFailure result={readFailure} retry={refresh} />
      ) : read.resource.status === 'loading' ? (
        <Loading />
      ) : read.resource.status === 'failed' ? (
        <ServiceFailure result={read.resource.failure} retry={refresh} />
      ) : (
        (['email', 'sms', 'push'] as const).map((id) => (
          <TargetControls
            key={id}
            id={id}
            row={read.resource.status === 'ready' ? read.resource.data.find((row) => row.channel === id) : undefined}
            busy={busy}
            perform={perform}
          />
        ))
      )}
    </section>
  );
}
function TargetControls({
  id,
  row,
  busy,
  perform,
}: {
  id: Channel;
  row: Target | undefined;
  busy: boolean;
  perform: (id: Channel, baseline: Target | undefined, action: Action) => Promise<void>;
}) {
  const { Copy, t, requestedLocale } = copy.useCopy();
  const [editing, setEditing] = useState(false),
    [address, setAddress] = useState(''),
    [ack, setAck] = useState(false);
  const [code, setCode] = useState(''),
    [error, setError] = useState<'invalidEmail' | 'invalidSms' | 'codeInvalid' | null>(null);
  const [remove, setRemove] = useState(false);
  const fingerprint = signature(row);
  useEffect(() => {
    setCode('');
    setAck(false);
    setEditing(false);
    setRemove(false);
    setError(null);
  }, [fingerprint]);
  function open() {
    setAddress(row?.address ?? '');
    setAck(false);
    setEditing(true);
    setError(null);
  }
  async function register() {
    const valid = id === 'email' ? z.string().email().max(320).safeParse(address).success : /^\+[1-9]\d{6,14}$/.test(address);
    if (!valid) {
      setError(id === 'email' ? 'invalidEmail' : 'invalidSms');
      return;
    }
    if (!ack || id === 'push') return;
    setError(null);
    await perform(id, row, { kind: 'register', address, locale: requestedLocale });
  }
  async function verify() {
    if (!/^\d{6}$/.test(code)) {
      setError('codeInvalid');
      return;
    }
    const submitted = code;
    setCode('');
    setError(null);
    await perform(id, row, { kind: 'verify', code: submitted });
  }
  return (
    <section className="notification-target-control" aria-label={t(id)}>
      <h3>
        <Copy k={id} />
      </h3>
      <p>
        {row ? (
          <>
            <Copy k={row.verifiedAt ? 'verified' : 'unverified'} />
            {id !== 'push' && (
              <>
                {' '}
                · <span lang="">{row.address}</span>
              </>
            )}
          </>
        ) : (
          <Copy k="absent" />
        )}
      </p>
      {id === 'push' && (
        <p className="muted">
          <Copy k="pushDependency" />
        </p>
      )}
      <div className="notification-target-actions">
        {id !== 'push' && (
          <Button variant="secondary" disabled={busy} onClick={open}>
            <Copy k={row ? 'change' : 'add'} />
          </Button>
        )}
        {row && (
          <Button variant="ghost" disabled={busy} onClick={() => setRemove(true)}>
            <Copy k="remove" />
          </Button>
        )}
      </div>
      {editing && id !== 'push' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
          className="notification-target-form"
          noValidate
        >
          <Field
            label={<Copy k={id === 'email' ? 'addressEmail' : 'addressSms'} />}
            type={id === 'email' ? 'email' : 'tel'}
            maxLength={id === 'email' ? 320 : 16}
            value={address}
            disabled={busy}
            onChange={(event) => {
              setAddress(event.target.value);
              setError(null);
              setAck(false);
            }}
            hint={id === 'sms' ? <Copy k="phoneHint" /> : undefined}
            error={error && error !== 'codeInvalid' ? <Copy k={error} /> : undefined}
            autoComplete={id === 'email' ? 'email' : 'tel'}
          />
          <p className="muted">
            <Copy k="consequences" />
          </p>
          <label className="notification-target-ack">
            <input type="checkbox" checked={ack} disabled={busy} onChange={(event) => setAck(event.target.checked)} />
            <span>
              <Copy k="acknowledge" />
            </span>
          </label>
          <div className="notification-target-actions">
            <Button type="submit" disabled={busy || !ack}>
              <Copy k="save" />
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              <Copy k="cancel" />
            </Button>
          </div>
        </form>
      )}
      {row && !row.verifiedAt && id !== 'push' && (
        <form
          className="notification-target-form"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
          noValidate
        >
          <Field
            label={<Copy k="code" />}
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            onChange={(event) => {
              setCode(event.target.value);
              setError(null);
            }}
            hint={<Copy k="codeHint" />}
            error={error === 'codeInvalid' ? <Copy k="codeInvalid" /> : undefined}
          />
          <Button type="submit" variant="secondary" disabled={busy}>
            <Copy k="verify" />
          </Button>
        </form>
      )}
      {remove && row && (
        <Dialog
          title={<Copy k="removeTitle" />}
          onClose={() => {
            if (!busy) setRemove(false);
          }}
        >
          <p lang={id === 'push' ? requestedLocale : ''}>{id === 'push' ? t('push') : row.address}</p>
          <p>
            <Copy k="removeBody" />
          </p>
          <div className="notification-target-actions">
            <Button variant="secondary" disabled={busy} onClick={() => setRemove(false)}>
              <Copy k="cancel" />
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void perform(id, row, { kind: 'remove' })}>
              <Copy k="removeConfirm" />
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
