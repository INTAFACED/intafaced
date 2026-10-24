'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { formatWhen } from '@/lib/as-of';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { shortId } from '@/lib/desk/desk-model';
import { METADATA_KEY, METADATA_VALUE_MAX, revisionOf, type AccountMetadata, type MetadataChange } from '@/lib/ledger/account-metadata';

type View =
  | { readonly kind: 'reading' }
  | { readonly kind: 'ready'; readonly metadata: AccountMetadata; readonly readAt: string; readonly parked: string | null }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number };

type Save =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly change: MetadataChange }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number; readonly detail: string | null };

function RefusalLine({ code, status, testId }: { code: string | null; status: number; testId: string }) {
  const view = explainRefusal(code, status, status >= 500);
  return (
    <p className="adm-alert" role="alert" data-testid={testId}>
      <strong>{view.title}.</strong> {view.body} {view.next} {code && <span className="adm-subtle">({code})</span>}
    </p>
  );
}

/**
 * One ledger account's operator metadata (J-ops-console-03 #6, #7, OPS-ledger-desk-01): the keys it holds, the history of
 * every set and delete with the value before and after, a form to set or overwrite a key on one founder's word, and a
 * two-founder desk to delete one. Labels only: nothing here can change a posting or a balance. Under the posting freeze
 * the read still answers and both writes are refused by svc-ledger with `ledger.frozen`.
 */
