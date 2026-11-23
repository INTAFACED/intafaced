import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Field, StatusNote } from '@intafaced/ui/lit';
import { Dialog } from '@intafaced/ui/lit/templates';
import {
  addReceiveContact,
  contactKind,
  fetchReceiveContacts,
  removeReceiveContact,
  useSession,
  verifyReceiveContact,
  type ReceiveContact,
  type ReceiveContactCode,
  type ReceiveContactList,
} from './deps';
import { payCopy } from './copy';

type Loaded =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'refused'; code: ReceiveContactCode }
  | { status: 'ready'; list: ReceiveContactList };
type Step = { kind: 'address' } | { kind: 'code'; contact: ReceiveContact };

/** The sentence for each refusal the service names. Never a guess: an unknown answer is the generic failure. */
export function receiveRefusalText(code: ReceiveContactCode | 'failed', max: number | null): string {
  switch (code) {
    case 'identity.receive_contact_invalid':
      return payCopy.t('Receive contact invalid');
    case 'identity.receive_contact_unset':
      return payCopy.t('Receive contacts not open');
    case 'identity.receive_contact_cap_reached':
      return max === null ? payCopy.t('Receive contact failed') : payCopy.t('Receive contacts used up {n}', { n: String(max) });
    case 'identity.receive_contact_mail_off':
      return payCopy.t('Receive contact mail off');
    case 'identity.receive_contact_sms_off':
      return payCopy.t('Receive contact sms off');
    case 'identity.receive_contact_wait':
      return payCopy.t('Receive contact wait');
    case 'identity.receive_contact_send_failed':
      return payCopy.t('Receive contact send failed');
    case 'identity.contact_code_invalid':
      return payCopy.t('Receive contact code invalid');
    case 'identity.security_locked':
      return payCopy.t('Handle security locked');
    case 'identity.delegated_refused':
      return payCopy.t('Handle delegated');
    case 'auth.account_frozen':
      return payCopy.t('Handle account frozen');
    case 'identity.session_not_live':
      return payCopy.t('Sign in again');
    default:
      return payCopy.t('Receive contact failed');
  }
}

/**
 * Receive's ways to receive (PP-send-request-03, J-pay-03 #6): extra emails and phones people can pay this account by.
 * One counts only once its code, sent to it, is typed back here. A sender that is switched off is named in the dialog
 * before anything is stored; a cap the owner has not published refuses and says so, never a made-up number.
 */
