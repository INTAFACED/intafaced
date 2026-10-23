import { useRef, useState, type FormEvent } from 'react';
import { Button, EmptyState, Failure, Loading, Page } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { useSession } from '../session/session';
import { date, useBankRead, type ActionSpec } from './components';
import {
  destinationCheckSchema,
  destinationRemovedSchema,
  destinationSchema,
  type Destination,
  type DestinationCheck,
  type WithdrawAsset,
} from './contracts';
import { moneyRefusalWords } from './money-refusal-copy';
import { DepthPanel } from './DepthParts';
import { WithdrawStepUp } from './WithdrawStepUp';
import { checkAddress, checkLabel, checkTag, coolingOf, shortenAddress } from './withdraw-model';
import { withdrawalCopy } from './withdrawal-copy';
import './bank-depth.css';

const STATE_KEYS = {
  pending: 'aStatePending',
  cooling: 'aStateCooling',
  active: 'aStateActive',
  blocked: 'aStateBlocked',
  archived: 'aStateArchived',
} as const;

/**
 * What the status column says. An active entry is not ready while its cooling-off has not ended, nor while the bank has
 * published no cooling-off period at all (the bank refuses to send to it then), so it reads cooling off or blocked.
 */
export function shownState(state: keyof typeof STATE_KEYS, cooling: 'ends' | 'ended' | 'unset'): keyof typeof STATE_KEYS {
  if (state !== 'active') return state;
  return cooling === 'ends' ? 'cooling' : cooling === 'unset' ? 'blocked' : 'active';
}

/**
 * The address book as a table. The columns always show; with no rows the body says why it is empty. Each row gives a short
 * form of the address and a Details control that opens the full address, so a long address never breaks the row. Every
 * cell comes from the bank's saved-destination read: a label (when one was set), the kind, the address, when it was added
 * the asset, network and tag, and the cooling-off the bank returned. An entry the bank calls active is shown as cooling off
 * while its cooling-off has not ended, and as blocked while no cooling-off is published, so the status never says "ready"
 * before it is.
 */
export function AddressTable({
  rows,
  now = Date.now(),
  onRename,
  onRemove,
}: {
  rows: readonly Destination[];
  now?: number;
  onRename?: (row: Destination) => void;
  onRemove?: (row: Destination) => void;
}) {
  const { t } = withdrawalCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="address-table">
          <thead>
            <tr>
              <th scope="col">{t('aColLabel')}</th>
              <th scope="col">{t('aColKind')}</th>
              <th scope="col">{t('aColNetwork')}</th>
              <th scope="col">{t('aColAddress')}</th>
              <th scope="col">{t('aColAdded')}</th>
              <th scope="col">{t('aColCooling')}</th>
              <th scope="col">{t('aColState')}</th>
              <th scope="col">{t('aColDetails')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => {
                const cooling = coolingOf(row, now);
                return (
                  <tr key={row.destinationId}>
                    <td lang={row.label ? 'und' : undefined}>{row.label ?? t('aNoLabel')}</td>
                    <td>{row.kind === 'bank' ? t('aKindBank') : t('aKindCrypto')}</td>
                    <td lang="und">
                      {row.assetId || row.network
                        ? [row.assetId, row.network, row.tag].filter((part) => part).join(' · ')
                        : t('aNotReturned')}
                    </td>
                    <td className="numeric" lang="und" data-withdrawal-private>
                      {shortenAddress(row.ref)}
                    </td>
                    <td>{date(row.addedAt)}</td>
                    <td>
                      {cooling.state === 'unset'
                        ? t('aCoolingUnset')
                        : t(cooling.state === 'ends' ? 'aCoolingEnds' : 'aCoolingEnded', { time: date(cooling.at) })}
                    </td>
                    <td>{row.state ? t(STATE_KEYS[shownState(row.state, cooling.state)]) : t('aNotReturned')}</td>
                    <td>
                      {onRename && row.state !== 'archived' ? (
                        <Button variant="ghost" onClick={() => onRename(row)}>
                          {t('aRename')}
                        </Button>
                      ) : null}
                      {onRemove && row.state !== 'archived' ? (
                        <Button variant="ghost" onClick={() => onRemove(row)}>
                          {t('aRemove')}
                        </Button>
                      ) : null}
                      <details>
                        <summary>{t('aDetails')}</summary>
                        <p>
                          {t('aFullAddress')}:{' '}
                          <span lang="und" data-withdrawal-private className="withdrawal-address-full">
                            {row.ref}
                          </span>
                        </p>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('aEmptyTitle')}>{t('aEmptyBody')}</EmptyState>}
    </>
  );
}

