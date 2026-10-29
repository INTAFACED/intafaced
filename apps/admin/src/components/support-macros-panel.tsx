'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchMacros, postSupportAction, type ActionReply } from '@/lib/support/browser';
import type { SupportMacrosView } from '@/lib/support/types';
import { ActionOutcome, Failed } from './support-action-parts';

/**
 * SP-desk-02 — the macro library and your signature.
 *
 * A macro's placeholders come from a closed list that svc-support fills when the macro is applied: the requester's
 * name, the request id and your name. Only a support lead shares a macro with the desk. The shortest shortcode is the
 * owner's value; while it is not set svc-support refuses every save and the panel says so.
 */

const PLACEHOLDERS = ['{{requester.name}}', '{{ticket.id}}', '{{agent.name}}'];

export function MacrosPanelView({
  view,
  busy,
  reply,
  onSave,
  onSignature,
}: {
  view: SupportMacrosView | null;
  busy: boolean;
  reply: ActionReply | null;
  onSave: (input: { title: string; shortcode: string; body: string; shared: boolean }) => void;
  onSignature: (signature: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [shortcode, setShortcode] = useState('');
  const [body, setBody] = useState('');
  const [shared, setShared] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const list = view?.list.kind === 'ok' ? view.list.data : null;
  const current = view?.signature.kind === 'ok' ? view.signature.data : null;
  const draftSignature = signature ?? current ?? '';
  return (
    <section className="dk-stack" aria-label="Macros and your signature" data-testid="support-macros">
      <h2>Macros and your signature</h2>
      {!view && <p className="dk-muted">Reading the macros…</p>}
      {view?.list.kind === 'failed' && <Failed name="Macros" part={view.list} />}
      {list && (
        <>
          <p className="dk-muted">
            {list.shortcodeMin === null
              ? 'The shortest shortcode is not set by the owner yet, so svc-support refuses every new macro (support.shortcode_rule_unset).'
              : `A shortcode is at least ${list.shortcodeMin} characters: lower-case letters, digits, hyphen and underscore.`}
          </p>
          {list.macros.length === 0 ? (
            <p className="dk-muted">svc-support says there are no macros you can use yet.</p>
          ) : (
            <ul className="dk-stack">
              {list.macros.map((m) => (
                <li key={m.id}>
                  <strong>{m.title}</strong>{' '}
                  <span className="dk-muted">
                    ({m.shortcode}, {m.shared ? 'shared' : 'yours'})
                  </span>
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <h3>New macro</h3>
      <p className="dk-muted">Placeholders you may use: {PLACEHOLDERS.join(', ')}. Any other is refused.</p>
      <div className="adm-field">
        <label htmlFor="sd-macro-title">Macro title</label>
        <input id="sd-macro-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="sd-macro-shortcode">Shortcode</label>
        <input id="sd-macro-shortcode" value={shortcode} maxLength={32} onChange={(e) => setShortcode(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="sd-macro-body">Macro text</label>
        <textarea id="sd-macro-body" className="adm-textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <label className="dk-row" htmlFor="sd-macro-shared">
        <input id="sd-macro-shared" type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Share with the desk (support leads only)
      </label>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          data-tone="primary"
          disabled={busy || title.trim() === '' || shortcode.trim() === '' || body.trim() === ''}
          onClick={() => onSave({ title, shortcode, body, shared })}
        >
          Save macro
        </button>
      </div>
      <h3>Your signature</h3>
      {view?.signature.kind === 'failed' && <Failed name="Signature" part={view.signature} />}
      <div className="adm-field">
        <label htmlFor="sd-signature">Signature (closes your public replies; leave empty for none)</label>
        <textarea
          id="sd-signature"
          className="adm-textarea"
          rows={2}
          maxLength={500}
          value={draftSignature}
          onChange={(e) => setSignature(e.target.value)}
        />
      </div>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          disabled={busy}
          onClick={() => onSignature(draftSignature.trim() === '' ? null : draftSignature)}
        >
          Save signature
        </button>
      </div>
      <ActionOutcome reply={reply} testId="macros-outcome" />
    </section>
  );
}

export function MacrosPanel() {
  const [view, setView] = useState<SupportMacrosView | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ActionReply | null>(null);
  const lock = useRef(false);

  async function reload() {
    setView(await fetchMacros());
  }

  useEffect(() => {
    void reload();
  }, []);

  async function send(request: Parameters<typeof postSupportAction>[0]) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      setReply(await postSupportAction(request));
      await reload();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <MacrosPanelView
      view={view}
      busy={busy}
      reply={reply}
      onSave={(input) => void send({ action: 'macro_save', ...input })}
      onSignature={(signature) => void send({ action: 'signature_set', signature })}
    />
  );
}
