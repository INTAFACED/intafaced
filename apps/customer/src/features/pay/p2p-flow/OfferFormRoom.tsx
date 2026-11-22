import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import { p2pDepth } from '../personal/p2p-depth-copy';
import { id } from '../schemas';
import { OfferForm } from './OfferForm';
import { Details, P2PHead, Pagination, Section, State, Status } from './parts';

/**
 * Create offer (`/uc/ad/create`, `/p2p/offers/new`) and Edit offer (`/uc/ad/update?offerId=…`) on the flow template:
 * the form in the step, and what posting depends on (the service's readiness and its registered payment methods) in
 * the summary. An edit with no offer chosen asks which offer, and shows no form and no readiness.
 */
export function OfferFormRoom({
  pay,
  userId,
  current,
  params,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  current: string;
  params: URLSearchParams;
}) {
  const update = current === '/uc/ad/update';
  const picking = update && !id.safeParse(params.get('offerId')).success;
  return (
    <FlowTemplate
      title={update ? p2pDepth.t('formEditTitle') : payCopy.t('createAnOffer')}
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
      state={{ kind: 'ready' }}
      step={
        <>
          <P2PHead current="" />
          {picking ? (
            <OfferForm pay={pay} userId={userId} mode="edit" offerId={null} />
          ) : (
            <OfferForm pay={pay} userId={userId} mode={update ? 'edit' : 'create'} offerId={params.get('offerId')} />
          )}
        </>
      }
      summary={picking ? null : <PublishAvailability pay={pay} />}
    />
  );
}

function PublishAvailability({ pay }: { pay: PersonalPayApi }) {
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  return (
    <div>
      <Section title={payCopy.t('serviceReadiness')}>
        <State resource={health.resource} retry={health.reload}>
          {(data) => (
            <Details
              values={[
                [payCopy.t('instrumentEncryption'), data.instrumentKmsConfigured ? payCopy.t('configured') : payCopy.t('notConnected')],
                [
                  payCopy.t('offerLimits'),
                  payCopy.t(
                    data.offerLimitsPosture === 'unset'
                      ? 'offerLimitsUnset'
                      : data.offerLimitsPosture === 'unlimited'
                        ? 'offerLimitsUnlimited'
                        : 'offerLimitsConfigured',
                  ),
                ],
                [
                  payCopy.t('moderation'),
                  data.moderation.status === 'configured'
                    ? payCopy.t('configuredLiveReachabilityIsUnprobed')
                    : payCopy.t('noModeratorsConfigured'),
                ],
              ]}
            />
          )}
        </State>
      </Section>
      <Section title={payCopy.t('registeredPaymentMethods')}>
        <State resource={methods.resource} retry={methods.reload} empty={payCopy.t('noPaymentMethodsRegistered')}>
          {(rows) => (
            <div>
              <ul>
                {rows.map((method) => (
                  <li key={`${method.methodId}:${method.country}`}>
                    <span>
                      {method.label}{' '}
                      <small className="lt-hint">{method.country === '*' ? payCopy.t('allCountries') : method.country}</small>
                    </span>{' '}
                    <Status value={method.enabled ? 'enabled' : 'disabled'} />
                  </li>
                ))}
              </ul>
              <Pagination count={rows.length} limit={200} setLimit={() => {}} />
            </div>
          )}
        </State>
      </Section>
    </div>
  );
}
