import { useState } from 'react';
import { Field } from '@intafaced/ui/lit';
import { useResource } from '../../../../shared/resource';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { PortalApi } from '../api';
import { isNotLive } from '../refusal';
import { useUnsavedForm } from '../useUnsavedForm';
import { DateTime } from '../ui/DateTime';
import { useServerList } from '../ui/useServerList';
import { Failure, Freshness, KpiStrip, Loading, Section, SelectField } from '../volt/parts';
import { Review as PortalReview } from '../volt/Review';
import { SettingsRoom } from '../volt/SettingsRoom';
import { ListBody, TestBanner } from './kit-parts';
import { mc } from './copy';
import { describeDestination, railWords, sameMasked } from './destination';
import { defaultDestination, destinationKindOfRail } from './model';
import { isDefaultDestination } from './destination';
import type { PayPayoutDestinationItem as DestinationItem } from '@intafaced/contracts/pay-portal-reads';
import { useReadAt } from '../hooks';
import { DestinationConfirm } from '../access/DestinationConfirm';
import type { DestinationProof } from '../access/destination-step-up';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const IBAN = /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}$/;
const IFSC = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;
/** A first look at the shape, so an obvious slip is caught before the review. The service checks it properly. */
export function referenceProblem(kind: 'crypto' | 'bank', ref: string): 'empty' | 'crypto' | 'bank' | null {
  const text = normaliseReference(ref);
  if (!text) return 'empty';
  if (kind === 'crypto') return EVM.test(text) ? null : 'crypto';
  return IBAN.test(text) || IFSC.test(text) ? null : 'bank';
}

/** What is sent to the service: the reference with every space removed. The review shows exactly this. */
export const normaliseReference = (ref: string): string => ref.replace(/\s+/g, '');

