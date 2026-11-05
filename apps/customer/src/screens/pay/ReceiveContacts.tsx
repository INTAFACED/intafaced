import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  addReceiveContact,
  Button,
  contactKind,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
    <div className="pay-block" data-testid="receive-contacts">
      <h3 className="pay-section-title" id={titleId}>
        {payCopy.t('Ways to receive')}
      </h3>
      <p className="pay-hint">{payCopy.t('Ways to receive hint')}</p>
      {loaded.status === 'loading' ? (
        <p className="pay-hint" aria-busy="true">
          {payCopy.t('Checking handle')}
        </p>
      ) : null}
      {loaded.status === 'failed' ? (
        <p className="pay-problem" role="alert">
          {payCopy.t('Ways to receive failed')}
          <button type="button" className="pay-chip" onClick={() => setRevision((n) => n + 1)}>
            {payCopy.t('Try again')}
          </button>
        </p>
      ) : null}
      {loaded.status === 'refused' ? (
        <p className="pay-problem" role="alert">
          {receiveRefusalText(loaded.code, null)}
        </p>
      ) : null}
      {list ? (
        <ul aria-labelledby={titleId} className="pay-receive-contacts">
          {list.contacts.length === 0 ? <li className="pay-hint">{payCopy.t('No ways to receive')}</li> : null}
          {list.contacts.map((contact) => (
            <li key={contact.id} className="pay-handle-row" data-verified={contact.verified ? '' : undefined}>
              <span className="pay-handle-row__text">
                <span className="pay-mono">{contact.target}</span>
                <span className="pay-hint">{contact.verified ? payCopy.t('Ready to receive') : payCopy.t('Waiting for its code')}</span>
              </span>
              {contact.verified ? null : (
                <Button variant="secondary" size={40} onClick={() => openCode(contact)}>
                  {payCopy.t('Enter the code')}
                </Button>
              )}
              <Button
                variant="ghost"
                size={40}
                aria-label={payCopy.t('Remove {target}', { target: contact.target })}
                disabled={removing !== null}
                loading={removing === contact.id}
                onClick={() => void remove(contact)}
              >
                {payCopy.t('Remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {rowRefusal ? (
        <p className="pay-problem" role="alert">
          {receiveRefusalText(rowRefusal, max)}
        </p>
      ) : null}
      <Button variant="secondary" size={40} disabled={list === null} onClick={openAdd}>
        {payCopy.t('Add an email or phone to receive by')}
      </Button>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          {step.kind === 'address' ? (
            <form onSubmit={(event) => void add(event)} noValidate>
              <DialogHeader>
                <DialogTitle>{payCopy.t('Add a way to receive')}</DialogTitle>
                <DialogDescription>{payCopy.t('Add a way to receive body')}</DialogDescription>
              </DialogHeader>
              <div className="pay-field">
                <label className="pay-field__label" htmlFor={addressId}>
                  {payCopy.t('Email or phone')}
                </label>
                <input
                  id={addressId}
                  className="pay-to__input"
                  type="text"
                  inputMode="email"
                  value={draft}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={320}
                  aria-invalid={refusal !== null || undefined}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <span className="pay-hint">{payCopy.t('Email or phone hint')}</span>
              </div>
              {refusal ? (
                <p className="pay-problem" role="alert">
                  {receiveRefusalText(refusal, max)}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" size={40} disabled={busy} onClick={() => setOpen(false)}>
                  {payCopy.t('Cancel')}
                </Button>
                <Button type="submit" variant="primary" size={40} loading={busy}>
                  {payCopy.t('Add')}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form onSubmit={(event) => void confirm(event)} noValidate>
              <DialogHeader>
                <DialogTitle>{payCopy.t('Enter the code')}</DialogTitle>
                <DialogDescription>{payCopy.t('Code sent to {target}', { target: step.contact.target })}</DialogDescription>
              </DialogHeader>
              <div className="pay-field">
                <label className="pay-field__label" htmlFor={codeId}>
                  {payCopy.t('Code')}
                </label>
                <input
                  id={codeId}
                  className="pay-to__input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  maxLength={16}
                  aria-invalid={refusal !== null || undefined}
                  onChange={(event) => setCode(event.target.value)}
                  data-mono=""
                />
              </div>
              {refusal ? (
                <p className="pay-problem" role="alert">
                  {receiveRefusalText(refusal, max)}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" size={40} disabled={busy} onClick={() => setOpen(false)}>
                  {payCopy.t('Cancel')}
                </Button>
                <Button type="submit" variant="primary" size={40} loading={busy}>
                  {payCopy.t('Confirm')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
