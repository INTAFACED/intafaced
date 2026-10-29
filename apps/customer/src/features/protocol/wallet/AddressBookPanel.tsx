import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ADDRESS_BOOK_LABEL_MAX, WALLET_GROUP_NAME_MAX } from '@intafaced/contracts/protocol-address-book';
import { Button, DataTable, Dialog, EmptyState, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { walletGroupPath } from '../routes';
import type { AddressBook } from './address-book-api';
import { walletCopy } from './copy';
import { ADDRESS } from './eip1193';
import { bookMessage, useAddressBook, type BookFailure } from './useAddressBook';

type Book = { kind: 'idle' } | { kind: 'opening' } | { kind: 'ready'; book: AddressBook } | { kind: 'closed'; message: string };

/**
 * The address book and wallet groups (D-portfolio-wallet-03). Kept by svc-protocol for this wallet address, so a contact
 * saved here is there on another device: the book opens with a sign-in the wallet signs (it moves nothing), and every
 * call carries that session. A group is this wallet and some of its contacts; its page shows their combined activity.
 */
export function AddressBookPanel() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { run, address } = useAddressBook();
  const [book, setBook] = useState<Book>({ kind: 'idle' });
  const [label, setLabel] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const turn = useRef(0);

  const fail = useCallback((failure: BookFailure) => bookMessage(t, failure), [t]);

  /** Reads the book; opens the session first when there is none. */
  const load = useCallback(async () => {
    const mine = ++turn.current;
    setBook({ kind: 'opening' });
    const read = await run((api, session) => api.list(session));
    if (mine !== turn.current) return;
    setBook(read.ok ? { kind: 'ready', book: read.data } : { kind: 'closed', message: fail(read) });
  }, [run, fail]);

  useEffect(() => {
    // The book is this wallet's: a new or changed wallet reads its own, and no wallet shows none.
    if (address) void load();
    else {
      turn.current++;
      setBook({ kind: 'idle' });
    }
  }, [address, load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    const text = label.trim();
    if (text.length === 0 || [...text].length > ADDRESS_BOOK_LABEL_MAX)
      return setProblem(t('bookRefused_contact_label_invalid', { max: String(ADDRESS_BOOK_LABEL_MAX) }));
    if (!ADDRESS.test(contactAddress.trim())) return setProblem(t('bookRefused_contact_address_invalid'));
    setProblem(null);
    setSaving(true);
    try {
      const added = await run((api, session) => api.addContact(session, { label: text, address: contactAddress.trim() }));
      if (!added.ok) return setProblem(fail(added));
      setLabel('');
      setContactAddress('');
      setNotice(t('addSaved', { label: added.data.label }));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, name: string) => {
    setNotice(null);
    const removed = await run((api, session) => api.removeContact(session, id));
    if (!removed.ok) return setProblem(fail(removed));
    setNotice(t('contactRemoved', { label: name }));
    await load();
  };

  const ready = book.kind === 'ready' ? book.book : null;

  return (
    <>
      <Panel title={t('bookTitle')}>
        <p className="muted">{t('bookNote')}</p>
        {!address && <p className="muted">{t('needsWallet')}</p>}
        {book.kind === 'opening' && <p role="status">{t('bookLoading')}</p>}
        {book.kind === 'closed' && (
          <>
            <p role="alert" data-book-closed>
              {book.message}
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              {t('bookSignIn')}
            </Button>
          </>
        )}
        <form aria-label={t('addTitle')} onSubmit={(event) => void save(event)}>
          <Field
            label={t('addLabel')}
            hint={t('addLabelHint', { max: String(ADDRESS_BOOK_LABEL_MAX) })}
            value={label}
            autoComplete="off"
            onChange={(event) => {
              setLabel(event.target.value);
              setProblem(null);
            }}
          />
          <Field
            label={t('addAddress')}
            hint={t('addAddressHint')}
            value={contactAddress}
            autoComplete="off"
            spellCheck={false}
            className="numeric"
            onChange={(event) => {
              setContactAddress(event.target.value);
              setProblem(null);
            }}
          />
          {problem && <p role="alert">{problem}</p>}
          <Button type="submit" disabled={!address || saving}>
            {t('addSave')}
          </Button>
        </form>
        {notice && <p role="status">{notice}</p>}
      </Panel>
      <Panel title={t('contactsTitle')}>
        <DataTable label={t('contactsTitle')} headers={[t('hdr_label'), t('hdr_address'), t('hdr_actions')]}>
          {ready && ready.contacts.length > 0 ? (
            ready.contacts.map((contact) => (
              <tr key={contact.id}>
                <td>{contact.label}</td>
                <td className="numeric">{contact.address}</td>
                <td>
                  <Button variant="ghost" onClick={() => void remove(contact.id, contact.label)}>
                    {t('contactRemove')}
                  </Button>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3}>
                <EmptyState title={ready ? t('contactsEmpty') : address ? t('bookLoading') : t('needsWallet')} />
              </td>
            </tr>
          )}
        </DataTable>
      </Panel>
      <Panel title={t('groupsTitle')}>
        <p className="muted">{t('groupsNote')}</p>
        <Button variant="secondary" disabled={!ready} onClick={() => setGrouping(true)}>
          {t('groupNew')}
        </Button>
        <DataTable label={t('groupsTitle')} headers={[t('hdr_name'), t('hdr_members')]}>
          {ready && ready.groups.length > 0 ? (
            ready.groups.map((group) => (
              <tr key={group.id}>
                <td>
                  <a href={walletGroupPath(group.id)}>{group.name}</a>
                </td>
                <td>{group.members.map((m) => (m.self ? t('groupThisWallet') : (m.label ?? m.address))).join(', ')}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2}>
                <EmptyState title={ready ? t('groupsEmpty') : address ? t('bookLoading') : t('needsWallet')} />
              </td>
            </tr>
          )}
        </DataTable>
      </Panel>
      {grouping && ready && (
        <NewGroupDialog
          book={ready}
          onClose={() => setGrouping(false)}
          onSaved={(name) => {
            setGrouping(false);
            setNotice(t('groupSaved', { name }));
            void load();
          }}
          run={run}
        />
      )}
    </>
  );
}

function NewGroupDialog({
  book,
  onClose,
  onSaved,
  run,
}: {
  book: AddressBook;
  onClose: () => void;
  onSaved: (name: string) => void;
  run: ReturnType<typeof useAddressBook>['run'];
}) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toggle = (member: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(member);
      else next.delete(member);
      return next;
    });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const text = name.trim();
    if (text.length === 0 || [...text].length > WALLET_GROUP_NAME_MAX)
      return setProblem(t('bookRefused_group_name_invalid', { max: String(WALLET_GROUP_NAME_MAX) }));
    if (chosen.size === 0) return setProblem(t('bookRefused_group_members_empty'));
    setProblem(null);
    setSaving(true);
    try {
      const created = await run((api, session) => api.createGroup(session, { name: text, members: [...chosen] }));
      if (!created.ok) return setProblem(bookMessage(t, created));
      onSaved(created.data.name);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={t('groupNew')} onClose={onClose}>
      <form aria-label={t('groupNew')} onSubmit={(event) => void save(event)}>
        <Field
          label={t('groupName')}
          hint={t('groupNameHint', { max: String(WALLET_GROUP_NAME_MAX) })}
          value={name}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
        <fieldset>
          <legend>{t('groupMembers')}</legend>
          <label className="field field--inline">
            <input type="checkbox" checked={chosen.has(book.owner)} onChange={(event) => toggle(book.owner, event.target.checked)} />
            <span>{t('groupThisWallet')}</span>
          </label>
          {book.contacts.map((contact) => (
            <label key={contact.id} className="field field--inline">
              <input
                type="checkbox"
                checked={chosen.has(contact.address)}
                onChange={(event) => toggle(contact.address, event.target.checked)}
              />
              <span>{contact.label}</span>
            </label>
          ))}
        </fieldset>
        {problem && <p role="alert">{problem}</p>}
        <Button type="submit" disabled={saving}>
          {t('groupSave')}
        </Button>{' '}
        <Button variant="secondary" onClick={onClose}>
          {t('groupCancel')}
        </Button>
      </form>
    </Dialog>
  );
}
