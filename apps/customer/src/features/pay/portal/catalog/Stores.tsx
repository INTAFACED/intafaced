import { useState } from 'react';
import type { MerchantStore } from '@intafaced/contracts/merchant-stores';
import type { PortalApi } from '../api';
import { useReadAt, useUrlParam } from '../hooks';
import { useBodyRequestId } from '../payments/invoice-model';
import { useServerList } from '../ui/useServerList';
import { useMayAddProducts } from './access';
import { catalogCopy as c } from './copy';
import { SettingsRoom } from '../volt/SettingsRoom';
import { Button, Field } from '@intafaced/ui/lit';
import { Empty, EntityList, Failure, Freshness, Loading, MoreFooter, Section, SelectField } from '../volt/parts';

/** The time zone this browser runs in: a sensible first choice for a store's own. */
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * `/pay/settings/stores` (M-adv-org-access-05, J-merchant-03 step 6): the business's stores, open ones first. The roles
 * that manage products add a store and archive or reopen one; a store is never deleted. Each product's page says where
 * it is sold.
 */
export function Stores({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const [shown, setShown] = useUrlParam('status', 'active');
  const status = shown === 'archived' ? 'archived' : 'active';
  const list = useServerList(
    (f, cursor, signal) => portal.stores(f.status, cursor, signal),
    { status },
    (s: MerchantStore) => s.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(store: MerchantStore) {
    setBusy(store.id);
    setNote(null);
    try {
      const result = store.status === 'active' ? await portal.archiveStore(store.id) : await portal.reopenStore(store.id);
      if (result.ok) {
        setNote({ ok: true, text: t(result.data.status === 'archived' ? 'storeArchived' : 'storeReopened', { name: store.name }) });
        list.reload();
      } else setNote({ ok: false, text: result.message });
    } finally {
      setBusy(null);
    }
  }

  const action = (row: MerchantStore) => (
    <Button
      tone="secondary"
      disabled={busy !== null}
      aria-label={t(row.status === 'active' ? 'storeArchiveName' : 'storeReopenName', { name: row.name })}
      onClick={() => void toggle(row)}
    >
      {t(row.status === 'active' ? 'storeArchive' : 'storeReopen')}
    </Button>
  );

  return (
    <div>
      <Freshness asOf={readAt} />
      {may.allowed && status === 'active' && <StoreCreate portal={portal} onAdded={() => list.reload()} />}
      <SelectField
        label={t('storesShow')}
        value={status}
        onChange={setShown}
        options={[
          ['active', t('storesShow_active')],
          ['archived', t('storesShow_archived')],
        ]}
      />
      {note && (
        <p className="lt-hint" role={note.ok ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {list.state.status === 'loading' && <Loading />}
      {list.state.status === 'failed' && <Failure result={list.state.failure} retry={() => list.reload()} />}
      {list.state.status === 'ready' &&
        (list.state.items.length === 0 && !list.state.hasMore ? (
          status === 'archived' ? (
            <Empty title={t('storesEmptyArchivedTitle')}>{t('storesEmptyArchivedBody')}</Empty>
          ) : (
            <Empty title={t('storesEmptyTitle')}>{t(may.allowed ? 'storesEmptyBody' : 'storesEmptyReadOnly')}</Empty>
          )
        ) : (
          <>
            <EntityList
              label={t('storesLabel')}
              rows={list.state.items}
              rowKey={(row) => row.id}
              columns={[
                { header: t('storeColName'), cell: (row) => <strong>{row.name}</strong> },
                { header: t('storeColAddress'), cell: (row) => row.address ?? t('storeNoAddress') },
                { header: t('storeColTimezone'), cell: (row) => row.timezone },
                { header: t('storeColStatus'), cell: (row) => t(`storeStatus_${row.status}`) },
                ...(may.allowed ? [{ header: t('storeColAction'), cell: action }] : []),
              ]}
            />
            <MoreFooter state={list.state} onMore={list.loadMore} />
          </>
        ))}
    </div>
  );
}

function StoreCreate({ portal, onAdded }: { portal: PortalApi; onAdded: () => void }) {
  const { t } = c.useCopy();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState(browserZone);
  const body = { name: name.trim(), ...(address.trim() ? { address: address.trim() } : {}), timezone: timezone.trim() };
  // One request id per body: a retry after a lost answer makes one store, and any change is a new request.
  const request = useBodyRequestId('catalog:store-new', body);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setShown(true);
    if (!body.name) return;
    setBusy(true);
    setNote(null);
    try {
      request.sent();
      const result = await portal.createStore({ ...body, requestId: request.id });
      if (result.ok) {
        request.renew();
        setNote({ ok: true, text: t('storeAdded', { name: result.data.store.name }) });
        setName('');
        setAddress('');
        setShown(false);
        onAdded();
      } else setNote({ ok: false, text: result.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={t('storeAdd')} description={t('storesPurpose')}>
      <div data-testid="form-stack">
        <Field
          label={t('storeName')}
          hint={t('storeNameHint')}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          error={shown && !body.name ? t('storeNameRequired') : undefined}
        />
        <Field label={t('storeAddress')} value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
        <Field
          label={t('storeTimezone')}
          hint={t('storeTimezoneHint')}
          value={timezone}
          maxLength={64}
          onChange={(e) => setTimezone(e.target.value)}
        />
        {note && (
          <p className="lt-hint" role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        <div className="lt-actions">
          <Button tone="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('storeSaving') : t('storeSave')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** `/pay/settings/stores` on the settings template: every role reads; the page gates adding and archiving. */
export function StoresRoom({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  return (
    <SettingsRoom need="products.read" explain={<p>{t('storesExplain')}</p>}>
      {() => <Stores portal={portal} />}
    </SettingsRoom>
  );
}
