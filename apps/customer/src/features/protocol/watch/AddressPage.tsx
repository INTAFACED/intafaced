import { useState, type FormEvent, type ReactNode } from 'react';
import { upsertAddressWatch, WATCH_NOTE_MAX, WATCH_TAG_MAX, type AddressWatch } from '@intafaced/contracts/protocol-watch-preferences';
import { navigate } from '../../../app/location';
import { Button, Dialog, EmptyState, Page, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../session/session';
import { protocolCopy } from '../copy';
import { ADDRESS_SHAPE } from '../routes';
import { AddressActivity, AddressHoldings, AddressSummary, PastBalance } from '../explorer/AddressDetails';
import { useAccountAddressWatches } from './account-lists';
import { watchCopy, type WatchTranslate } from './copy';
import '../protocol.css';

type AddressWatches = ReturnType<typeof useAccountAddressWatches>;

/** Shell of a Web3 page: the read-only banner and the Not INTACHAIN pill every protocol room carries. */
export function WatchShell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const { language } = usePreferences();
  const room = protocolCopy.forLocale(language).t;
  return (
    <div className="legacy-room protocol-room" lang={watchCopy.forLocale(language).renderedLocale}>
      <Page
        title={title}
        description={description}
        eyebrow={
          <>
            <span>{room('bannerLine')}</span>
            <span className="badge protocol-pill">{room('bannerPill')}</span>
          </>
        }
      >
        {children}
      </Page>
    </div>
  );
}

function WatchDialog({
  address,
  existing,
  change,
  onClose,
  t,
}: {
  address: string;
  existing: AddressWatch | undefined;
  change: AddressWatches['change'];
  onClose: () => void;
  t: WatchTranslate;
}) {
  const [tag, setTag] = useState(existing?.tag ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'not-saved' | 'full' | 'unknown' | 'tag'>('idle');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!tag.trim()) return setState('tag');
    setState('saving');
    const write = await change((items) => upsertAddressWatch(items, { address, tag, note }));
    if (write === 'saved') onClose();
    else setState(write);
  }
  return (
    <Dialog title={t('watch')} onClose={onClose}>
      <form className="protocol-quote" onSubmit={save}>
        <label>
          <span>{t('watchTag')}</span>
          <input type="text" value={tag} maxLength={WATCH_TAG_MAX} onChange={(event) => setTag(event.target.value)} />
        </label>
        <label>
          <span>{t('watchNote')}</span>
          <textarea value={note} maxLength={WATCH_NOTE_MAX} onChange={(event) => setNote(event.target.value)} />
        </label>
        <small className="muted">{t('watchNoteHint')}</small>
        {state === 'tag' && <p role="alert">{t('watchTagRequired')}</p>}
        {state === 'not-saved' && <p role="alert">{t('watchFailed')}</p>}
        {state === 'full' && <p role="alert">{t('watchFull')}</p>}
        {state === 'unknown' && <p role="alert">{t('watchUnknown')}</p>}
        <div className="actions">
          <Button type="submit" disabled={state === 'saving'}>
            {t('watchSave')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('watchCancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The signed-in account's own watch on this address, and the button to add or change it. Nobody else's watch is read. */
function WatchPanel({ address, t }: { address: string; t: WatchTranslate }) {
  const { userId } = useSession();
  const { list, change } = useAccountAddressWatches();
  const [open, setOpen] = useState(false);
  if (!userId)
    return (
      <p>
        {t('watchSignIn')} <a href="/login">{t('signIn')}</a>
      </p>
    );
  const mine = list.status === 'ready' ? list.items.find((watch) => watch.address === address.toLowerCase()) : undefined;
  return (
    <div className="tokens-watch">
      {list.status === 'failed' && (
        <p className="muted">
          {t('watchReadFailed')}{' '}
          <Button variant="secondary" onClick={list.reload}>
            {t('tryAgain')}
          </Button>
        </p>
      )}
      {mine && (
        <p>
          {t('watchedAs', { tag: mine.tag })} {mine.note && t('yourNote', { note: mine.note })}
        </p>
      )}
      <Button variant="secondary" disabled={list.status !== 'ready'} onClick={() => setOpen(true)}>
        {t('watch')}
      </Button>
      <a href="/chain/watchlist">{t('openWatchlist')}</a>
      {open && <WatchDialog address={address} existing={mine} change={change} onClose={() => setOpen(false)} t={t} />}
    </div>
  );
}

/**
 * An address on the network the explorer reads (/chain/address/:address, D-explorer-03 and -04). Its kind, balance,
 * holdings, transactions, internal transactions and past balance are the indexer's, read at blocks it has stored; the
 * private watch is the account's own record (`protocol.address-watches`). The explorer holds no funds.
 */
export function AddressPage({ address }: { address: string | undefined }) {
  const { language } = usePreferences();
  const { t } = watchCopy.forLocale(language);
  const valid = address !== undefined && ADDRESS_SHAPE.test(address);
  if (!valid)
    return (
      <WatchShell title={t('notFoundTitle')}>
        <Panel title={t('notFoundTitle')}>
          <div data-code="protocol.not_found" role="status">
            <EmptyState title={t('notFoundBody')} />
          </div>
        </Panel>
        <Button variant="secondary" onClick={() => navigate('/chain')}>
          {t('back')}
        </Button>
      </WatchShell>
    );
  return (
    <WatchShell title={t('pageTitle', { address })} description={t('noFunds')}>
      <WatchPanel address={address} t={t} />
      <section aria-label={t('summary')}>
        <Panel title={t('summary')}>
          <AddressSummary
            key={address}
            address={address}
            labels={{ address: t('summaryAddress'), kind: t('summaryKind'), balance: t('summaryBalance') }}
          />
        </Panel>
      </section>
      <Panel title={t('transactions')}>
        <AddressActivity key={address} address={address} />
      </Panel>
      <section aria-label={t('holdings')}>
        <Panel title={t('holdings')}>
          <AddressHoldings key={address} address={address} />
        </Panel>
      </section>
      <section aria-label={t('pastBalance')}>
        <Panel title={t('pastBalance')}>
          <PastBalance key={address} address={address} />
        </Panel>
      </section>
      <Button variant="secondary" onClick={() => navigate('/chain')}>
        {t('back')}
      </Button>
    </WatchShell>
  );
}