/** The saved-destination read in its three states. A refusal goes through the shared refusal copy; no row is invented. */
export function AddressBook({
  resource,
  reload,
  now,
  onRename,
  onRemove,
}: {
  resource: Resource<readonly Destination[]>;
  reload: () => void;
  now?: number;
  onRename?: (row: Destination) => void;
  onRemove?: (row: Destination) => void;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <AddressTable rows={resource.data} now={now} onRename={onRename} onRemove={onRemove} />;
}

type Draft = { label: string; assetId: string; network: string; address: string; tag: string };
const EMPTY: Draft = { label: '', assetId: '', network: '', address: '', tag: '' };

/**
 * What is wrong with a draft, field by field, before anything is sent. The bank checks the same rules again; this only
 * stops a mistyped entry from costing a confirmation code.
 */
export function draftProblems(draft: Draft, assets: readonly WithdrawAsset[]) {
  const asset = assets.find((a) => a.assetId === draft.assetId);
  const label = checkLabel(draft.label.trim());
  const address = checkAddress(draft.address);
  return {
    label: label === 'ok' ? null : label === 'empty' ? ('aLabelHint' as const) : ('aLabelBad' as const),
    asset: asset ? null : ('aAssetPick' as const),
    network: asset && asset.networks.some((n) => n.networkId === draft.network) ? null : ('aNetworkPick' as const),
    address: address === 'ok' ? null : address === 'empty' ? ('aAddressEmpty' as const) : ('aAddressBad' as const),
    tag: checkTag(draft.tag) === 'ok' ? null : ('aTagBad' as const),
  };
}

/**
 * The add form. Saving needs a fresh confirmation (`trade:withdraw`): the code buys one token, used for this save only.
 * Before the code is asked for, the bank checks the address (`ramps.destinations.check`, W-withdraw-03): a mixed-case
 * address whose checksum does not match is refused at the field, and one that starts and ends like a saved address but
 * is not (address poisoning) shows a warning that must be ticked before it can be saved. The bank checks both again on save.
 */
function AddForm({ onSaved }: { onSaved: () => void }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const networks = useBankRead('ramps.destinations.networks', undefined);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const [checksumBad, setChecksumBad] = useState(false);
  const [lookalike, setLookalike] = useState<NonNullable<DestinationCheck['lookalike']> | null>(null);
  const [checked, setChecked] = useState(false);
  const [untickedShown, setUntickedShown] = useState(false);
  // The address as typed now, so a check answered after the field changed is dropped, not applied to the new address.
  const typed = useRef('');
  if (networks.resource.status === 'loading') return <Loading />;
  if (networks.resource.status === 'failed') return <Failure result={networks.resource.failure} retry={networks.reload} />;
  const assets = networks.resource.data;
  if (assets.length === 0) return <EmptyState title={t('aNoAssetsTitle')}>{t('aNoAssetsBody')}</EmptyState>;
  const asset = assets.find((a) => a.assetId === draft.assetId);
  const local = draftProblems(draft, assets);
  const problems = { ...local, address: local.address ?? (checksumBad ? ('aAddressChecksum' as const) : null) };
  const shown = (key: keyof typeof problems) => (tried ? problems[key] : null);
  const set = (patch: Partial<Draft>) => {
    setSaved(null);
    setCheckProblem(null);
    if (patch.address !== undefined) {
      // A new address is a new check: the old warning and tick do not carry over.
      typed.current = patch.address.trim();
      setChecksumBad(false);
      setLookalike(null);
      setChecked(false);
      setUntickedShown(false);
    }
    setDraft((before) => ({ ...before, ...patch }));
  };
  const input = {
    assetId: draft.assetId,
    network: draft.network,
    ref: draft.address.trim(),
    label: draft.label.trim(),
    ...(draft.tag ? { tag: draft.tag } : {}),
    ...(lookalike && checked ? { confirmLookalike: true } : {}),
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (checking || Object.values(local).some((p) => p !== null)) return;
    if (lookalike) {
      // Already warned about this address: it goes ahead only once ticked.
      if (checked) setConfirming(true);
      else setUntickedShown(true);
      return;
    }
    const ref = input.ref;
    setChecking(true);
    setCheckProblem(null);
    try {
      const answer = await api.query('bank', 'ramps.destinations.check', { ref }, destinationCheckSchema);
      if (typed.current !== ref) return;
      if (!answer.ok) {
        setCheckProblem(moneyRefusalWords(answer.code) ?? t('aCheckFailed'));
        return;
      }
      if (answer.data.address !== 'ok') {
        setChecksumBad(answer.data.address === 'checksum_mismatch');
        if (answer.data.address === 'invalid') setCheckProblem(t('aAddressBad'));
        return;
      }
      if (answer.data.lookalike) {
        setLookalike(answer.data.lookalike);
        return;
      }
      setConfirming(true);
    } catch {
      if (typed.current === ref) setCheckProblem(t('aCheckFailed'));
    } finally {
      setChecking(false);
    }
  }
  return (
    <>
      <form className="bd-stack" onSubmit={submit} noValidate aria-label={t('aAddTitle')}>
        <label className="field">
          <span>{t('aLabel')}</span>
          <input
            value={draft.label}
            onChange={(event) => set({ label: event.target.value })}
            autoComplete="off"
            aria-invalid={shown('label') ? true : undefined}
            aria-describedby="address-label-hint"
          />
          <small id="address-label-hint" role={shown('label') ? 'alert' : undefined}>
            {t(shown('label') ?? 'aLabelHint')}
          </small>
        </label>
        <label className="field">
          <span>{t('aAsset')}</span>
          <select
            value={draft.assetId}
            onChange={(event) => {
              const next = assets.find((a) => a.assetId === event.target.value);
              set({ assetId: event.target.value, network: next?.defaultNetworkId ?? next?.networks[0]?.networkId ?? '' });
            }}
            aria-invalid={shown('asset') ? true : undefined}
          >
            <option value="">{t('aAssetAny')}</option>
            {assets.map((a) => (
              <option key={a.assetId} value={a.assetId}>
                {a.assetId}
              </option>
            ))}
          </select>
          {shown('asset') && <small role="alert">{t('aAssetPick')}</small>}
        </label>
        <label className="field">
          <span>{t('aNetwork')}</span>
          <select
            value={draft.network}
            onChange={(event) => set({ network: event.target.value })}
            disabled={!asset}
            aria-invalid={shown('network') ? true : undefined}
            aria-describedby="address-network-hint"
          >
            {!asset && <option value="">{t('aNetworkFirst')}</option>}
            {asset?.networks.map((n) => (
              <option key={n.networkId} value={n.networkId}>
                {n.label}
              </option>
            ))}
          </select>
          <small id="address-network-hint">{t('aNetworkHint')}</small>
        </label>
        <label className="field">
          <span>{t('aAddress')}</span>
          <input
            value={draft.address}
            onChange={(event) => set({ address: event.target.value })}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={shown('address') ? true : undefined}
            aria-describedby="address-hint"
          />
          <small id="address-hint" role={shown('address') ? 'alert' : undefined}>
            {t(shown('address') ?? 'aAddressHint')}
          </small>
        </label>
        <label className="field">
          <span>{t('aTag')}</span>
          <input
            value={draft.tag}
            onChange={(event) => set({ tag: event.target.value })}
            autoComplete="off"
            aria-invalid={shown('tag') ? true : undefined}
            aria-describedby="address-tag-hint"
          />
          <small id="address-tag-hint" role={shown('tag') ? 'alert' : undefined}>
            {t(shown('tag') ?? 'aTagHint')}
          </small>
        </label>
        {lookalike && (
          <div className="bd-stack" role="alert" data-testid="address-lookalike">
            <strong>{t('aLookalikeTitle')}</strong>
            <p>
              {lookalike.label
                ? t('aLookalikeBody', { saved: lookalike.label, address: lookalike.refMasked })
                : t('aLookalikeBodyUnnamed', { address: lookalike.refMasked })}
            </p>
            <label className="money-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  setChecked(event.target.checked);
                  setUntickedShown(false);
                }}
              />
              <span>{t('aLookalikeConfirm')}</span>
            </label>
            {untickedShown && !checked && <small role="alert">{t('aLookalikeUnticked')}</small>}
          </div>
        )}
        <p>{t('aSaveNote')}</p>
        <Button type="submit" variant="primary" disabled={checking}>
          {t('aSave')}
        </Button>
        {checking && <p role="status">{t('aChecking')}</p>}
        {checkProblem && <p role="alert">{checkProblem}</p>}
        {saved && <p role="status">{t('aSaved', { label: saved })}</p>}
      </form>
      {confirming && (
        <WithdrawStepUp
          why={t('aSaveWhy')}
          run={async (token) => {
            const answer = await api.mutate('bank', 'ramps.destinations.save', input, destinationSchema, { bearer: token });
            // The two address refusals in the customer's own words; the check above makes them rare.
            if (!answer.ok && answer.code === 'bank.address_lookalike') return { ...answer, message: t('aLookalikeRefused') };
            if (!answer.ok && answer.code === 'bank.address_checksum_mismatch') return { ...answer, message: t('aAddressChecksum') };
            return answer;
          }}
          onDone={() => {
            setConfirming(false);
            setSaved(input.label);
            setDraft(EMPTY);
            setTried(false);
            setLookalike(null);
            setChecked(false);
            onSaved();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/**
 * `/uc/withdraw/address`: the address book and the form to add to it. The book is the bank's own saved-destination read
 * (`bank.ramps.destinations.list`); the assets and networks offered are the bank's read of the ledger's asset list. Saving
 * and removing each ask for a fresh confirmation; renaming does not, because it cannot change where money goes.
 */
export function WithdrawalAddresses({ open }: { open?: (spec: ActionSpec) => void } = {}) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const book = useBankRead('ramps.destinations.list', undefined);
  const [removing, setRemoving] = useState<Destination | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  // Renaming changes only the label (`bank:write`), so it needs no confirmation.
  const rename = open
    ? (row: Destination) =>
        open({
          title: t('aRenameTitle'),
          procedure: 'ramps.destinations.rename',
          facts: [[t('aRenameAddress'), shortenAddress(row.ref)]],
          initial: { label: row.label ?? '' },
          fields: [
            {
              name: 'label',
              label: t('aLabel'),
              validate: (value) => (checkLabel(value.trim()) === 'ok' ? null : t('aLabelHint')),
            },
          ],
          notes: [t('aRenameNote')],
          input: (values) => ({ destinationId: row.destinationId, label: values.label!.trim() }),
          verifyOutcome: (data, input) => (data as { destinationId?: string; label?: string | null }).label === input.label,
          submit: t('aRenameSubmit'),
        })
    : undefined;
  return (
    <Page eyebrow={t('aEyebrow')} title={t('aTitle')} description={t('aLead')}>
      <div className="withdrawal-page bd-stack">
        <DepthPanel title={t('aTableTitle')}>
          <AddressBook
            resource={book.resource}
            reload={book.reload}
            onRename={rename}
            onRemove={(row) => {
              setRemoved(null);
              setRemoving(row);
            }}
          />
          {removed && <p role="status">{t('aRemoved', { label: removed })}</p>}
        </DepthPanel>
        <DepthPanel title={t('aAddTitle')}>
          <AddForm onSaved={book.reload} />
        </DepthPanel>
        {removing && (
          <WithdrawStepUp
            why={t('aRemoveWhy', { address: shortenAddress(removing.ref) })}
            run={(token) =>
              api.mutate(
                'bank',
                'ramps.destinations.remove',
                // One removal of one entry: a retry of it is the same request.
                { destinationId: removing.destinationId, idempotencyKey: `destination-remove:${removing.destinationId}` },
                destinationRemovedSchema,
                { bearer: token },
              )
            }
            onDone={() => {
              setRemoved(removing.label ?? shortenAddress(removing.ref));
              setRemoving(null);
              book.reload();
            }}
            onCancel={() => setRemoving(null)}
          />
        )}
        <p>
          <a className="text-link" href="/uc/withdraw">
            {t('aBack')} ↗
          </a>
        </p>
      </div>
    </Page>
  );
}
