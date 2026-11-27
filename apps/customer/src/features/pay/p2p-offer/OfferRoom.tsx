// volt-room: /uc/ad/create
// volt-room: /uc/ad/update
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { PayCopy, payCopy } from '../copy';
import { P2PTabs } from '../p2p-tabs';
import type { PersonalPayApi } from '../pay-api';
import { OfferForm } from '../personal/OfferForm';
import { p2pDepth } from '../personal/p2p-depth-copy';
import { id } from '../schemas';
import { PayDetails, PaySection, PayState, Status } from '../volt/parts';

/**
 * `/uc/ad/create` and `/uc/ad/update` (also `/p2p/offers/new`), creating or editing a person-to-person offer on the flow
 * template: the P2P rooms above, then the offer form and, when creating or editing a valid offer, service readiness and
 * registered payment methods.
 */
export function OfferRoom({
  pay,
  userId,
  mode,
  offerId,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  mode: 'create' | 'edit';
  offerId: string | null;
}) {
  const { layoutMode } = usePreferences();
  const editNeedsPick = mode === 'edit' && !id.safeParse(offerId).success;
  return (
    <FlowTemplate
      title={mode === 'edit' ? p2pDepth.t('formEditTitle') : payCopy.t('createAnOffer')}
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
      section={<P2PTabs current={undefined} />}
      state={{ kind: 'ready' }}
      mode={layoutMode === 'pro' ? 'pro' : 'simple'}
      step={
        editNeedsPick ? (
          <OfferForm pay={pay} userId={userId} mode="edit" offerId={null} />
        ) : (
          <div className="lt-stack">
            <OfferForm pay={pay} userId={userId} mode={mode} offerId={offerId} />
            <PublishAvailability pay={pay} />
          </div>
        )
      }
    />
  );
}

function PublishAvailability({ pay }: { pay: PersonalPayApi }) {
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  return (
    <div className="lt-stack">
      <PaySection title={payCopy.t('serviceReadiness')}>
        <PayState resource={health.resource} retry={health.reload}>
          {(data) => (
            <PayDetails
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
        </PayState>
      </PaySection>
      <PaySection title={payCopy.t('registeredPaymentMethods')}>
        <PayState resource={methods.resource} retry={methods.reload} empty={payCopy.t('noPaymentMethodsRegistered')}>
          {(rows) => (
            <div className="lt-stack">
              {rows.map((method) => (
                <div className="lt-row lt-row-between" key={`${method.methodId}:${method.country}`}>
                  <span className="lt-stack-tight">
                    <span>{method.label}</span>
                    <small className="lt-hint">{method.country === '*' ? payCopy.t('allCountries') : method.country}</small>
                  </span>
                  <Status value={method.enabled ? 'enabled' : 'disabled'} />
                </div>
              ))}
              <p className="lt-muted">
                <PayCopy k="recordsWindow" params={{ count: rows.length, limit: 200 }} />
                {rows.length === 200 ? payCopy.t('moreRecordsMayExist') : ''}
              </p>
              {rows.length === 200 && (
                <p className="lt-muted">
                  <PayCopy k="thisServiceHasNoContinuationCursorThis" />
                </p>
              )}
            </div>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
