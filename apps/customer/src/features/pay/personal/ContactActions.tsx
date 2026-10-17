import { useId, useRef, useState } from 'react';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { uiCopy } from '../../../shared/ui-copy';
import { useResource } from '../../../shared/resource';
import type { PersonalPayApi } from '../pay-api';
import type { Contacts } from '../schemas';
import { FailureText } from './OrderChat';
import { p2pChatCopy } from './p2p-chat-copy';
import { changeContact, contactStanding, serviceFailureKind, type ContactChange, type ServiceFailure } from './p2p-chat-model';

const newKeyPart = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export type ContactsView =
  { status: 'loading' } | { status: 'failed'; kind: ServiceFailure } | { status: 'ready'; following: boolean; blocking: boolean };

/**
 * Follow and block as the service holds them. Every disabled button names its reason in the line under it, and the
 * buttons reflect only what `contacts.list` or the last change returned.
 */
export function ContactButtons({
  view,
  self,
  busy,
  saved,
  failure,
  onChange,
  onAskBlock,
  onReload,
}: {
  view: ContactsView;
  self: boolean;
  busy: ContactChange | null;
  saved: ContactChange | null;
  failure: ServiceFailure | null;
  onChange: (change: ContactChange) => void;
  onAskBlock: () => void;
  onReload: () => void;
}) {
  const { t, languageFor, directionFor } = p2pChatCopy.useCopy();
  const reasonId = useId();
  const ready = view.status === 'ready';
  const off = self || !ready || busy !== null;
  const reason = self
    ? t('failSelf')
    : view.status === 'loading'
      ? t('contactsLoading')
      : view.status === 'failed'
        ? t('contactsLoadFailed')
        : busy !== null
          ? t('saving')
          : null;
  const following = view.status === 'ready' && view.following;
  const blocking = view.status === 'ready' && view.blocking;
  return (
    <div className="p2p-contact" data-testid="contact-actions" lang={languageFor('contactsTitle')} dir={directionFor('contactsTitle')}>
      <h3>{t('contactsTitle')}</h3>
      {following || blocking ? (
        <p className="p2p-contact-status" data-testid="contact-status">
          {following ? <span>{t('statusFollowing')}</span> : null}
          {blocking ? <span>{t('statusBlocked')}</span> : null}
        </p>
      ) : null}
      <div className="p2p-cp-actions" role="group" aria-label={t('contactsTitle')}>
        <Button
          variant="secondary"
          disabled={off}
          aria-describedby={reasonId}
          onClick={() => onChange(following ? 'unfollow' : 'follow')}
          data-testid="contact-follow"
        >
          {following ? t('unfollowAction') : t('followAction')}
        </Button>
        <Button
          variant="secondary"
          disabled={off}
          aria-describedby={reasonId}
          onClick={() => (blocking ? onChange('unblock') : onAskBlock())}
          data-testid="contact-block"
        >
          {blocking ? t('unblockAction') : t('blockAction')}
        </Button>
        {view.status === 'failed' ? (
          <Button variant="ghost" onClick={onReload}>
            {t('contactsRetry')}
          </Button>
        ) : null}
      </div>
      <p className="muted" id={reasonId}>
        {reason ?? t('followNote')}
      </p>
      {view.status === 'failed' ? (
        <p role="alert" className="p2p-contact-problem" data-testid="contact-load-failed">
          <FailureText kind={view.kind} />
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="pay-confirmed" data-testid="contact-saved">
          {saved === 'follow'
            ? t('savedFollow')
            : saved === 'unfollow'
              ? t('savedUnfollow')
              : saved === 'block'
                ? t('savedBlock')
                : t('savedUnblock')}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="p2p-contact-problem" data-testid="contact-failure">
          <FailureText kind={failure} />
        </p>
      ) : null}
    </div>
  );
}

/** What blocking does, in the words of the confirmation. */
export function BlockConfirmBody({
  busy,
  failure,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  failure: ServiceFailure | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = p2pChatCopy.useCopy();
  return (
    <div className="form-stack" data-testid="block-confirm">
      <p>{t('blockBody')}</p>
      {failure ? (
        <p role="alert" className="p2p-contact-problem">
          <FailureText kind={failure} />
        </p>
      ) : null}
      <div className="actions">
        <Button variant="sell" disabled={busy} onClick={onConfirm}>
          {busy ? t('saving') : t('blockConfirm')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t('blockCancel')}
        </Button>
      </div>
    </div>
  );
}

/** Follow / unfollow and block / unblock one member, read from and written to svc-p2p. */
export function ContactActions({ pay, peerId }: { pay: PersonalPayApi; peerId: string }) {
  const { t } = p2pChatCopy.useCopy();
  const ui = uiCopy.useCopy();
  const list = useResource((signal) => pay.contacts(signal), `pay:contacts:${pay.viewer}`);
  const [lists, setLists] = useState<Contacts | null>(null);
  const [busy, setBusy] = useState<ContactChange | null>(null);
  const [saved, setSaved] = useState<ContactChange | null>(null);
  const [failure, setFailure] = useState<ServiceFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const self = pay.viewer !== null && pay.viewer.toLowerCase() === peerId.toLowerCase();
  const current: Contacts | null = lists ?? (list.resource.status === 'ready' ? list.resource.data : null);
  const view: ContactsView = current
    ? { status: 'ready', ...contactStanding(current, peerId) }
    : list.resource.status === 'failed'
      ? { status: 'failed', kind: serviceFailureKind(list.resource.failure) }
      : { status: 'loading' };

  async function change(next: ContactChange) {
    if (inFlight.current || self) return;
    inFlight.current = true;
    setBusy(next);
    setFailure(null);
    setSaved(null);
    try {
      const outcome = await changeContact(pay, keys.current, newKeyPart, next, peerId);
      if (outcome.ok) {
        setLists(outcome.contacts);
        setSaved(next);
        setConfirming(false);
      } else {
        setFailure(outcome.kind);
        // After a lost reply the real state is unknown: read it again rather than leave the old buttons standing.
        if (outcome.kind === 'unconfirmed') {
          setLists(null);
          list.reload();
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <>
      <ContactButtons
        view={view}
        self={self}
        busy={busy}
        saved={saved}
        failure={confirming ? null : failure}
        onChange={(next) => void change(next)}
        onAskBlock={() => {
          setFailure(null);
          setSaved(null);
          setConfirming(true);
        }}
        onReload={() => {
          setLists(null);
          list.reload();
        }}
      />
      {confirming ? (
        <Dialog
          closeLabel={ui.t('closeDialog')}
          title={t('blockTitle')}
          onClose={() => {
            if (!inFlight.current) setConfirming(false);
          }}
        >
          <BlockConfirmBody
            busy={busy === 'block'}
            failure={failure}
            onConfirm={() => void change('block')}
            onCancel={() => setConfirming(false)}
          />
        </Dialog>
      ) : null}
    </>
  );
}
