import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../../session';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { PayDetails, PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { CreateMandate } from '../../MerchantBilling';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { mandateSchema, subscriptionSchema, subscriptionPostureSchema } from '../../schemas';
import { PortalBack } from '../ExtensionTools';
import { Gate, Money, SelectField } from '../components';
import { DateTime } from '../ui/DateTime';
import { useUrlParam } from '../hooks';
import { useUnsavedForm } from '../useUnsavedForm';
import { extensionCopy as c } from './copy';
import type { PortalApi } from '../api';
import type { PortalRoute } from '../routes';
import type { ApiResult } from '../../../../shared/api';
import { createSubscriptionWithRecovery, replaySubscriptionCreate } from './subscription-recovery';
import { cadenceLabel, pathLabel } from './subscription-words';
import { SubscriptionPriceFact, SubscriptionPricePicker, subscriptionPriceLabel } from '../catalog/SubscriptionPrice';

export { NextRun, SubscriptionDetailView, SubscriptionsView } from './SubscriptionList';

type Subscription = z.infer<typeof subscriptionSchema>;
type Mandate = z.infer<typeof mandateSchema>;
export function subscriptionHeader(route: PortalRoute) {
  return {
    title: c.t(
      route.room === 'subscription-new' ? 'createSubscription' : route.room === 'subscription' ? 'subscriptionTitle' : 'subscriptionsTitle',
    ),
    purpose: c.t(route.room === 'subscription-new' ? 'createSubscriptionPurpose' : 'subscriptionsPurpose'),
    action: (
      <Button
        variant="primary"
        nativeButton={false}
        role="link"
        render={<a href={route.room === 'subscription-new' ? '/pay/subscriptions' : '/pay/subscriptions/new'} />}
      >
        {c.t(route.room === 'subscription-new' ? 'subscriptionsTitle' : 'createSubscription')}
      </Button>
    ),
  };
}
/** `/pay/subscriptions/new`: the way back to the list and the create form. The list and one schedule are `./SubscriptionList`. */
export function Subscriptions({
  portal,
  merchantId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  authority: PayBusinessAuthority | null;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => (authority ? createBusinessPayApi(api, userId, authority) : null), [api, userId, authority]);
  return (
    <div className="lt-stack">
      <PortalBack href="/pay/subscriptions">{c.t('subscriptionsTitle')}</PortalBack>
      <CreateSubscription portal={portal} merchantId={merchantId} pay={pay} />
    </div>
  );
}
function SubscriptionRecovery({
  check,
  onKnown,
  onSettled,
  outcomeShown = false,
}: {
  /** True when the review above already says the outcome is not confirmed: the general notice is then left out. */
  outcomeShown?: boolean;
  check: (current: () => boolean) => Promise<ApiResult<Subscription>>;
  onKnown: (subscription: Subscription) => void;
  onSettled?: (result: ApiResult<Subscription>) => void;
}) {
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <div className="lt-stack">
      {/* One message about the unconfirmed request: the latest check's answer replaces the general notice. */}
      {(message || !outcomeShown) && (
        <p className="pp-callout" role="status">
          {message || c.t('unresolvedSubscription')}
        </p>
      )}
      <Button
        disabled={busy}
        onClick={async () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          try {
            const result = await check(() => mounted.current);
            if (!mounted.current) return;
            if (result.ok) onKnown(result.data);
            else
              setMessage(
                result.reason === 'uncertain' || result.reason === 'aborted' ? c.t('subscriptionStillUnresolved') : result.message,
              );
            onSettled?.(result);
          } finally {
            busyRef.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        {c.t('checkSubscriptionOriginal')}
      </Button>
    </div>
  );
}
export function SubscriptionTerms({ mandate: m, path }: { mandate: Mandate; path: string }) {
  return (
    <PayDetails
      values={[
        [c.t('customer'), m.customerId],
        [c.t('chargePath'), path ? pathLabel(path) : c.t('unavailable')],
        [c.t('amount'), <Money value={m.amount} asset={m.assetId} />],
        [c.t('cadence'), cadenceLabel(m.cadence)],
        [c.t('mandateStart'), <DateTime value={m.startsAt} />],
        [c.t('mandateEnd'), m.endsAt ? <DateTime value={m.endsAt} /> : c.t('openEnded')],
        [c.t('authorizedCeiling'), m.ceiling !== null ? <Money value={m.ceiling} asset={m.assetId} /> : c.t('noCeiling')],
      ]}
    />
  );
}
function CreateSubscription({ portal, merchantId, pay }: { portal: PortalApi; merchantId: string; pay: BusinessPayApi | null }) {
  const mandates = useResource((signal) => portal.mandates(merchantId, signal), `portal:mandates:${merchantId}`);
  const posture = useResource((signal) => portal.subscriptionPosture(signal), 'portal:subscription-posture');
  const open = useResource((signal) => portal.subscriptions(merchantId, 200, signal), `portal:subscriptions-open:${merchantId}`);
  return (
    <CreateSubscriptionView
      mandates={mandates.resource}
      subscriptions={open.resource}
      posture={posture.resource}
      pay={pay}
      portal={portal}
      reload={() => {
        mandates.reload();
        posture.reload();
        // the list of open subscriptions decides which mandates are still offered
        open.reload();
      }}
    />
  );
}
export function CreateSubscriptionView({
  mandates,
  subscriptions,
  posture,
  pay,
  portal,
  reload,
}: {
  mandates: Resource<Mandate[]>;
  /** The subscriptions already running, so a mandate that has an open one is not offered again. */
  subscriptions?: Resource<Subscription[]>;
  posture: Resource<z.infer<typeof subscriptionPostureSchema>>;
  pay: BusinessPayApi | null;
  portal?: PortalApi;
  reload: () => void;
}) {
  const [revision, setRevision] = useState(0);
  // Refresh guard state without remounting an in-flight confirmation.
  const [, refreshLock] = useState(0);
  const [mandateId, setMandateId] = useUrlParam('mandateId');
  const [draftPath, setPath] = useState('');
  const recovered = pay && mandateId ? pay.guard.original(`${pay.authority!.userId}:subscription-create:${mandateId}`)?.value : undefined;
  const recoveredPath = recovered?.path;
  const path = recoveredPath ?? draftPath;
  // The catalogue price chosen for this mandate; a create being recovered keeps the one it was sent with.
  const [draftPrice, setPrice] = useState('');
  useEffect(() => setPrice(''), [mandateId]);
  const recoveredPrice = recovered ? (recovered.priceId ?? '') : undefined;
  const priceId = recoveredPrice ?? draftPrice;
  const [created, setCreated] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  useUnsavedForm(Boolean(mandateId || path), c.t('draftWarning'));
  const taken = new Set(
    subscriptions?.status === 'ready'
      ? subscriptions.data.filter((x) => x.status === 'active' || x.status === 'paused').map((x) => x.mandateId)
      : [],
  );
  // A mandate that already has an open subscription cannot start a second one; the one being recovered stays listed.
  const choices =
    mandates.status === 'ready' ? mandates.data.filter((m) => m.status === 'active' && (!taken.has(m.id) || m.id === mandateId)) : [];
  const selected = choices.find((m) => m.id === mandateId);
  const locked = Boolean(pay && mandateId && pay.guard.status(`${pay.authority!.userId}:subscription-create:${mandateId}`));
  // The mandate whose create reply was lost and is said so by the review itself (it is forgotten when the choice changes).
  const [uncertainShown, setUncertainShown] = useState('');
  useEffect(() => setUncertainShown(''), [mandateId]);
  const allowed = posture.status === 'ready' && posture.data.paths.some((p) => p.path === path && p.charge !== 'refuse');
  return (
    <div className="lt-stack">
      <PaySection title={c.t('railPosture')}>
        <Gate resource={posture} retry={reload}>
          {() => <p className="pp-callout">{c.t('railPostureBody')}</p>}
        </Gate>
      </PaySection>
      <PaySection title={c.t('createSubscription')}>
        <Gate resource={mandates} retry={reload}>
          {() =>
            choices.length ? (
              <div data-testid="form-stack" className="lt-stack">
                <SelectField
                  label={c.t('chooseMandate')}
                  value={mandateId}
                  onChange={setMandateId}
                  hint={c.t('chooseMandateHint')}
                  options={[
                    ['', c.t('selectMandate')],
                    ...choices.map((m) => [m.id, `${m.customerId} · ${m.amount} ${m.assetId} · ${cadenceLabel(m.cadence)}`] as const),
                  ]}
                />
                <SelectField
                  label={c.t('choosePath')}
                  disabled={Boolean(recoveredPath)}
                  value={path}
                  onChange={setPath}
                  options={[
                    ['', c.t('selectPath')],
                    ...(recoveredPath
                      ? [[recoveredPath, pathLabel(recoveredPath)] as const]
                      : posture.status === 'ready'
                        ? posture.data.paths.filter((p) => p.charge !== 'refuse').map((p) => [p.path, pathLabel(p.path)] as const)
                        : []),
                  ]}
                />
                {selected && portal && (
                  <SubscriptionPricePicker
                    portal={portal}
                    mandate={selected}
                    value={priceId}
                    onChange={setPrice}
                    disabled={recoveredPrice !== undefined}
                  />
                )}
                {selected && <SubscriptionTerms mandate={selected} path={path} />}
                {pay && locked && (
                  <SubscriptionRecovery
                    key={`${pay.authority!.userId}:${mandateId}`}
                    outcomeShown={uncertainShown === mandateId}
                    check={(current) => replaySubscriptionCreate(pay, mandateId, path, current, priceId || undefined)}
                    onKnown={(data) => {
                      setCreateNotice('');
                      setCreated(data.id);
                      setMandateId('');
                      setPath('');
                      setRevision((v) => v + 1);
                      reload();
                    }}
                    onSettled={(result) => {
                      if (!result.ok) {
                        setPath(path);
                        // "Still not confirmed" is already said by the check itself; only a real refusal is added.
                        if (result.reason !== 'uncertain' && result.reason !== 'aborted') setCreateNotice(result.message);
                      }
                      refreshLock((v) => v + 1);
                    }}
                  />
                )}
                {createNotice && <p role="status">{createNotice}</p>}
                {mandateId && (
                  <a className="lt-link" href={`/pay/subscriptions?mandateId=${encodeURIComponent(mandateId)}`}>
                    {taken.has(mandateId) ? c.t('openExisting') : c.t('subscriptionsTitle')}
                  </a>
                )}
                {pay ? (
                  <span
                    title={
                      locked
                        ? c.t('unresolvedSubscription')
                        : !selected || !allowed
                          ? c.t('termsGap')
                          : pay.access('pay:write')
                            ? c.t('subscriptionAuthority')
                            : undefined
                    }
                  >
                    <PortalReview
                      key={`${mandateId}:${revision}`}
                      title={c.t('createSubscription')}
                      description={c.t('subscriptionCreateReview')}
                      review={
                        selected && (
                          <>
                            <SubscriptionTerms mandate={selected} path={path} />
                            {priceId && portal && (
                              <p>
                                {subscriptionPriceLabel()}: <SubscriptionPriceFact portal={portal} priceId={priceId} />
                              </p>
                            )}
                          </>
                        )
                      }
                      disabled={!selected || !allowed || Boolean(pay.access('pay:write')) || locked}
                      perform={async () => {
                        try {
                          const result = await createSubscriptionWithRecovery(pay, mandateId, path, priceId || undefined);
                          setUncertainShown(!result.ok && result.reason === 'uncertain' ? mandateId : '');
                          // An unconfirmed reply is shown once, by the review and the check below it.
                          if (!result.ok && result.reason !== 'uncertain') setCreateNotice(result.message);
                          return result;
                        } finally {
                          refreshLock((v) => v + 1);
                        }
                      }}
                      onConfirmed={(data) => {
                        setCreateNotice('');
                        setCreated(data.id);
                        setMandateId('');
                        setPath('');
                        setPrice('');
                        reload();
                      }}
                    />
                  </span>
                ) : (
                  <p className="pp-callout" role="status">
                    {c.t('subscriptionAuthority')}
                  </p>
                )}
              </div>
            ) : (
              <EmptyState title={c.t('chooseMandate')}>
                {mandates.status === 'ready' && mandates.data.some((m) => m.status === 'active')
                  ? c.t('allMandatesTaken')
                  : c.t('noMandates')}
              </EmptyState>
            )
          }
        </Gate>
        {created && (
          <a className="lt-link" href={`/pay/subscriptions/${encodeURIComponent(created)}`}>
            {c.t('openNewSubscription')}
          </a>
        )}
      </PaySection>
      {pay && <CreateMandate pay={pay} refresh={reload} portal={portal} />}
    </div>
  );
}
