'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ModuleId } from '@intafaced/config';
import { MODULE_IDS } from '@intafaced/config/modules';
import { SERVICE_OWNER_TEAM_MAX, SERVICE_RECORD_STALE, type ServiceRecord } from '@intafaced/contracts/ops-console-services';
import { formatAsOf } from '@/lib/as-of';
import { postConsoleChange, type ConsoleChangeReply } from '@/lib/console-announcements/browser';
import './desk.css';

/**
 * The owner-set part of a module's service record: the owning team, the modules it depends on, and its runbook. A save
 * names the revision this page read, so another founder's change is never overwritten unseen; after any outcome the page
 * reads again rather than repeating the save.
 */

function Outcome({ reply }: { reply: ConsoleChangeReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="service-record-outcome">
        <strong>Done: service record saved</strong>
      </div>
    );
  return (
    <div className="adm-callout" role="alert" data-tone="danger" data-testid="service-record-outcome" data-code={reply.code ?? ''}>
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function Fields({
  module,
  record,
  blocker,
  onDone,
}: {
  module: ModuleId;
  record: ServiceRecord | null;
  blocker: string | null;
  onDone: (reply: ConsoleChangeReply) => void;
}) {
  const [owner, setOwner] = useState(record?.ownerTeam ?? '');
  const [runbook, setRunbook] = useState(record?.runbook ?? '');
  const [deps, setDeps] = useState<readonly string[]>(record?.dependencies ?? []);
  const [busy, setBusy] = useState(false);
  const disabled = busy || record === null;

  const save = async () => {
    if (!record) return;
    setBusy(true);
    const reply = await postConsoleChange('/api/service-records', {
      module,
      expectedRevision: record.revision,
      ownerTeam: owner,
      dependencies: MODULE_IDS.filter((m) => deps.includes(m)),
      runbook,
    });
    setBusy(false);
    onDone(reply);
  };

  return (
    <>
      {blocker && <p className="dk-why">{blocker}</p>}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="service-owner">Owner team</label>
          <input
            id="service-owner"
            className="adm-input"
            maxLength={SERVICE_OWNER_TEAM_MAX}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="service-runbook">Runbook (a path in docs/runbooks/)</label>
          <input
            id="service-runbook"
            className="adm-input"
            placeholder="docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md"
            value={runbook}
            onChange={(e) => setRunbook(e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
      <fieldset className="dk-stack" disabled={disabled}>
        <legend>Depends on</legend>
        <div className="dk-row">
          {MODULE_IDS.filter((m) => m !== module).map((m) => (
            <label key={m}>
              <input
                type="checkbox"
                name="dependency"
                value={m}
                checked={deps.includes(m)}
                onChange={(e) => setDeps((d) => (e.target.checked ? [...d, m] : d.filter((x) => x !== m)))}
              />{' '}
              {m}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void save()} disabled={disabled}>
          Save the service record
        </button>
        <span className="dk-muted">Blank owner or runbook leaves it not set.</span>
      </div>
    </>
  );
}

export function ServiceRecordForm({ module, record, blocker }: { module: ModuleId; record: ServiceRecord | null; blocker: string | null }) {
  const router = useRouter();
  const [reply, setReply] = useState<ConsoleChangeReply | null>(null);
  const onDone = (r: ConsoleChangeReply) => {
    setReply(r);
    // Saved, saved first by someone else, or not known: read what is stored now. The fields reset from the new revision.
    if (r.ok || r.code === SERVICE_RECORD_STALE || r.changed === 'unknown') router.refresh();
  };
  return (
    <section className="dk-stack" aria-labelledby="h-service-record" data-testid="service-record-form">
      <h2 id="h-service-record">Change the service record</h2>
      <p className="dk-muted">
        {record === null || record.revision === 0
          ? 'Nobody has set this record yet.'
          : `Revision ${record.revision}, saved ${formatAsOf(record.updatedAt)}.`}
      </p>
      <Outcome reply={reply} />
      <Fields key={record?.revision ?? -1} module={module} record={record} blocker={blocker} onDone={onDone} />
    </section>
  );
}
