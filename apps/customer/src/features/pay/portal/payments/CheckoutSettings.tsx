// volt-room: /pay/checkout
// volt-room: portal:checkout-settings
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { Field } from '@intafaced/ui/lit';
import { type Resource, useResource } from '../../../../shared/resource';
import { useSession } from '../../../session';
import { validatedMutation } from '../../BusinessPay';
import { createBusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import * as shared from '../../schemas';
import type { PortalApi } from '../api';
import { DateTime } from '../ui/DateTime';
import { CopyReference, Empty, Facts, Gate, Section } from '../volt/parts';
import { Review as PortalReview } from '../volt/Review';
import { SettingsRoom } from '../volt/SettingsRoom';
import { paymentsCopy as c } from './copy';
import { CheckoutLook } from './CheckoutLook';
import { CheckoutMethods } from './CheckoutMethods';
import { lookCopy } from './look-copy';
import { methodsCopy } from './methods-copy';
import { definite } from './not-available';
import { ReceivingWallet } from './ReceivingWallet';
import type { CheckoutSettings } from './schemas';
import { walletCopy } from './wallet-copy';

/** `/pay/checkout`: the checkout profile as the service holds it now, and a way for the owner to add a new one. */
export function CheckoutSettingsPage({
  portal,
  merchantId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  authority: PayBusinessAuthority | null;
}) {
  const settings = useResource((s) => portal.checkoutSettings(merchantId, s), `portal:checkout-settings:${merchantId}`);
  return (
    <CheckoutSettingsView
      settings={settings.resource}
      retry={settings.reload}
      merchantId={merchantId}
      authority={authority}
      portal={portal}
    />
  );
}

export function CheckoutSettingsView({
  settings,
  retry,
  merchantId,
  authority,
  portal,
}: {
  settings: Resource<CheckoutSettings>;
  retry: () => void;
  merchantId: string;
  authority: PayBusinessAuthority | null;
  /** Reads and saves the checkout look. Without it (a static preview) that section is left out. */
  portal?: PortalApi;
}) {
  return (
    <>
      {portal && <CheckoutLook portal={portal} id={SECTION.look} />}
      {portal && <CheckoutMethods portal={portal} ids={{ methods: SECTION.methods, preview: SECTION.preview }} />}
      {portal && <ReceivingWallet portal={portal} id={SECTION.wallet} />}
      <Section id={SECTION.current} title={c.t('cs_currentTitle')} description={c.t('cs_currentBody')}>
        <Gate resource={settings} retry={retry} rows={3}>
          {(s) =>
            s.status === 'not_configured' ? (
              <Empty title={c.t('cs_noneTitle')}>{c.t('cs_noneBody')}</Empty>
            ) : (
              <Facts
                items={[
                  [
                    c.t('cs_domains'),
                    s.domains.length ? (
                      <ul>
                        {s.domains.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    ) : (
                      c.t('hp_checkoutNoDomains')
                    ),
                  ],
                  [c.t('cs_since'), <DateTime value={s.createdAt} />],
                  [c.t('cs_reference'), <CopyReference value={s.profileId} what={c.t('cs_reference')} />],
                ]}
              />
            )
          }
        </Gate>
      </Section>
      <NewProfile merchantId={merchantId} authority={authority} onSaved={retry} />
    </>
  );
}

/** Where the page's index links to. */
const SECTION = {
  look: 'checkout-look',
  methods: 'checkout-methods',
  preview: 'checkout-preview',
  wallet: 'checkout-wallet',
  current: 'checkout-current',
  add: 'checkout-add',
};

/** `/pay/checkout` on the settings template: the index of its parts, what it means, and the page for the account. */
export function CheckoutSettingsRoom({ portal, authority }: { portal: PortalApi; authority: PayBusinessAuthority | null }) {
  return (
    <SettingsRoom
      need="profile.read"
      sections={[
        { id: SECTION.look, label: lookCopy.t('title') },
        { id: SECTION.methods, label: methodsCopy.t('title') },
        { id: SECTION.preview, label: methodsCopy.t('previewTitle') },
        { id: SECTION.wallet, label: walletCopy.t('title') },
        { id: SECTION.current, label: c.t('cs_currentTitle') },
        { id: SECTION.add, label: c.t('cs_newTitle') },
      ]}
      explain={<p>{c.t('checkoutSettingsExplain')}</p>}
    >
      {({ merchantId }) => <CheckoutSettingsPage portal={portal} merchantId={merchantId} authority={authority} />}
    </SettingsRoom>
  );
}

function NewProfile({
  merchantId,
  authority,
  onSaved,
}: {
  merchantId: string;
  authority: PayBusinessAuthority | null;
  onSaved: () => void;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const [domains, setDomains] = useState('');
  const [created, setCreated] = useState('');
  const list = domains
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  const noWrite = pay.access('pay:write') !== null;
  return (
    <Section id={SECTION.add} title={c.t('cs_newTitle')} description={c.t('cs_newBody')}>
      {noWrite && (
        <p className="lt-hint" role="note">
          {c.t('cs_ownerOnly')}
        </p>
      )}
      <div data-testid="form-stack">
        <Field label={c.t('cs_domains')} value={domains} onChange={(e) => setDomains(e.target.value)} hint={c.t('cs_domainsHint')} />
        <PortalReview
          title={c.t('cs_create')}
          description={c.t('cs_createBody')}
          variant="primary"
          disabled={noWrite || list.length === 0}
          review={<Facts items={[[c.t('cs_domains'), list.join(', ')]]} />}
          perform={async () =>
            definite(
              await validatedMutation(
                pay,
                'merchant.profile',
                { merchantId, domains: list },
                z.object({ merchantId: shared.id, domains: z.array(z.string().min(1)).min(1) }),
                z.object({ id: shared.id, merchantId: shared.id }),
                'pay:write',
                'profile-create',
              ),
            )
          }
          onConfirmed={(data) => {
            setCreated(data.id);
            setDomains('');
            onSaved();
          }}
        />
        {created && (
          <p role="status" className="lt-hint">
            {c.t('cs_created')}
          </p>
        )}
      </div>
    </Section>
  );
}
