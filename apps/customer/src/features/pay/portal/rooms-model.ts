import type { ReactNode } from 'react';
import type { PortalApi } from './api';
import type { MerchantAccessValue } from './access/MerchantAccess';
import type { PortalRoom, PortalRoute } from './routes';
import type { PayBusinessAuthority } from '../pay-api';
import type { StarterFee } from './schemas';

/** Everything a room needs to draw itself. A room never reads the signed-in account any other way. */
export type RoomContext = {
  portal: PortalApi;
  authority: PayBusinessAuthority | null;
  /** Who is signed in to which business, and what they may do. */
  access: MerchantAccessValue;
  /** The fee INTAFACED has published for new accounts, as the server states it (with its TEST mark), or null until one is published. */
  starterFee: StarterFee | null;
};
export type RoomHeader = { title: string; purpose: string; action?: ReactNode };

/**
 * One portal page. `header` is the title, purpose and one action; `render` is the page body. `here` names the
 * menu item that stays lit for sub-pages and defaults to `/pay/<room>`.
 */
export type RoomDef = {
  header(route: PortalRoute): RoomHeader;
  render(route: PortalRoute, ctx: RoomContext): ReactNode;
  here?: string | ((route: PortalRoute) => string);
  /**
   * What the page does for a signed-in person with no business account. Left out, the page shows the one calm
   * "No business account yet" state and its header action is switched off. `'render'` keeps the page as it is (setup,
   * where the account is made). A function draws its own body (the team page, for invitations).
   */
  withoutBusiness?: 'render' | ((ctx: RoomContext) => ReactNode);
};
export type RoomTable = Partial<Record<PortalRoom, RoomDef>>;

/** Merge the packages' tables. A room registered twice is a bug, so it throws instead of letting one silently win. */
export function mergeRooms(...tables: RoomTable[]): Record<PortalRoom, RoomDef> {
  const merged: Partial<Record<PortalRoom, RoomDef>> = {};
  for (const table of tables)
    for (const [room, def] of Object.entries(table) as [PortalRoom, RoomDef][]) {
      if (merged[room]) throw new Error(`Portal room registered twice: ${room}`);
      merged[room] = def;
    }
  return merged as Record<PortalRoom, RoomDef>;
}
