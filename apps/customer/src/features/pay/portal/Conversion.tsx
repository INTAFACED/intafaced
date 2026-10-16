import { useResource, type Resource } from '../../../shared/resource';
import { Button } from '../../../shared/ui';
import { PayDetails, PaySection } from '../components';
import { HaltBanner } from './components';
import { Arrives, CopyReference, PortalBack } from './ExtensionTools';
import { extensionCopy as c } from './extension-copy';
import type { PortalApi } from './api';
import type { PortalRoute } from './routes';
import type { HaltStatus } from './schemas';
export function conversionHeader(route: PortalRoute) {
  return {
    title: c.t(
      route.room === 'conversion-new' ? 'convertTitle' : route.room === 'conversion-order' ? 'conversionOrderTitle' : 'conversionTitle',
    ),
    purpose: c.t(
      route.room === 'conversion-new'
        ? 'convertPurpose'
        : route.room === 'conversion-order'
          ? 'conversionOrderPurpose'
          : 'conversionPurpose',
    ),
    action: (
      <a className="button button--secondary" href={route.room === 'conversion' ? '/pay/money' : '/pay/conversion'}>
        {c.t(route.room === 'conversion' ? 'openBalances' : 'conversionTitle')}
      </a>
    ),
  };
}
export function Conversion({ portal, merchantId, route }: { portal: PortalApi; merchantId: string; route: PortalRoute }) {
  const halts = useResource((signal) => portal.haltStatus(merchantId, signal), `portal:conversion-halts:${merchantId}`);
  return <ConversionView room={route.room} orderId={route.param} halts={halts.resource} reload={halts.reload} />;
}
/** Main's conversion namespace is notBuilt; never send a quote or execute mutation to suggest otherwise. */
export function ConversionView({
  room,
  orderId,
  halts,
  reload,
}: {
  room: string;
  orderId?: string;
  halts: Resource<HaltStatus>;
  reload: () => void;
}) {
  return (
    <div className="stack">
      <PortalBack href={room === 'conversion' ? '/pay/merchant' : '/pay/conversion'}>
        {c.t(room === 'conversion' ? 'backHome' : 'conversionTitle')}
      </PortalBack>
      <p className="pp-callout pp-callout--warn" role="note">
        <strong>{c.t('conversionTest')}</strong> {c.t('conversionTestBody')}
      </p>
      <PaySection
        title={c.t('conversionControls')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <HaltBanner resource={halts} scopes={['conversion']} />
        <p className="muted">{c.t('conversionPauseUnknown')}</p>
      </PaySection>
      {room === 'conversion-new' ? (
        <>
          <Arrives>{c.t('conversionNewGap')}</Arrives>
          <PaySection title={c.t('quoteTerms')}>
            <PayDetails
              values={[
                [c.t('sourceAsset'), 'USD'],
                [c.t('targetAsset'), 'USDT'],
                ...[c.t('rate'), c.t('spread'), c.t('fee'), c.t('minimumReceived'), c.t('quoteExpiry')].map(
                  (label) => [label, c.t('unavailable')] as [string, string],
                ),
              ]}
            />
            <span title={c.t('conversionDisabledReason')}>
              <Button disabled>{c.t('getQuote')}</Button>
            </span>
            <p className="muted">{c.t('conversionDisabledReason')}</p>
          </PaySection>
        </>
      ) : room === 'conversion-order' ? (
        <>
          <PaySection title={c.t('reference')}>
            <CopyReference value={orderId ?? ''} />
          </PaySection>
          <Arrives>{c.t('conversionDetailGap')}</Arrives>
        </>
      ) : (
        <>
          <Arrives>{c.t('conversionGap')}</Arrives>
          <PaySection title={c.t('conversionPreference')}>
            <Arrives>{c.t('conversionPreferenceGap')}</Arrives>
          </PaySection>
          <a className="text-link" href="/pay/conversion/new">
            {c.t('quoteTerms')}
          </a>
        </>
      )}
    </div>
  );
}
