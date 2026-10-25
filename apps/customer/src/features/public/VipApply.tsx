import { useMemo, useState } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import { refusalCopy } from '../../data';
import type { Loadable } from '../../data/types';
import type { ApiResult } from '../../shared/api';
import { snapshotTime } from './fee-tier';
import { feeTierCopy } from './fee-tier-copy';
import {
  sendVipApplication,
  sizeName,
  typeName,
  vipApplicationsFetcher,
  type VipApplication,
  type VipApplications,
} from './vip-application';

const SOURCE_KEY = 'vip-applications';

/** The VIP application on My tier (SP-fees-vip-04, J-cex-spot-10 #7), for the signed-in person. */
export function VipApply() {
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<VipApplications>(SOURCE_KEY, vipApplicationsFetcher(env.api), { intervalMs: 30_000 }),
    [env],
  );
  const load = useSource(source);
  return (
    <VipApplyView
      load={load}
      send={async (file, note) => {
        const result = await sendVipApplication(
          env.api,
          { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
          note,
        );
        if (result.ok) env.poller.refresh(SOURCE_KEY);
        return result;
      }}
    />
  );
}

type Sent = ApiResult<{ application: VipApplication }>;
type Copy = ReturnType<typeof feeTierCopy.useCopy>;

/** The words for a send that did not keep an application, naming the accepted files where that is the fix. */
function refusedLine(copy: Copy, result: Extract<Sent, { ok: false }>, file: File, rules: NonNullable<VipApplications['rules']>): string {
  const types = rules.proofTypes.map(typeName).join(', ');
  switch (result.code) {
    case 'vip.file_type_unsupported':
      return copy.t('vipRefused_file_type_unsupported', { type: file.type ? typeName(file.type) : file.name, types });
    case 'vip.file_not_its_type':
      return copy.t('vipRefused_file_not_its_type', { type: typeName(file.type), types });
    case 'vip.file_too_large':
      return copy.t('vipRefused_file_too_large', { size: sizeName(rules.maxBytes) });
    case 'vip.file_empty':
      return copy.t('vipRefused_file_empty');
    case 'vip.application_unset':
      return copy.t('vipRefused_application_unset');
    case 'vip.proof_key_unset':
      return copy.t('vipRefused_proof_key_unset');
    case 'vip.application_open':
      return copy.t('vipRefused_application_open');
    default:
      return copy.t('vipRefused_other', { message: result.message });
  }
}

export function VipApplyView({ load, send }: { load: Loadable<VipApplications>; send: (file: File, note: string) => Promise<Sent> }) {
  const copy = feeTierCopy.useCopy();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  const data = load.status === 'ready' ? load.data : null;
  const rules = data?.rules ?? null;
  const waiting = data?.applications.some((application) => application.status === 'pending') ?? false;

  const submit = async () => {
    if (!file || !rules || busy) return;
    // Over the size the owner published is refused here, before a large file is read and sent; the service checks again.
    if (file.size > rules.maxBytes) {
      setLine({ ok: false, text: copy.t('vipRefused_file_too_large', { size: sizeName(rules.maxBytes) }) });
      return;
    }
    setBusy(true);
    setLine(null);
    try {
      const result = await send(file, note);
      if (result.ok) {
        setLine({ ok: true, text: copy.t('vipSent', { file: result.data.application.proof.fileName }) });
        setFile(null);
        setNote('');
      } else {
        setLine({ ok: false, text: refusedLine(copy, result, file, rules) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pub-card" aria-labelledby="vip-apply-title" data-tier-page="vip-apply">
      <h2 id="vip-apply-title">{copy.t('vipTitle')}</h2>
      <p>{copy.t('vipLead')}</p>
      {load.status === 'loading' ? <p role="status">{copy.t('vipLoading')}</p> : null}
      {load.status === 'error' ? (
        <p role="alert">
          {copy.t('vipLoadFailed')}{' '}
          <button type="button" className="text-link" onClick={load.retry}>
            {copy.t('retry')}
          </button>
        </p>
      ) : null}
      {load.status === 'refused' ? <p role="alert">{refusalCopy(load.code).title}</p> : null}
      {data && !rules ? <p data-vip="not-open">{copy.t('vipNotOpen')}</p> : null}
      {rules ? (
        <p data-vip="rules">{copy.t('vipRules', { types: rules.proofTypes.map(typeName).join(', '), size: sizeName(rules.maxBytes) })}</p>
      ) : null}
      {rules && waiting ? (
        <p role="status" data-vip="waiting">
          {copy.t('vipWaiting')}
        </p>
      ) : null}
      {rules && !waiting ? (
        <form
          className="form-stack"
          data-vip="form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>{copy.t('vipFileLabel')}</span>
            <input
              type="file"
              accept={rules.proofTypes.join(',')}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setLine(null);
              }}
            />
          </label>
          <label className="field">
            <span>{copy.t('vipNoteLabel')}</span>
            <textarea value={note} maxLength={1000} rows={3} onChange={(event) => setNote(event.target.value)} />
          </label>
          <p>
            <button type="submit" className="button button--primary" disabled={!file || busy}>
              {busy ? copy.t('vipSending') : copy.t('vipSend')}
            </button>
          </p>
        </form>
      ) : null}
      {line ? (
        <p role={line.ok ? 'status' : 'alert'} data-vip-result={line.ok ? 'sent' : 'refused'}>
          {line.text}
        </p>
      ) : null}
      {data ? (
        <>
          <h3>{copy.t('vipYoursTitle')}</h3>
          {data.applications.length === 0 ? (
            <p data-vip="none">{copy.t('vipNone')}</p>
          ) : (
            <table className="pub-table" aria-label={copy.t('vipYoursTitle')}>
              <thead>
                <tr>
                  <th scope="col">{copy.t('colSent')}</th>
                  <th scope="col">{copy.t('colFile')}</th>
                  <th scope="col">{copy.t('colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {data.applications.map((application) => (
                  <tr key={application.id} data-vip-application={application.status}>
                    <th scope="row">{snapshotTime(application.createdAt)}</th>
                    <td>
                      {application.proof.fileName} ({typeName(application.proof.contentType)}, {sizeName(application.proof.byteLength)})
                    </td>
                    <td>{copy.t(`vipStatus_${application.status}` as const)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}
