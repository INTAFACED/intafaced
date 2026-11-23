import type { ReactNode } from 'react';
import type { PortalRoom } from '../../routes';
import { SettingsRoom, type Account } from '../../volt/SettingsRoom';
import { useSettingsBApi, type SettingsBApi } from '../b-client';
import { DeveloperNav } from './DeveloperNav';

/** The signed-in client, built once; a page takes it as a prop so a test can hand it a fake. */
function Live({ children }: { children: (api: SettingsBApi) => ReactNode }) {
  return <>{children(useSettingsBApi())}</>;
}

/**
 * A developer page on the settings template: the row that moves between the developer pages is its index, and the page
 * draws its sections with the signed-in client once the business is known.
 */
export function DeveloperRoom({
  room,
  explain,
  children,
}: {
  room: PortalRoom;
  explain: ReactNode;
  children: (api: SettingsBApi, account: Account) => ReactNode;
}) {
  return (
    <SettingsRoom index={<DeveloperNav room={room} />} explain={explain}>
      {(account) => <Live>{(api) => children(api, account)}</Live>}
    </SettingsRoom>
  );
}