export function AccountMetadataPanel({ accountId, userId, onClose }: { accountId: string; userId: string; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'reading' });
  const [deleting, setDeleting] = useState<string | null>(null);

  // A re-read after a write keeps the panel (and the write's own answer) on screen until the new answer arrives.
  const load = useCallback(async () => {
    setView((current) => (current.kind === 'ready' ? current : { kind: 'reading' }));
    try {
      const res = await fetch(`/api/ledger-metadata?accountId=${encodeURIComponent(accountId)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as {
        metadata?: AccountMetadata;
        treasuryParked?: unknown;
        code?: unknown;
        upstream?: unknown;
      } | null;
      if (res.ok && body?.metadata) {
        const parked = typeof body.treasuryParked === 'string' ? body.treasuryParked : null;
        setView({ kind: 'ready', metadata: body.metadata, readAt: new Date().toISOString(), parked });
        return;
      }
      const code = typeof body?.upstream === 'string' ? body.upstream : typeof body?.code === 'string' ? body.code : null;
      setView({ kind: 'refused', code, status: res.status });
    } catch {
      setView({ kind: 'refused', code: 'admin.upstream_unavailable', status: 503 });
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="adm-stack" data-testid="ledger-metadata" data-account={accountId} aria-label="Account metadata">
      <div className="adm-actions">
        <h3>Metadata on this account</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" onClick={() => void load()} disabled={view.kind === 'reading'}>
          Read again
        </button>
      </div>
      <p className="adm-subtle">
        Labels a founder puts on a ledger account. They are not postings: setting or deleting one changes no balance and no transaction.
        Each read is recorded under your name; deleting a key needs a second founder.
      </p>
      {view.kind === 'reading' && <p className="adm-subtle">Reading the ledger…</p>}
      {view.kind === 'refused' && <RefusalLine code={view.code} status={view.status} testId="ledger-metadata-refused" />}
      {view.kind === 'ready' && (
        <>
          <p className="adm-subtle" data-testid="ledger-metadata-address">
            <code>{view.metadata.address}</code> · read {formatWhen(view.readAt)}
          </p>
          {view.metadata.frozen && (
            <p className="adm-alert" role="status" data-testid="ledger-metadata-frozen">
              The posting freeze is on. These labels can still be read; svc-ledger refuses any set or delete until it is lifted.
            </p>
          )}
          {view.metadata.entries.length === 0 ? (
            <p data-testid="ledger-metadata-empty">This account holds no metadata.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="ledger-metadata-entries">
                <caption className="adm-sr-only">Metadata keys on {view.metadata.address}</caption>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th>Revision</th>
                    <th>Set</th>
                    <th>Delete</th>
                  </tr>
                </thead>
                <tbody>
                  {view.metadata.entries.map((entry) => (
                    <tr key={entry.key} data-key={entry.key}>
                      <td>
                        <code>{entry.key}</code>
                      </td>
                      <td>{entry.value}</td>
                      <td>{entry.revision}</td>
                      <td>
                        {formatWhen(entry.updatedAt)} by {shortId(entry.updatedBy)}
                      </td>
                      <td>
                        <button type="button" onClick={() => setDeleting(entry.key)} aria-pressed={deleting === entry.key}>
                          Delete {entry.key}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <SetForm metadata={view.metadata} parked={view.parked} onSaved={() => void load()} />
          {deleting && (
            <DeleteDesk metadata={view.metadata} keyName={deleting} parked={view.parked} userId={userId} onChanged={() => void load()} />
          )}
          <History changes={view.metadata.changes} />
        </>
      )}
    </section>
  );
}

function SetForm({ metadata, parked, onSaved }: { metadata: AccountMetadata; parked: string | null; onSaved: () => void }) {
  const uid = useId();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const typedKey = key.trim();
  const typedReason = reason.trim();
  const hold = parked
    ? parked
    : !METADATA_KEY.test(typedKey)
      ? 'A key is lower case: a letter, then letters, digits, _ . : or -, 64 at most.'
      : value.length < 1 || value.length > METADATA_VALUE_MAX
        ? `A value is 1 to ${METADATA_VALUE_MAX} characters.`
        : typedReason.length < 12 || typedReason.length > 500
          ? 'A reason is 12 to 500 characters.'
          : null;
  const revision = revisionOf(metadata, typedKey);
  const existing = metadata.entries.find((e) => e.key === typedKey);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (hold || save.kind === 'saving') return;
    setSave({ kind: 'saving' });
    try {
      const headers = await founderMutationHeaders();
      const res = await fetch('/api/ledger-metadata/set', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ accountId: metadata.accountId, body: { key: typedKey, value, reason: typedReason, revision } }),
      });
      const body = (await res.json().catch(() => null)) as {
        change?: MetadataChange;
        code?: unknown;
        upstream?: unknown;
        detail?: unknown;
      } | null;
      if (res.ok && body?.change) {
        setSave({ kind: 'saved', change: body.change });
        setKey('');
        setValue('');
        setReason('');
        onSaved();
        return;
      }
      const code = typeof body?.upstream === 'string' ? body.upstream : typeof body?.code === 'string' ? body.code : null;
      setSave({ kind: 'refused', code, status: res.status, detail: typeof body?.detail === 'string' ? body.detail : null });
    } catch {
      setSave({ kind: 'refused', code: 'admin.upstream_unavailable', status: 503, detail: null });
    }
  };

  return (
    <form className="adm-stack" onSubmit={(event) => void submit(event)} data-testid="ledger-metadata-set">
      <h4>Set a key</h4>
      <div className="adm-field">
        <label htmlFor={`${uid}key`}>Key</label>
        <input
          id={`${uid}key`}
          className="adm-input"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="adm-field">
        <label htmlFor={`${uid}value`}>Value</label>
        <input
          id={`${uid}value`}
          className="adm-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={METADATA_VALUE_MAX}
          autoComplete="off"
        />
      </div>
      <div className="adm-field">
        <label htmlFor={`${uid}reason`}>Why (recorded with the change, 12 to 500 characters)</label>
        <textarea
          id={`${uid}reason`}
          className="adm-textarea"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </div>
      <p className="adm-subtle">
        {existing
          ? `Overwrites "${existing.value}" (revision ${existing.revision}).`
          : revision > 0
            ? `Sets a deleted key again, from revision ${revision}.`
            : 'Adds a new key.'}
      </p>
      <div className="adm-actions">
        <button type="submit" disabled={hold !== null || save.kind === 'saving'}>
          {save.kind === 'saving' ? 'Saving…' : 'Set key'}
        </button>
        {hold && <span className="adm-subtle">{hold}</span>}
      </div>
      {save.kind === 'saved' && (
        <p role="status" data-testid="ledger-metadata-saved">
          Set <code>{save.change.key}</code> to “{save.change.after}” at revision {save.change.revision}.
        </p>
      )}
      {save.kind === 'refused' && <RefusalLine code={save.code} status={save.status} testId="ledger-metadata-set-refused" />}
    </form>
  );
}

function DeleteDesk({
  metadata,
  keyName,
  parked,
  userId,
  onChanged,
}: {
  metadata: AccountMetadata;
  keyName: string;
  parked: string | null;
  userId: string;
  onChanged: () => void;
}) {
  const entry = metadata.entries.find((e) => e.key === keyName);
  const action: ControlAction | null = entry
    ? {
        heading: `Delete ${entry.key}`,
        submitLabel: 'Ask a second founder to approve the delete',
        needsReason: true,
        reasonLabel: 'Why (recorded with the delete, 12 to 500 characters)',
        build: (reason) => ({
          kind: 'ledger.account_metadata.delete',
          accountId: metadata.accountId,
          key: entry.key,
          reason,
          version: String(entry.revision),
        }),
        danger: true,
      }
    : null;
  return (
    <div className="adm-stack" data-testid="ledger-metadata-delete">
      <ControlDesk
        endpoint="/api/ledger-metadata/delete"
        userId={userId}
        blockedReason={parked}
        action={action}
        formHold={entry ? null : `${keyName} holds no value now. Read the account again.`}
        consequence={
          entry
            ? `Deletes "${entry.value}" from ${entry.key} on ${metadata.address}, if the key is still at revision ${entry.revision}. No posting or balance changes.`
            : 'Nothing to delete.'
        }
        blockedButtonLabel="Delete unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

function History({ changes }: { changes: readonly MetadataChange[] }) {
  if (changes.length === 0) return <p data-testid="ledger-metadata-history-empty">No key on this account has been set or deleted.</p>;
  return (
    <div className="adm-table-scroll">
      <table className="adm-crm-table" data-testid="ledger-metadata-history">
        <caption>Changes, newest first</caption>
        <thead>
          <tr>
            <th>When</th>
            <th>Key</th>
            <th>Change</th>
            <th>Before</th>
            <th>After</th>
            <th>Asked by</th>
            <th>Approved by</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.seq} data-seq={change.seq} data-action={change.action} data-key={change.key}>
              <td>{formatWhen(change.recordedAt)}</td>
              <td>
                <code>{change.key}</code>
              </td>
              <td>{change.action === 'set' ? 'Set' : 'Deleted'}</td>
              <td>{change.before ?? '—'}</td>
              <td>{change.after ?? '—'}</td>
              <td title={change.requesterId}>{shortId(change.requesterId)}</td>
              <td title={change.approverId ?? undefined}>{change.approverId ? shortId(change.approverId) : 'Not needed'}</td>
              <td>{change.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