export function ReceiveContacts() {
  const { api } = useSession();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'address' });
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ReceiveContactCode | 'failed' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowRefusal, setRowRefusal] = useState<ReceiveContactCode | 'failed' | null>(null);
  const addressId = useId();
  const codeId = useId();
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetchReceiveContacts(api, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setLoaded(
        outcome.kind === 'ok'
          ? { status: 'ready', list: outcome.list }
          : outcome.kind === 'refused'
            ? { status: 'refused', code: outcome.code }
            : { status: 'failed' },
      );
    });
    return () => controller.abort();
  }, [api, revision]);

  const list = loaded.status === 'ready' ? loaded.list : null;
  const max = list?.max ?? null;

  function openAdd() {
    setDraft('');
    setCode('');
    setRefusal(null);
    setStep({ kind: 'address' });
    setOpen(true);
  }

  function openCode(contact: ReceiveContact) {
    setCode('');
    setRefusal(null);
    setStep({ kind: 'code', contact });
    setOpen(true);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const target = draft.trim();
    const channel = contactKind(target) ?? (target.startsWith('+') ? 'phone' : 'email');
    setBusy(true);
    setRefusal(null);
    const outcome = await addReceiveContact(api, { channel, target });
    setBusy(false);
    if (outcome.kind !== 'ok') return setRefusal(outcome.kind === 'refused' ? outcome.code : 'failed');
    setLoaded({ status: 'ready', list: outcome.list });
    const added = outcome.list.contacts.find((c) => c.channel === channel && c.target.toLowerCase() === target.toLowerCase());
    if (!added || added.verified) return setOpen(false);
    setCode('');
    setStep({ kind: 'code', contact: added });
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (busy || step.kind !== 'code') return;
    setBusy(true);
    setRefusal(null);
    const outcome = await verifyReceiveContact(api, { id: step.contact.id, code: code.trim() });
    setBusy(false);
    if (outcome.kind !== 'ok') return setRefusal(outcome.kind === 'refused' ? outcome.code : 'failed');
    setLoaded({ status: 'ready', list: outcome.list });
    setOpen(false);
  }

  async function remove(contact: ReceiveContact) {
    // One removal at a time: a second click on a row already going would only come back "not found".
    if (removing !== null) return;
    setRemoving(contact.id);
    setRowRefusal(null);
    const outcome = await removeReceiveContact(api, { id: contact.id });
    setRemoving(null);
    if (outcome.kind === 'ok') setLoaded({ status: 'ready', list: outcome.list });
    else setRowRefusal(outcome.kind === 'refused' ? outcome.code : 'failed');
  }

  return (
    <div className="lt-stack" data-testid="receive-contacts">
      <h3 id={titleId}>{payCopy.t('Ways to receive')}</h3>
      <p className="lt-hint">{payCopy.t('Ways to receive hint')}</p>
      {loaded.status === 'loading' ? (
        <p className="lt-hint" aria-busy="true">
          {payCopy.t('Checking handle')}
        </p>
      ) : null}
      {loaded.status === 'failed' ? (
        <StatusNote tone="error" actions={<Button onClick={() => setRevision((n) => n + 1)}>{payCopy.t('Try again')}</Button>}>
          {payCopy.t('Ways to receive failed')}
        </StatusNote>
      ) : null}
      {loaded.status === 'refused' ? <StatusNote tone="error">{receiveRefusalText(loaded.code, null)}</StatusNote> : null}
      {list ? (
        <ul aria-labelledby={titleId} className="lt-rows">
          {list.contacts.length === 0 ? <li className="lt-hint">{payCopy.t('No ways to receive')}</li> : null}
          {list.contacts.map((contact) => (
            <li key={contact.id} data-verified={contact.verified ? '' : undefined}>
              <span className="lt-lines">
                <span className="lt-mono">{contact.target}</span>
                <span className="lt-hint">{contact.verified ? payCopy.t('Ready to receive') : payCopy.t('Waiting for its code')}</span>
              </span>
              <span className="lt-actions">
                {contact.verified ? null : <Button onClick={() => openCode(contact)}>{payCopy.t('Enter the code')}</Button>}
                <Button
                  tone="quiet"
                  aria-label={payCopy.t('Remove {target}', { target: contact.target })}
                  disabled={removing !== null}
                  aria-busy={removing === contact.id || undefined}
                  onClick={() => void remove(contact)}
                >
                  {payCopy.t('Remove')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {rowRefusal ? <StatusNote tone="error">{receiveRefusalText(rowRefusal, max)}</StatusNote> : null}
      <div className="lt-actions">
        <Button disabled={list === null} onClick={openAdd}>
          {payCopy.t('Add an email or phone to receive by')}
        </Button>
      </div>

      {open ? (
        <Dialog
          title={step.kind === 'address' ? payCopy.t('Add a way to receive') : payCopy.t('Enter the code')}
          closeLabel={payCopy.t('Dismiss')}
          onClose={() => !busy && setOpen(false)}
        >
          {step.kind === 'address' ? (
            <form className="lt-stack" onSubmit={(event) => void add(event)} noValidate>
              <p className="lt-hint">{payCopy.t('Add a way to receive body')}</p>
              <Field
                id={addressId}
                label={payCopy.t('Email or phone')}
                type="text"
                inputMode="email"
                value={draft}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={320}
                hint={payCopy.t('Email or phone hint')}
                error={refusal ? receiveRefusalText(refusal, max) : undefined}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="lt-actions">
                <Button tone="quiet" disabled={busy} onClick={() => setOpen(false)}>
                  {payCopy.t('Cancel')}
                </Button>
                <Button type="submit" tone="primary" disabled={busy} aria-busy={busy || undefined}>
                  {payCopy.t('Add')}
                </Button>
              </div>
            </form>
          ) : (
            <form className="lt-stack" onSubmit={(event) => void confirm(event)} noValidate>
              <p className="lt-hint">{payCopy.t('Code sent to {target}', { target: step.contact.target })}</p>
              <Field
                id={codeId}
                label={payCopy.t('Code')}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                maxLength={16}
                error={refusal ? receiveRefusalText(refusal, max) : undefined}
                onChange={(event) => setCode(event.target.value)}
                data-mono=""
              />
              <div className="lt-actions">
                <Button tone="quiet" disabled={busy} onClick={() => setOpen(false)}>
                  {payCopy.t('Cancel')}
                </Button>
                <Button type="submit" tone="primary" disabled={busy} aria-busy={busy || undefined}>
                  {payCopy.t('Confirm')}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}
