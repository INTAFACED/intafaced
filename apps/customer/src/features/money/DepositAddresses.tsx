import { useState } from 'react';
import { Button } from '../../shared/ui';
import { useResource, type Resource } from '../../shared/resource';
import { useSession } from '../session/session';
import { CopyButton } from '../../screens/account/CopyButton';
import { depositAddressesCopy } from './deposit-addresses-copy';
import { createDepositReads, type DepositAddressItem, type DepositAddressList, type DepositNetworkView } from './deposit-reads';

const DAY_MS = 86_400_000;
const LABEL_MAX = 40;

/** The bank's refusals of a new address, in the person's words. Anything else is the generic failure. */
const CREATE_REFUSALS: Partial<Record<string, 'capUnset' | 'expiryUnset' | 'labelInvalid' | 'numbersUsed'>> = {
  'bank.deposit_address_cap_unset': 'capUnset',
  'bank.deposit_address_expiry_unset': 'expiryUnset',
  'bank.deposit_address_label_invalid': 'labelInvalid',
  'bank.deposit_address_numbers_used': 'numbersUsed',
};

const formatDate = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));

type Actions = {
  create: (label: string | null) => Promise<{ ok: true; data: DepositAddressItem } | { ok: false; code?: string }>;
  rename: (addressIndex: number, label: string | null) => Promise<{ ok: true; data: DepositAddressItem } | { ok: false; code?: string }>;
};

/**
 * The person's addresses for one asset on one network (W-deposit-02): the first and every extra one, each with its name and
 * expiry, and a form to make another. Shown once the first address is on screen.
 */
export function DepositAddresses({ asset, network }: { asset: string; network: DepositNetworkView }) {
  const { api, userId } = useSession();
  const reads = createDepositReads(api);
  const { resource, reload } = useResource<DepositAddressList>(
    (signal) => reads.addresses(asset, network.id, signal),
    `${userId}:deposit-addresses:${asset}:${network.id}`,
  );
  return (
    <DepositAddressesView
      network={network}
      list={resource}
      reload={reload}
      actions={{
        create: (label) => reads.createAddress(asset, network.id, label),
        rename: (addressIndex, label) => reads.labelAddress(asset, network.id, addressIndex, label),
      }}
    />
  );
}

export function DepositAddressesView({
  network,
  list,
  reload,
  actions,
  now = Date.now(),
}: {
  network: DepositNetworkView;
  list: Resource<DepositAddressList>;
  reload: () => void;
  actions: Actions;
  now?: number;
}) {
  const { t } = depositAddressesCopy.useCopy();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (list.status !== 'ready') {
    return (
      <section className="bd-addresses" aria-label={t('title', { network: network.label })} data-testid="deposit-addresses">
        <h4>{t('title', { network: network.label })}</h4>
        {list.status === 'loading' ? (
          <p role="status">{t('loading')}</p>
        ) : (
          <>
            <p role="alert">{t('loadFailed')}</p>
            <Button variant="ghost" onClick={reload}>
              {t('retry')}
            </Button>
          </>
        )}
      </section>
    );
  }

  const { items, cap, expiryDays } = list.data;
  const open = items.filter((row) => row.state === 'active').length;

  async function create() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await actions.create(label.trim() === '' ? null : label.trim());
      if (result.ok) {
        setLabel('');
        setNote({ kind: 'ok', text: t('created', { number: result.data.addressIndex }) });
        reload();
      } else {
        const text =
          result.code === 'bank.deposit_address_cap_reached'
            ? t('capReached', { cap: cap ?? open })
            : t(CREATE_REFUSALS[result.code ?? ''] ?? 'createFailed');
        setNote({ kind: 'error', text });
      }
    } catch {
      setNote({ kind: 'error', text: t('createFailed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bd-addresses" aria-label={t('title', { network: network.label })} data-testid="deposit-addresses">
      <h4>{t('title', { network: network.label })}</h4>
      <p>{t('lead')}</p>
      <ul className="bd-address-list">
        {items.map((row) => (
          <AddressRow key={row.addressIndex} row={row} now={now} rename={actions.rename} onRenamed={reload} />
        ))}
      </ul>
      <p data-testid="deposit-addresses-cap">
        {cap === null ? t('capUnset') : t('open', { open, cap })}
        {cap !== null && (expiryDays === null ? ` ${t('expiryUnset')}` : ` ${t('windowNote', { days: expiryDays })}`)}
      </p>
      <label className="field">
        <span>{t('newLabel')}</span>
        <input value={label} maxLength={LABEL_MAX} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <Button variant="secondary" disabled={busy} onClick={() => void create()}>
        {busy ? t('creating') : t('create')}
      </Button>
      {note && <p role={note.kind === 'error' ? 'alert' : 'status'}>{note.text}</p>}
    </section>
  );
}

function AddressRow({
  row,
  now,
  rename,
  onRenamed,
}: {
  row: DepositAddressItem;
  now: number;
  rename: Actions['rename'];
  onRenamed: () => void;
}) {
  const { t } = depositAddressesCopy.useCopy();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.label ?? '');
  const [failed, setFailed] = useState(false);
  const fallback = row.addressIndex === 0 ? t('firstName') : t('extraName', { number: row.addressIndex });
  const name = row.label ?? fallback;
  const expiry =
    row.expiresAt === null
      ? t('neverExpires')
      : row.state === 'expired'
        ? t('expiredOn', { date: formatDate(row.expiresAt) })
        : (() => {
            const left = new Date(row.expiresAt).getTime() - now;
            return left < DAY_MS
              ? t('expiresToday', { date: formatDate(row.expiresAt) })
              : t('expiresOn', { date: formatDate(row.expiresAt), days: Math.ceil(left / DAY_MS) });
          })();

  async function save() {
    setFailed(false);
    try {
      const result = await rename(row.addressIndex, draft.trim() === '' ? null : draft.trim());
      if (!result.ok) return setFailed(true);
      setEditing(false);
      onRenamed();
    } catch {
      setFailed(true);
    }
  }

  return (
    <li data-address-index={row.addressIndex} data-state={row.state}>
      <strong lang="und">{name}</strong>
      {row.label !== null && <small> {fallback}</small>}
      <p>
        <span data-testid="numeric" className="numeric" style={{ overflowWrap: 'anywhere' }}>
          {row.address}
        </span>
      </p>
      <p data-testid="deposit-address-expiry">{expiry}</p>
      <CopyButton value={row.address} label={t('copy')} />
      {row.memo && (
        <div role="note">
          <strong>{t('memoTitle')}</strong>
          <p data-testid="numeric" className="numeric">
            {row.memo}
          </p>
          <CopyButton value={row.memo} label={t('copyMemo')} />
        </div>
      )}
      {editing ? (
        <div>
          <label className="field">
            <span>{t('renameLabel', { name: fallback })}</span>
            <input value={draft} maxLength={LABEL_MAX} onChange={(event) => setDraft(event.target.value)} />
            <small>{t('clearHint')}</small>
          </label>
          <Button variant="primary" onClick={() => void save()}>
            {t('save')}
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('cancel')}
          </Button>
          {failed && <p role="alert">{t('renameFailed')}</p>}
        </div>
      ) : (
        <Button
          variant="ghost"
          onClick={() => {
            // Each rename starts from the saved name, never from an abandoned draft.
            setDraft(row.label ?? '');
            setFailed(false);
            setEditing(true);
          }}
        >
          {t('rename')}
        </Button>
      )}
    </li>
  );
}