/** `/pay/payouts/destinations`: where your payouts can go. Full numbers and addresses are never shown again once saved. */
export function Destinations({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const [said, setSaid] = useState<string | null>(null);
  const list = useServerList(
    (_f, cursor, signal) => portal.destinationPage(merchantId, cursor, signal),
    { m: merchantId },
    (d: DestinationItem) => d.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const rows = list.state.status === 'ready' ? list.state.items : [];
  const lastUsed = rows
    .map((d) => d.lastUsedAt)
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1);
  const defaultRow = defaultDestination(rows);
  const count = list.state.status === 'ready' ? (list.state.hasMore ? t('mnCountNewest', { n: rows.length }) : String(rows.length)) : '—';
  return (
    <>
      <TestBanner />
      <Freshness asOf={readAt} />
      <KpiStrip
        label={t('dstTiles')}
        tiles={[
          { label: t('dstCount'), period: t('mnPeriodNow'), href: '/pay/payouts/destinations', value: count },
          {
            label: t('dstDefault'),
            period: t('mnPeriodNow'),
            href: '/pay/payouts/destinations',
            value: list.state.status !== 'ready' ? '—' : defaultRow ? defaultRow.destinationMasked : t('dstDefaultNone'),
            note: defaultRow ? railWords(t, defaultRow.railId) : undefined,
            // Words ("None chosen") are set in the smaller value style, like the date tile; an address stays a figure.
            size: defaultRow ? undefined : 'text',
          },
          {
            label: t('dstLastUsed'),
            period: t('mnPeriodNow'),
            href: '/pay/payouts?status=paid_out',
            value: lastUsed ? <DateTime value={lastUsed} /> : '—',
            size: 'text',
          },
          { label: t('dstScreening'), period: t('mnPeriodNow'), href: '/pay/payouts/destinations', value: t('notRecorded'), size: 'text' },
        ]}
      />
      <Section id={SECTION.saved} title={t('dstTable')}>
        <ListBody
          state={list.state}
          retry={() => list.reload()}
          onMore={list.loadMore}
          empty={{ title: t('dstEmptyTitle'), body: t('dstEmptyBody') }}
          label={t('dstTable')}
          rowKey={(d) => d.id}
          columns={[
            { header: t('mnColDestination'), cell: (d) => describeDestination(t, d.kind, d.destinationMasked, d.railId) },
            { header: t('dstStatus'), cell: (d) => <DestinationState item={d} /> },
            {
              header: t('dstDefault'),
              cell: (d) => (isDefaultDestination(d) ? <strong>{t('dstDefaultYes')}</strong> : <span>{t('dstDefaultNo')}</span>),
            },
            { header: t('dstScreening'), cell: () => <span>{t('notRecorded')}</span> },
            { header: t('mnColAdded'), cell: (d) => <DateTime value={d.createdAt} /> },
            {
              header: t('dstLastUsed'),
              cell: (d) => (d.lastUsedAt ? <DateTime value={d.lastUsedAt} /> : <span>{t('mnNever')}</span>),
            },
          ]}
        />
      </Section>
      {said && (
        <p className="lt-hint" role="status">
          {said}
        </p>
      )}
      {rows.length > 0 && (
        <ManageDestinations portal={portal} merchantId={merchantId} rows={rows} onChanged={list.reload} setSaid={setSaid} />
      )}
      <AddDestination
        portal={portal}
        merchantId={merchantId}
        existing={rows}
        listState={list.state.status === 'ready' ? 'ready' : list.state.status === 'loading' ? 'loading' : 'failed'}
        onAdded={list.reload}
      />
    </>
  );
}

/** Where the page's index links to. */
const SECTION = { saved: 'destinations-saved', manage: 'destinations-manage', add: 'destinations-add' };

/** `/pay/payouts/destinations` on the settings template: the index of its parts, what it means, and the page for the account. */
export function DestinationsRoom({ portal }: { portal: PortalApi }) {
  const { t } = mc.useCopy();
  return (
    <SettingsRoom
      need="settlements.read"
      sections={[
        { id: SECTION.saved, label: t('dstTable') },
        { id: SECTION.manage, label: t('dstManageTitle') },
        { id: SECTION.add, label: t('dstAddTitle') },
      ]}
      explain={<p>{t('destinationsExplain')}</p>}
    >
      {({ merchantId }) => <Destinations portal={portal} merchantId={merchantId} />}
    </SettingsRoom>
  );
}

/**
 * Where a destination stands (J-merchant-02 #5), in the service's words: Unverified until it is verified, then waiting
 * until the time svc-pay gives, then Active. Never inferred from anything else.
 */
export function DestinationState({ item }: { item: Pick<DestinationItem, 'state' | 'activatesAt'> }) {
  const { t } = mc.useCopy();
  if (item.state === 'active') return <span>{t('dstStateActive')}</span>;
  if (item.state === 'held' && item.activatesAt)
    return (
      <span>
        {t('dstStateHeld')} <DateTime value={item.activatesAt} />
      </span>
    );
  if (item.state === 'held') return <span>{t('dstStateHeld')}</span>;
  return <strong>{t('dstStateUnverified')}</strong>;
}

/** Verify a saved, unverified destination: the full address typed again, then a fresh confirmation. */
function VerifyDestination({
  portal,
  merchantId,
  item,
  owner,
  onVerified,
}: {
  portal: PortalApi;
  merchantId: string;
  item: DestinationItem;
  owner: boolean;
  onVerified: () => void;
}) {
  const { t } = mc.useCopy();
  const kind = item.kind === 'bank' ? 'bank' : 'crypto';
  const [ref, setRef] = useState('');
  const [proof, setProof] = useState<DestinationProof>({ code: '' });
  const sentRef = normaliseReference(ref);
  const problem = referenceProblem(kind, ref);
  const mismatch = !problem && !sameMasked(kind, sentRef, item.destinationMasked);
  return (
    <PortalReview
      title={t('dstVerify')}
      variant="primary"
      description={t('dstVerifyBody')}
      disabled={!owner}
      disabledReason={t('dstManageOwnerOnly')}
      review={
        <>
          <Field
            label={`${kind === 'bank' ? t('dstRefBankLabel') : t('dstRefCryptoLabel')} *`}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            hint={describeDestination(t, item.kind, item.destinationMasked, item.railId)}
            error={
              ref.trim() === ''
                ? undefined
                : problem
                  ? t(problem === 'empty' ? 'dstRefEmpty' : problem === 'crypto' ? 'dstRefCrypto' : 'dstRefBank')
                  : mismatch
                    ? t('dstVerifyMismatch')
                    : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
          <DestinationConfirm proof={proof} onChange={setProof} />
        </>
      }
      perform={async () => {
        if (problem || mismatch)
          return {
            ok: false as const,
            reason: 'error' as const,
            code: 'portal.local',
            message: problem ? t('dstRefEmpty') : t('dstVerifyMismatch'),
          };
        // A code is good once: the next try asks for a new one, whatever this one's answer.
        if ('code' in proof) setProof({ code: '' });
        return portal.setPayoutDestination(merchantId, item.railId, kind, sentRef, proof);
      }}
      onConfirmed={() => {
        setRef('');
        onVerified();
      }}
    />
  );
}

/** Choose the default and remove a destination. Owner only on the service; the buttons say so instead of vanishing. */
function ManageDestinations({
  portal,
  merchantId,
  rows,
  onChanged,
  setSaid,
}: {
  portal: PortalApi;
  merchantId: string;
  rows: readonly DestinationItem[];
  onChanged: () => void;
  /** Said by the page, so it survives the list reloading. */
  setSaid: (words: string) => void;
}) {
  const { t } = mc.useCopy();
  const { can } = useMerchantAccess();
  const owner = can('owner');
  return (
    <Section id={SECTION.manage} title={t('dstManageTitle')} description={t('dstManageBody')}>
      <ul aria-label={t('dstManageLabel')}>
        {rows.map((d) => {
          const name = describeDestination(t, d.kind, d.destinationMasked, d.railId);
          const isDefault = isDefaultDestination(d);
          const review = (
            <dl data-testid="pp-facts" className="lt-kv">
              <div>
                <dt>{t('mnColDestination')}</dt>
                <dd>{name}</dd>
              </div>
              {isDefault && (
                <div>
                  <dt>{t('dstDefault')}</dt>
                  <dd>{t('dstRemoveIsDefault')}</dd>
                </div>
              )}
            </dl>
          );
          return (
            <li key={d.id}>
              <p>
                {name} · <DestinationState item={d} /> {isDefault && <strong>· {t('dstDefaultYes')}</strong>}
              </p>
              <div className="lt-actions">
                {d.state === 'unverified' && (
                  <VerifyDestination
                    portal={portal}
                    merchantId={merchantId}
                    item={d}
                    owner={owner}
                    onVerified={() => {
                      setSaid(t('dstVerified'));
                      onChanged();
                    }}
                  />
                )}
                {d.state === 'held' && (
                  <PortalReview
                    title={t('dstCancelHold')}
                    variant="sell"
                    description={t('dstCancelHoldBody')}
                    disabled={!owner}
                    disabledReason={t('dstCancelHoldOwnerOnly')}
                    review={review}
                    perform={() => portal.destinationCancelHold({ merchantId, destinationId: d.id })}
                    onConfirmed={() => {
                      setSaid(t('dstCancelHoldDone'));
                      onChanged();
                    }}
                  />
                )}
                {!isDefault && (
                  <PortalReview
                    title={t('dstMakeDefault')}
                    description={t('dstMakeDefaultBody')}
                    disabled={!owner}
                    disabledReason={t('dstManageOwnerOnly')}
                    review={review}
                    perform={() => portal.destinationSetDefault({ merchantId, destinationId: d.id })}
                    onConfirmed={() => {
                      setSaid(t('dstMakeDefaultDone'));
                      onChanged();
                    }}
                  />
                )}
                <PortalReview
                  title={t('dstRemove')}
                  variant="sell"
                  description={t('dstRemoveBody')}
                  disabled={!owner}
                  disabledReason={t('dstManageOwnerOnly')}
                  review={review}
                  perform={() => portal.destinationRemove({ merchantId, destinationId: d.id })}
                  onConfirmed={() => {
                    setSaid(t('dstRemoveDone'));
                    onChanged();
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {!owner && <p className="lt-hint">{t('dstManageOwnerOnly')}</p>}
    </Section>
  );
}

/** What the owner checks before saving: the network, the address exactly as it is sent, and what it replaces. */
export function SaveReview({
  railId,
  kind,
  sentRef,
  replaces,
}: {
  railId: string;
  kind: 'crypto' | 'bank';
  sentRef: string;
  replaces: Pick<DestinationItem, 'kind' | 'destinationMasked' | 'railId'> | null;
}) {
  const { t } = mc.useCopy();
  return (
    <dl data-testid="pp-facts" className="lt-kv">
      <div>
        <dt>{t('dstRail')}</dt>
        <dd>{railWords(t, railId)}</dd>
      </div>
      <div>
        <dt>{kind === 'bank' ? t('dstRefBankLabel') : t('dstRefCryptoLabel')}</dt>
        <dd data-testid="pp-mono" className="lt-mono">
          {sentRef}
        </dd>
      </div>
      {replaces && (
        <>
          <div>
            <dt>{t('dstReplaces')}</dt>
            <dd>{describeDestination(t, replaces.kind, replaces.destinationMasked, replaces.railId)}</dd>
          </div>
          <div>
            <dt>{t('dstReplaceWarnLabel')}</dt>
            <dd>{t('dstReplaceWarn')}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

/**
 * Why Save is off, as a copy key, or null. The saved list must have been read first: the service keeps one destination
 * per network, so without the list the "Replaces…" warning cannot be shown and a save could overwrite one unseen.
 */
export function saveBlock(input: {
  owner: boolean;
  listState: 'loading' | 'ready' | 'failed';
  hasRail: boolean;
  problem: 'empty' | 'crypto' | 'bank' | null;
}): 'dstOwnerOnly' | 'dstListLoading' | 'dstListFailed' | 'dstPickRail' | 'dstRefEmpty' | 'dstRefCrypto' | 'dstRefBank' | null {
  if (!input.owner) return 'dstOwnerOnly';
  if (input.listState === 'loading') return 'dstListLoading';
  if (input.listState === 'failed') return 'dstListFailed';
  if (!input.hasRail) return 'dstPickRail';
  if (input.problem) return input.problem === 'empty' ? 'dstRefEmpty' : input.problem === 'crypto' ? 'dstRefCrypto' : 'dstRefBank';
  return null;
}

/**
 * The service keeps ONE destination per network (merchant and rail), so adding on a network that already has one
 * replaces it. That is also why a payout names its destination by `railId` alone (see PayoutNew).
 */
function AddDestination({
  portal,
  merchantId,
  existing,
  listState,
  onAdded,
}: {
  portal: PortalApi;
  merchantId: string;
  existing: readonly DestinationItem[];
  /** Whether the saved list has been read. Until it has, the page cannot tell whether saving replaces something. */
  listState: 'loading' | 'ready' | 'failed';
  onAdded: () => void;
}) {
  const { t } = mc.useCopy();
  const { can } = useMerchantAccess();
  const rails = useResource((s) => portal.rails(s), `money:rails:${merchantId}`);
  const [railId, setRail] = useState('');
  const [ref, setRef] = useState('');
  const [proof, setProof] = useState<DestinationProof>({ code: '' });
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState<'added' | 'replaced' | false>(false);
  useUnsavedForm(ref.trim() !== '' && !saved, t('mnUnsaved'));
  const owner = can('owner');
  const options = rails.resource.status === 'ready' ? rails.resource.data.filter((r) => r.capabilities.includes('payout') && r.usable) : [];
  const rail = options.find((r) => r.id === railId) ?? (options.length === 1 ? options[0]! : null);
  const kind = rail ? destinationKindOfRail(rail.id) : null;
  const problem = kind ? referenceProblem(kind, ref) : null;
  const sentRef = normaliseReference(ref);
  const onRail = rail ? (existing.find((d) => d.railId === rail.id) ?? null) : null;
  // J-merchant-02 #5: a new destination (or one replacing an unverified one) is saved unverified, with no code. Only a
  // verified one is changed through the fresh confirmation and the hold.
  const replaces = onRail && onRail.state !== 'unverified' ? onRail : null;
  const block = saveBlock({ owner, listState, hasRail: rail !== null, problem });
  const why = block ? t(block) : null;
  return (
    <Section id={SECTION.add} title={t('dstAddTitle')} description={t('dstAddBody')}>
      {rails.resource.status === 'loading' ? (
        <Loading rows={1} />
      ) : rails.resource.status === 'failed' ? (
        isNotLive(rails.resource.failure) ? null : (
          <Failure result={rails.resource.failure} retry={rails.reload} />
        )
      ) : options.length === 0 ? (
        <p className="lt-hint">{t('dstNoRails')}</p>
      ) : (
        <form data-testid="form-stack" noValidate onSubmit={(e) => e.preventDefault()}>
          <SelectField
            label={t('dstRail')}
            value={rail?.id ?? ''}
            onChange={setRail}
            options={[['', t('pnChoose')], ...options.map((r) => [r.id, railWords(t, r.id)] as const)]}
          />
          <Field
            label={`${kind === 'bank' ? t('dstRefBankLabel') : t('dstRefCryptoLabel')} *`}
            value={ref}
            onChange={(e) => {
              setRef(e.target.value);
              setSaved(false);
            }}
            onBlur={() => setTried(true)}
            hint={t('dstRefHint')}
            error={
              tried && problem ? t(problem === 'empty' ? 'dstRefEmpty' : problem === 'crypto' ? 'dstRefCrypto' : 'dstRefBank') : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
          <PortalReview
            title={replaces ? t('dstReplace') : t('dstSave')}
            variant="primary"
            description={replaces ? t('dstReplaceReviewBody') : t('dstSaveReviewBody')}
            disabled={why !== null}
            disabledReason={why ?? undefined}
            review={
              rail && kind ? (
                <>
                  <SaveReview railId={rail.id} kind={kind} sentRef={sentRef} replaces={replaces} />
                  {replaces && <DestinationConfirm proof={proof} onChange={setProof} />}
                </>
              ) : undefined
            }
            perform={() => {
              if (!replaces) return portal.destinationAdd({ merchantId, railId: rail!.id, kind: kind!, ref: sentRef });
              // A code is good once: the next try asks for a new one, whatever this one's answer.
              if ('code' in proof) setProof({ code: '' });
              return portal.setPayoutDestination(merchantId, rail!.id, kind!, sentRef, proof);
            }}
            onConfirmed={() => {
              setSaved(replaces ? 'replaced' : 'added');
              setRef('');
              onAdded();
            }}
          />
          {saved && (
            <p className="lt-hint" role="status">
              {saved === 'replaced' ? t('dstReplaced') : t('dstSavedUnverified')}
            </p>
          )}
        </form>
      )}
    </Section>
  );
}
