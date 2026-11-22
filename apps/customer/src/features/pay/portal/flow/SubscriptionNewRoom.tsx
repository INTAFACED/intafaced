// volt-room: /pay/subscriptions/new
// volt-room: portal:subscription-new
import { useState } from 'react';
import { z } from 'zod';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useRelease } from '../../../../shared/outside';
import { useResource, type Resource } from '../../../../shared/resource';
import type { BusinessPayApi } from '../../pay-api';
import type { mandateSchema, subscriptionSchema, subscriptionPostureSchema } from '../../schemas';
import type { PortalApi } from '../api';
import { useUrlParam } from '../hooks';
import { useUnsavedForm } from '../useUnsavedForm';
import { extensionCopy as c } from '../payments/copy';
import { cadenceLabel, pathLabel } from '../payments/Subscriptions';
import { createSubscriptionWithRecovery, replaySubscriptionCreate } from '../payments/subscription-recovery';
import { subscriptionPriceLabel } from '../catalog/SubscriptionPrice';
import { CreateMandate } from '../../billing-flow/CreateMandate';
import { PortalReview } from './review';
import { Empty, Gate, Section, SelectField } from './parts';
import { SubscriptionPriceFact, SubscriptionPricePicker, SubscriptionRecovery, SubscriptionTerms } from './subscription-parts';

type Subscription = z.infer<typeof subscriptionSchema>;
type Mandate = z.infer<typeof mandateSchema>;

/**
 * `/pay/subscriptions/new` (J-merchant-03 step 4), on the flow template: the rail posture, then a subscription started
 * from an active mandate on a charge path the service offers, with an optional catalogue price, and a mandate recorded
 * below. A create whose reply was lost keeps its path and price and is checked, never sent again blind.
 */
export function CreateSubscription({ portal, merchantId, pay }: { portal: PortalApi; merchantId: string; pay: BusinessPayApi | null }) {
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
  // A new mandate choice starts with no price chosen.
  useRelease(mandateId, () => setPrice(''));
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
  useRelease(mandateId, () => setUncertainShown(''));
  const allowed = posture.status === 'ready' && posture.data.paths.some((p) => p.path === path && p.charge !== 'refuse');
  return (
    <FlowTemplate
      framed
      title={c.t('createSubscription')}
      state={{ kind: 'ready' }}
      step={
        <div>
          <Section title={c.t('railPosture')}>
            <Gate resource={posture} retry={reload}>
              {() => <p>{c.t('railPostureBody')}</p>}
            </Gate>
          </Section>
          <Section title={c.t('createSubscription')}>
            <Gate resource={mandates} retry={reload}>
              {() =>
                choices.length ? (
                  <div data-testid="form-stack">
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
                      <p role="status">{c.t('subscriptionAuthority')}</p>
                    )}
                  </div>
                ) : (
                  <Empty
                    title={c.t('chooseMandate')}
                    body={
                      mandates.status === 'ready' && mandates.data.some((m) => m.status === 'active')
                        ? c.t('allMandatesTaken')
                        : c.t('noMandates')
                    }
                  />
                )
              }
            </Gate>
            {created && (
              <a className="lt-link" href={`/pay/subscriptions/${encodeURIComponent(created)}`}>
                {c.t('openNewSubscription')}
              </a>
            )}
          </Section>
          {pay && <CreateMandate pay={pay} refresh={reload} portal={portal} />}
        </div>
      }
    />
  );
}
