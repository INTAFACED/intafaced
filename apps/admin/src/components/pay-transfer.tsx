'use client';

import { useRef, useState } from 'react';
import { fetchTransfer } from '@/lib/ops-desk/browser';
import { displayCell } from '@/lib/ops-desk/model';
import type { ReadOutcome } from '@/lib/ops-desk/types';
import { formatAsOf } from '@/lib/as-of';
import './desk.css';

/**
 * One transfer's full record from svc-bank (`ops.transferDetail`). It is read when asked, never with the page, because svc-bank
 * writes a log line with the reader and the id every time it hands a record out. A refusal is shown in the service's words with
 * its code; nothing is shown in place of a record that could not be read.
 */

type Load = { readonly state: 'idle' } | { readonly state: 'loading' } | { readonly state: 'done'; readonly outcome: ReadOutcome | null };

function RecordView({ outcome }: { outcome: ReadOutcome | null }) {
  if (outcome === null) {
    return (
      <p className="dk-why" role="alert" data-testid="transfer-unreached">
        The console could not reach its own server for this record. Nothing is shown rather than a guess.
      </p>
    );
  }
  const { part } = outcome;
  if (part.kind === 'failed') {
    return (
      <div
        className="adm-callout"
        data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'}
        role="status"
        data-testid="transfer-failed"
      >
        <strong>Could not load the transfer record</strong>
        <p className="dk-muted">As of {formatAsOf(outcome.asOf)}.</p>
        <p>{part.message}</p>
        {part.code && <p className="dk-muted">Code: {part.code}</p>}
        <p className="dk-muted">Nothing is shown here rather than a guess.</p>
      </div>
    );
  }
  if (part.data.shape !== 'record') return null;
  return (
    <div className="dk-stack" data-testid="transfer-record">
      <p className="dk-asof">As of {formatAsOf(outcome.asOf)} (when this console read svc-bank)</p>
      <dl className="dk-kv">
        {part.data.cells.map((c) => (
          <div key={c.key} className="dk-kv-row">
            <dt>{c.label}</dt>
            <dd className={c.kind === 'text' && c.label.toLowerCase().includes('id') ? 'dk-packet' : undefined}>{displayCell(c)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A button that reads the record of the transfer with this id, and shows it below. */
export function TransferRecord({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const busy = useRef(false);
  async function read() {
    if (busy.current) return;
    busy.current = true;
    setLoad({ state: 'loading' });
    try {
      setLoad({ state: 'done', outcome: await fetchTransfer(id) });
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="dk-stack" data-testid="transfer-detail">
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void read()} disabled={load.state === 'loading'}>
          {load.state === 'loading' ? 'Reading…' : load.state === 'done' ? 'Read the record again' : 'Read the full transfer record'}
        </button>
        <span className="dk-muted">svc-bank logs your account and this id each time it hands out a record.</span>
      </div>
      {load.state === 'done' && <RecordView outcome={load.outcome} />}
    </div>
  );
}

/** Look up one transfer by id: the way to reach a one-off send, which no list holds. */
export function TransferLookup() {
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const id = typed.trim();
  return (
    <form
      className="dk-stack"
      data-testid="transfer-lookup"
      onSubmit={(e) => {
        e.preventDefault();
        if (id !== '') setAsked(id);
      }}
    >
      <h3>Look up one transfer</h3>
      <p className="dk-muted">
        Paste a standing-order execution id or a one-off send id, as support has it from the customer. svc-bank gives the same answer for an
        id it does not hold and for one that is not in its format.
      </p>
      <div className="adm-field">
        <label htmlFor="transfer-lookup-id">Transfer id</label>
        <input
          id="transfer-lookup-id"
          className="adm-input"
          value={typed}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            setAsked(null);
          }}
        />
      </div>
      <div className="dk-row">
        <button type="submit" className="adm-btn" disabled={id === ''}>
          Find this transfer
        </button>
        {id === '' && <span className="dk-why">Enter a transfer id first.</span>}
      </div>
      {asked !== null && <TransferRecord key={asked} id={asked} />}
    </form>
  );
}
