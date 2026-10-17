import './developers.css';
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { WithAccount } from '../../access/WithAccount';
import type { RoomDef, RoomTable } from '../../rooms-model';
import type { PortalRoom, PortalRoute } from '../../routes';
import { useSettingsBApi, type SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { DeveloperNav } from './DeveloperNav';
import { DeliveryList } from './Deliveries';
import { Docs } from './Docs';
import { EndpointPage } from './Endpoint';
import { Keys } from './Keys';
import { canManageWebhooks } from './model';
import { Sandbox } from './Sandbox';
import { Signing } from './Signing';
import { Webhooks } from './Webhooks';

const link = (href: string, label: string, variant: 'primary' | 'secondary' = 'secondary') => (
  <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
    {label}
  </Button>
);

type Words = { title: string; purpose: string; action?: ReactNode };
const words: Record<string, () => Words> = {
  'developer-keys': () => ({ title: c.t('keysTitle'), purpose: c.t('keysPurpose'), action: link('#create', c.t('createKeyAction')) }),
  'developer-signing': () => ({ title: c.t('signingTitle'), purpose: c.t('signingPurpose') }),
  'developer-webhooks': () => ({
    title: c.t('endpointsTitle'),
    purpose: c.t('endpointsPurpose'),
    action: link('#add', c.t('addEndpoint')),
  }),
  'developer-endpoint': () => ({ title: c.t('endpointTitle'), purpose: c.t('endpointPurpose') }),
  'developer-deliveries': () => ({ title: c.t('deliveriesTitle'), purpose: c.t('deliveriesPurpose') }),
  'developer-sandbox': () => ({ title: c.t('sandboxTitle'), purpose: c.t('sandboxPurpose') }),
  'developer-docs': () => ({ title: c.t('docsTitle'), purpose: c.t('docsPurpose') }),
};

function Frame({ room, children }: { room: PortalRoom; children: ReactNode }) {
  return (
    <div className="stack">
      <DeveloperNav room={room} />
      {children}
    </div>
  );
}

/** The signed-in client, built once; a page takes it as a prop so a test can hand it a fake. */
function Live({ children }: { children: (api: SettingsBApi) => ReactNode }) {
  return <>{children(useSettingsBApi())}</>;
}

const def = (
  room: PortalRoom,
  body: (route: PortalRoute, api: SettingsBApi, ctx: { role: string; scopes: readonly string[] }) => ReactNode,
): RoomDef => ({
  header: () => words[room]!(),
  here: '/pay/developer/keys',
  render: (route, { authority }) => (
    <WithAccount>
      {({ role }) => (
        <Frame room={room}>
          <Live>{(api) => body(route, api, { role, scopes: authority?.scopes ?? [] })}</Live>
        </Frame>
      )}
    </WithAccount>
  ),
});

export const developersRooms: RoomTable = {
  'developer-keys': def('developer-keys', (_r, api, { scopes }) => <Keys api={api} scopes={scopes} />),
  'developer-signing': def('developer-signing', (_r, api) => <Signing api={api} />),
  'developer-webhooks': def('developer-webhooks', (_r, api, { role }) => <Webhooks api={api} canManage={canManageWebhooks(role)} />),
  'developer-endpoint': def('developer-endpoint', (route, api, { role }) => (
    <EndpointPage api={api} endpointId={route.param ?? ''} canManage={canManageWebhooks(role)} />
  )),
  'developer-deliveries': def('developer-deliveries', (_r, api, { role }) => (
    <DeliveryList api={api} canManage={canManageWebhooks(role)} />
  )),
  'developer-sandbox': def('developer-sandbox', (_r, api) => <Sandbox api={api} />),
  'developer-docs': def('developer-docs', () => <Docs />),
};
