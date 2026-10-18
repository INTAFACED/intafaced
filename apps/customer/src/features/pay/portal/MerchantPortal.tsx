import { useMemo, type ReactNode } from 'react';
import { useSession } from '../../session/session';
import { createPortalApi } from './api';
import { portalCopy } from './copy';
import { parsePortalRoute, type PortalRoute } from './routes';
import type { StarterFee } from './schemas';
import './portal.css';
import { ExactMoneyContext } from './presentation';
import { LayoutFrame } from './home-layout/Frame';
import { rooms } from './rooms';
import type { RoomContext } from './rooms-model';
import { DisabledAction, NoBusiness } from './access/NoBusiness';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../pay-api';
import { headerActionReason } from './access/headerActions';
import { MerchantAccessProvider, useMerchantAccess } from './access/MerchantAccess';
import { RefusalOnceProvider } from './components';
import { authorityFromAccess } from './access/authority';

/**
 * The merchant portal shell (W3a). Every page here is scoped by the server from the signed session, so the
 * browser never names a merchant. `starterFee` is the fee INTAFACED has published for new accounts: null
 * until one is, and a null fee means an account cannot be opened from onboarding.
 * `MerchantAccessProvider` sits at the root: every page and the frame read who is signed in from it.
 */
export function MerchantPortal(props: { path: string; authority?: PayBusinessAuthority | null; starterFee?: StarterFee | null }) {
  return (
    <MerchantAccessProvider>
      <PortalRooms {...props} />
    </MerchantAccessProvider>
  );
}

function PortalRooms({
  path,
  authority = null,
  starterFee = null,
}: {
  path: string;
  authority?: PayBusinessAuthority | null;
  starterFee?: StarterFee | null;
}) {
  const { api, userId } = useSession();
  const portal = useMemo(() => createPortalApi(api, userId), [api, userId]);
  const access = useMerchantAccess();
  // A page that needs a `PayBusinessAuthority` gets one made from the resolved access, for the owner only.
  const effective = authority ?? authorityFromAccess(access.access, userId, access.sessionScopes);
  const pay = useMemo(() => createBusinessPayApi(api, userId, effective), [api, userId, effective]);
  const route = parsePortalRoute(path);
  if (!route) return null;
  return (
    <PortalPage
      route={route}
      pay={pay}
      ctx={{
        portal,
        authority: effective,
        access,
        starterFee,
      }}
    />
  );
}

/**
 * One page inside the frame. A signed-in person with no business account never reaches a page's own code: they get the
 * one calm "No business account yet" state and the header action switched off, unless the page says otherwise
 * (`withoutBusiness` on its room). This is the only place that decision is made.
 */
export function PortalPage({ route, ctx, pay = null }: { route: PortalRoute; ctx: RoomContext; pay?: BusinessPayApi | null }) {
  const room = rooms[route.room];
  const noBusiness = ctx.access.access.status === 'none' && room.withoutBusiness !== 'render';
  const body = !noBusiness ? (
    room.render(route, ctx)
  ) : typeof room.withoutBusiness === 'function' ? (
    room.withoutBusiness(ctx)
  ) : (
    <NoBusiness />
  );
  return (
    <PortalFrame
      route={route}
      actionOff={noBusiness}
      actionReason={noBusiness ? undefined : headerActionReason(route.room, ctx.access, pay)}
    >
      <RefusalOnceProvider>{body}</RefusalOnceProvider>
    </PortalFrame>
  );
}

export function PortalFrame({
  route,
  actionOff = false,
  actionReason,
  children,
}: {
  route: PortalRoute;
  actionOff?: boolean;
  /** Why the header action is switched off for this person (their role lacks the scope). Null or left out: it works. */
  actionReason?: string | null;
  children: ReactNode;
}) {
  // Subscribes the header to the language preference; the room headers read the same catalogs.
  portalCopy.useCopy();
  const room = rooms[route.room];
  const copy = room.header(route);
  const here = typeof room.here === 'function' ? room.here(route) : (room.here ?? `/pay/${route.room}`);
  return (
    <LayoutFrame
      here={here}
      title={copy.title}
      purpose={copy.purpose}
      action={
        actionOff ? (
          <DisabledAction action={copy.action} />
        ) : actionReason ? (
          <DisabledAction action={copy.action} reason={actionReason} />
        ) : (
          copy.action
        )
      }
    >
      <ExactMoneyContext.Provider
        value={Boolean(route.param || route.step) || route.room.endsWith('-new') || route.room === 'money-activity'}
      >
        {children}
      </ExactMoneyContext.Provider>
    </LayoutFrame>
  );
}
