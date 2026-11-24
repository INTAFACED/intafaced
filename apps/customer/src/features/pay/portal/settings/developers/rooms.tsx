import './developers.css';
import type { ReactNode } from 'react';
import type { RoomDef, RoomTable } from '../../rooms-model';
import type { PortalRoom, PortalRoute } from '../../routes';
import { useSettingsBApi, type SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { DeliveriesRoom } from './Deliveries';
import { DocsRoom } from './DocsRoom';
import { EndpointRoom } from './Endpoint';
import { KeysRoom } from './Keys';
import { SandboxRoom } from './Sandbox';
import { SigningRoom } from './Signing';
import { WebhooksRoom } from './Webhooks';
import { LinkButton } from '../../volt/parts';

/** The heading's one action: a link drawn as one of the kit's buttons (the keys and webhooks pages are on the kit). */
const link = (href: string, label: string) => <LinkButton href={href}>{label}</LinkButton>;

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

/** The signed-in client, built once; a page takes it as a prop so a test can hand it a fake. */
function Live({ children }: { children: (api: SettingsBApi) => ReactNode }) {
  return <>{children(useSettingsBApi())}</>;
}

/** A developer page on its Volt template (settings or record-list): it draws its own title row, its index and its sections. */
const volt = (room: PortalRoom, body: (route: PortalRoute, ctx: { scopes: readonly string[] }) => ReactNode): RoomDef => ({
  header: () => words[room]!(),
  here: '/pay/developer/keys',
  ownTitle: true,
  render: (route, { authority }) => body(route, { scopes: authority?.scopes ?? [] }),
});

export const developersRooms: RoomTable = {
  'developer-keys': volt('developer-keys', (_r, { scopes }) => <KeysRoom scopes={scopes} />),
  'developer-signing': volt('developer-signing', () => <SigningRoom />),
  'developer-webhooks': volt('developer-webhooks', () => <WebhooksRoom />),
  'developer-endpoint': volt('developer-endpoint', (route) => <EndpointRoom endpointId={route.param ?? ''} />),
  'developer-deliveries': volt('developer-deliveries', () => <DeliveriesRoom />),
  'developer-sandbox': volt('developer-sandbox', () => <SandboxRoom />),
  // The guide draws on its own reading template, with its own title, the developer pages as links and the account's
  // states (DocsRoom.tsx), so it takes neither the frame's heading nor the row above.
  'developer-docs': {
    header: () => words['developer-docs']!(),
    here: '/pay/developer/keys',
    ownTitle: true,
    render: () => <Live>{(api) => <DocsRoom api={api} />}</Live>,
  },
};
