'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { SCAN_LABEL, SCAN_NOTE, addedByLabel, canOpen, sizeLabel } from '@/lib/support/files';
import { downloadFile, fetchTicketFiles, uploadFile } from '@/lib/support/files-browser';
import type { TicketFilesView } from '@/lib/support/files-server';
import { shortId } from '@/lib/desk/desk-model';
import { Failed } from './support-action-parts';

/**
 * FILES ON THE TICKET — what the customer attached, each with its scan state.
 *
 * Only a clean file has a download button; a file still being scanned or blocked shows why it has none. The download is
 * a real file (never opened in the console), and svc-support serves it only on a ticket assigned to the operator. The
 * assigned operator can also add a file: it belongs to the customer's request and they see it like a comment, so the panel
 * says so beside the control and marks each row with who added it. Size, type and count are the owner's settings, enforced by
 * svc-support; a refusal says which.
 */

export interface TicketFilesViewProps {
  readonly view: TicketFilesView | null;
  readonly loading: boolean;
  readonly busyId: string | null;
  readonly refusal: RefusalView | null;
  readonly uploading: boolean;
  readonly onDownload: (fileId: string) => void;
  readonly onUpload: (file: File) => void;
  readonly onRefresh: () => void;
}

export function TicketFilesPanelView(p: TicketFilesViewProps) {
  return (
    <section className="dk-stack" aria-label="Files on this ticket" data-testid="ticket-files">
      <h3>Files</h3>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : p.view.files.kind === 'failed' ? (
        <Failed name="Files" part={p.view.files} />
      ) : p.view.files.data.length === 0 ? (
        <p className="dk-muted" data-testid="ticket-files-empty">
          No file is on this ticket.
        </p>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table" data-testid="ticket-files-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Scan</th>
                <th>Added by</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.view.files.data.map((f) => (
                <tr key={f.id} data-scan-state={f.scanState}>
                  <td>
                    <span className="dk-packet">{shortId(f.id)}</span> · {f.contentType}
                  </td>
                  <td>{sizeLabel(f.byteLength)}</td>
                  <td title={SCAN_NOTE[f.scanState]}>{SCAN_LABEL[f.scanState]}</td>
                  <td data-testid="ticket-file-by">{addedByLabel(f)}</td>
                  <td>{formatWhen(f.createdAt)}</td>
                  <td>
                    {canOpen(f.scanState) ? (
                      <button type="button" className="adm-btn" disabled={p.busyId !== null} onClick={() => p.onDownload(f.id)}>
                        {p.busyId === f.id ? 'Downloading…' : 'Download'}
                      </button>
                    ) : (
                      <span className="dk-muted">{SCAN_NOTE[f.scanState]}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.refusal && (
        <div className="adm-callout" role="alert" data-tone="danger" data-testid="ticket-files-refusal">
          <strong>{p.refusal.title}</strong>
          <p>{p.refusal.body}</p>
          <p>{p.refusal.next}</p>
        </div>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={p.onRefresh} disabled={p.loading}>
          {p.loading ? 'Reading…' : 'Reload files'}
        </button>
        {p.view && <span className="dk-asof">As of {formatAsOf(p.view.asOf)}</span>}
      </div>
      <div className="dk-stack" data-testid="ticket-files-add">
        <label className="dk-field">
          <span>Add a file for the customer</span>
          <input
            type="file"
            data-testid="ticket-files-input"
            disabled={p.uploading}
            onChange={(e) => {
              const picked = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (picked) p.onUpload(picked);
            }}
          />
        </label>
        {p.uploading && <p className="dk-muted">Adding and scanning the file…</p>}
        <p className="dk-muted">
          The customer sees a file you add, like a comment. It is scanned first and is not kept if the scan refuses it. Only the operator
          the ticket is assigned to can add one.
        </p>
      </div>
    </section>
  );
}

function saveBlob(blob: Blob, fileId: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attachment-${fileId.slice(0, 8)}`;
  link.click();
  URL.revokeObjectURL(url);
}

export function TicketFiles({ ticketId }: { ticketId: string }) {
  const [view, setView] = useState<TicketFilesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  const [uploading, setUploading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchTicketFiles(ticketId);
    if (mine === seq.current) {
      setView(next);
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
    return () => {
      seq.current += 1;
    };
  }, [load]);

  async function download(fileId: string) {
    if (busyId !== null) return;
    setBusyId(fileId);
    setRefusal(null);
    try {
      const got = await downloadFile(fileId);
      if (got.ok) saveBlob(got.blob, fileId);
      else {
        setRefusal(got.refusal);
        // A file that was still being scanned may have changed state; show what is true.
        await load();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function upload(file: File) {
    if (uploading) return;
    setUploading(true);
    setRefusal(null);
    try {
      const got = await uploadFile(ticketId, file);
      if (!got.ok) setRefusal(got.refusal);
      // Either way show what svc-support holds now, never a guess at the new row.
      await load();
    } finally {
      setUploading(false);
    }
  }

  return (
    <TicketFilesPanelView
      view={view}
      loading={loading}
      busyId={busyId}
      refusal={refusal}
      uploading={uploading}
      onDownload={(id) => void download(id)}
      onUpload={(file) => void upload(file)}
      onRefresh={() => void load()}
    />
  );
}
